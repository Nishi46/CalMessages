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
// resolveMealContentTransition and resolveCorrectionTransition below. So are
// paused:meal_content and paused:correction, for the same reason (12 §A step
// 2) — the router calls those same two functions with fromState: 'paused'
// instead of adding a second, duplicated set of runtime-dependent branches.
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
  // 11 breakdown §B step 9: fired by billing logic after a meal-log write
  // crosses the free-tier limit — always from 'idle', since every write path
  // (fast meal_content and the clarification-answer completion above) lands
  // in 'idle' before this second-stage transition is even considered.
  // createCheckoutLink runs first so its {checkoutLink} result is available
  // to the sendReply that follows (11 breakdown §C step 11).
  [key('idle', 'limit_crossed')]: {
    toState: 'awaiting_checkout',
    sideEffects: [{ type: 'createCheckoutLink' }, { type: 'sendReply', template: 'paywall' }],
  },
  // 11 breakdown §C step 13: fired by the Stripe webhook handler once
  // checkout.session.completed resolves which user just paid — same
  // synthetic-trigger route as limit_crossed above, for the same reason.
  [key('awaiting_checkout', 'checkout_completed')]: {
    toState: 'idle',
    sideEffects: [{ type: 'sendReply', template: 'checkout_confirmed' }],
  },
  // 12 §A step 1 (Build Spec §4.7): app-level pause, distinct from carrier
  // STOP (12 §C). paused_at itself is stamped by the router alongside this
  // transition's updateUserState call, not by a side effect — no side effect
  // type currently expresses "also write a column" (12 §A step 4).
  [key('idle', 'pause')]: {
    toState: 'paused',
    sideEffects: [{ type: 'sendReply', template: 'pause_confirmed' }],
  },
  [key('paused', 'resume')]: {
    toState: 'idle',
    sideEffects: [{ type: 'sendReply', template: 'resume_confirmed' }],
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
//
// fromState (12 §A step 2) is the "return to idle" default's paused
// counterpart — a paused user's meal-logging turn has to land back in
// 'paused', not 'idle', or the very next inbound message would misclassify
// against the wrong state. Only the direct-write branch below is affected;
// a low-confidence hold always goes to awaiting_clarification regardless of
// where it started, same as idle.
export function resolveMealContentTransition(
  candidate: MealCandidate,
  fromState: ConversationState = 'idle',
): Transition {
  if (candidate.confidence === 'low') {
    // No vision/text producer currently populates confidenceNote (09 §F
    // step 25: "where available") — the template's own {confidenceNote}
    // placeholder expects a leading " — " separator, supplied here only
    // when there's a real note, so the reply still reads as one clean
    // sentence when there isn't: "Got a partial read. What was it,
    // roughly?" vs "...read — couldn't tell the portion size. What...".
    const confidenceNote = candidate.confidenceNote ? ` — ${candidate.confidenceNote}` : '';
    return {
      toState: 'awaiting_clarification',
      sideEffects: [
        { type: 'holdCandidate', candidate },
        {
          type: 'sendReply',
          template: 'meal_clarifying_question',
          vars: { confidenceNote },
        },
      ],
    };
  }

  return {
    toState: fromState,
    sideEffects: [
      { type: 'writeMealLog' },
      { type: 'sendReply', template: 'meal_logged' },
    ],
  };
}

export type CorrectionMatch =
  | { kind: 'single'; targetLogId: string }
  | { kind: 'multiple'; candidateLogIds: string[] };

// "Delete that" with no replacement value resolves the same way as a
// value-replacement correction, but writes a delete instead (09 §E step
// 23) — the intent is captured in the disambiguation hold too (via
// PendingContext), since it's only known here and would otherwise be lost
// by the time an answer resolves which log was meant.
export type CorrectionIntent = 'correct' | 'delete';

// idle:correction has the same runtime-data-dependent shape as
// idle:meal_content (09 §C step 13) — how many plausible correction targets
// resolveCorrectionTarget (09 §E) finds decides the branch: a single match
// writes the correction (or delete) directly; more than one reuses
// awaiting_clarification as a disambiguation hold rather than adding a
// tenth state. The router resolves the match first, then calls this
// instead of resolveTransition for the correction trigger.
//
// fromState (12 §A step 2) mirrors resolveMealContentTransition's — a
// paused user correcting/deleting a log returns to 'paused', not 'idle'.
export function resolveCorrectionTransition(
  match: CorrectionMatch,
  intent: CorrectionIntent = 'correct',
  fromState: ConversationState = 'idle',
): Transition {
  if (match.kind === 'multiple') {
    return {
      toState: 'awaiting_clarification',
      sideEffects: [
        {
          type: 'mergeContext',
          patch: { pendingKind: 'correction_target', candidateLogIds: match.candidateLogIds, intent },
        },
        { type: 'sendReply', template: 'correction_disambiguation' },
      ],
    };
  }

  if (intent === 'delete') {
    return {
      toState: fromState,
      sideEffects: [
        { type: 'deleteMealLog', targetLogId: match.targetLogId },
        { type: 'sendReply', template: 'delete_confirmed' },
      ],
    };
  }

  return {
    toState: fromState,
    sideEffects: [
      { type: 'writeCorrection', targetLogId: match.targetLogId },
      { type: 'sendReply', template: 'correction_confirmed' },
    ],
  };
}
