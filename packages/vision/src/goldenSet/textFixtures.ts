import type { ConfidenceTier } from '../scoreConfidence.js';

export interface MacroToleranceBand {
  calories: [number, number];
  protein: [number, number];
  carbs: [number, number];
  fat: [number, number];
}

export interface TextGoldenFixture {
  id: string;
  text: string;
  // Hand-labeled tolerance band, not exact numbers — model output isn't
  // deterministic (08 §E step 13).
  expectedMacros: MacroToleranceBand;
  expectedConfidence: ConfidenceTier;
}

// Small, started-not-complete corpus (04 §14, 08 §E) tracking confidence-tier
// drift across provider/prompt changes — the Sprint Plan's own wording is
// "golden-set regression corpus started," not finished; more fixtures are
// expected to accumulate in later sprints. Covers each confidence-scorer
// rule at least once: packaged override, home-cooked/mixed cap, missing
// portion reference, and high item count, stacked and unstacked.
export const TEXT_GOLDEN_FIXTURES: TextGoldenFixture[] = [
  {
    id: 'packaged-protein-bar',
    text: 'a Quest protein bar',
    expectedMacros: { calories: [180, 220], protein: [18, 24], carbs: [10, 20], fat: [6, 10] },
    expectedConfidence: 'high',
  },
  {
    id: 'packaged-chips-vague-portion',
    text: 'some chips',
    expectedMacros: { calories: [150, 300], protein: [1, 4], carbs: [15, 30], fat: [8, 18] },
    expectedConfidence: 'medium',
  },
  {
    id: 'home-cooked-chicken-rice-broccoli',
    text: 'grilled chicken breast with a cup of white rice and steamed broccoli',
    expectedMacros: { calories: [450, 650], protein: [35, 50], carbs: [45, 65], fat: [5, 15] },
    expectedConfidence: 'medium',
  },
  {
    id: 'home-cooked-steak-potatoes-explicit-portion',
    text: '12 oz ribeye steak with mashed potatoes',
    expectedMacros: { calories: [700, 1000], protein: [55, 75], carbs: [30, 50], fat: [35, 55] },
    expectedConfidence: 'medium',
  },
  {
    id: 'home-cooked-beef-stew-no-portion',
    text: 'a bowl of homemade beef stew',
    expectedMacros: { calories: [300, 600], protein: [15, 35], carbs: [15, 35], fat: [10, 30] },
    expectedConfidence: 'low',
  },
  {
    id: 'mixed-stir-fry-many-items',
    text: 'chicken stir fry with rice, broccoli, carrots, and peanut sauce',
    expectedMacros: { calories: [550, 800], protein: [30, 45], carbs: [60, 90], fat: [15, 30] },
    expectedConfidence: 'low',
  },
  {
    id: 'packaged-and-fresh-mixed',
    text: 'a granola bar and a banana',
    expectedMacros: { calories: [200, 350], protein: [3, 8], carbs: [35, 55], fat: [4, 10] },
    expectedConfidence: 'medium',
  },
  {
    id: 'home-cooked-pasta-explicit-portion',
    text: 'two cups of spaghetti with marinara sauce',
    expectedMacros: { calories: [400, 600], protein: [10, 20], carbs: [70, 100], fat: [5, 15] },
    expectedConfidence: 'medium',
  },
];

// 08 §E step 15: photo fixtures are deferred, not silently skipped — no
// sample images exist in the repo yet, and the Sprint Plan's "started, not
// complete" wording anticipates this isn't finished in one sprint. Growing
// this corpus with 2-3 photo fixtures (and the vision-path equivalent of
// `runGoldenSet`) is left for a later sprint once sample photos exist.
