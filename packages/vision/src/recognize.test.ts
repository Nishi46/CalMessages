import { describe, expect, it } from 'vitest';
import { createVisionProvider } from './recognize.js';
import type { RawVisionAnalysis, VisionModelClient } from './visionModelClient.js';

const photo = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' };

function fakeProvider(raw: RawVisionAnalysis) {
  const visionClient: VisionModelClient = {
    analyze: async () => raw,
  };
  return createVisionProvider({
    fetchByKey: async (photoKey: string) => {
      expect(photoKey).toBe('photo-key-1');
      return photo;
    },
    visionClient,
  });
}

describe('createVisionProvider (08 §C, breakdown steps 8-10)', () => {
  it('short-circuits non-food photos before scoring, with zeroed macros', async () => {
    const provider = fakeProvider({ isFood: false, unassessable: false, items: [] });

    expect(await provider.recognize('photo-key-1')).toEqual({
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

  it('short-circuits unassessable photos before scoring, with zeroed macros', async () => {
    const provider = fakeProvider({ isFood: true, unassessable: true, items: [] });

    expect(await provider.recognize('photo-key-1')).toEqual({
      items: [],
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      isFood: false,
      rejectionReason: 'unassessable',
      confidence: 'low',
    });
  });

  it('sums item macros and wires signals into the confidence scorer for a packaged item', async () => {
    const provider = fakeProvider({
      isFood: true,
      unassessable: false,
      dishCategory: 'packaged',
      hasPortionReference: true,
      items: [
        { name: 'Protein bar', portion: '1 bar', calories: 200, protein: 20, carbs: 15, fat: 8, certainty: 0.95 },
      ],
    });

    expect(await provider.recognize('photo-key-1')).toEqual({
      items: [{ name: 'Protein bar', portion: '1 bar', calories: 200, protein: 20, carbs: 15, fat: 8 }],
      calories: 200,
      protein: 20,
      carbs: 15,
      fat: 8,
      isFood: true,
      confidence: 'high',
    });
  });

  it('sums macros across multiple items', async () => {
    const provider = fakeProvider({
      isFood: true,
      unassessable: false,
      dishCategory: 'packaged',
      hasPortionReference: true,
      items: [
        { name: 'Rice', portion: '1 cup', calories: 200, protein: 4, carbs: 45, fat: 0, certainty: 0.9 },
        { name: 'Chicken', portion: '4 oz', calories: 180, protein: 35, carbs: 0, fat: 4, certainty: 0.9 },
      ],
    });

    const result = await provider.recognize('photo-key-1');
    expect(result).toMatchObject({ calories: 380, protein: 39, carbs: 45, fat: 4 });
  });

  it('falls back to a conservative dish category and portion reference when the provider omits them', async () => {
    const provider = fakeProvider({
      isFood: true,
      unassessable: false,
      items: [
        { name: 'Casserole', portion: '1 serving', calories: 400, protein: 20, carbs: 30, fat: 15, certainty: 0.95 },
      ],
    });

    // No dishCategory/hasPortionReference in the raw response: falls back to
    // 'mixed' (capped at medium) and hasPortionReference: false (drops one
    // tier), landing on 'low' rather than a falsely confident 'high'.
    const result = await provider.recognize('photo-key-1');
    expect(result.confidence).toBe('low');
  });
});
