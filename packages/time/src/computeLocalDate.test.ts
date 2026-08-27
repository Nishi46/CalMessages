import { describe, expect, it } from 'vitest';
import { computeLocalDate } from './computeLocalDate.js';

describe('computeLocalDate', () => {
  it('rolls back to the prior day for a timezone behind UTC, just after local midnight', () => {
    // 2026-08-27T03:30:00Z is 2026-08-26T23:30 in America/New_York (EDT, UTC-4).
    const nowUtc = new Date('2026-08-27T03:30:00Z');
    expect(computeLocalDate(nowUtc, 'America/New_York')).toBe('2026-08-26');
  });

  it('rolls forward to the next day for a timezone ahead of UTC, just after local midnight', () => {
    // 2026-08-26T20:00:00Z is 2026-08-27T05:00 in Asia/Tokyo (UTC+9) — a day
    // later than the UTC calendar date, proving this isn't naive UTC truncation.
    const nowUtc = new Date('2026-08-26T20:00:00Z');
    expect(computeLocalDate(nowUtc, 'Asia/Tokyo')).toBe('2026-08-27');
  });

  it('stays on the same local day just before local midnight, then rolls over a minute later', () => {
    // 2026-08-27T03:59:00Z is 2026-08-26T23:59 in America/New_York (EDT, UTC-4).
    const nowUtc = new Date('2026-08-27T03:59:00Z');
    expect(computeLocalDate(nowUtc, 'America/New_York')).toBe('2026-08-26');

    // One minute later — 2026-08-27T00:00 local — the day rolls over.
    const oneMinuteLater = new Date('2026-08-27T04:00:00Z');
    expect(computeLocalDate(oneMinuteLater, 'America/New_York')).toBe('2026-08-27');
  });

  it('resolves the correct local date across a DST transition, per the UTC offset in effect that day', () => {
    // Same wall-clock UTC time, either side of America/New_York's Nov 2026
    // fall-back (EDT UTC-4 -> EST UTC-5) — the real-tz-library requirement
    // this step calls out, since fixed offset math would get one of these wrong.
    const beforeFallBack = new Date('2026-11-01T04:30:00Z'); // still EDT (UTC-4)
    expect(computeLocalDate(beforeFallBack, 'America/New_York')).toBe('2026-11-01');

    const afterFallBack = new Date('2026-11-02T04:30:00Z'); // now EST (UTC-5)
    expect(computeLocalDate(afterFallBack, 'America/New_York')).toBe('2026-11-01');
  });

  it('matches the UTC date for the UTC timezone itself', () => {
    const nowUtc = new Date('2026-08-26T23:59:00Z');
    expect(computeLocalDate(nowUtc, 'UTC')).toBe('2026-08-26');
  });
});
