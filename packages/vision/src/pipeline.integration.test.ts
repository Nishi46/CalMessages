import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextParser } from './parse.js';
import { createVisionProvider } from './recognize.js';
import { createTextModelClient } from './textModelClient.js';
import { createVisionModelClient } from './visionModelClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchJson(content: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    })),
  );
}

// Mocks only at the fetch boundary (08 §F step 18) — proves the full internal
// pipeline (raw HTTP call → signal derivation → scorer → final
// `MealCandidate`) wires together end to end, without hitting a real API in
// CI. `recognize.test.ts`/`parse.test.ts` mock one seam further in, at the
// injected `VisionModelClient`/`TextModelClient`; these tests are the ones
// that actually exercise `createVisionModelClient`/`createTextModelClient`.
describe('vision/text pipelines wired to the real HTTP client (08 §F step 18)', () => {
  it('recognize() carries a real HTTP response through to a scored MealCandidate', async () => {
    stubFetchJson({
      isFood: true,
      unassessable: false,
      dishCategory: 'packaged',
      hasPortionReference: true,
      items: [
        { name: 'Protein bar', portion: '1 bar', calories: 200, protein: 20, carbs: 15, fat: 8, certainty: 0.95 },
      ],
    });

    const provider = createVisionProvider({
      fetchByKey: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }),
      visionClient: createVisionModelClient({ apiKey: 'test-key' }),
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

  it('recognize() propagates a non-food response without ever reaching the scorer', async () => {
    stubFetchJson({ isFood: false, unassessable: false, items: [] });

    const provider = createVisionProvider({
      fetchByKey: async () => ({ bytes: new Uint8Array(), contentType: 'image/jpeg' }),
      visionClient: createVisionModelClient({ apiKey: 'test-key' }),
    });

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

  it('parse() carries a real HTTP response through to a scored MealCandidate', async () => {
    stubFetchJson({
      isFood: true,
      dishCategory: 'home_cooked',
      hasPortionReference: false,
      items: [
        { name: 'Casserole', portion: '1 serving', calories: 400, protein: 20, carbs: 30, fat: 15, certainty: 0.9 },
      ],
    });

    const parser = createTextParser({ textClient: createTextModelClient({ apiKey: 'test-key' }) });

    const result = await parser.parse('a serving of casserole');
    // home_cooked caps at medium, then the missing-portion-reference rule
    // drops one more tier.
    expect(result.confidence).toBe('low');
  });

  it('parse() propagates a non-food response without ever reaching the scorer', async () => {
    stubFetchJson({ isFood: false, items: [] });

    const parser = createTextParser({ textClient: createTextModelClient({ apiKey: 'test-key' }) });

    expect(await parser.parse('just got back from the gym')).toEqual({
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
});
