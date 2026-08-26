import type { TemplateId } from './templates.js';

// Side effects are pure data attached to a transition, not executed inline —
// that's what keeps the lookup table itself testable without mocking I/O
// (04 §14). applySideEffects (07 §C) is what actually sends replies / writes
// to Postgres; this type only describes what a transition intends to happen.
// `template` is typed against the known template registry so a typo in the
// static lookup table (transitions.ts) fails to compile instead of failing
// silently at render time.
export type SideEffect =
  | { type: 'sendReply'; template: TemplateId; vars?: Record<string, string | number> }
  | { type: 'mergeContext'; patch: Record<string, unknown> }
  | { type: 'createGoal' };
