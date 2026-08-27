import { getRecentMealLogsForUser } from '@tally/db-consumer';
import { parseDayReference, type DayReference } from '@tally/conversation';
import { addDaysToLocalDate, computeLocalDate, weekdayOfLocalDate } from '@tally/time';

export type CorrectionTargetResolution =
  | { kind: 'single'; targetLogId: string }
  | { kind: 'multiple'; candidateLogIds: string[] }
  | { kind: 'none' };

function resolveTargetDate(dayRef: DayReference | null, today: string): string {
  if (!dayRef) {
    return today;
  }
  if (dayRef.kind === 'yesterday') {
    return addDaysToLocalDate(today, -1);
  }
  // Most recent occurrence of the named weekday, on or before today —
  // covers "it's Monday and I said Monday" (today) the same as "today's
  // Thursday and I said Monday" (3 days back), with no special-casing.
  for (let back = 0; back < 7; back++) {
    const candidate = addDaysToLocalDate(today, -back);
    if (weekdayOfLocalDate(candidate) === dayRef.weekday) {
      return candidate;
    }
  }
  return today; // unreachable — the loop above covers all 7 weekdays
}

// 09 §E step 21-22: parse an explicit day reference from the text
// ("yesterday", a weekday name) if present — default lookback is same-day,
// extending to a prior day only when the text names one explicitly. Exactly
// one plausible match on the resolved day is the target; more than one is
// left for the router to turn into a disambiguation reply (transitions.ts's
// resolveCorrectionTransition); zero means nothing recent was found.
export async function resolveCorrectionTarget(
  userId: string,
  text: string,
  timezone: string,
  now: Date = new Date(),
): Promise<CorrectionTargetResolution> {
  const today = computeLocalDate(now, timezone);
  const targetDate = resolveTargetDate(parseDayReference(text), today);

  const recent = await getRecentMealLogsForUser(userId, { sinceDate: targetDate });
  const matches = recent.filter((log) => log.localDate === targetDate);

  if (matches.length === 0) {
    return { kind: 'none' };
  }
  if (matches.length === 1) {
    return { kind: 'single', targetLogId: matches[0].id };
  }
  return { kind: 'multiple', candidateLogIds: matches.map((log) => log.id) };
}
