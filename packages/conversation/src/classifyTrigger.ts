import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';
import { isCorrectionText } from './correctionPattern.js';

export interface InboundSignal {
  currentState: ConversationState;
  hasText: boolean;
  hasPhoto: boolean;
  // Raw inbound text, when hasText is true — only consulted for the
  // idle-state correction-pattern check (09 §C step 9); every other branch
  // here only needs to know whether text/a photo is present, not its
  // content.
  text?: string;
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

  // Any inbound while a clarifying question (meal or correction target) is
  // outstanding resolves it — 09 §C step 8.
  if (signal.currentState === 'awaiting_clarification') {
    return 'clarification_answer';
  }

  if (signal.currentState === 'idle') {
    if (signal.hasText && signal.text !== undefined && isCorrectionText(signal.text)) {
      return 'correction';
    }
    return 'meal_content';
  }

  return 'unhandled';
}
