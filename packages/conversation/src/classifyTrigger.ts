import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';
import { isCorrectionText } from './correctionPattern.js';
import { isPauseText, isResumeText } from './pausePattern.js';
import { isDeleteAccountText } from './deleteAccountPattern.js';

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

  // 12 §B step 5: checked ahead of every state-specific branch below — a
  // data-deletion request has to work "from any state" (04 §6.1), including
  // mid-onboarding or mid-clarification, not just from idle.
  if (signal.hasText && signal.text !== undefined && isDeleteAccountText(signal.text)) {
    return 'delete';
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

  // idle and paused are both logging-capable (12 §A step 2: "logging still
  // works if the user texts in" while paused) — pause/resume are only
  // checked in the one direction each can actually fire from, ahead of the
  // correction/meal_content checks both states otherwise share.
  if (signal.currentState === 'idle' || signal.currentState === 'paused') {
    if (signal.hasText && signal.text !== undefined) {
      if (signal.currentState === 'idle' && isPauseText(signal.text)) {
        return 'pause';
      }
      if (signal.currentState === 'paused' && isResumeText(signal.text)) {
        return 'resume';
      }
      if (isCorrectionText(signal.text)) {
        return 'correction';
      }
    }
    return 'meal_content';
  }

  return 'unhandled';
}
