import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextModelClient } from './textModelClient.js';
import type { RawTextAnalysis } from './textModelClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTextModelClient (08 §D step 11, §F step 18)', () => {
  it('sends the text as the user message and parses the JSON response', async () => {
    const fakeAnalysis: RawTextAnalysis = {
      isFood: true,
      dishCategory: 'home_cooked',
      hasPortionReference: false,
      items: [{ name: 'Stew', portion: 'a bowl', calories: 450, protein: 25, carbs: 25, fat: 20, certainty: 0.8 }],
    };

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.messages[1]).toEqual({ role: 'user', content: 'a bowl of homemade beef stew' });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify(fakeAnalysis) } }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createTextModelClient({ apiKey: 'test-key' });
    const result = await client.analyze('a bowl of homemade beef stew');

    expect(result).toEqual(fakeAnalysis);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the provider responds with a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' }) as Response),
    );

    const client = createTextModelClient({ apiKey: 'test-key' });

    await expect(client.analyze('anything')).rejects.toThrow(/429/);
  });
});
