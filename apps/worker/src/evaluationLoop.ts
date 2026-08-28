import { countNudgesSentToday, daysSinceLastLog, getActiveUsersForScheduling, hasLoggedToday } from '@tally/db-consumer';
import type { User } from '@tally/db-consumer';
import { computeLocalDate, localTimeOfDay } from '@tally/time';
import type { Queue } from 'bullmq';
import { isWithinNudgeWindow, isWithinQuietHours } from './nudgeSchedule.js';
import type { NudgeJobData } from './queue.js';
import { NUDGE_QUEUE_NAME } from './queue.js';

// 04 §7.3: default hard cap of one proactive send per day. Checked here as
// the scheduler's cheap pre-filter (09 breakdown §D step 13); the queue
// consumer (nudgeJobProcessor.ts) re-checks authoritatively immediately
// before sending (§D step 14) to close the race Architecture §7 describes.
export const DAILY_NUDGE_CAP = 1;

// Placeholder 5-day disengagement formula — Build Spec §5 specifies
// "reduced further... rather than increased" with no exact ratio. Same
// placeholder posture as computeDefaultGoal (07 §D step 16): a fixed rule
// now, tuned later, flagged explicitly so it isn't mistaken for a considered
// product decision. A fixed 1-in-N ratio (rather than one that scales with
// daysSinceLastLog) guarantees this never trends toward MORE frequent sends
// as disengagement grows, no matter how N gets retuned later.
const DISENGAGEMENT_THRESHOLD_DAYS = 5;
const DISENGAGEMENT_SEND_EVERY_NTH_ELIGIBLE_DAY = 3;

export function shouldSkipForDisengagement(daysSinceLastLogValue: number | null): boolean {
  if (daysSinceLastLogValue === null || daysSinceLastLogValue < DISENGAGEMENT_THRESHOLD_DAYS) {
    return false;
  }
  return daysSinceLastLogValue % DISENGAGEMENT_SEND_EVERY_NTH_ELIGIBLE_DAY !== 0;
}

// 04 §7.1's evaluation loop body, run once per active user per tick. Order
// matches the pseudocode exactly: nudge window, already-logged, quiet
// hours, frequency cap, then the disengagement rule as a further chance to
// skip — never a chance to send on top of an already-failed check (09
// breakdown §C step 11). `now` is threaded through rather than read via
// Date.now() so the whole loop can be driven by an injected clock in tests
// (§F step 18).
export async function evaluateUserForNudge(
  user: User,
  now: Date,
  enqueueNudge: (data: NudgeJobData) => Promise<void>,
): Promise<void> {
  const localDate = computeLocalDate(now, user.timezone);
  const timeOfDay = localTimeOfDay(now, user.timezone);

  if (!isWithinNudgeWindow(timeOfDay)) return;
  if (await hasLoggedToday(user.id, localDate)) return;
  if (isWithinQuietHours(timeOfDay)) return;
  if ((await countNudgesSentToday(user.id, localDate)) >= DAILY_NUDGE_CAP) return;
  if (shouldSkipForDisengagement(await daysSinceLastLog(user.id, now))) return;

  await enqueueNudge({ userId: user.id, localDate });
}

// Runs the loop body across every active user (04 §7.1's "for each active
// user"). The job id is the idempotency key from §C step 11 — BullMQ's
// job-id dedup is the first of the two frequency-cap layers §D describes;
// the queue consumer's authoritative check (§D step 14) is the second. One
// user's evaluation failing (e.g. a transient DB error) doesn't abort the
// rest of the tick.
export async function runEvaluationLoop(queue: Queue<NudgeJobData>, now: Date): Promise<void> {
  const users = await getActiveUsersForScheduling();
  const results = await Promise.allSettled(
    users.map((user) =>
      evaluateUserForNudge(user, now, async (data) => {
        await queue.add(NUDGE_QUEUE_NAME, data, { jobId: `nudge:${data.userId}:${data.localDate}` });
      }),
    ),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[worker] evaluation loop failed for a user', result.reason);
    }
  }
}
