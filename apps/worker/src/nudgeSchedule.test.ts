import { describe, expect, it } from 'vitest';
import { isWithinNudgeWindow, isWithinQuietHours } from './nudgeSchedule.js';

describe('isWithinNudgeWindow (09 breakdown §B step 6, placeholder ~8pm default)', () => {
  it('is false before the window opens', () => {
    expect(isWithinNudgeWindow({ hour: 19, minute: 59 })).toBe(false);
  });

  it('is true at the exact start of the window (inclusive)', () => {
    expect(isWithinNudgeWindow({ hour: 20, minute: 0 })).toBe(true);
  });

  it('is true one minute before the window closes', () => {
    expect(isWithinNudgeWindow({ hour: 20, minute: 29 })).toBe(true);
  });

  it('is false at the exact end of the window (exclusive)', () => {
    expect(isWithinNudgeWindow({ hour: 20, minute: 30 })).toBe(false);
  });
});

describe('isWithinQuietHours (wraps past midnight, e.g. 22:00 -> 08:00)', () => {
  it('is false just before quiet hours start', () => {
    expect(isWithinQuietHours({ hour: 21, minute: 59 })).toBe(false);
  });

  it('is true at the exact start of quiet hours (inclusive)', () => {
    expect(isWithinQuietHours({ hour: 22, minute: 0 })).toBe(true);
  });

  it('is true in the middle of the night, after midnight', () => {
    expect(isWithinQuietHours({ hour: 3, minute: 0 })).toBe(true);
  });

  it('is true one minute before quiet hours end', () => {
    expect(isWithinQuietHours({ hour: 7, minute: 59 })).toBe(true);
  });

  it('is false at the exact end of quiet hours (exclusive)', () => {
    expect(isWithinQuietHours({ hour: 8, minute: 0 })).toBe(false);
  });

  it('is false in the middle of the day', () => {
    expect(isWithinQuietHours({ hour: 14, minute: 0 })).toBe(false);
  });
});
