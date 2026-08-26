import { describe, expect, it } from 'vitest';
import { createTextParser } from '../parse.js';
import type { RawTextAnalysis, TextModelClient } from '../textModelClient.js';
import { runGoldenSet } from './runGoldenSet.js';
import { TEXT_GOLDEN_FIXTURES } from './textFixtures.js';

// Stand-in for a real provider until one is wired (VISION_PROVIDER_API_KEY is
// still empty — .env.example) — hand-crafted raw model output per fixture, so
// this test exercises the real assembleMealCandidate/scoreConfidence pipeline
// end-to-end without hitting a network. Swapping in
// `createTextParser({ textClient: createTextModelClient({ apiKey }) })` is
// how you'd point this same corpus/runner at a real provider to check for
// confidence-tier drift (04 §14) once one exists.
const STUB_RESPONSES: Record<string, RawTextAnalysis> = {
  'packaged-protein-bar': {
    isFood: true,
    dishCategory: 'packaged',
    hasPortionReference: true,
    items: [{ name: 'Quest protein bar', portion: '1 bar', calories: 200, protein: 21, carbs: 15, fat: 8, certainty: 0.95 }],
  },
  'packaged-chips-vague-portion': {
    isFood: true,
    dishCategory: 'packaged',
    hasPortionReference: false,
    items: [{ name: 'Chips', portion: 'a handful', calories: 220, protein: 2, carbs: 22, fat: 13, certainty: 0.85 }],
  },
  'home-cooked-chicken-rice-broccoli': {
    isFood: true,
    dishCategory: 'home_cooked',
    hasPortionReference: true,
    items: [
      { name: 'Grilled chicken breast', portion: '6 oz', calories: 250, protein: 40, carbs: 0, fat: 6, certainty: 0.9 },
      { name: 'White rice', portion: '1 cup', calories: 205, protein: 4, carbs: 45, fat: 0, certainty: 0.85 },
      { name: 'Steamed broccoli', portion: '1 cup', calories: 55, protein: 4, carbs: 11, fat: 1, certainty: 0.85 },
    ],
  },
  'home-cooked-steak-potatoes-explicit-portion': {
    isFood: true,
    dishCategory: 'home_cooked',
    hasPortionReference: true,
    items: [
      { name: 'Ribeye steak', portion: '12 oz', calories: 750, protein: 65, carbs: 0, fat: 45, certainty: 0.9 },
      { name: 'Mashed potatoes', portion: '1 cup', calories: 220, protein: 4, carbs: 35, fat: 9, certainty: 0.85 },
    ],
  },
  'home-cooked-beef-stew-no-portion': {
    isFood: true,
    dishCategory: 'home_cooked',
    hasPortionReference: false,
    items: [{ name: 'Beef stew', portion: 'a bowl', calories: 450, protein: 25, carbs: 25, fat: 20, certainty: 0.8 }],
  },
  'mixed-stir-fry-many-items': {
    isFood: true,
    dishCategory: 'mixed',
    hasPortionReference: false,
    items: [
      { name: 'Chicken', portion: 'unspecified', calories: 150, protein: 25, carbs: 0, fat: 8, certainty: 0.85 },
      { name: 'Rice', portion: 'unspecified', calories: 220, protein: 4, carbs: 45, fat: 0, certainty: 0.8 },
      { name: 'Broccoli', portion: 'unspecified', calories: 30, protein: 2, carbs: 6, fat: 0, certainty: 0.8 },
      { name: 'Carrots', portion: 'unspecified', calories: 25, protein: 1, carbs: 6, fat: 0, certainty: 0.8 },
      { name: 'Peanut sauce', portion: 'unspecified', calories: 150, protein: 4, carbs: 8, fat: 10, certainty: 0.7 },
    ],
  },
  'packaged-and-fresh-mixed': {
    isFood: true,
    dishCategory: 'mixed',
    hasPortionReference: true,
    items: [
      { name: 'Granola bar', portion: '1 bar', calories: 120, protein: 3, carbs: 20, fat: 4, certainty: 0.85 },
      { name: 'Banana', portion: '1 medium', calories: 105, protein: 1, carbs: 27, fat: 0, certainty: 0.9 },
    ],
  },
  'home-cooked-pasta-explicit-portion': {
    isFood: true,
    dishCategory: 'home_cooked',
    hasPortionReference: true,
    items: [{ name: 'Spaghetti with marinara', portion: '2 cups', calories: 500, protein: 15, carbs: 85, fat: 8, certainty: 0.85 }],
  },
};

const stubClient: TextModelClient = {
  analyze: async (text) => {
    const fixture = TEXT_GOLDEN_FIXTURES.find((candidate) => candidate.text === text);
    const stub = fixture && STUB_RESPONSES[fixture.id];
    if (!stub) {
      throw new Error(`no stub response for "${text}"`);
    }
    return stub;
  },
};

describe('runGoldenSet against the text golden-set corpus (08 §E, breakdown step 14)', () => {
  it('passes every fixture in the corpus', async () => {
    const parser = createTextParser({ textClient: stubClient });
    const results = await runGoldenSet(parser, TEXT_GOLDEN_FIXTURES);

    for (const result of results) {
      expect(result.passed, `fixture "${result.id}" (confidence: ${result.candidate.confidence})`).toBe(true);
    }
  });

  it('flags a fixture as failed when confidence or macros drift out of tolerance', async () => {
    const driftedClient: TextModelClient = {
      analyze: async () => ({
        isFood: true,
        dishCategory: 'home_cooked',
        hasPortionReference: false,
        items: [
          { name: 'Mystery meal', portion: '1 serving', calories: 5000, protein: 1, carbs: 1, fat: 1, certainty: 0.5 },
        ],
      }),
    };
    const parser = createTextParser({ textClient: driftedClient });
    const [result] = await runGoldenSet(parser, [TEXT_GOLDEN_FIXTURES[0]]);

    expect(result.passed).toBe(false);
    expect(result.macrosWithinTolerance).toBe(false);
  });
});
