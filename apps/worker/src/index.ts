import { createStripeSubscriptionStatusClient } from '@tally/billing';
import { renderTemplate } from '@tally/conversation';
import { getPool } from '@tally/db-consumer';
import { createTwilioSendClient, sendMessage } from '@tally/messaging';
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

async function start(): Promise<void> {
  leadership = await tryAcquireSchedulerLeadership(getPool());
  if (leadership.isLeader) {
    console.log('[worker] acquired scheduler leadership; starting evaluation loop and reconciliation ticks');
    tick = startPeriodicTick(schedulerTickMs, runSchedulerTick);
    reconciliationTick = startPeriodicTick(reconciliationTickMs, runReconciliationTickNow);
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
