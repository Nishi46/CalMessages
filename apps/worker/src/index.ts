import { createStripeSubscriptionStatusClient } from '@tally/billing';
import { renderTemplate } from '@tally/conversation';
import { getPool } from '@tally/db-consumer';
import { createTwilioSendClient, sendMessage } from '@tally/messaging';
import { createS3ObjectStore } from '@tally/object-store';
import { consoleDeliverabilityNotifier, runDeliverabilityAlertTick } from './deliverabilityAlert.js';
import { DEFAULT_PURGE_GRACE_PERIOD_MS, runDeletionPurgeTick } from './deletionPurge.js';
import { runEvaluationLoop } from './evaluationLoop.js';
import { createNudgeJobProcessor } from './nudgeJobProcessor.js';
import { createNudgeQueue, createNudgeWorker, type NudgeJobData } from './queue.js';
import { runReconciliationTick } from './reconciliation.js';
import { createRedisConnection } from './redis.js';
import { tryAcquireSchedulerLeadership, type SchedulerLeadership } from './schedulerLock.js';
import { startPeriodicTick, type TickHandle } from './schedulerTick.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const redisUrl = requireEnv('REDIS_URL');

const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
if (!accountSid.startsWith('AC')) {
  throw new Error(
    "TWILIO_ACCOUNT_SID must be the Account SID from the Twilio Console (starts with 'AC') — " +
      "not an API Key SID (starts with 'SK').",
  );
}
const authToken = requireEnv('TWILIO_AUTH_TOKEN');
const fromNumber = requireEnv('TWILIO_PHONE_NUMBER');
const stripeSecretKey = requireEnv('STRIPE_SECRET_KEY');

// 12 §B step 8: the purge sweep's only use of an ObjectStore — same
// construction as apps/api/src/index.ts, against the same bucket, since
// this is the only other process that ever needs to touch meal photos.
const objectStore = createS3ObjectStore({
  endpoint: requireEnv('S3_ENDPOINT'),
  bucket: requireEnv('S3_BUCKET'),
  accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
});

// 04 §7.1's example interval; overridable rather than hardcoded per 09
// breakdown §A step 4.
const schedulerTickMs = process.env.SCHEDULER_TICK_MS ? Number(process.env.SCHEDULER_TICK_MS) : 15 * 60 * 1000;
if (!Number.isFinite(schedulerTickMs) || schedulerTickMs <= 0) {
  throw new Error(`SCHEDULER_TICK_MS must be a positive number, got: ${process.env.SCHEDULER_TICK_MS}`);
}

// 11 breakdown §E step 16: daily per 04 §8.4, overridable for the same
// reason SCHEDULER_TICK_MS is — so a test/local run doesn't wait a real day.
const RECONCILIATION_TICK_MS = 24 * 60 * 60 * 1000;
const reconciliationTickMs = process.env.RECONCILIATION_TICK_MS
  ? Number(process.env.RECONCILIATION_TICK_MS)
  : RECONCILIATION_TICK_MS;
if (!Number.isFinite(reconciliationTickMs) || reconciliationTickMs <= 0) {
  throw new Error(`RECONCILIATION_TICK_MS must be a positive number, got: ${process.env.RECONCILIATION_TICK_MS}`);
}
// A little slack over the tick interval itself, so an account synced just
// under 24h ago (webhook or the previous reconciliation run) isn't
// immediately flagged stale again by jitter in exactly when a tick fires.
const reconciliationStaleAfterMs = process.env.RECONCILIATION_STALE_AFTER_MS
  ? Number(process.env.RECONCILIATION_STALE_AFTER_MS)
  : reconciliationTickMs + 2 * 60 * 60 * 1000;
if (!Number.isFinite(reconciliationStaleAfterMs) || reconciliationStaleAfterMs <= 0) {
  throw new Error(
    `RECONCILIATION_STALE_AFTER_MS must be a positive number, got: ${process.env.RECONCILIATION_STALE_AFTER_MS}`,
  );
}

