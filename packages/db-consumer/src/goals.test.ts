import { afterAll, describe, expect, it } from 'vitest';
import { createGoal, getCurrentGoal } from './goals.js';
import { getPool } from './pool.js';
import { uniqueTestPhone } from './testSupport.js';
import { createUser } from './users.js';

describe('db-consumer goals (against a real Postgres, per breakdown 07 §D step 16)', () => {
  it('creates a self-sourced goal for a user', async () => {
    const user = await createUser(uniqueTestPhone());

    const goal = await createGoal(user.id, { type: 'lose', dailyCalories: 1650, dailyProtein: 120 });

    expect(goal.userId).toBe(user.id);
    expect(goal.type).toBe('lose');
    expect(goal.dailyCalories).toBe(1650);
    expect(goal.dailyProtein).toBe(120);
    expect(goal.source).toBe('self');
    expect(goal.supersededAt).toBeNull();
  });
});

describe('getCurrentGoal (09 §D, against a real Postgres)', () => {
  it('returns null when the user has no goal', async () => {
    const user = await createUser(uniqueTestPhone());

    expect(await getCurrentGoal(user.id)).toBeNull();
  });

  it('returns the most recently set goal', async () => {
    const user = await createUser(uniqueTestPhone());
    await createGoal(user.id, { type: 'lose', dailyCalories: 1650, dailyProtein: 120 });
    await createGoal(user.id, { type: 'maintain', dailyCalories: 2000, dailyProtein: 140 });

    const current = await getCurrentGoal(user.id);

    expect(current?.dailyCalories).toBe(2000);
    expect(current?.type).toBe('maintain');
  });
});

afterAll(async () => {
  await getPool().end();
});
