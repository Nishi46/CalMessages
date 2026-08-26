import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisionModelClient } from './visionModelClient.js';
import type { RawVisionAnalysis } from './visionModelClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createVisionModelClient (08 §C step 8, §F step 18)', () => {
  it('sends the photo as a base64 data URL and parses the JSON response', async () => {
    const fakeAnalysis: RawVisionAnalysis = {
      isFood: true,
      unassessable: false,
      dishCategory: 'packaged',
      hasPortionReference: true,
      items: [{ name: 'Apple', portion: '1 medium', calories: 95, protein: 0, carbs: 25, fat: 0, certainty: 0.9 }],
    };

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.messages[1].content[0].image_url.url).toBe(
        `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
      );
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify(fakeAnalysis) } }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createVisionModelClient({ apiKey: 'test-key' });
    const result = await client.analyze({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' });

    expect(result).toEqual(fakeAnalysis);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the provider responds with a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }) as Response),
    );

    const client = createVisionModelClient({ apiKey: 'test-key' });

    await expect(
      client.analyze({ bytes: new Uint8Array(), contentType: 'image/jpeg' }),
    ).rejects.toThrow(/500/);
  });
});
