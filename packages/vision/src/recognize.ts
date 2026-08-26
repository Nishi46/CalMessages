import type { MealCandidate } from '@tally/shared-types';
import { assembleMealCandidate, EMPTY_MEAL_CANDIDATE_MACROS } from './assembleCandidate.js';
import type { FetchByKey } from './photoSource.js';
import type { VisionProvider } from './provider.js';
import type { VisionModelClient } from './visionModelClient.js';

export interface RecognizeDeps {
  fetchByKey: FetchByKey;
  visionClient: VisionModelClient;
}

// Returns a `VisionProvider` (the 04 §5.1 `recognize(photoKey)` contract
// Sprint 4's router imports) closed over the injected fetch/HTTP-call deps —
// same factory shape as `createTwilioSendClient` in the messaging package.
export function createVisionProvider(deps: RecognizeDeps): VisionProvider {
  return {
    async recognize(photoKey: string): Promise<MealCandidate> {
      const photo = await deps.fetchByKey(photoKey);
      const raw = await deps.visionClient.analyze(photo);

      // 04 §5.3: non-food and unassessable photos are both terminal states —
      // there's nothing to score, so both short-circuit before the
      // confidence scorer ever runs (08 §C step 10).
      if (!raw.isFood) {
        return {
          ...EMPTY_MEAL_CANDIDATE_MACROS,
          isFood: false,
          rejectionReason: 'non_food',
          confidence: 'low',
        };
      }
      if (raw.unassessable) {
        return {
          ...EMPTY_MEAL_CANDIDATE_MACROS,
          isFood: false,
          rejectionReason: 'unassessable',
          confidence: 'low',
        };
      }

      return assembleMealCandidate(raw.items, raw);
    },
  };
}
