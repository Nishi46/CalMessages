// No date-parsing library — just keyword matching, same posture as
// onboardingAnswers.ts's goal classifier (09 §E step 21). Deliberately
// leaves the actual date arithmetic to the caller (packages/time), which is
// where real-timezone/calendar-boundary concerns already live — this file
// only turns text into an intent.
export type DayReference = { kind: 'yesterday' } | { kind: 'weekday'; weekday: number };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// null means no explicit day reference was found — callers default to
// same-day (09 §E step 21: "Default lookback is same-day; extend to prior
// days only when a day reference is explicit").
export function parseDayReference(text: string): DayReference | null {
  if (/\byesterday\b/i.test(text)) {
    return { kind: 'yesterday' };
  }

  for (let weekday = 0; weekday < WEEKDAYS.length; weekday++) {
    if (new RegExp(`\\b${WEEKDAYS[weekday]}\\b`, 'i').test(text)) {
      return { kind: 'weekday', weekday };
    }
  }

  return null;
}
