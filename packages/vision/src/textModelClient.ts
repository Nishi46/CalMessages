import type { RawCandidateItem, RawCandidateSignals } from './assembleCandidate.js';

export type RawTextItem = RawCandidateItem;

// No `unassessable` field here (unlike `RawVisionAnalysis`) — there's no
// photo-quality failure mode for text (08 §D step 11).
export interface RawTextAnalysis extends RawCandidateSignals {
  isFood: boolean;
  items: RawTextItem[];
}

export interface TextModelClient {
  analyze(text: string): Promise<RawTextAnalysis>;
}

export interface TextModelClientConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
// A lighter model than the vision path's default — text-only parsing doesn't
// need multimodal capability (04 §5.1: "the same or a lighter hosted model").
const DEFAULT_MODEL = 'gpt-4o-mini';

const PARSING_PROMPT = `You are a nutrition estimation assistant. Given a text description of a
meal, respond with JSON matching exactly this shape and nothing else:
{
  "isFood": boolean,
  "items": [
    { "name": string, "portion": string, "calories": number, "protein": number,
      "carbs": number, "fat": number, "certainty": number } // certainty is 0-1
  ],
  "dishCategory": "packaged" | "home_cooked" | "mixed",
  "hasPortionReference": boolean // true only if the text states an explicit
                                  // portion/quantity, e.g. "a cup of rice"
}
If isFood is false, items must be an empty array.`;

// Same swappable-provider posture as `createVisionModelClient` — an
// OpenAI-compatible chat-completions endpoint as the concrete default, kept
// out of `parse()` and the confidence scorer behind this one file.
export function createTextModelClient(config: TextModelClientConfig): TextModelClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;

  return {
    async analyze(text: string): Promise<RawTextAnalysis> {
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
            { role: 'system', content: PARSING_PROMPT },
            { role: 'user', content: text },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Text parser request failed: ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      return JSON.parse(body.choices[0].message.content) as RawTextAnalysis;
    },
  };
}
