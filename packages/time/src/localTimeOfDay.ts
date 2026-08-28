import { formatInTimeZone } from 'date-fns-tz';

export interface LocalTimeOfDay {
  hour: number;
  minute: number;
}

// Companion to computeLocalDate, backed by the same real-IANA-timezone
// conversion (see that file's comment) rather than a second library — the
// nudge-window and quiet-hours checks (09 breakdown §B step 5) need local
// wall-clock time of day, not just the local calendar date.
export function localTimeOfDay(nowUtc: Date, timezone: string): LocalTimeOfDay {
  return {
    hour: Number(formatInTimeZone(nowUtc, timezone, 'H')),
    minute: Number(formatInTimeZone(nowUtc, timezone, 'm')),
  };
}
