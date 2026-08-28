import { afterAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from './pool.js';
import {
  getOrCreateSubscriptionForUser,
  getSubscriptionStatus,
  incrementFreeAnalysesUsed,
  upsertSubscriptionFromCheckout,
} from './subscriptions.js';
import { createUser } from './users.js';

describe('db-consumer subscriptions (against a real Postgres, per 11 breakdown §A)', () => {
  it('creates a subscription with the table\'s own defaults on first use', async () => {
    const user = await createUser(`+1${Date.now()}`);

    const sub = await getOrCreateSubscriptionForUser(user.id);

    expect(sub.userId).toBe(user.id);
    expect(sub.plan).toBe('free');
    expect(sub.status).toBe('active');
    expect(sub.freeAnalysesUsed).toBe(0);
    expect(sub.freeAnalysesLimit).toBe(20);
  });

  it('returns the existing row on a second call instead of erroring', async () => {
    const user = await createUser(`+1${Date.now()}1`);
    const first = await getOrCreateSubscriptionForUser(user.id);

    const second = await getOrCreateSubscriptionForUser(user.id);

    expect(second.id).toBe(first.id);
    expect(second.freeAnalysesUsed).toBe(first.freeAnalysesUsed);
  });

  it('getSubscriptionStatus returns null when no row exists yet', async () => {
    const user = await createUser(`+1${Date.now()}2`);

    expect(await getSubscriptionStatus(user.id)).toBeNull();
  });

  it('getSubscriptionStatus reflects the current row once one exists', async () => {
    const user = await createUser(`+1${Date.now()}3`);
    await getOrCreateSubscriptionForUser(user.id);

    const status = await getSubscriptionStatus(user.id);
    expect(status?.userId).toBe(user.id);
  });

  it('incrementFreeAnalysesUsed increments within a transaction', async () => {
    const user = await createUser(`+1${Date.now()}4`);
    await getOrCreateSubscriptionForUser(user.id);

    const updated = await withTransaction(async (client) => {
      await incrementFreeAnalysesUsed(client, user.id);
      return incrementFreeAnalysesUsed(client, user.id);
    });

    expect(updated.freeAnalysesUsed).toBe(2);
  });

  it('upsertSubscriptionFromCheckout sets status active and stripe ids, creating a row if none exists', async () => {
    const user = await createUser(`+1${Date.now()}5`);

    const sub = await upsertSubscriptionFromCheckout(user.id, 'cus_123', 'sub_123');

    expect(sub.status).toBe('active');
    expect(sub.stripeCustomerId).toBe('cus_123');
    expect(sub.stripeSubscriptionId).toBe('sub_123');
  });

  it('upsertSubscriptionFromCheckout overwrites an existing row rather than duplicating it', async () => {
    const user = await createUser(`+1${Date.now()}6`);
    const created = await getOrCreateSubscriptionForUser(user.id);

    const upserted = await upsertSubscriptionFromCheckout(user.id, 'cus_456', 'sub_456');

    expect(upserted.id).toBe(created.id);
    expect(upserted.stripeCustomerId).toBe('cus_456');
  });
});

describe('withTransaction (11 breakdown §A step 3)', () => {
  it('commits all writes on success', async () => {
    const user = await createUser(`+1${Date.now()}7`);

    await withTransaction(async (client) => {
      await client.query('UPDATE "user" SET timezone = $2 WHERE id = $1', [user.id, 'America/Chicago']);
    });

    const { rows } = await getPool().query('SELECT timezone FROM "user" WHERE id = $1', [user.id]);
    expect(rows[0].timezone).toBe('America/Chicago');
  });

  it('rolls back every write when fn rejects partway through', async () => {
    const user = await createUser(`+1${Date.now()}8`);

    await expect(
      withTransaction(async (client) => {
        await client.query('UPDATE "user" SET timezone = $2 WHERE id = $1', [user.id, 'America/Chicago']);
        throw new Error('simulated failure between statements');
      }),
    ).rejects.toThrow('simulated failure between statements');

    const { rows } = await getPool().query('SELECT timezone FROM "user" WHERE id = $1', [user.id]);
    expect(rows[0].timezone).toBe('America/New_York');
  });
});

afterAll(async () => {
  await getPool().end();
});
