import { describe, expect, it } from 'vitest';
import { scoreConfidence, type ConfidenceSignals } from './scoreConfidence.js';

const base: ConfidenceSignals = {
  modelCertainty: 0.95,
  itemCount: 1,
  dishCategory: 'packaged',
  hasPortionReference: true,
};

describe('scoreConfidence (08 §B, breakdown step 7)', () => {
  it('scores packaged + visible labeling + high certainty as high', () => {
    expect(scoreConfidence(base)).toBe('high');
  });

  it('caps a home-cooked dish at medium even with high certainty', () => {
    expect(scoreConfidence({ ...base, dishCategory: 'home_cooked' })).toBe('medium');
  });

  it('caps a mixed dish at medium even with high certainty', () => {
    expect(scoreConfidence({ ...base, dishCategory: 'mixed' })).toBe('medium');
  });

  it('drops an otherwise-high case to medium when portion reference is missing', () => {
    expect(scoreConfidence({ ...base, hasPortionReference: false })).toBe('medium');
  });

  it('drops one tier for a 5-item plate', () => {
    expect(scoreConfidence({ ...base, itemCount: 5 })).toBe('medium');
  });

  it('does not lower confidence below 4 items', () => {
    expect(scoreConfidence({ ...base, itemCount: 3 })).toBe('high');
  });

  it('stacks two triggered lowering rules, one tier drop each, floored at low', () => {
    expect(scoreConfidence({ ...base, hasPortionReference: false, itemCount: 5 })).toBe('low');
  });

  it('maps low model certainty to low for a non-packaged dish', () => {
    expect(
      scoreConfidence({
        modelCertainty: 0.2,
        itemCount: 1,
        dishCategory: 'mixed',
        hasPortionReference: true,
      }),
    ).toBe('low');
  });

  it('packaged + visible labeling overrides a low certainty-derived base tier', () => {
    expect(scoreConfidence({ ...base, modelCertainty: 0.2 })).toBe('high');
  });

  it('maps mid-range model certainty to medium for a non-packaged case', () => {
    expect(
      scoreConfidence({
        modelCertainty: 0.7,
        itemCount: 1,
        dishCategory: 'home_cooked',
        hasPortionReference: true,
      }),
    ).toBe('medium');
  });

  it('never drops below low', () => {
    expect(
      scoreConfidence({
        modelCertainty: 0.2,
        itemCount: 5,
        dishCategory: 'home_cooked',
        hasPortionReference: false,
      }),
    ).toBe('low');
  });
});
