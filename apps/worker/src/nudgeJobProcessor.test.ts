import { createUser, getPool } from '@tally/db-consumer';
import { computeLocalDate } from '@tally/time';
import type { Job } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createNudgeJobProcessor } from './nudgeJobProcessor.js';
import type { NudgeJobData } from './queue.js';

function fakeJob(data: NudgeJobData): Job<NudgeJobData> {
  return { data } as Job<NudgeJobData>;
}

describe('createNudgeJobProcessor (09 breakdown §D step 14 — authoritative send-time cap check)', () => {
  it('sends when no nudge has gone out today', async () => {
    const user = await createUser(`+1${Date.now()}`);
    const sendNudge = vi.fn().mockResolvedValue(undefined);
    const process = createNudgeJobProcessor(sendNudge);

    await process(fakeJob({ userId: user.id, localDate: '2026-08-27' }));

    expect(sendNudge).toHaveBeenCalledWith({ userId: user.id, localDate: '2026-08-27' });
  });

  it('aborts without sending when the cap is already met, without throwing', async () => {
    const user = await createUser(`+1${Date.now()}1`);
    // Simulates the race Architecture §7 describes: a nudge already landed
    // for this user/day by the time this job runs, even though the
    // scheduler's earlier pre-filter (§C step 11) let it through.
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'outbound', 'nudge', now(), 'sent')`,
      [user.id],
    );
    const sendNudge = vi.fn().mockResolvedValue(undefined);
    const process = createNudgeJobProcessor(sendNudge);
    const localDate = computeLocalDate(new Date(), user.timezone);

    await expect(process(fakeJob({ userId: user.id, localDate }))).resolves.toBeUndefined();
    expect(sendNudge).not.toHaveBeenCalled();
  });

  it("does not abort for a different user's nudge sent today", async () => {
    const sentTo = await createUser(`+1${Date.now()}2`);
    const evaluating = await createUser(`+1${Date.now()}3`);
    await getPool().query(
      `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
       VALUES ($1, 'outbound', 'nudge', now(), 'sent')`,
      [sentTo.id],
    );
    const sendNudge = vi.fn().mockResolvedValue(undefined);
    const process = createNudgeJobProcessor(sendNudge);

    await process(fakeJob({ userId: evaluating.id, localDate: '2026-08-27' }));

    expect(sendNudge).toHaveBeenCalledWith({ userId: evaluating.id, localDate: '2026-08-27' });
  });
});

afterAll(async () => {
  await getPool().end();
});
