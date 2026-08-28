import { renderTemplate } from '@tally/conversation';
import { createUser, getPool } from '@tally/db-consumer';
import { sendMessage, type TwilioSendClient } from '@tally/messaging';
import { QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { evaluateUserForNudge } from './evaluationLoop.js';
import { createNudgeJobProcessor } from './nudgeJobProcessor.js';
import { createNudgeQueue, createNudgeWorker, NUDGE_QUEUE_NAME, type NudgeJobData } from './queue.js';
import { createRedisConnection } from './redis.js';

// 09 breakdown §F step 22: end-to-end double-fire race tests, wired to a
// real BullMQ queue/worker over the same Redis the production worker uses
// (REDIS_URL), plus a real Postgres for the authoritative check. Mocks only
// at the Twilio boundary — proves the full producer -> queue -> consumer ->
// sendMessage() chain, not just that a job got enqueued once.
//
// Both tests target a single, freshly-created user directly, rather than
// going through runEvaluationLoop's full active-user sweep — this shared
// dev database accumulates idle-state users from every other test run in
// this session, and sweeping all of them would make "wait for the job to
// complete" ambiguous about *whose* job just finished.

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

function fakeTwilioClient(): TwilioSendClient {
  return { send: vi.fn().mockResolvedValue({ sid: `SM_race_${Math.random()}` }) };
}

describe('double-fire race (09 breakdown §F step 22)', () => {
  it('job-id dedup: two overlapping evaluation cycles for the same user/day result in exactly one send', async () => {
    const user = await createUser(`+1${Date.now()}`);
    const now = new Date('2026-08-28T00:15:00Z'); // 2026-08-27T20:15 America/New_York — inside the nudge window

    const connection = createRedisConnection(redisUrl);
    const queue = createNudgeQueue(connection);
    // QueueEvents needs its own dedicated connection, separate from the
    // Worker's (both use blocking Redis commands internally). Closed
    // explicitly below rather than trusting queueEvents.close() to tear
    // down a connection it didn't create.
    const queueEventsConnection = createRedisConnection(redisUrl);
    const queueEvents = new QueueEvents(NUDGE_QUEUE_NAME, { connection: queueEventsConnection });
    const client = fakeTwilioClient();
    const processor = createNudgeJobProcessor(async (data) => {
      await sendMessage(client, data.userId, renderTemplate('proactive_checkin'), 'nudge');
    });
    const worker = createNudgeWorker(connection, processor);

    try {
      await queueEvents.waitUntilReady();

      const enqueue = (data: NudgeJobData) =>
        queue
          .add(NUDGE_QUEUE_NAME, data, { jobId: `nudge:${data.userId}:${data.localDate}` })
          .then(() => undefined);

      // Two "overlapping evaluation cycles" for the same user — e.g. a
      // leader-election glitch briefly letting two scheduler instances both
      // tick at once.
      await Promise.all([evaluateUserForNudge(user, now, enqueue), evaluateUserForNudge(user, now, enqueue)]);

      const job = await queue.getJob(`nudge:${user.id}:2026-08-27`);
      expect(job).not.toBeNull();
      await job?.waitUntilFinished(queueEvents, 5000);

      expect(client.send).toHaveBeenCalledTimes(1); // only one real send, despite two enqueue attempts

      const { rows } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM message_event WHERE user_id = $1 AND type = 'nudge' AND direction = 'outbound'`,
        [user.id],
      );
      expect(Number(rows[0].count)).toBe(1);
    } finally {
      await worker.close();
      await queue.close();
      await queueEvents.close();
      queueEventsConnection.disconnect();
      connection.disconnect();
    }
  });

  it('authoritative check: two distinct jobs targeting the same user/day (dedup bypassed) still only send once', async () => {
    const user = await createUser(`+1${Date.now()}1`);
    const localDate = '2026-08-27';

    const connection = createRedisConnection(redisUrl);
    const queue = createNudgeQueue(connection);
    // QueueEvents needs its own dedicated connection, separate from the
    // Worker's (both use blocking Redis commands internally). Closed
    // explicitly below rather than trusting queueEvents.close() to tear
    // down a connection it didn't create.
    const queueEventsConnection = createRedisConnection(redisUrl);
    const queueEvents = new QueueEvents(NUDGE_QUEUE_NAME, { connection: queueEventsConnection });
    const client = fakeTwilioClient();
    const processor = createNudgeJobProcessor(async (data) => {
      await sendMessage(client, data.userId, renderTemplate('proactive_checkin'), 'nudge');
    });
    // BullMQ's default Worker concurrency is 1 — jobs process one at a time,
    // in order added, which is what lets the second job's authoritative
    // check see the first job's already-written message_event row.
    const worker = createNudgeWorker(connection, processor);

    try {
      await queueEvents.waitUntilReady();

      // Two independently-generated job ids for the identical (userId,
      // localDate) — simulates the idempotency key itself being bypassed
      // (e.g. two out-of-sync scheduler processes), which is exactly the
      // scenario the authoritative check exists to cover as the second,
      // independent layer. Suffixed with user.id (fresh per run) rather
      // than a bare literal — BullMQ keeps completed jobs in Redis
      // indefinitely with no cleanup configured, so a hardcoded id would
      // dedup against a previous run's already-completed leftover job and
      // never actually reprocess. Hyphen-separated, not colon-separated —
      // BullMQ only allows a custom id to contain ':' when it splits into
      // exactly 3 parts (its own repeatable-job-id convention).
      const jobA = await queue.add(NUDGE_QUEUE_NAME, { userId: user.id, localDate }, { jobId: `race-job-a-${user.id}` });
      const jobB = await queue.add(NUDGE_QUEUE_NAME, { userId: user.id, localDate }, { jobId: `race-job-b-${user.id}` });

      await Promise.all([jobA.waitUntilFinished(queueEvents, 5000), jobB.waitUntilFinished(queueEvents, 5000)]);

      expect(client.send).toHaveBeenCalledTimes(1);

      const { rows } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM message_event WHERE user_id = $1 AND type = 'nudge' AND direction = 'outbound'`,
        [user.id],
      );
      expect(Number(rows[0].count)).toBe(1);
    } finally {
      await worker.close();
      await queue.close();
      await queueEvents.close();
      queueEventsConnection.disconnect();
      connection.disconnect();
    }
  });
});

afterAll(async () => {
  await getPool().end();
});
