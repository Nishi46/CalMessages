// Scoped to what Sprint 2 needs to classify — the router matches inbound
// intent against current state, not a general-purpose NLU classifier (04
// §6.1). Later sprints add triggers (meal content, correction, command
// words, opt-out language) alongside their own transitions.
//
// Sprint 4 (09 §C step 7) adds meal_content (photo or food-describing text
// while idle), clarification_answer (any inbound while
// awaiting_clarification), and correction (idle-state text matching the
// correction pattern — 09 §C step 9).
export type Trigger =
  | 'first_contact'
  | 'onboarding_answer'
  | 'meal_content'
  | 'clarification_answer'
  | 'correction'
  | 'unhandled';
