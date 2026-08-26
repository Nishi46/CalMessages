import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from './pool.js';
import { createUser, getUserByPhone, updateUserState } from './users.js';

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

  afterAll(async () => {
    await getPool().end();
  });
});
