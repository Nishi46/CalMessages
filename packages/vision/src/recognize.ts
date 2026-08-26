import type { MealCandidate, MealCandidateItem } from '@tally/shared-types';
import { fallbackDishCategory, fallbackHasPortionReference } from './dishHeuristics.js';
import type { FetchByKey } from './photoSource.js';
import type { VisionProvider } from './provider.js';
import { scoreConfidence } from './scoreConfidence.js';
import type { VisionModelClient } from './visionModelClient.js';

export interface RecognizeDeps {
  fetchByKey: FetchByKey;
  visionClient: VisionModelClient;
}

const UNLOGGABLE_MACROS = { items: [] as MealCandidateItem[], calories: 0, protein: 0, carbs: 0, fat: 0 };

function sumBy<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
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
        return { ...UNLOGGABLE_MACROS, isFood: false, rejectionReason: 'non_food', confidence: 'low' };
      }
      if (raw.unassessable) {
        return { ...UNLOGGABLE_MACROS, isFood: false, rejectionReason: 'unassessable', confidence: 'low' };
      }

      const items: MealCandidateItem[] = raw.items.map((item) => ({
        name: item.name,
        portion: item.portion,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
      }));

      const modelCertainty =
        raw.items.length === 0 ? 0 : sumBy(raw.items, (item) => item.certainty) / raw.items.length;
      const dishCategory = raw.dishCategory ?? fallbackDishCategory();
      const hasPortionReference = raw.hasPortionReference ?? fallbackHasPortionReference();

      const confidence = scoreConfidence({
        modelCertainty,
        itemCount: items.length,
        dishCategory,
        hasPortionReference,
      });

      return {
        items,
        calories: sumBy(items, (item) => item.calories),
        protein: sumBy(items, (item) => item.protein),
        carbs: sumBy(items, (item) => item.carbs),
        fat: sumBy(items, (item) => item.fat),
        confidence,
        isFood: true,
      };
    },
  };
}
