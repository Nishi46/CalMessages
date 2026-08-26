import { describe, expect, it } from 'vitest';
import { classifyTrigger } from './classifyTrigger.js';
import type { ConversationState } from './state.js';

describe('classifyTrigger (07 §B, breakdown step 6)', () => {
  it('classifies a text or photo from a new user as first_contact', () => {
    expect(classifyTrigger({ currentState: 'new', hasText: true, hasPhoto: false })).toBe(
      'first_contact',
    );
    expect(classifyTrigger({ currentState: 'new', hasText: false, hasPhoto: true })).toBe(
      'first_contact',
    );
  });

  it.each(['onboarding_q1', 'onboarding_q2', 'onboarding_q3'] as const)(
    'classifies any inbound during %s as onboarding_answer',
    (currentState) => {
      expect(classifyTrigger({ currentState, hasText: true, hasPhoto: false })).toBe(
        'onboarding_answer',
      );
      expect(classifyTrigger({ currentState, hasText: false, hasPhoto: true })).toBe(
        'onboarding_answer',
      );
    },
  );

  it('classifies inbound in every other state as unhandled', () => {
    const states: ConversationState[] = [
      'idle',
      'awaiting_clarification',
      'awaiting_checkout',
      'paused',
      'care_pause',
      'deleted',
    ];

    for (const currentState of states) {
      expect(classifyTrigger({ currentState, hasText: true, hasPhoto: false })).toBe('unhandled');
    }
  });

  it('classifies no text and no photo as unhandled regardless of state', () => {
    expect(classifyTrigger({ currentState: 'new', hasText: false, hasPhoto: false })).toBe(
      'unhandled',
    );
  });
});
