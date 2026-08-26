export interface ConfidenceSignals {
  modelCertainty: number;
  itemCount: number;
  dishCategory: 'packaged' | 'home_cooked' | 'mixed';
  hasPortionReference: boolean;
}

export type ConfidenceTier = 'high' | 'medium' | 'low';

const TIER_ORDER: ConfidenceTier[] = ['low', 'medium', 'high'];

// Placeholder thresholds pending real correction-rate data — 04 §5.2 flags
// tuning these as a P1 activity (Build Spec §9 open question 3). This scorer
// is a pure function of `ConfidenceSignals` specifically so the thresholds
// can move without a redeploy of the vision integration itself, same posture
// as Sprint 2's `computeDefaultGoal` placeholder formula.
const HIGH_CERTAINTY_THRESHOLD = 0.85;
const MEDIUM_CERTAINTY_THRESHOLD = 0.6;

// 04 §5.2: "4+ distinct items" lowers confidence one tier.
const HIGH_ITEM_COUNT_THRESHOLD = 4;

function certaintyToTier(modelCertainty: number): ConfidenceTier {
  if (modelCertainty >= HIGH_CERTAINTY_THRESHOLD) return 'high';
  if (modelCertainty >= MEDIUM_CERTAINTY_THRESHOLD) return 'medium';
  return 'low';
}

function dropOneTier(tier: ConfidenceTier): ConfidenceTier {
  const index = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(index - 1, 0)];
}

function capAt(tier: ConfidenceTier, cap: ConfidenceTier): ConfidenceTier {
  return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(cap) ? cap : tier;
}

// Ordered rules, not a weighted score — same auditability reason the
// conversation state machine is a lookup table rather than free-form logic
// (04 §5.2):
//   1. Packaged food with visible labeling overrides straight to `high`;
//      home-cooked/mixed dishes are capped at `medium` regardless of other
//      signals (Build Spec §4.2).
//   2. Missing portion reference and a high item count each drop the tier by
//      one if triggered. 04 §5.2 only specifies that each of these "lowers"
//      confidence, not how multiple triggered rules combine — this applies
//      at most one drop per triggered rule, and lets multiple triggered
//      rules stack (floored at `low`), as a judgment call rather than a
//      spec-derived rule.
export function scoreConfidence(signals: ConfidenceSignals): ConfidenceTier {
  let tier = certaintyToTier(signals.modelCertainty);

  if (signals.dishCategory === 'packaged') {
    tier = 'high';
  } else {
    tier = capAt(tier, 'medium');
  }

  if (!signals.hasPortionReference) {
    tier = dropOneTier(tier);
  }
  if (signals.itemCount >= HIGH_ITEM_COUNT_THRESHOLD) {
    tier = dropOneTier(tier);
  }

  return tier;
}
