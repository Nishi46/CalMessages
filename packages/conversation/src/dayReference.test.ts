import { describe, expect, it } from 'vitest';
import { parseDayReference } from './dayReference.js';

describe('parseDayReference (09 §E, breakdown step 21)', () => {
  it('recognizes "yesterday"', () => {
    expect(parseDayReference("that was actually yesterday's lunch")).toEqual({ kind: 'yesterday' });
  });

  it.each([
    ['it was monday', 1],
    ['on Tuesday I had eggs', 2],
    ['sunday brunch, not today', 0],
  ])('recognizes a weekday name: %s', (text, weekday) => {
    expect(parseDayReference(text)).toEqual({ kind: 'weekday', weekday });
  });

  it('returns null with no explicit day reference, defaulting callers to same-day', () => {
    expect(parseDayReference('that was actually 2 eggs not 3')).toBeNull();
    expect(parseDayReference('delete that')).toBeNull();
  });
});
