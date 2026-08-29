import { describe, expect, it } from 'vitest';
import type { MealCandidate } from '@tally/shared-types';
import {
  resolveCorrectionTransition,
  resolveMealContentTransition,
  resolveTransition,
} from './transitions.js';
import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';

describe('resolveTransition (07 §A, breakdown steps 4-5)', () => {
  it.each([
    ['new', 'first_contact', 'onboarding_q1', ['sendReply']],
    ['onboarding_q1', 'onboarding_answer', 'onboarding_q2', ['sendReply']],
    ['onboarding_q2', 'onboarding_answer', 'onboarding_q3', ['sendReply']],
    ['onboarding_q3', 'onboarding_answer', 'idle', ['createGoal', 'sendReply']],
    ['awaiting_clarification', 'clarification_answer', 'idle', ['writeMealLog', 'sendReply']],
    ['idle', 'limit_crossed', 'awaiting_checkout', ['createCheckoutLink', 'sendReply']],
    ['awaiting_checkout', 'checkout_completed', 'idle', ['sendReply']],
    ['idle', 'pause', 'paused', ['sendReply']],
    ['paused', 'resume', 'idle', ['sendReply']],
    ['new', 'delete', 'deleted', ['sendReply']],
    ['onboarding_q1', 'delete', 'deleted', ['sendReply']],
    ['onboarding_q2', 'delete', 'deleted', ['sendReply']],
    ['onboarding_q3', 'delete', 'deleted', ['sendReply']],
    ['idle', 'delete', 'deleted', ['sendReply']],
    ['awaiting_clarification', 'delete', 'deleted', ['sendReply']],
    ['awaiting_checkout', 'delete', 'deleted', ['sendReply']],
    ['paused', 'delete', 'deleted', ['sendReply']],
    ['care_pause', 'delete', 'deleted', ['sendReply']],
    ['new', 'flagged_language', 'care_pause', ['sendReply']],
    ['onboarding_q1', 'flagged_language', 'care_pause', ['sendReply']],
    ['onboarding_q2', 'flagged_language', 'care_pause', ['sendReply']],
    ['onboarding_q3', 'flagged_language', 'care_pause', ['sendReply']],
    ['idle', 'flagged_language', 'care_pause', ['sendReply']],
    ['awaiting_clarification', 'flagged_language', 'care_pause', ['sendReply']],
    ['awaiting_checkout', 'flagged_language', 'care_pause', ['sendReply']],
    ['paused', 'flagged_language', 'care_pause', ['sendReply']],
    // A second flagged message while already in care_pause still gets the
    // caring reply again (self-transition), rather than silently no-op'ing.
    ['care_pause', 'flagged_language', 'care_pause', ['sendReply']],
  ] as const)(
    '%s + %s -> %s',
    (fromState, trigger, expectedToState, expectedEffectTypes) => {
      const transition = resolveTransition(fromState, trigger);

      expect(transition.toState).toBe(expectedToState);
      expect(transition.sideEffects.map((effect) => effect.type)).toEqual(expectedEffectTypes);
      expect(transition.isFallback).toBeFalsy();
    },
  );

  it.each([
    ['idle', 'onboarding_answer'],
    ['paused', 'first_contact'],
    ['care_pause', 'first_contact'],
    ['deleted', 'onboarding_answer'],
    ['new', 'unhandled'],
    ['idle', 'meal_content'],
    ['idle', 'correction'],
    ['paused', 'pause'],
    ['idle', 'resume'],
    ['deleted', 'delete'],
    ['deleted', 'first_contact'],
    ['deleted', 'meal_content'],
    ['deleted', 'flagged_language'],
  ] as const)('%s + %s falls back to a same-state no-op instead of throwing', (fromState, trigger) => {
    expect(() => resolveTransition(fromState, trigger)).not.toThrow();

    const transition = resolveTransition(fromState, trigger);
    expect(transition.toState).toBe(fromState);
    expect(transition.sideEffects).toEqual([]);
    expect(transition.isFallback).toBe(true);
  });

  it('covers every ConversationState/Trigger combination without throwing', () => {
    const states: ConversationState[] = [
      'new',
      'onboarding_q1',
      'onboarding_q2',
      'onboarding_q3',
      'idle',
      'awaiting_clarification',
      'awaiting_checkout',
      'paused',
      'care_pause',
      'deleted',
    ];
    const triggers: Trigger[] = [
      'first_contact',
      'onboarding_answer',
      'meal_content',
      'clarification_answer',
      'correction',
      'limit_crossed',
      'checkout_completed',
      'pause',
      'resume',
      'delete',
      'flagged_language',
      'unhandled',
    ];

    for (const state of states) {
      for (const trigger of triggers) {
        expect(() => resolveTransition(state, trigger)).not.toThrow();
      }
    }
  });

  // 12 §B step 5: "confirm resolveTransition falls through to the safe
  // fallback for every trigger once a user is deleted" — deleted is
  // terminal, so unlike every other state, no trigger (not even 'delete'
  // itself) transitions out of it.
  it('deleted is terminal: every trigger falls back to a same-state no-op', () => {
    const triggers: Trigger[] = [
      'first_contact',
      'onboarding_answer',
      'meal_content',
      'clarification_answer',
      'correction',
      'limit_crossed',
      'checkout_completed',
      'pause',
      'resume',
      'delete',
      'flagged_language',
      'unhandled',
    ];

    for (const trigger of triggers) {
      const transition = resolveTransition('deleted', trigger);
      expect(transition.toState).toBe('deleted');
      expect(transition.sideEffects).toEqual([]);
      expect(transition.isFallback).toBe(true);
    }
  });

  // 12 §E step 16 (04 §11: "not a bug to auto-heal"): no trigger returns a
  // flagged user to normal operation automatically — the only state a
  // trigger can move a care_pause user *to* is 'care_pause' itself (a
  // self-loop, e.g. a second flagged message or ordinary meal-logging text)
  // or 'deleted' (delete is a deliberate account-termination action, not a
  // return to normal — it's excluded from "back to normal" by definition,
  // not an oversight in this test). Nothing here builds the admin/dashboard
  // tooling step 16 notes doesn't exist yet — this only confirms the gap is
  // real and total: no keyword, no timer, no lookup-table row gets a
  // care_pause user back to 'idle'.
  it('care_pause never auto-exits back to normal operation, for any trigger', () => {
    const triggers: Trigger[] = [
      'first_contact',
      'onboarding_answer',
      'meal_content',
      'clarification_answer',
      'correction',
      'limit_crossed',
      'checkout_completed',
      'pause',
      'resume',
      'delete',
      'flagged_language',
      'unhandled',
    ];

    for (const trigger of triggers) {
      const transition = resolveTransition('care_pause', trigger);
      expect(['care_pause', 'deleted']).toContain(transition.toState);
    }
  });
});

