import { createMealLog, createUser, getPool } from '@tally/db-consumer';
import type { MealCandidate } from '@tally/shared-types';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveCorrectionTarget } from './resolveCorrectionTarget.js';

const TIMEZONE = 'America/New_York';
// Fixed instant so "today"/"yesterday" are deterministic across runs:
// 2026-08-27T15:00:00Z is 2026-08-27 (Thursday) in America/New_York.
const NOW = new Date('2026-08-27T15:00:00Z');

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

describe('resolveCorrectionTarget (09 §E, breakdown steps 21-22, against a real Postgres)', () => {
  it('resolves a single same-day match with no day reference', async () => {
    const user = await createUser(`+1${Date.now()}`);
    const log = await createMealLog(user.id, candidate(), 'photo', '2026-08-27');

    const result = await resolveCorrectionTarget(user.id, 'that was actually 2 eggs', TIMEZONE, NOW);

    expect(result).toEqual({ kind: 'single', targetLogId: log.id });
  });

  it('resolves an explicit "yesterday" reference to the prior day, not today', async () => {
    const user = await createUser(`+1${Date.now()}1`);
    await createMealLog(user.id, candidate(), 'photo', '2026-08-27'); // today — should be ignored
    const yesterdayLog = await createMealLog(user.id, candidate(), 'photo', '2026-08-26');

    const result = await resolveCorrectionTarget(
      user.id,
      "that was actually yesterday's lunch",
      TIMEZONE,
      NOW,
    );

    expect(result).toEqual({ kind: 'single', targetLogId: yesterdayLog.id });
  });

  it('resolves an explicit weekday reference to the most recent occurrence of that day', async () => {
    const user = await createUser(`+1${Date.now()}2`);
    // NOW is Thursday 2026-08-27; Monday of that week is 2026-08-24.
    const mondayLog = await createMealLog(user.id, candidate(), 'photo', '2026-08-24');

    const result = await resolveCorrectionTarget(user.id, 'it was monday actually', TIMEZONE, NOW);

    expect(result).toEqual({ kind: 'single', targetLogId: mondayLog.id });
  });

  it('returns multiple candidate ids when more than one log matches the resolved day', async () => {
    const user = await createUser(`+1${Date.now()}3`);
    const first = await createMealLog(user.id, candidate(), 'photo', '2026-08-27');
    const second = await createMealLog(user.id, candidate(), 'text', '2026-08-27');

    const result = await resolveCorrectionTarget(user.id, 'that was actually 2 eggs', TIMEZONE, NOW);

    expect(result.kind).toBe('multiple');
    expect(result).toMatchObject({
      candidateLogIds: expect.arrayContaining([first.id, second.id]),
    });
  });

  it('returns none when nothing matches the resolved day', async () => {
    const user = await createUser(`+1${Date.now()}4`);

    const result = await resolveCorrectionTarget(user.id, 'that was actually 2 eggs', TIMEZONE, NOW);

    expect(result).toEqual({ kind: 'none' });
  });

  afterAll(async () => {
    await getPool().end();
  });
});