// 12 §B step 7: daily, same cadence as reconciliation — a 30-day grace
// period has no need for anything finer-grained, and this rides the same
// leadership election rather than a second lock, for the same reasons
// reconciliation does (see the comment on reconciliationTick below).
const PURGE_TICK_MS = 24 * 60 * 60 * 1000;
const purgeTickMs = process.env.PURGE_TICK_MS ? Number(process.env.PURGE_TICK_MS) : PURGE_TICK_MS;
if (!Number.isFinite(purgeTickMs) || purgeTickMs <= 0) {
  throw new Error(`PURGE_TICK_MS must be a positive number, got: ${process.env.PURGE_TICK_MS}`);
}
const purgeGracePeriodMs = process.env.PURGE_GRACE_PERIOD_MS
  ? Number(process.env.PURGE_GRACE_PERIOD_MS)
  : DEFAULT_PURGE_GRACE_PERIOD_MS;
if (!Number.isFinite(purgeGracePeriodMs) || purgeGracePeriodMs <= 0) {
  throw new Error(`PURGE_GRACE_PERIOD_MS must be a positive number, got: ${process.env.PURGE_GRACE_PERIOD_MS}`);
}

// 13 breakdown §B step 4 (04 §12, Build Spec §7): a P0 incident mechanism,
// not dashboard-only — checked on the same cadence as the nudge scheduler
// rather than reconciliation/purge's once-daily sweep, since a deliverability
// collapse needs to surface within minutes, not up to a day later.
const DELIVERABILITY_ALERT_TICK_MS = 15 * 60 * 1000;
const deliverabilityAlertTickMs = process.env.DELIVERABILITY_ALERT_TICK_MS
  ? Number(process.env.DELIVERABILITY_ALERT_TICK_MS)
  : DELIVERABILITY_ALERT_TICK_MS;
if (!Number.isFinite(deliverabilityAlertTickMs) || deliverabilityAlertTickMs <= 0) {
  throw new Error(
    `DELIVERABILITY_ALERT_TICK_MS must be a positive number, got: ${process.env.DELIVERABILITY_ALERT_TICK_MS}`,
  );
}
// The trailing window the failure rate is computed over — wider than the
// tick interval so a single tick's window still has a meaningful sample
// size, not just whatever trickled in since the last check.
const DELIVERABILITY_ALERT_WINDOW_MS = 60 * 60 * 1000;
const deliverabilityAlertWindowMs = process.env.DELIVERABILITY_ALERT_WINDOW_MS
  ? Number(process.env.DELIVERABILITY_ALERT_WINDOW_MS)
  : DELIVERABILITY_ALERT_WINDOW_MS;
if (!Number.isFinite(deliverabilityAlertWindowMs) || deliverabilityAlertWindowMs <= 0) {
  throw new Error(
    `DELIVERABILITY_ALERT_WINDOW_MS must be a positive number, got: ${process.env.DELIVERABILITY_ALERT_WINDOW_MS}`,
  );
}
// Placeholder default pending a real incident-response decision (13
// breakdown §B step 5 flags the alert destination itself as undecided by
// 01-07; this number is the same kind of gap) — 20% of outbound messages
// failing/undelivered in the trailing window is well past ordinary carrier
// noise, but nobody has actually signed off on this threshold.
const DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD = 0.2;
const deliverabilityAlertFailureRateThreshold = process.env.DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD
  ? Number(process.env.DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD)
  : DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD;
if (
  !Number.isFinite(deliverabilityAlertFailureRateThreshold) ||
  deliverabilityAlertFailureRateThreshold <= 0 ||
  deliverabilityAlertFailureRateThreshold > 1
) {
  throw new Error(
    `DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD must be a number in (0, 1], got: ${process.env.DELIVERABILITY_ALERT_FAILURE_RATE_THRESHOLD}`,
  );
}

