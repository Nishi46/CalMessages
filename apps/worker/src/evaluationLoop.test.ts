import { describe, expect, it } from 'vitest';
import { shouldSkipForDisengagement } from './evaluationLoop.js';

describe('shouldSkipForDisengagement (09 breakdown §C step 12, placeholder 1-in-3 ratio)', () => {
  it('does not apply the reduction for the never-logged sentinel', () => {
    // daysSinceLastLog's sentinel for "never logged" is null, not Infinity —
    // treated the same as "below threshold" here, since a brand-new user
    // with no history yet isn't the "went quiet after logging" case this
    // rule targets.
    expect(shouldSkipForDisengagement(null)).toBe(false);
  });

  it('never applies the reduction below the 5-day threshold', () => {
    expect(shouldSkipForDisengagement(0)).toBe(false);
    expect(shouldSkipForDisengagement(4)).toBe(false);
  });

  it('applies a fixed 1-in-3 ratio once at or past the threshold', () => {
    expect(shouldSkipForDisengagement(5)).toBe(true);
    expect(shouldSkipForDisengagement(6)).toBe(false);
    expect(shouldSkipForDisengagement(7)).toBe(true);
    expect(shouldSkipForDisengagement(8)).toBe(true);
    expect(shouldSkipForDisengagement(9)).toBe(false);
  });

  it('never produces a higher send rate for a more-disengaged user than a less-disengaged one', () => {
    const daysToCheck = Array.from({ length: 100 }, (_, i) => i);
    const sendRate = (values: number[]) => values.filter((d) => !shouldSkipForDisengagement(d)).length / values.length;

    const justOverThreshold = daysToCheck.filter((d) => d >= 5 && d < 35);
    const deeplyDisengaged = daysToCheck.filter((d) => d >= 65 && d < 95);

    expect(sendRate(deeplyDisengaged)).toBeLessThanOrEqual(sendRate(justOverThreshold));
  });
});
