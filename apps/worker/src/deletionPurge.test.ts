import { createMealLog, createUser, getPool, getUserById, updateUserState } from '@tally/db-consumer';
import type { ObjectStore } from '@tally/object-store';
import type { MealCandidate } from '@tally/shared-types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runDeletionPurgeTick } from './deletionPurge.js';

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function fakeObjectStore(deleteObject: ObjectStore['deleteObject'] = vi.fn().mockResolvedValue(undefined)): ObjectStore {
  return { putObject: vi.fn(), getObject: vi.fn(), deleteObject };
}

function fakeCandidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
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

async function markDeleted(userId: string, deletedRequestedAt: Date): Promise<void> {
  await updateUserState(userId, 'deleted', null, undefined, { deletedRequestedAt });
}

async function setPhotoUrl(mealLogId: string, photoUrl: string): Promise<void> {
  await getPool().query(`UPDATE meal_log SET photo_url = $2 WHERE id = $1`, [mealLogId, photoUrl]);
}

describe('runDeletionPurgeTick (12 §B step 7-8, against a real Postgres)', () => {
  it('purges a user whose grace period has elapsed: meal logs and photos gone, PII scrubbed', async () => {
    const phone = `+1${Date.now()}1`;
    const user = await createUser(phone);
    const log = await createMealLog(user.id, fakeCandidate(), 'photo', '2026-01-01');
    await setPhotoUrl(log.id, 'meal-photos/purge-me');
    await markDeleted(user.id, new Date(Date.now() - GRACE_PERIOD_MS - 60_000));
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const objectStore = fakeObjectStore(deleteObject);

    await runDeletionPurgeTick(objectStore, new Date(), GRACE_PERIOD_MS);

    expect(deleteObject).toHaveBeenCalledWith('meal-photos/purge-me');

    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);

    const purged = await getUserById(user.id);
    expect(purged?.phoneE164).not.toBe(phone);
    expect(purged?.phoneE164).toBe(`deleted-${user.id}`);
    expect(purged?.deletedRequestedAt).toBeNull();
  });

  it('leaves a user under the 30-day grace period untouched', async () => {
    const phone = `+1${Date.now()}2`;
    const user = await createUser(phone);
    await createMealLog(user.id, fakeCandidate(), 'photo', '2026-01-01');
    await markDeleted(user.id, new Date(Date.now() - 60_000)); // just now, nowhere near 30 days
    const objectStore = fakeObjectStore();

    await runDeletionPurgeTick(objectStore, new Date(), GRACE_PERIOD_MS);

    expect(objectStore.deleteObject).not.toHaveBeenCalled();
    const purged = await getUserById(user.id);
    expect(purged?.phoneE164).toBe(phone);
    const { rows } = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });

  it('ignores a user who has not requested deletion at all', async () => {
    const phone = `+1${Date.now()}3`;
    const user = await createUser(phone);
    await updateUserState(user.id, 'idle');
    const objectStore = fakeObjectStore();

    await runDeletionPurgeTick(objectStore, new Date(), GRACE_PERIOD_MS);

    expect(objectStore.deleteObject).not.toHaveBeenCalled();
    const untouched = await getUserById(user.id);
    expect(untouched?.phoneE164).toBe(phone);
  });

  it('one user failing does not stop the rest of the sweep from being purged', async () => {
    const failingUser = await createUser(`+1${Date.now()}4`);
    const failingLog = await createMealLog(failingUser.id, fakeCandidate(), 'photo', '2026-01-01');
    await setPhotoUrl(failingLog.id, 'meal-photos/will-fail');
    await markDeleted(failingUser.id, new Date(Date.now() - GRACE_PERIOD_MS - 60_000));

    const okUser = await createUser(`+1${Date.now()}5`);
    await createMealLog(okUser.id, fakeCandidate(), 'photo', '2026-01-01');
    await markDeleted(okUser.id, new Date(Date.now() - GRACE_PERIOD_MS - 60_000));

    const deleteObject = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'meal-photos/will-fail') {
        throw new Error('simulated S3 failure');
      }
    });
    const objectStore = fakeObjectStore(deleteObject);

    await expect(runDeletionPurgeTick(objectStore, new Date(), GRACE_PERIOD_MS)).resolves.toBeUndefined();

    // The failing user's photo delete threw before its meal_log rows or PII
    // were touched, so both are still intact — safe to retry next tick.
    const failingStillThere = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [
      failingUser.id,
    ]);
    expect(failingStillThere.rows).toHaveLength(1);
    const failingUserRow = await getUserById(failingUser.id);
    expect(failingUserRow?.deletedRequestedAt).not.toBeNull();

    // The other user's purge completed normally.
    const okStillThere = await getPool().query('SELECT * FROM meal_log WHERE user_id = $1', [okUser.id]);
    expect(okStillThere.rows).toHaveLength(0);
    const okUserRow = await getUserById(okUser.id);
    expect(okUserRow?.deletedRequestedAt).toBeNull();
  });

  afterAll(async () => {
    await getPool().end();
  });
});
