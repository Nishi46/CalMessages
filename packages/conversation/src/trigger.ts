// Scoped to what Sprint 2 needs to classify — the router matches inbound
// intent against current state, not a general-purpose NLU classifier (04
// §6.1). Later sprints add triggers (meal content, correction, command
// words, opt-out language) alongside their own transitions.
//
// Sprint 4 (09 §C step 7) adds meal_content (photo or food-describing text
// while idle), clarification_answer (any inbound while
// awaiting_clarification), and correction (idle-state text matching the
// correction pattern — 09 §C step 9).
// limit_crossed (11 breakdown §B step 9) and checkout_completed (11
// breakdown §C step 13) are synthetic — neither comes out of
// classifyTrigger. Billing logic fires them directly at resolveTransition
// (from the meal-log write and the Stripe webhook, respectively), so those
// transitions (like every other one) still flow through the one lookup
// table rather than conversation_state being set directly from billing code.
export type Trigger =
  | 'first_contact'
  | 'onboarding_answer'
  | 'meal_content'
  | 'clarification_answer'
  | 'correction'
  | 'limit_crossed'
  | 'checkout_completed'
  | 'unhandled';
