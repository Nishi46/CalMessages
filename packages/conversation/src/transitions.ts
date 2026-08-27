import type { MealCandidate } from '@tally/shared-types';
import type { ConversationState } from './state.js';
import type { Trigger } from './trigger.js';
import type { SideEffect } from './sideEffect.js';

export interface Transition {
  toState: ConversationState;
  sideEffects: SideEffect[];
  // Set only on the sentinel returned for an undefined {state, trigger} pair
  // (07 §D) — lets a caller like the router skip DB round-trips for a
  // message that has no defined transition yet, without re-deriving the
  // lookup-table logic to detect a no-op itself.
  isFallback?: boolean;
}

function key(fromState: ConversationState, trigger: Trigger): string {
  return `${fromState}:${trigger}`;
}

// 04 §6.1 — the new -> onboarding_q1/q2/q3 -> idle slice from Sprint 2, plus
// Sprint 4's awaiting_clarification:clarification_answer (09 §C step 12) —
// resolving a held meal candidate against the clarifying answer and writing
// the completed log. Every other {state, trigger} pair falls through to the
// fallback transition below until its own sprint wires it in.
//
// idle:meal_content and idle:correction are deliberately absent here — see
// resolveMealContentTransition and resolveCorrectionTransition below.
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
  [key('awaiting_clarification', 'clarification_answer')]: {
    toState: 'idle',
    sideEffects: [
      { type: 'writeMealLog' },
      { type: 'sendReply', template: 'meal_logged' },
    ],
  },
};

// Same state, no side effects. A miss must never throw (04 §14) — an
// undefined {state, trigger} pair is a safe no-op, not a crash.
function fallbackTransition(fromState: ConversationState): Transition {
  return { toState: fromState, sideEffects: [], isFallback: true };
}

export function resolveTransition(fromState: ConversationState, trigger: Trigger): Transition {
  return TRANSITIONS[key(fromState, trigger)] ?? fallbackTransition(fromState);
}

// idle:meal_content is the first transition whose outcome depends on
// runtime data, not just the {state, trigger} key (09 §C step 11) — a
// MealCandidate's confidence tier decides the branch, and a static lookup
// table row can't express that. The router resolves the candidate first
// (calling TextParser/VisionProvider), then calls this — instead of
// resolveTransition — to pick between the two candidate transitions below
// before calling applySideEffects.
export function resolveMealContentTransition(candidate: MealCandidate): Transition {
  if (candidate.confidence === 'low') {
    return {
      toState: 'awaiting_clarification',
      sideEffects: [
        { type: 'holdCandidate', candidate },
        {
          type: 'sendReply',
          template: 'meal_clarifying_question',
          vars: { confidenceNote: candidate.confidenceNote ?? '' },
        },
      ],
    };
  }

  return {
    toState: 'idle',
    sideEffects: [
      { type: 'writeMealLog' },
      { type: 'sendReply', template: 'meal_logged' },
    ],
  };
}

export type CorrectionMatch =
  | { kind: 'single'; targetLogId: string }
  | { kind: 'multiple'; candidateLogIds: string[] };

// idle:correction has the same runtime-data-dependent shape as
// idle:meal_content (09 §C step 13) — how many plausible correction targets
// resolveCorrectionTarget (09 §E) finds decides the branch: a single match
// writes the correction directly; more than one reuses awaiting_clarification
// as a disambiguation hold rather than adding a tenth state. The router
// resolves the match first, then calls this instead of resolveTransition for
// the correction trigger.
export function resolveCorrectionTransition(match: CorrectionMatch): Transition {
  if (match.kind === 'multiple') {
    return {
      toState: 'awaiting_clarification',
      sideEffects: [
        {
          type: 'mergeContext',
          patch: { pendingKind: 'correction_target', candidateLogIds: match.candidateLogIds },
        },
        { type: 'sendReply', template: 'correction_disambiguation' },
      ],
    };
  }

  return {
    toState: 'idle',
    sideEffects: [
      { type: 'writeCorrection', targetLogId: match.targetLogId },
      { type: 'sendReply', template: 'correction_confirmed' },
    ],
  };
}
