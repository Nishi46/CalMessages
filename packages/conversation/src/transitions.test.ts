import { describe, expect, it } from 'vitest';
import { resolveTransition } from './transitions.js';
import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';

describe('resolveTransition (07 §A, breakdown steps 4-5)', () => {
  it.each([
    ['new', 'first_contact', 'onboarding_q1', ['sendReply']],
    ['onboarding_q1', 'onboarding_answer', 'onboarding_q2', ['sendReply']],
    ['onboarding_q2', 'onboarding_answer', 'onboarding_q3', ['sendReply']],
    ['onboarding_q3', 'onboarding_answer', 'idle', ['createGoal', 'sendReply']],
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
    const triggers: Trigger[] = ['first_contact', 'onboarding_answer', 'unhandled'];

    for (const state of states) {
      for (const trigger of triggers) {
        expect(() => resolveTransition(state, trigger)).not.toThrow();
      }
    }
  });
});
