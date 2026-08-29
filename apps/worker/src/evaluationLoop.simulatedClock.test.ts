import { createUser, getPool, hasLoggedToday, uniqueTestPhone } from '@tally/db-consumer';
import { computeLocalDate, localTimeOfDay } from '@tally/time';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { evaluateUserForNudge } from './evaluationLoop.js';
import { isWithinNudgeWindow, isWithinQuietHours } from './nudgeSchedule.js';

// 09 breakdown §F step 18: every check under test here is driven by an
// injected `now: Date` — never Date.now() — which is what lets every test
// below simulate midnight rollovers, DST transitions, and multi-day
// disengagement windows without waiting on the real wall clock.

describe('midnight rollover (09 breakdown §F step 19)', () => {
  it("a log made at 11:59pm local doesn't cover a nudge evaluation two minutes later, at 12:01am local", async () => {
    const user = await createUser(uniqueTestPhone());
    const elevenFiftyNinePmLocal = new Date('2026-08-27T03:59:00Z'); // 2026-08-26T23:59 America/New_York
    const twelveOhOneAmLocal = new Date('2026-08-27T04:01:00Z'); // 2026-08-27T00:01 America/New_York, two minutes later

    const dayOfLog = computeLocalDate(elevenFiftyNinePmLocal, user.timezone);
    const dayOfEvaluation = computeLocalDate(twelveOhOneAmLocal, user.timezone);
    expect(dayOfLog).not.toBe(dayOfEvaluation); // the local day actually rolled over between the two instants

    await getPool().query(
      `INSERT INTO meal_log (user_id, items, confidence, source, local_date, logged_at)
       VALUES ($1, '[]', 'high', 'text', $2, $3)`,
      [user.id, dayOfLog, elevenFiftyNinePmLocal.toISOString()],
    );

    expect(await hasLoggedToday(user.id, dayOfLog)).toBe(true);
    expect(await hasLoggedToday(user.id, dayOfEvaluation)).toBe(false);
  });
});

describe('DST transition (09 breakdown §F step 20)', () => {
  // America/New_York's Nov 2026 fall-back happens at 2026-11-01T06:00:00Z
  // (2am EDT -> 1am EST) — same transition instant packages/time's own DST
  // tests use. Both probes below land at the same LOCAL wall-clock time
  // (20:10, inside the nudge window; 23:00, inside quiet hours) on either
  // side of it. Fixed-offset math would get one side wrong; real IANA
  // tz-aware conversion (packages/time, backed by date-fns-tz) gets both right.
  it('the nudge window is evaluated correctly on both sides of the transition', () => {
    const beforeFallBack = new Date('2026-11-01T00:10:00Z'); // 2026-10-31T20:10 EDT (UTC-4)
    const afterFallBack = new Date('2026-11-02T01:10:00Z'); // 2026-11-01T20:10 EST (UTC-5)

    expect(isWithinNudgeWindow(localTimeOfDay(beforeFallBack, 'America/New_York'))).toBe(true);
    expect(isWithinNudgeWindow(localTimeOfDay(afterFallBack, 'America/New_York'))).toBe(true);
  });

  it('quiet hours are evaluated correctly on both sides of the transition', () => {
    const beforeFallBack = new Date('2026-11-01T03:00:00Z'); // 2026-10-31T23:00 EDT (UTC-4)
    const afterFallBack = new Date('2026-11-02T04:00:00Z'); // 2026-11-01T23:00 EST (UTC-5)

    expect(isWithinQuietHours(localTimeOfDay(beforeFallBack, 'America/New_York'))).toBe(true);
    expect(isWithinQuietHours(localTimeOfDay(afterFallBack, 'America/New_York'))).toBe(true);
  });

  it('a naive fixed -4 offset would have gotten the post-transition instant wrong (sanity check on the fixture)', () => {
    // If this ever stops being true, the fixture above no longer proves
    // anything — the two instants would need picking again.
    const afterFallBack = new Date('2026-11-02T01:10:00Z');
    const naiveFixedOffsetHour = (afterFallBack.getUTCHours() - 4 + 24) % 24;
    expect(naiveFixedOffsetHour).not.toBe(20);
  });
});

