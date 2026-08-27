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
      'unhandled',
    ];

    for (const state of states) {
      for (const trigger of triggers) {
        expect(() => resolveTransition(state, trigger)).not.toThrow();
      }
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
