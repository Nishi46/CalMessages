import type { MealCandidate } from '@tally/shared-types';
import { assembleMealCandidate, EMPTY_MEAL_CANDIDATE_MACROS } from './assembleCandidate.js';
import type { TextParser } from './provider.js';
import type { TextModelClient } from './textModelClient.js';

export interface ParseDeps {
  textClient: TextModelClient;
}

// Returns a `TextParser` (the 04 §5.1 `parse(text)` contract) closed over
// the injected model client — same factory shape as `createVisionProvider`.
export function createTextParser(deps: ParseDeps): TextParser {
  return {
    async parse(text: string): Promise<MealCandidate> {
      const raw = await deps.textClient.analyze(text);

      // Non-food text degrades to rejectionReason: 'non_food' the same way an
      // unparseable onboarding answer degraded to a default in Sprint 2 —
      // `rejectionReason: 'unassessable'` never applies on this path, since
      // there's no photo-quality failure mode for text (08 §D step 11).
      if (!raw.isFood) {
        return {
          ...EMPTY_MEAL_CANDIDATE_MACROS,
          isFood: false,
          rejectionReason: 'non_food',
          confidence: 'low',
        };
      }

      return assembleMealCandidate(raw.items, raw);
    },
  };
}
