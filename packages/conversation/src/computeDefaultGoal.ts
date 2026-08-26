import type { GoalType } from './onboardingAnswers.js';

export interface ComputedGoal {
  dailyCalories: number;
  dailyProtein: number;
}

// Placeholder formula pending a real nutrition calculation — 04 §6.1 doesn't
// specify one, and this sprint only needs the state machine to ship, not a
// production-accurate estimator (same posture as the Sprint 1 router stub).
// The `lose` numbers mirror the Build Spec §4.1 sample transcript exactly,
// so the manual cold-onboarding test (07 §F step 24) has a known-correct
// value to check against.
const PLACEHOLDER_GOALS: Record<GoalType, ComputedGoal> = {
  lose: { dailyCalories: 1650, dailyProtein: 120 },
  maintain: { dailyCalories: 2000, dailyProtein: 130 },
  gain: { dailyCalories: 2400, dailyProtein: 150 },
  protein_only: { dailyCalories: 2000, dailyProtein: 150 },
};

// rawStartingPoint is accepted now, even though unused, so this signature
// doesn't have to change once a real formula reads weight/protein-target
// text out of it.
export function computeDefaultGoal(goalType: GoalType, rawStartingPoint: string): ComputedGoal {
  void rawStartingPoint;
  return PLACEHOLDER_GOALS[goalType];
}
