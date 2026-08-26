// Scoped to what Sprint 2 needs to classify — the router matches inbound
// intent against current state, not a general-purpose NLU classifier (04
// §6.1). Later sprints add triggers (meal content, correction, command
// words, opt-out language) alongside their own transitions.
export type Trigger = 'first_contact' | 'onboarding_answer' | 'unhandled';
