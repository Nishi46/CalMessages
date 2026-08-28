import { describe, expect, it } from 'vitest';
import { localTimeOfDay } from './localTimeOfDay.js';

describe('localTimeOfDay', () => {
  it('reads the local hour/minute for a timezone behind UTC', () => {
    // 2026-08-27T03:30:00Z is 2026-08-26T23:30 in America/New_York (EDT, UTC-4).
    const nowUtc = new Date('2026-08-27T03:30:00Z');
    expect(localTimeOfDay(nowUtc, 'America/New_York')).toEqual({ hour: 23, minute: 30 });
  });

  it('reads the local hour/minute for a timezone ahead of UTC', () => {
    // 2026-08-26T20:15:00Z is 2026-08-27T05:15 in Asia/Tokyo (UTC+9).
    const nowUtc = new Date('2026-08-26T20:15:00Z');
    expect(localTimeOfDay(nowUtc, 'Asia/Tokyo')).toEqual({ hour: 5, minute: 15 });
  });

  it('resolves the correct local hour across a DST transition, per the UTC offset in effect that day', () => {
    // Same wall-clock UTC time, one day apart, straddling America/New_York's
    // Nov 2026 fall-back (EDT UTC-4 -> EST UTC-5 at 2026-11-01T06:00:00Z) —
    // fixed-offset math would produce the same local hour both times; real
    // tz-aware conversion doesn't, same rationale as computeLocalDate's DST test.
    const beforeFallBack = new Date('2026-11-01T04:30:00Z'); // still EDT (UTC-4)
    expect(localTimeOfDay(beforeFallBack, 'America/New_York')).toEqual({ hour: 0, minute: 30 });

    const afterFallBack = new Date('2026-11-02T04:30:00Z'); // now EST (UTC-5)
    expect(localTimeOfDay(afterFallBack, 'America/New_York')).toEqual({ hour: 23, minute: 30 });
  });

  it('matches the UTC time for the UTC timezone itself, including a single-digit hour/minute', () => {
    const nowUtc = new Date('2026-08-26T08:05:00Z');
    expect(localTimeOfDay(nowUtc, 'UTC')).toEqual({ hour: 8, minute: 5 });
  });
});
