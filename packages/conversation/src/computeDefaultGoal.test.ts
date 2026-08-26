import { describe, expect, it } from 'vitest';
import { computeDefaultGoal } from './computeDefaultGoal.js';

describe('computeDefaultGoal (07 §C, breakdown step 11)', () => {
  it('matches the Build Spec §4.1 sample transcript for a lose goal', () => {
    expect(computeDefaultGoal('lose', '190lbs, no target given')).toEqual({
      dailyCalories: 1650,
      dailyProtein: 120,
    });
  });

  it.each(['lose', 'maintain', 'gain', 'protein_only'] as const)(
    'returns a fixed placeholder for goalType %s regardless of starting point text',
    (goalType) => {
      const withOneStartingPoint = computeDefaultGoal(goalType, '190lbs');
      const withAnotherStartingPoint = computeDefaultGoal(goalType, 'not sure, maybe 150?');

      expect(withOneStartingPoint).toEqual(withAnotherStartingPoint);
    },
  );
});
