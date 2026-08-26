import { describe, expect, it } from 'vitest';
import {
  captureGoalAnswer,
  captureReferralAnswer,
  captureStartingPointAnswer,
} from './onboardingAnswers.js';

describe('captureGoalAnswer (07 §B, breakdown step 7)', () => {
  it.each([
    ['lose weight, on a glp1', 'lose'],
    ['I want to gain some muscle', 'gain'],
    ['just hit a protein number', 'protein_only'],
    ['maintaining for now', 'maintain'],
  ] as const)('maps %j to goalType %s', (rawText, goalType) => {
    expect(captureGoalAnswer(rawText)).toEqual({ goalType, rawGoalAnswer: rawText });
  });

  it('defaults to maintain on an unparseable answer rather than blocking', () => {
    expect(captureGoalAnswer('not sure, whatever works')).toEqual({
      goalType: 'maintain',
      rawGoalAnswer: 'not sure, whatever works',
    });
  });
});

describe('captureStartingPointAnswer (07 §B, breakdown step 8)', () => {
  it('stores the raw text verbatim with no parsing', () => {
    expect(captureStartingPointAnswer('190lbs, no target given')).toEqual({
      rawStartingPoint: '190lbs, no target given',
    });
  });
});

describe('captureReferralAnswer (07 §B, breakdown step 9)', () => {
  it('captures a referral code verbatim', () => {
    expect(captureReferralAnswer('coach-jamie-123')).toEqual({ rawReferral: 'coach-jamie-123' });
  });

  it('treats blank input as organic signup, never a gate', () => {
    expect(captureReferralAnswer('')).toEqual({ rawReferral: null });
    expect(captureReferralAnswer('   ')).toEqual({ rawReferral: null });
  });
});
