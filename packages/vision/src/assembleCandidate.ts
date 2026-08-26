import type { MealCandidate, MealCandidateItem } from '@tally/shared-types';
import { fallbackDishCategory, fallbackHasPortionReference } from './dishHeuristics.js';
import { scoreConfidence } from './scoreConfidence.js';

export interface RawCandidateItem {
  name: string;
  portion: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  certainty: number; // model-reported, per item, 0-1
}

export interface RawCandidateSignals {
  // Present only when the caller's response exposes these directly. When it
  // doesn't, assembleMealCandidate falls back to a heuristic (08 §C step 9).
  dishCategory?: 'packaged' | 'home_cooked' | 'mixed';
  hasPortionReference?: boolean;
}

export const EMPTY_MEAL_CANDIDATE_MACROS = {
  items: [] as MealCandidateItem[],
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
};

function sumBy<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

// Shared by both recognize() and parse() (04 §5.2: "confidence scoring is a
// separate step from recognition" — one scorer, two callers, 08 §D step 12).
// Turns a raw items list + per-item certainty into the final `MealCandidate`;
// callers must rule out their own terminal non-food/unassessable states
// first, since there's nothing to score in those cases.
export function assembleMealCandidate(
  rawItems: RawCandidateItem[],
  signals: RawCandidateSignals,
): MealCandidate {
  const items: MealCandidateItem[] = rawItems.map((item) => ({
    name: item.name,
    portion: item.portion,
    calories: item.calories,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
  }));

  const modelCertainty =
    rawItems.length === 0 ? 0 : sumBy(rawItems, (item) => item.certainty) / rawItems.length;

  const confidence = scoreConfidence({
    modelCertainty,
    itemCount: items.length,
    dishCategory: signals.dishCategory ?? fallbackDishCategory(),
    hasPortionReference: signals.hasPortionReference ?? fallbackHasPortionReference(),
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
}
