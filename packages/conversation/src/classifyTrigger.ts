import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';

export interface InboundSignal {
  currentState: ConversationState;
  hasText: boolean;
  hasPhoto: boolean;
}

// No general-purpose NLU — the router matches inbound intent against current
// state, not an intent classifier layered on top (04 §6.1). This sprint only
// needs to tell "is this the first message" from "is this an onboarding
// answer" from "everything else."
//
// A photo arriving mid-onboarding classifies as onboarding_answer for now,
// not the "log the meal anyway" fast path from Build Spec §4.1's edge case —
// that path needs the meal-logging pipeline, which lands in Sprint 4.
const ONBOARDING_STATES: ConversationState[] = ['onboarding_q1', 'onboarding_q2', 'onboarding_q3'];

export function classifyTrigger(signal: InboundSignal): Trigger {
  if (!signal.hasText && !signal.hasPhoto) {
    return 'unhandled';
  }

  if (signal.currentState === 'new') {
    return 'first_contact';
  }

  if (ONBOARDING_STATES.includes(signal.currentState)) {
    return 'onboarding_answer';
  }

  return 'unhandled';
}
