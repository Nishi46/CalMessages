// Side effects are pure data attached to a transition, not executed inline —
// that's what keeps the lookup table itself testable without mocking I/O
// (04 §14). An interpreter that actually sends replies / writes to Postgres
// lands with the rest of Sprint 2's onboarding wiring; this type only
// describes what a transition intends to happen.
export type SideEffect =
  | { type: 'sendReply'; template: string; vars?: Record<string, string | number> }
  | { type: 'mergeContext'; patch: Record<string, unknown> }
  | { type: 'createGoal' };
