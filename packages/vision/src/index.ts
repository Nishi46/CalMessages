export type { VisionProvider, TextParser } from './provider.js';
export type { ConfidenceSignals, ConfidenceTier } from './scoreConfidence.js';
export { scoreConfidence } from './scoreConfidence.js';
export type { Photo, FetchByKey } from './photoSource.js';
export type {
  RawVisionItem,
  RawVisionAnalysis,
  VisionModelClient,
  VisionModelClientConfig,
} from './visionModelClient.js';
export { createVisionModelClient } from './visionModelClient.js';
export type { RecognizeDeps } from './recognize.js';
export { createVisionProvider } from './recognize.js';
export type {
  RawTextItem,
  RawTextAnalysis,
  TextModelClient,
  TextModelClientConfig,
} from './textModelClient.js';
export { createTextModelClient } from './textModelClient.js';
export type { ParseDeps } from './parse.js';
export { createTextParser } from './parse.js';
export type { MacroToleranceBand, TextGoldenFixture } from './goldenSet/textFixtures.js';
export { TEXT_GOLDEN_FIXTURES } from './goldenSet/textFixtures.js';
export type { GoldenSetResult } from './goldenSet/runGoldenSet.js';
export { runGoldenSet } from './goldenSet/runGoldenSet.js';