describe('resolveMealContentTransition (09 §C, breakdown step 11)', () => {
  function candidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
    return {
      items: [{ name: 'eggs', portion: '3', calories: 210, protein: 18, carbs: 2, fat: 15 }],
      calories: 210,
      protein: 18,
      carbs: 2,
      fat: 15,
      confidence: 'high',
      isFood: true,
      ...overrides,
    };
  }

  it.each(['high', 'medium'] as const)(
    'stays idle and writes the meal log on %s confidence',
    (confidence) => {
      const transition = resolveMealContentTransition(candidate({ confidence }));

      expect(transition.toState).toBe('idle');
      expect(transition.sideEffects).toEqual([
        { type: 'writeMealLog' },
        { type: 'sendReply', template: 'meal_logged' },
      ]);
    },
  );

  it('holds the candidate and asks a clarifying question on low confidence, prefixing a real note with " — "', () => {
    const low = candidate({ confidence: 'low', confidenceNote: 'couldn\'t tell the portion size' });

    const transition = resolveMealContentTransition(low);

    expect(transition.toState).toBe('awaiting_clarification');
    expect(transition.sideEffects).toEqual([
      { type: 'holdCandidate', candidate: low },
      {
        type: 'sendReply',
        template: 'meal_clarifying_question',
        vars: { confidenceNote: " — couldn't tell the portion size" },
      },
    ]);
  });

  it('defaults confidenceNote to an empty string when the candidate has none', () => {
    const transition = resolveMealContentTransition(candidate({ confidence: 'low' }));

    expect(transition.sideEffects[1]).toEqual({
      type: 'sendReply',
      template: 'meal_clarifying_question',
      vars: { confidenceNote: '' },
    });
  });

  it('returns to paused, not idle, on high/medium confidence when fromState is paused (12 §A step 2)', () => {
    const transition = resolveMealContentTransition(candidate({ confidence: 'medium' }), 'paused');

    expect(transition.toState).toBe('paused');
    expect(transition.sideEffects).toEqual([
      { type: 'writeMealLog' },
      { type: 'sendReply', template: 'meal_logged' },
    ]);
  });

  it('still holds for a clarifying question on low confidence when fromState is paused', () => {
    const transition = resolveMealContentTransition(candidate({ confidence: 'low' }), 'paused');

    expect(transition.toState).toBe('awaiting_clarification');
  });

  // 12 §E step 15: logs silently (writeMealLog still fires), but the reply
  // never surfaces macros — care_pause_logged instead of meal_logged.
  it('returns to care_pause and swaps to the non-macro reply on high/medium confidence when fromState is care_pause', () => {
    const transition = resolveMealContentTransition(candidate({ confidence: 'high' }), 'care_pause');

    expect(transition.toState).toBe('care_pause');
    expect(transition.sideEffects).toEqual([
      { type: 'writeMealLog' },
      { type: 'sendReply', template: 'care_pause_logged' },
    ]);
  });

  it('still holds for the (already macro-free) clarifying question on low confidence when fromState is care_pause', () => {
    const transition = resolveMealContentTransition(candidate({ confidence: 'low' }), 'care_pause');

    expect(transition.toState).toBe('awaiting_clarification');
    expect(transition.sideEffects[1]).toMatchObject({ template: 'meal_clarifying_question' });
  });
});

