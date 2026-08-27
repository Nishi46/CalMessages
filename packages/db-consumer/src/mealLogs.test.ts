import type { MealCandidate } from '@tally/shared-types';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCorrection,
  createMealLog,
  getDailyTotals,
  getRecentMealLogsForUser,
  softDeleteMealLog,
} from './mealLogs.js';
import { getPool } from './pool.js';
import { createUser } from './users.js';

function candidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
  return {
    items: [{ name: 'eggs', portion: '3', calories: 210, protein: 18, carbs: 2, fat: 15 }],
    calories: 210,
    protein: 18,
    carbs: 2,
    fat: 15,
    confidence: 'high',
    isFood: true,
    ...overrides,
  };
}

describe('db-consumer mealLogs (against a real Postgres, per breakdown 09 §A)', () => {
  it('creates a meal log and reads its fields back', async () => {
    const user = await createUser(`+1${Date.now()}`);

    const log = await createMealLog(user.id, candidate(), 'photo', '2026-08-26');

    expect(log.userId).toBe(user.id);
    expect(log.items).toEqual(candidate().items);
    expect(log.calories).toBe(210);
    expect(log.confidence).toBe('high');
    expect(log.source).toBe('photo');
    expect(log.localDate).toBe('2026-08-26');
    expect(log.correctedFromId).toBeNull();
    expect(log.softDeletedAt).toBeNull();
  });

  it('sums daily totals across multiple logs on the same local_date, excluding other days', async () => {
    const user = await createUser(`+1${Date.now()}1`);

    await createMealLog(user.id, candidate({ calories: 400, protein: 30, carbs: 10, fat: 20 }), 'text', '2026-08-26');
    await createMealLog(user.id, candidate({ calories: 300, protein: 20, carbs: 5, fat: 10 }), 'text', '2026-08-26');
    await createMealLog(user.id, candidate({ calories: 999, protein: 99, carbs: 99, fat: 99 }), 'text', '2026-08-25');

    const totals = await getDailyTotals(user.id, '2026-08-26');
    expect(totals).toEqual({ calories: 700, protein: 50, carbs: 15, fat: 30 });
  });

  it('excludes soft-deleted logs from daily totals and recent-logs lookups', async () => {
    const user = await createUser(`+1${Date.now()}2`);
    const log = await createMealLog(user.id, candidate({ calories: 500 }), 'text', '2026-08-26');

    await softDeleteMealLog(log.id);

    const totals = await getDailyTotals(user.id, '2026-08-26');
    expect(totals).toEqual({ calories: 0, protein: 0, carbs: 0, fat: 0 });

    const recent = await getRecentMealLogsForUser(user.id, { sinceDate: '2026-08-01' });
    expect(recent.find((l) => l.id === log.id)).toBeUndefined();
  });

  it('getRecentMealLogsForUser only returns logs on/after sinceDate', async () => {
    const user = await createUser(`+1${Date.now()}3`);
    await createMealLog(user.id, candidate(), 'text', '2026-08-20');
    const inRange = await createMealLog(user.id, candidate(), 'text', '2026-08-26');

    const recent = await getRecentMealLogsForUser(user.id, { sinceDate: '2026-08-25' });
    expect(recent.map((l) => l.id)).toEqual([inRange.id]);
  });

  it('createCorrection copies the original log\'s local_date, not today\'s', async () => {
    const user = await createUser(`+1${Date.now()}4`);
    const original = await createMealLog(user.id, candidate({ calories: 300 }), 'photo', '2026-08-20');

    const correction = await createCorrection(original.id, user.id, candidate({ calories: 350 }));

    expect(correction?.localDate).toBe('2026-08-20');
    expect(correction?.correctedFromId).toBe(original.id);
    expect(correction?.source).toBe('text');

    const totals = await getDailyTotals(user.id, '2026-08-20');
    // Both the original and the correction row are live (soft_deleted_at IS
    // NULL) — creating a correction doesn't delete the row it corrects.
    expect(totals.calories).toBe(650);
  });

  it('createCorrection returns null when the original log belongs to a different user', async () => {
    const owner = await createUser(`+1${Date.now()}5`);
    const other = await createUser(`+1${Date.now()}6`);
    const original = await createMealLog(owner.id, candidate(), 'photo', '2026-08-26');

    const correction = await createCorrection(original.id, other.id, candidate());

    expect(correction).toBeNull();
  });

  it('softDeleteMealLog is idempotent — returns null on a second call', async () => {
    const user = await createUser(`+1${Date.now()}7`);
    const log = await createMealLog(user.id, candidate(), 'text', '2026-08-26');

    const first = await softDeleteMealLog(log.id);
    expect(first?.softDeletedAt).not.toBeNull();

    const second = await softDeleteMealLog(log.id);
    expect(second).toBeNull();
  });

  afterAll(async () => {
    await getPool().end();
  });
});
