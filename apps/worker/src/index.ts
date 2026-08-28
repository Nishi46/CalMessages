import { getPool } from '@tally/db-consumer';
import type { Job } from 'bullmq';
import { runEvaluationLoop } from './evaluationLoop.js';
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

// 04 §7.1's example interval; overridable rather than hardcoded per 09
// breakdown §A step 4.
const schedulerTickMs = process.env.SCHEDULER_TICK_MS ? Number(process.env.SCHEDULER_TICK_MS) : 15 * 60 * 1000;
if (!Number.isFinite(schedulerTickMs) || schedulerTickMs <= 0) {
  throw new Error(`SCHEDULER_TICK_MS must be a positive number, got: ${process.env.SCHEDULER_TICK_MS}`);
}

const connection = createRedisConnection(redisUrl);
const nudgeQueue = createNudgeQueue(connection);

// Placeholder job processor — §E step 17 replaces this with the
// authoritative frequency-cap check followed by the real sendMessage() call.
async function processNudgeJob(job: Job<NudgeJobData>): Promise<void> {
  console.log(`[worker] would send nudge for user ${job.data.userId} (${job.data.localDate})`);
}

const nudgeWorker = createNudgeWorker(connection, processNudgeJob);

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
