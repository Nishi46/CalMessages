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
//
// pause/resume (12 §A step 1) are classified from keyword match, distinct
// from Twilio's carrier-level STOP/START (12 §C step 9) which never reaches
// classifyTrigger as text at all.
//
// delete (12 §B step 5) is also keyword-classified, but — unlike
// pause/resume, which only fire from one specific state each — it's checked
// "from any state" (04 §6.1), ahead of every other branch in classifyTrigger,
// since a data-deletion request has to work regardless of where the user's
// conversation happens to be.
//
// flagged_language (12 §D step 12-13) outranks every other branch in
// classifyTrigger, including delete — 04 §6.1: "Any state, on flagged
// language" pre-empts everything else for that inbound message. See
// safetyGuardrailPattern.ts for the NOT PRODUCT-REVIEWED disclaimer on the
// actual keyword list this trigger is classified from.
export type Trigger =
  | 'first_contact'
  | 'onboarding_answer'
  | 'meal_content'
  | 'clarification_answer'
  | 'correction'
  | 'limit_crossed'
  | 'checkout_completed'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'flagged_language'
  | 'unhandled';
