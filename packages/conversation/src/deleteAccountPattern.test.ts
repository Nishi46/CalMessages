import { describe, expect, it } from 'vitest';
import { isDeleteAccountText } from './deleteAccountPattern.js';

describe('isDeleteAccountText (12 §B, breakdown step 5)', () => {
  it.each([
    'delete my data',
    'please delete my data',
    'delete my account',
    'delete my information',
    'delete all my data',
    'erase my data',
    'remove my account',
  ])('matches %s', (text) => {
    expect(isDeleteAccountText(text)).toBe(true);
  });

  it('does not match "delete that" — the single-meal-log correction phrase (09 §E), not account deletion', () => {
    expect(isDeleteAccountText('delete that')).toBe(false);
    expect(isDeleteAccountText('delete that entry please')).toBe(false);
  });

  it.each(['grilled salmon and rice', 'undo that', 'pause', 'resume'])(
    'does not match %s',
    (text) => {
      expect(isDeleteAccountText(text)).toBe(false);
    },
  );
});
