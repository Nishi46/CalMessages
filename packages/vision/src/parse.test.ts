import { describe, expect, it } from 'vitest';
import { createTextParser } from './parse.js';
import type { RawTextAnalysis, TextModelClient } from './textModelClient.js';

function fakeParser(raw: RawTextAnalysis) {
  const textClient: TextModelClient = {
    analyze: async (text: string) => {
      expect(text).toBe('a cup of rice and grilled chicken');
      return raw;
    },
  };
  return createTextParser({ textClient });
}

describe('createTextParser (08 §D, breakdown steps 11-12)', () => {
  it('degrades non-food text to rejectionReason: non_food, with zeroed macros', async () => {
    const parser = fakeParser({ isFood: false, items: [] });

    expect(await parser.parse('a cup of rice and grilled chicken')).toEqual({
      items: [],
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      isFood: false,
      rejectionReason: 'non_food',
      confidence: 'low',
    });
  });

  it('never produces rejectionReason: unassessable — there is no photo-quality failure mode for text', async () => {
    const parser = fakeParser({ isFood: false, items: [] });
    const result = await parser.parse('a cup of rice and grilled chicken');

    expect(result.rejectionReason).not.toBe('unassessable');
  });

  it('reuses scoreConfidence via an explicitly stated portion', async () => {
    const parser = fakeParser({
      isFood: true,
      dishCategory: 'packaged',
      hasPortionReference: true,
      items: [
        { name: 'Protein bar', portion: '1 bar', calories: 200, protein: 20, carbs: 15, fat: 8, certainty: 0.95 },
      ],
    });

    expect(await parser.parse('a cup of rice and grilled chicken')).toEqual({
      items: [{ name: 'Protein bar', portion: '1 bar', calories: 200, protein: 20, carbs: 15, fat: 8 }],
      calories: 200,
      protein: 20,
      carbs: 15,
      fat: 8,
      isFood: true,
      confidence: 'high',
    });
  });

  it('defaults hasPortionReference to false when no portion is stated explicitly', async () => {
    const parser = fakeParser({
      isFood: true,
      dishCategory: 'packaged',
      // hasPortionReference omitted — model/text didn't state an explicit portion.
      items: [
        { name: 'Chips', portion: 'some', calories: 300, protein: 3, carbs: 30, fat: 18, certainty: 0.95 },
      ],
    });

    const result = await parser.parse('a cup of rice and grilled chicken');
    // Packaged overrides to high, then the missing-portion-reference rule
    // drops it one tier.
    expect(result.confidence).toBe('medium');
  });

  it('sums macros across multiple parsed items', async () => {
    const parser = fakeParser({
      isFood: true,
      dishCategory: 'home_cooked',
      hasPortionReference: true,
      items: [
        { name: 'Rice', portion: '1 cup', calories: 200, protein: 4, carbs: 45, fat: 0, certainty: 0.9 },
        { name: 'Chicken', portion: '4 oz', calories: 180, protein: 35, carbs: 0, fat: 4, certainty: 0.9 },
      ],
    });

    const result = await parser.parse('a cup of rice and grilled chicken');
    expect(result).toMatchObject({ calories: 380, protein: 39, carbs: 45, fat: 4 });
  });
});
