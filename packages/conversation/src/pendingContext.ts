import type { MealCandidate } from '@tally/shared-types';

// The two shapes awaiting_clarification now holds (09 §C step 13 reuses the
// state rather than adding a tenth one). The clarification_answer handler
// reads `pendingKind` to know which resolution path to run — completing a
// held low-confidence meal candidate, vs. resolving which of several
// recent logs a correction was aimed at (09 §C step 14).
// `intent` records whether the disambiguation was for a value-replacement
// correction or a delete (09 §E step 23) — captured here since the
// distinction is only known at the moment the hold is created, and would
// otherwise be lost by the time an answer resolves which log was meant.
export type PendingContext =
  | { pendingKind: 'meal_candidate'; candidate: MealCandidate }
  | {
      pendingKind: 'correction_target';
      candidateLogIds: string[];
      intent: 'correct' | 'delete';
    };
