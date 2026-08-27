import { describe, expect, it } from 'vitest';
import { addDaysToLocalDate, weekdayOfLocalDate } from './localDateArithmetic.js';

describe('addDaysToLocalDate', () => {
  it('subtracts a day within the same month', () => {
    expect(addDaysToLocalDate('2026-08-27', -1)).toBe('2026-08-26');
  });

  it('crosses a month boundary', () => {
    expect(addDaysToLocalDate('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    expect(addDaysToLocalDate('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('adds forward too', () => {
    expect(addDaysToLocalDate('2026-08-27', 3)).toBe('2026-08-30');
  });
});

describe('weekdayOfLocalDate', () => {
  it.each([
    ['2026-08-23', 0], // Sunday
    ['2026-08-24', 1], // Monday
    ['2026-08-27', 4], // Thursday
    ['2026-08-29', 6], // Saturday
  ])('%s is weekday %i', (localDate, expected) => {
    expect(weekdayOfLocalDate(localDate)).toBe(expected);
  });
});
