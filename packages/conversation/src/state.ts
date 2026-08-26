// 04 §6.1 — the full state enum, even though Sprint 2 only wires transitions
// for the new -> onboarding_q1/q2/q3 -> idle slice (05 Sprint Plan, Sprint 2
// Ships). Declaring the full set now means later sprints add lookup-table
// rows instead of widening this type.
export type ConversationState =
  | 'new'
  | 'onboarding_q1'
  | 'onboarding_q2'
  | 'onboarding_q3'
  | 'idle'
  | 'awaiting_clarification'
  | 'awaiting_checkout'
  | 'paused'
  | 'care_pause'
  | 'deleted';
