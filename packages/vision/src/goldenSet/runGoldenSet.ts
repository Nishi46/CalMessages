import type { MealCandidate } from '@tally/shared-types';
import type { TextParser } from '../provider.js';
import type { ConfidenceTier } from '../scoreConfidence.js';
import type { MacroToleranceBand, TextGoldenFixture } from './textFixtures.js';

export interface GoldenSetResult {
  id: string;
  passed: boolean;
  candidate: MealCandidate;
  confidenceMatched: boolean;
  macrosWithinTolerance: boolean;
}

function withinBand(value: number, [min, max]: [number, number]): boolean {
  return value >= min && value <= max;
}

function macrosWithinTolerance(candidate: MealCandidate, band: MacroToleranceBand): boolean {
  return (
    withinBand(candidate.calories, band.calories) &&
    withinBand(candidate.protein, band.protein) &&
    withinBand(candidate.carbs, band.carbs) &&
    withinBand(candidate.fat, band.fat)
  );
}

// Not a strict pass/fail gate on exact numbers (04 §14, 08 §E step 14) — this
// is the drift-tracking mechanism: point it at any `TextParser` (a fake for
// CI, or `createTextParser` wired to a real provider when checking for
// confidence-tier drift after a prompt/provider change) and get a per-fixture
// report. `TextParser` is provider-agnostic by design, so this runner never
// touches a real API itself — the caller decides what it's pointed at.
export async function runGoldenSet(
  parser: TextParser,
  fixtures: TextGoldenFixture[],
): Promise<GoldenSetResult[]> {
  const results: GoldenSetResult[] = [];

  for (const fixture of fixtures) {
    const candidate = await parser.parse(fixture.text);
    const confidenceMatched = candidateConfidenceMatches(candidate, fixture.expectedConfidence);
    const macrosOk = macrosWithinTolerance(candidate, fixture.expectedMacros);

    results.push({
      id: fixture.id,
      passed: confidenceMatched && macrosOk,
      candidate,
      confidenceMatched,
      macrosWithinTolerance: macrosOk,
    });
  }

  return results;
}

function candidateConfidenceMatches(candidate: MealCandidate, expected: ConfidenceTier): boolean {
  return candidate.confidence === expected;
}
