import { formatInTimeZone } from 'date-fns-tz';

// Real IANA-timezone conversion, not offset math — the day boundary this
// produces has to match what a person in `timezone` actually experienced,
// including across DST transitions. Shared by Sprint 5's midnight-rollover
// and quiet-hours checks (09 §B), so it lives here rather than being
// duplicated per caller.
export function computeLocalDate(nowUtc: Date, timezone: string): string {
  return formatInTimeZone(nowUtc, timezone, 'yyyy-MM-dd');
}
