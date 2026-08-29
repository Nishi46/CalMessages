import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';
import { isCorrectionText } from './correctionPattern.js';
import { isPauseText, isResumeText } from './pausePattern.js';
import { isDeleteAccountText } from './deleteAccountPattern.js';
import { isFlaggedLanguage } from './safetyGuardrailPattern.js';

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

  // 12 §D step 13: "Any state, on flagged language" pre-empts every other
  // branch below, including delete — checked first of all of them, not just
  // ahead of the state-specific ones. Safety outranks every other intent a
  // message could otherwise be classified as.
  if (signal.hasText && signal.text !== undefined && isFlaggedLanguage(signal.text)) {
    return 'flagged_language';
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

  // idle, paused, and care_pause are all logging-capable (12 §A step 2:
  // "logging still works if the user texts in" while paused; 12 §E step 15:
  // meal-logging triggers still fire while in care_pause, just with a
  // different reply — see resolveMealContentTransition/
  // resolveCorrectionTransition). pause/resume are only checked in the one
  // direction each can actually fire from — care_pause matches neither, on
  // purpose: it's "not auto-exited by any timer or keyword" (12 §E step 16),
  // so texting "resume" here falls through to meal_content like any other
  // non-food text, rather than a state-machine row existing to catch it.
  if (
    signal.currentState === 'idle' ||
    signal.currentState === 'paused' ||
    signal.currentState === 'care_pause'
  ) {
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
