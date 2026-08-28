import { countNudgesSentToday } from '@tally/db-consumer';
import type { Job, Processor } from 'bullmq';
import { DAILY_NUDGE_CAP } from './evaluationLoop.js';
import type { NudgeJobData } from './queue.js';

// 09 breakdown §D step 14: the authoritative frequency-cap check, re-run
// against current message_event data immediately before the real send —
// never trusting the scheduler's evaluation-time decision (§C step 11),
// which can be stale by the time this job runs. This is what closes the
// race Architecture §7 describes: a leader-election glitch or an
// overlapping evaluation cycle enqueuing the same user twice. Together with
// the job-id dedup already in place (§C step 11 / §D step 15), this is the
// second of the two independent layers §D step 15 calls for — "cheap to
// check twice; expensive to get wrong."
//
// Aborting here is a normal, non-error outcome: the job still completes
// successfully, it just sends nothing, so BullMQ doesn't retry it.
//
// `sendNudge` is the actual send — index.ts wires it to the real
// sendMessage(client, userId, body, 'nudge') call (§E step 17); accepted as
// a parameter here so this file stays free of Twilio/template specifics.
export function createNudgeJobProcessor(sendNudge: (data: NudgeJobData) => Promise<void>): Processor<NudgeJobData> {
  return async (job: Job<NudgeJobData>) => {
    const sentToday = await countNudgesSentToday(job.data.userId, job.data.localDate);
    if (sentToday >= DAILY_NUDGE_CAP) {
      console.log(`[worker] skipping nudge for user ${job.data.userId} — daily cap already met at send time`);
      return;
    }
    await sendNudge(job.data);
  };
}
