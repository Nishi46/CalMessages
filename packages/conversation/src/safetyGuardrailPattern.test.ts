import { describe, expect, it } from 'vitest';
import { isFlaggedLanguage } from './safetyGuardrailPattern.js';

// 12 §D step 12: NOT PRODUCT-REVIEWED — see the disclaimer atop
// safetyGuardrailPattern.ts. These tests lock in the placeholder list's
// current behavior so a future review has a documented starting point to
// change deliberately, not a guarantee that this list is clinically correct.
describe('isFlaggedLanguage (12 §D, breakdown step 12 — NOT PRODUCT-REVIEWED)', () => {
  it.each([
    'I want to kill myself',
    'thinking about suicide',
    'I am suicidal',
    'I want to die',
    'planning to end my life',
    'I keep thinking about self-harm',
    'I want to self harm',
    "life feels not worth living",
    'I would be better off dead',
  ])('matches %s', (text) => {
    expect(isFlaggedLanguage(text)).toBe(true);
  });

  it.each(['grilled salmon and rice', 'undo that', 'pause', 'delete my data', 'resume'])(
    'does not match ordinary conversation text like %s',
    (text) => {
      expect(isFlaggedLanguage(text)).toBe(false);
    },
  );

  it('deliberately over-fires on hyperbole, per 04 §11\'s high false-positive tolerance', () => {
    // Documents the accepted cost, not a bug — "this diet is killing me"
    // legitimately matches nothing here since it doesn't contain "myself",
    // but a closer phrase like "I could just kill myself over this diet"
    // does, and that's intentional per the file's own disclaimer.
    expect(isFlaggedLanguage('I could just kill myself over this diet')).toBe(true);
  });
});
