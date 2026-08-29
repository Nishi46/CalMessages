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

  // 12 §A step 4: paused_at is left untouched (the assertion above already
  // covers that — its update has no fifth arg) unless a caller explicitly
  // passes a Date or null.
  it('leaves paused_at untouched when the pausedAt param is omitted', async () => {
    const phone = `+1${Date.now()}1b`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'idle', null, undefined, new Date());

    const updated = await updateUserState(created.id, 'awaiting_checkout');
    expect(updated.pausedAt).not.toBeNull();
  });

  it('stamps paused_at when a Date is passed, and clears it when null is passed', async () => {
    const phone = `+1${Date.now()}1c`;
    const created = await createUser(phone);

    const paused = await updateUserState(created.id, 'paused', null, undefined, new Date());
    expect(paused.pausedAt).not.toBeNull();

    const resumed = await updateUserState(created.id, 'idle', null, undefined, null);
    expect(resumed.pausedAt).toBeNull();
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

  // 12 §A step 3: the filter above was confirmed against a raw SQL write —
  // this confirms it holds now that paused_at is actually set through the
  // real updateUserState write path (12 §A step 4), not just direct SQL.
  it('excludes a user paused via updateUserState, and includes them again once resumed', async () => {
    const phone = `+1${Date.now()}6`;
    const created = await createUser(phone);
    await updateUserState(created.id, 'idle');

    await updateUserState(created.id, 'paused', null, undefined, new Date());
    let active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(false);

    await updateUserState(created.id, 'idle', null, undefined, null);
    active = await getActiveUsersForScheduling();
    expect(active.some((u) => u.id === created.id)).toBe(true);
  });
});

afterAll(async () => {
  await getPool().end();
});