describe('frequency cap boundary (09 breakdown §F step 21)', () => {
  const NUDGE_WINDOW_INSTANT = new Date('2026-08-28T00:15:00Z'); // 2026-08-27T20:15 America/New_York

  async function seedUserWithNudgesSentToday(count: number) {
    const user = await createUser(uniqueTestPhone());
    for (let i = 0; i < count; i++) {
      await getPool().query(
        `INSERT INTO message_event (user_id, direction, type, sent_at, delivery_status)
         VALUES ($1, 'outbound', 'nudge', $2, 'sent')`,
        [user.id, NUDGE_WINDOW_INSTANT.toISOString()],
      );
    }
    return user;
  }

  it('sends when one under the cap (0 sent today, cap is 1)', async () => {
    const user = await seedUserWithNudgesSentToday(0);
    const enqueueNudge = vi.fn().mockResolvedValue(undefined);

    await evaluateUserForNudge(user, NUDGE_WINDOW_INSTANT, enqueueNudge);

    expect(enqueueNudge).toHaveBeenCalledTimes(1);
  });

  it('does not send when exactly at the cap (1 sent today, cap is 1)', async () => {
    const user = await seedUserWithNudgesSentToday(1);
    const enqueueNudge = vi.fn().mockResolvedValue(undefined);

    await evaluateUserForNudge(user, NUDGE_WINDOW_INSTANT, enqueueNudge);

    expect(enqueueNudge).not.toHaveBeenCalled();
  });

  it('does not send, and does not throw, when already over the cap (2 sent today — should not be reachable, but must degrade safely)', async () => {
    const user = await seedUserWithNudgesSentToday(2);
    const enqueueNudge = vi.fn().mockResolvedValue(undefined);

    await expect(evaluateUserForNudge(user, NUDGE_WINDOW_INSTANT, enqueueNudge)).resolves.toBeUndefined();
    expect(enqueueNudge).not.toHaveBeenCalled();
  });
});

describe('5-day disengagement, evaluated end to end through the real DB (09 breakdown §F step 23)', () => {
  it('sends on roughly 1 in 3 eligible days once past the threshold, and never more often as days accumulate', async () => {
    const user = await createUser(uniqueTestPhone());
    // 2026-08-02T00:10:00Z is 2026-08-01T20:10 in America/New_York (EDT,
    // UTC-4) — chosen so that adding whole-day offsets below (no DST
    // transition between here and the last tick) keeps every tick's LOCAL
    // time-of-day inside the nudge window, not just its UTC clock time.
    const lastLoggedAt = new Date('2026-08-02T00:10:00Z');
    const lastLoggedLocalDate = computeLocalDate(lastLoggedAt, user.timezone);
    await getPool().query(
      `INSERT INTO meal_log (user_id, items, confidence, source, local_date, logged_at)
       VALUES ($1, '[]', 'high', 'text', $2, $3)`,
      [user.id, lastLoggedLocalDate, lastLoggedAt.toISOString()],
    );

    // Five simulated ticks, each exactly N days after lastLoggedAt, all
    // landing inside the nudge window (20:00 local) with nothing else
    // (today's log, quiet hours, frequency cap) in play — the only thing
    // that varies between ticks is daysSinceLastLog, isolating the
    // disengagement rule exactly as "otherwise-identical eligibility" requires.
    const sendResultsByDaysSince: Record<number, boolean> = {};
    for (const daysSince of [5, 6, 7, 8, 9]) {
      const tickInstant = new Date(lastLoggedAt.getTime() + daysSince * 24 * 60 * 60 * 1000);
      const enqueueNudge = vi.fn().mockResolvedValue(undefined);

      await evaluateUserForNudge(user, tickInstant, enqueueNudge);

      sendResultsByDaysSince[daysSince] = enqueueNudge.mock.calls.length > 0;
    }

    // Matches the 1-in-3 placeholder ratio exactly: 5(skip) 6(send) 7(skip) 8(skip) 9(send).
    expect(sendResultsByDaysSince).toEqual({ 5: false, 6: true, 7: false, 8: false, 9: true });

    const sendCount = Object.values(sendResultsByDaysSince).filter(Boolean).length;
    const skipCount = Object.values(sendResultsByDaysSince).filter((sent) => !sent).length;
    // The never-more-often requirement itself: a disengaged user is skipped
    // at least as often as they're sent to, for every window checked.
    expect(skipCount).toBeGreaterThanOrEqual(sendCount);
  });
});

afterAll(async () => {
  await getPool().end();
});
