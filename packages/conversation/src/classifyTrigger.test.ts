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

  it('classifies inbound in states with no Sprint 4/7 wiring as unhandled', () => {
    const states: ConversationState[] = ['awaiting_checkout', 'care_pause', 'deleted'];

    for (const currentState of states) {
      expect(classifyTrigger({ currentState, hasText: true, hasPhoto: false })).toBe('unhandled');
    }
  });

  it('classifies no text and no photo as unhandled regardless of state', () => {
    expect(classifyTrigger({ currentState: 'new', hasText: false, hasPhoto: false })).toBe(
      'unhandled',
    );
  });

  it('classifies a photo or non-correction text while idle as meal_content', () => {
    expect(classifyTrigger({ currentState: 'idle', hasText: false, hasPhoto: true })).toBe(
      'meal_content',
    );
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'chicken and rice' }),
    ).toBe('meal_content');
  });

  it('classifies idle-state text matching the correction pattern as correction', () => {
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'that was actually 2 eggs' }),
    ).toBe('correction');
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'undo that' }),
    ).toBe('correction');
  });

  it('defaults ambiguous idle-state text to meal_content rather than correction', () => {
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'grilled salmon' }),
    ).toBe('meal_content');
  });

  it('classifies idle-state pause language as pause', () => {
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'pause' }),
    ).toBe('pause');
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'please stop nudges' }),
    ).toBe('pause');
  });

  it('does not classify a bare "stop" as pause — that is the carrier-level keyword (12 §C)', () => {
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'stop' }),
    ).toBe('meal_content');
  });

  it('classifies a photo or non-resume text while paused as meal_content, same as idle (12 §A step 2)', () => {
    expect(classifyTrigger({ currentState: 'paused', hasText: false, hasPhoto: true })).toBe(
      'meal_content',
    );
    expect(
      classifyTrigger({ currentState: 'paused', hasText: true, hasPhoto: false, text: 'chicken and rice' }),
    ).toBe('meal_content');
  });

  it('classifies paused-state text matching the correction pattern as correction, same as idle', () => {
    expect(
      classifyTrigger({ currentState: 'paused', hasText: true, hasPhoto: false, text: 'undo that' }),
    ).toBe('correction');
  });

  it('classifies paused-state resume language as resume', () => {
    expect(
      classifyTrigger({ currentState: 'paused', hasText: true, hasPhoto: false, text: 'resume' }),
    ).toBe('resume');
  });

  it('does not classify "pause" while already paused, or "resume" while idle', () => {
    expect(
      classifyTrigger({ currentState: 'paused', hasText: true, hasPhoto: false, text: 'pause' }),
    ).toBe('meal_content');
    expect(
      classifyTrigger({ currentState: 'idle', hasText: true, hasPhoto: false, text: 'resume' }),
    ).toBe('meal_content');
  });

  it('classifies any inbound while awaiting_clarification as clarification_answer', () => {
    expect(
      classifyTrigger({ currentState: 'awaiting_clarification', hasText: true, hasPhoto: false, text: 'it was oatmeal' }),
    ).toBe('clarification_answer');
    expect(
      classifyTrigger({ currentState: 'awaiting_clarification', hasText: false, hasPhoto: true }),
    ).toBe('clarification_answer');
  });
});
