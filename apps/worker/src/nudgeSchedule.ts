import type { LocalTimeOfDay } from '@tally/time';

// Placeholder tunables pending the P1 per-user-learned timing from Build
// Spec open question 2 ("fixed 8pm default, or learn each user's typical
// dinner time...") — same posture as computeDefaultGoal (07 §D step 16): a
// fixed value now, a real formula later, flagged explicitly so it isn't
// mistaken for a considered product decision.
//
// The nudge window is deliberately narrow (not "any time after 8pm") so a
// missed tick doesn't leave the send trailing into the night — 04 §7.1's
// evaluation loop runs every ~15 minutes, so a window a little wider than
// that keeps a single slow tick from skipping the day entirely.
export const NUDGE_WINDOW_START: LocalTimeOfDay = { hour: 20, minute: 0 };
export const NUDGE_WINDOW_END: LocalTimeOfDay = { hour: 20, minute: 30 };

// Late-night/early-morning band; also a placeholder. Wraps past midnight
// (22:00 -> 08:00), which isWithinRange below handles explicitly.
export const QUIET_HOURS_START: LocalTimeOfDay = { hour: 22, minute: 0 };
export const QUIET_HOURS_END: LocalTimeOfDay = { hour: 8, minute: 0 };

function minutesSinceMidnight(time: LocalTimeOfDay): number {
  return time.hour * 60 + time.minute;
}

// Inclusive of start, exclusive of end. Handles ranges that wrap past
// midnight (start > end, e.g. quiet hours) as well as same-day ranges
// (start < end, e.g. the nudge window).
function isWithinRange(time: LocalTimeOfDay, start: LocalTimeOfDay, end: LocalTimeOfDay): boolean {
  const t = minutesSinceMidnight(time);
  const s = minutesSinceMidnight(start);
  const e = minutesSinceMidnight(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export function isWithinNudgeWindow(time: LocalTimeOfDay): boolean {
  return isWithinRange(time, NUDGE_WINDOW_START, NUDGE_WINDOW_END);
}

export function isWithinQuietHours(time: LocalTimeOfDay): boolean {
  return isWithinRange(time, QUIET_HOURS_START, QUIET_HOURS_END);
}
