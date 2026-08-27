import { describe, expect, it } from 'vitest';
import { isCorrectionText, isDeleteText } from './correctionPattern.js';

describe('isCorrectionText (09 §C, breakdown step 9)', () => {
  it.each([
    'that was actually 2 eggs not 3',
    'actually it had cheese too',
    'undo that',
    'delete that',
    'no it was chicken',
    'no, it was chicken',
  ])('matches %s', (text) => {
    expect(isCorrectionText(text)).toBe(true);
  });

  it.each(['grilled salmon and rice', 'two eggs and toast', 'oatmeal with berries'])(
    'does not match a plain meal description like %s',
    (text) => {
      expect(isCorrectionText(text)).toBe(false);
    },
  );
});

describe('isDeleteText (09 §E, breakdown step 23)', () => {
  it.each(['delete that', 'undo that', 'please undo'])('matches %s', (text) => {
    expect(isDeleteText(text)).toBe(true);
  });

  it('does not match a value-replacement correction', () => {
    expect(isDeleteText('that was actually 2 eggs not 3')).toBe(false);
    expect(isDeleteText('no it was chicken')).toBe(false);
  });
});
