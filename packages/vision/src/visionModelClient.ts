import type { Photo } from './photoSource.js';

export interface RawVisionItem {
  name: string;
  portion: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  certainty: number; // model-reported, per item, 0-1
}

export interface RawVisionAnalysis {
  isFood: boolean;
  // Too dark/blurry to assess (04 §5.3) — only meaningful when isFood is true;
  // a provider that already says "not food" has no separate quality opinion.
  unassessable: boolean;
  items: RawVisionItem[];
  // Present only when the provider's own response exposes these directly.
  // When it doesn't, the caller falls back to a heuristic (08 §C step 9).
  dishCategory?: 'packaged' | 'home_cooked' | 'mixed';
  hasPortionReference?: boolean;
}

export interface VisionModelClient {
  analyze(photo: Photo): Promise<RawVisionAnalysis>;
}

export interface VisionModelClientConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

const RECOGNITION_PROMPT = `You are a nutrition estimation assistant. Given a photo of food, respond with
JSON matching exactly this shape and nothing else:
{
  "isFood": boolean,
  "unassessable": boolean, // true only if the photo is too dark/blurry to judge
  "items": [
    { "name": string, "portion": string, "calories": number, "protein": number,
      "carbs": number, "fat": number, "certainty": number } // certainty is 0-1
  ],
  "dishCategory": "packaged" | "home_cooked" | "mixed",
  "hasPortionReference": boolean // a utensil, hand, or known-size plate is visible
}
If isFood is false or unassessable is true, items must be an empty array.`;

// The hosted multimodal model is a swappable, stateless dependency (Architecture
// §3.2) — recognition itself is treated as a commodity (Vision Brief §1), and
// picking the actual vendor is an open decision (04 §1, .env.example's
// VISION_PROVIDER_API_KEY). This client targets an OpenAI-compatible
// chat-completions endpoint as the concrete default; swapping providers means
// replacing this one file, since `recognize()` and the confidence scorer only
// ever see the `VisionModelClient`/`RawVisionAnalysis` shapes above.
export function createVisionModelClient(config: VisionModelClientConfig): VisionModelClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;

  return {
    async analyze(photo: Photo): Promise<RawVisionAnalysis> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: RECOGNITION_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${photo.contentType};base64,${Buffer.from(photo.bytes).toString('base64')}`,
                  },
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Vision provider request failed: ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      return JSON.parse(body.choices[0].message.content) as RawVisionAnalysis;
    },
  };
}
