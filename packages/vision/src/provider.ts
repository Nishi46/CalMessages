import type { MealCandidate } from '@tally/shared-types';

export interface VisionProvider {
  recognize(photoKey: string): Promise<MealCandidate>;
}

export interface TextParser {
  parse(text: string): Promise<MealCandidate>;
}