describe('resolveCorrectionTransition (09 §C, breakdown step 13)', () => {
  it('writes the correction and stays idle for a single match', () => {
    const transition = resolveCorrectionTransition({ kind: 'single', targetLogId: 'log-1' });

    expect(transition.toState).toBe('idle');
    expect(transition.sideEffects).toEqual([
      { type: 'writeCorrection', targetLogId: 'log-1' },
      { type: 'sendReply', template: 'correction_confirmed' },
    ]);
  });

  it('holds a disambiguation context (intent: correct, by default) and asks which entry, for multiple matches', () => {
    const transition = resolveCorrectionTransition({
      kind: 'multiple',
      candidateLogIds: ['log-1', 'log-2'],
    });

    expect(transition.toState).toBe('awaiting_clarification');
    expect(transition.sideEffects).toEqual([
      {
        type: 'mergeContext',
        patch: { pendingKind: 'correction_target', candidateLogIds: ['log-1', 'log-2'], intent: 'correct' },
      },
      { type: 'sendReply', template: 'correction_disambiguation' },
    ]);
  });
});

describe('resolveCorrectionTransition — delete intent (09 §E, breakdown step 23)', () => {
  it('deletes the log and stays idle for a single match', () => {
    const transition = resolveCorrectionTransition({ kind: 'single', targetLogId: 'log-1' }, 'delete');

    expect(transition.toState).toBe('idle');
    expect(transition.sideEffects).toEqual([
      { type: 'deleteMealLog', targetLogId: 'log-1' },
      { type: 'sendReply', template: 'delete_confirmed' },
    ]);
  });

  it('tags the disambiguation hold with intent: delete, for multiple matches', () => {
    const transition = resolveCorrectionTransition(
      { kind: 'multiple', candidateLogIds: ['log-1', 'log-2'] },
      'delete',
    );

    expect(transition.toState).toBe('awaiting_clarification');
    expect(transition.sideEffects[0]).toEqual({
      type: 'mergeContext',
      patch: { pendingKind: 'correction_target', candidateLogIds: ['log-1', 'log-2'], intent: 'delete' },
    });
  });
});

describe('resolveCorrectionTransition — paused fromState (12 §A step 2)', () => {
  it('returns to paused, not idle, on a single-match correction', () => {
    const transition = resolveCorrectionTransition({ kind: 'single', targetLogId: 'log-1' }, 'correct', 'paused');

    expect(transition.toState).toBe('paused');
  });

  it('returns to paused, not idle, on a single-match delete', () => {
    const transition = resolveCorrectionTransition({ kind: 'single', targetLogId: 'log-1' }, 'delete', 'paused');

    expect(transition.toState).toBe('paused');
  });
});

describe('resolveCorrectionTransition — care_pause fromState (12 §E step 15)', () => {
  it('returns to care_pause and swaps to the non-macro reply on a single-match correction', () => {
    const transition = resolveCorrectionTransition(
      { kind: 'single', targetLogId: 'log-1' },
      'correct',
      'care_pause',
    );

    expect(transition.toState).toBe('care_pause');
    expect(transition.sideEffects).toEqual([
      { type: 'writeCorrection', targetLogId: 'log-1' },
      { type: 'sendReply', template: 'care_pause_logged' },
    ]);
  });

  it('returns to care_pause and swaps to the non-macro reply on a single-match delete', () => {
    const transition = resolveCorrectionTransition(
      { kind: 'single', targetLogId: 'log-1' },
      'delete',
      'care_pause',
    );

    expect(transition.toState).toBe('care_pause');
    expect(transition.sideEffects).toEqual([
      { type: 'deleteMealLog', targetLogId: 'log-1' },
      { type: 'sendReply', template: 'care_pause_logged' },
    ]);
  });

  it('still holds for the (already macro-free) disambiguation question on multiple matches', () => {
    const transition = resolveCorrectionTransition(
      { kind: 'multiple', candidateLogIds: ['log-1', 'log-2'] },
      'correct',
      'care_pause',
    );

    expect(transition.toState).toBe('awaiting_clarification');
    expect(transition.sideEffects[1]).toEqual({
      type: 'sendReply',
      template: 'correction_disambiguation',
    });
  });
});
