import { renderTemplate } from '@tally/conversation';
import { getPool } from '@tally/db-consumer';
import { createTwilioSendClient, sendMessage } from '@tally/messaging';
import { runEvaluationLoop } from './evaluationLoop.js';
import { createNudgeJobProcessor } from './nudgeJobProcessor.js';
import { createNudgeQueue, createNudgeWorker, type NudgeJobData } from './queue.js';
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

// 04 §7.1's example interval; overridable rather than hardcoded per 09
// breakdown §A step 4.
const schedulerTickMs = process.env.SCHEDULER_TICK_MS ? Number(process.env.SCHEDULER_TICK_MS) : 15 * 60 * 1000;
if (!Number.isFinite(schedulerTickMs) || schedulerTickMs <= 0) {
  throw new Error(`SCHEDULER_TICK_MS must be a positive number, got: ${process.env.SCHEDULER_TICK_MS}`);
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

let leadership: SchedulerLeadership | undefined;
let tick: TickHandle | undefined;

async function start(): Promise<void> {
  leadership = await tryAcquireSchedulerLeadership(getPool());
  if (leadership.isLeader) {
    console.log('[worker] acquired scheduler leadership; starting evaluation loop tick');
    tick = startPeriodicTick(schedulerTickMs, runSchedulerTick);
  } else {
    console.log('[worker] scheduler leadership held elsewhere; running queue consumer only');
  }
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  tick?.stop();
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