const connection = createRedisConnection(redisUrl);
const nudgeQueue = createNudgeQueue(connection);

const sendClient = createTwilioSendClient({ accountSid, authToken, fromNumber });

// 09 breakdown §E step 17: nudges are "just another outbound message" per
// Architecture §3.1's one-send-path design — the same sendMessage() every
// other outbound type (fast-path replies, recaps, the paywall) goes
// through, unchanged.
async function sendNudge(data: NudgeJobData): Promise<void> {
  await sendMessage(sendClient, data.userId, renderTemplate('proactive_checkin'), 'nudge');
}

const nudgeWorker = createNudgeWorker(connection, createNudgeJobProcessor(sendNudge));

async function runSchedulerTick(): Promise<void> {
  await runEvaluationLoop(nudgeQueue, new Date());
}

const subscriptionStatusClient = createStripeSubscriptionStatusClient({ secretKey: stripeSecretKey });

async function runReconciliationTickNow(): Promise<void> {
  await runReconciliationTick(subscriptionStatusClient, new Date(), reconciliationStaleAfterMs);
}

async function runDeletionPurgeTickNow(): Promise<void> {
  await runDeletionPurgeTick(objectStore, new Date(), purgeGracePeriodMs);
}

async function runDeliverabilityAlertTickNow(): Promise<void> {
  await runDeliverabilityAlertTick(consoleDeliverabilityNotifier, new Date(), deliverabilityAlertWindowMs, {
    failureRateThreshold: deliverabilityAlertFailureRateThreshold,
  });
}

let leadership: SchedulerLeadership | undefined;
let tick: TickHandle | undefined;
// 11 breakdown §E step 16: rides the same leadership the nudge scheduler
// already acquires, rather than a second advisory lock — at this scale, one
// worker process running all singleton background duties is simpler to
// reason about than per-job leader election, and a daily reconciliation
// sweep (unlike duplicate nudge sends) is harmless to run twice if it ever
// did overlap. Also doesn't reuse the BullMQ queue infrastructure: that
// exists for per-user job scheduling/dedup at nudge-send scale, which a
// once-a-day sweep over a small stale-account set doesn't need.
let reconciliationTick: TickHandle | undefined;
// 12 §B step 7: same rationale as reconciliationTick above — a daily purge
// sweep is harmless to run twice (getUsersPendingPurge's own WHERE clause
// keeps an already-purged user from being reprocessed), so it rides the same
// leadership election rather than a third lock.
let purgeTick: TickHandle | undefined;
// 13 breakdown §B step 4: same rationale again — a read-only threshold check
// that only ever logs is harmless run twice by two leaders in a
// leadership-transition window, so this rides the same election too rather
// than standing up a fourth lock for what is, mechanically, the same kind of
// job as reconciliation/purge.
let deliverabilityAlertTick: TickHandle | undefined;

async function start(): Promise<void> {
  leadership = await tryAcquireSchedulerLeadership(getPool());
  if (leadership.isLeader) {
    console.log(
      '[worker] acquired scheduler leadership; starting evaluation loop, reconciliation, purge, and deliverability-alert ticks',
    );
    tick = startPeriodicTick(schedulerTickMs, runSchedulerTick);
    reconciliationTick = startPeriodicTick(reconciliationTickMs, runReconciliationTickNow);
    purgeTick = startPeriodicTick(purgeTickMs, runDeletionPurgeTickNow);
    deliverabilityAlertTick = startPeriodicTick(deliverabilityAlertTickMs, runDeliverabilityAlertTickNow);
  } else {
    console.log('[worker] scheduler leadership held elsewhere; running queue consumer only');
  }
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  tick?.stop();
  reconciliationTick?.stop();
  purgeTick?.stop();
  deliverabilityAlertTick?.stop();
  await nudgeWorker.close();
  await nudgeQueue.close();
  await leadership?.release();
  connection.disconnect();
  await getPool().end();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
