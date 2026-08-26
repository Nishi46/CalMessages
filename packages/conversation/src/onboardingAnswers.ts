export type GoalType = 'lose' | 'maintain' | 'gain' | 'protein_only';

// Ordered so a specific mention (protein target, glp1) beats the generic
// "maintain" fallback when an answer touches more than one concept.
const GOAL_KEYWORDS: Array<{ pattern: RegExp; goalType: GoalType }> = [
  { pattern: /\b(lose|losing|cut|cutting|glp-?1)\b/i, goalType: 'lose' },
  { pattern: /\b(gain|gaining|bulk|bulking)\b/i, goalType: 'gain' },
  { pattern: /\bprotein\b/i, goalType: 'protein_only' },
  { pattern: /\bmaintain(ing)?\b/i, goalType: 'maintain' },
];

export interface GoalAnswer {
  goalType: GoalType;
  rawGoalAnswer: string;
}

// Build Spec §4.1 edge case: never block onboarding on an unparseable
// answer — default to maintain rather than re-asking or stalling the whole
// product on one unmatched text.
export function captureGoalAnswer(rawText: string): GoalAnswer {
  const match = GOAL_KEYWORDS.find(({ pattern }) => pattern.test(rawText));
  return { goalType: match?.goalType ?? 'maintain', rawGoalAnswer: rawText };
}

export interface StartingPointAnswer {
  rawStartingPoint: string;
}

// No weight/number parsing this sprint — captured verbatim. computeDefaultGoal
// (07 §C) consumes this as opaque input until a real formula lands.
export function captureStartingPointAnswer(rawText: string): StartingPointAnswer {
  return { rawStartingPoint: rawText };
}

export interface ReferralAnswer {
  rawReferral: string | null;
}

// Blank or unrecognized input is organic signup, never a gate — referral
// attribution is best-effort per Build Spec §4.1's edge case.
export function captureReferralAnswer(rawText: string): ReferralAnswer {
  const trimmed = rawText.trim();
  return { rawReferral: trimmed.length > 0 ? trimmed : null };
}
