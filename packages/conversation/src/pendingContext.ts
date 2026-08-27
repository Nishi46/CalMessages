import type { MealCandidate } from '@tally/shared-types';

// The two shapes awaiting_clarification now holds (09 §C step 13 reuses the
// state rather than adding a tenth one). The clarification_answer handler
// reads `pendingKind` to know which resolution path to run — completing a
// held low-confidence meal candidate, vs. resolving which of several
// recent logs a correction was aimed at (09 §C step 14).
export type PendingContext =
  | { pendingKind: 'meal_candidate'; candidate: MealCandidate }
  | { pendingKind: 'correction_target'; candidateLogIds: string[] };
