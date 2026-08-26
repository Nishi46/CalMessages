import { afterAll, describe, expect, it } from 'vitest';
import { createGoal } from './goals.js';
import { getPool } from './pool.js';
import { createUser } from './users.js';

describe('db-consumer goals (against a real Postgres, per breakdown 07 §D step 16)', () => {
  it('creates a self-sourced goal for a user', async () => {
    const user = await createUser(`+1${Date.now()}`);

    const goal = await createGoal(user.id, { type: 'lose', dailyCalories: 1650, dailyProtein: 120 });

    expect(goal.userId).toBe(user.id);
    expect(goal.type).toBe('lose');
    expect(goal.dailyCalories).toBe(1650);
    expect(goal.dailyProtein).toBe(120);
    expect(goal.source).toBe('self');
    expect(goal.supersededAt).toBeNull();
  });

  afterAll(async () => {
    await getPool().end();
  });
});
