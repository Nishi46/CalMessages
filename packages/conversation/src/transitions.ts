import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';
import type { SideEffect } from './sideEffect.js';

export interface Transition {
  toState: ConversationState;
  sideEffects: SideEffect[];
}

function key(fromState: ConversationState, trigger: Trigger): string {
  return `${fromState}:${trigger}`;
}

// 04 §6.1 — only the new -> onboarding_q1/q2/q3 -> idle slice named in the
// Sprint Plan's Sprint 2 Ships column. Every other {state, trigger} pair
// (including every pair involving awaiting_clarification, awaiting_checkout,
// paused, care_pause, or deleted) falls through to the fallback transition
// below until its own sprint wires it in.
const TRANSITIONS: Record<string, Transition> = {
  [key('new', 'first_contact')]: {
    toState: 'onboarding_q1',
    sideEffects: [{ type: 'sendReply', template: 'onboarding_welcome_q1' }],
  },
  [key('onboarding_q1', 'onboarding_answer')]: {
    toState: 'onboarding_q2',
    sideEffects: [{ type: 'sendReply', template: 'onboarding_q2' }],
  },
  [key('onboarding_q2', 'onboarding_answer')]: {
    toState: 'onboarding_q3',
    sideEffects: [{ type: 'sendReply', template: 'onboarding_q3' }],
  },
  [key('onboarding_q3', 'onboarding_answer')]: {
    toState: 'idle',
    sideEffects: [
      { type: 'createGoal' },
      { type: 'sendReply', template: 'onboarding_goal_confirmation' },
    ],
  },
};

// Same state, no side effects. A miss must never throw (04 §14) — an
// undefined {state, trigger} pair is a safe no-op, not a crash.
function fallbackTransition(fromState: ConversationState): Transition {
  return { toState: fromState, sideEffects: [] };
}

export function resolveTransition(fromState: ConversationState, trigger: Trigger): Transition {
  return TRANSITIONS[key(fromState, trigger)] ?? fallbackTransition(fromState);
}
