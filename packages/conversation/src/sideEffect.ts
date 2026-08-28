import type { MealCandidate } from '@tally/shared-types';
import type { TemplateId } from './templates.js';

// Side effects are pure data attached to a transition, not executed inline —
// that's what keeps the lookup table itself testable without mocking I/O
// (04 §14). applySideEffects (07 §C) is what actually sends replies / writes
// to Postgres; this type only describes what a transition intends to happen.
// `template` is typed against the known template registry so a typo in the
// static lookup table (transitions.ts) fails to compile instead of failing
// silently at render time.
//
// writeMealLog / holdCandidate / writeCorrection (09 §C step 10) are kept
// distinct from mergeContext/sendReply since the interpreter needs to
// special-case what actually gets persisted for each, rather than treating
// them as an opaque context patch.
export type SideEffect =
  | { type: 'sendReply'; template: TemplateId; vars?: Record<string, string | number> }
  | { type: 'mergeContext'; patch: Record<string, unknown> }
  | { type: 'createGoal' }
  | { type: 'writeMealLog' }
  | { type: 'holdCandidate'; candidate: MealCandidate }
  | { type: 'writeCorrection'; targetLogId: string }
  // "Delete that" with no replacement value (09 §E step 23) — kept
  // distinct from writeCorrection since there's no MealCandidate to write.
  | { type: 'deleteMealLog'; targetLogId: string }
  // 11 breakdown §C step 11: same "result feeds the sendReply that follows
  // it" chaining createGoal uses (07 §C step 13) — the paywall template's
  // {checkoutLink} placeholder needs a real Stripe Checkout URL, which is
  // runtime data (an API call), not something a static table row can hold.
  | { type: 'createCheckoutLink' };
