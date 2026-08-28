import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from './pool.js';
import { createUser, getActiveUsersForScheduling, getUserByPhone, updateUserState } from './users.js';

describe('db-consumer users (smoke test against a real Postgres, per breakdown Sprint 1.A step 8)', () => {
  it('creates a user and reads it back by phone', async () => {
    const phone = `+1${Date.now()}`;

    const created = await createUser(phone);
    expect(created.phoneE164).toBe(phone);
    expect(created.conversationState).toBe('new');
    expect(created.planStatus).toBe('free');

    const fetched = await getUserByPhone(phone);
    expect(fetched?.id).toBe(created.id);
  });

  it('returns null for a phone number with no user row', async () => {
    const fetched = await getUserByPhone(`+1${Date.now()}-missing`);
    expect(fetched).toBeNull();
  });

  it('updates conversation state and context', async () => {
    const phone = `+1${Date.now()}1`;
    const created = await createUser(phone);

    const updated = await updateUserState(created.id, 'onboarding_q1', { heldAnswer: 'lose' });
    expect(updated.conversationState).toBe('onboarding_q1');
    expect(updated.conversationContext).toEqual({ heldAnswer: 'lose' });
  });
});

describe('getActiveUsersForScheduling (09 breakdown §C step 7)', () => {
  it('includes an idle user with no opt-out or pause', async () => {
    const phone = `+1${Date.now()}2`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'idle');

    const active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(true);
  });

  it('excludes a user not in the idle state', async () => {
    const phone = `+1${Date.now()}3`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'onboarding_q1');

    const active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(false);
  });

  it('excludes an opted-out user even if idle', async () => {
    const phone = `+1${Date.now()}4`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'idle');
    await getPool().query('UPDATE "user" SET opt_out_at = now() WHERE id = $1', [created.id]);

    const active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(false);
  });

  it('excludes a paused user even if idle', async () => {
    const phone = `+1${Date.now()}5`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'idle');
    await getPool().query('UPDATE "user" SET paused_at = now() WHERE id = $1', [created.id]);

    const active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(false);
  });
});

afterAll(async () => {
  await getPool().end();
});
