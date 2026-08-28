import { afterAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from './pool.js';
import {
  getOrCreateSubscriptionForUser,
  getStaleSubscriptions,
  getSubscriptionStatus,
  incrementFreeAnalysesUsed,
  syncSubscriptionStatusFromStripe,
  upsertSubscriptionFromCheckout,
} from './subscriptions.js';
import { createUser } from './users.js';

// stripe_subscription_id is uniquely constrained (11 breakdown §E) — every
// fixture needs its own id, not a fixed literal reused across runs, or a
// repeat test run collides with a still-live row from a previous one.
let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

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
    const customerId = uniqueId('cus');
    const subscriptionId = uniqueId('sub');

    const sub = await upsertSubscriptionFromCheckout(user.id, customerId, subscriptionId);

    expect(sub.status).toBe('active');
    expect(sub.stripeCustomerId).toBe(customerId);
    expect(sub.stripeSubscriptionId).toBe(subscriptionId);
  });

  it('upsertSubscriptionFromCheckout overwrites an existing row rather than duplicating it', async () => {
    const user = await createUser(`+1${Date.now()}6`);
    const created = await getOrCreateSubscriptionForUser(user.id);
    const customerId = uniqueId('cus');

    const upserted = await upsertSubscriptionFromCheckout(user.id, customerId, uniqueId('sub'));

    expect(upserted.id).toBe(created.id);
    expect(upserted.stripeCustomerId).toBe(customerId);
  });

  it('upsertSubscriptionFromCheckout stamps stripe_synced_at', async () => {
    const user = await createUser(`+1${Date.now()}9`);
    const before = new Date();

    const sub = await upsertSubscriptionFromCheckout(user.id, uniqueId('cus'), uniqueId('sub'));

    expect(sub.stripeSyncedAt).not.toBeNull();
    expect(sub.stripeSyncedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});

describe('syncSubscriptionStatusFromStripe (11 breakdown §E steps 15-16)', () => {
  it('updates status and stamps stripe_synced_at, keyed on stripe_subscription_id', async () => {
    const user = await createUser(`+1${Date.now()}10`);
    const subscriptionId = uniqueId('sub_sync');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_sync'), subscriptionId);

    const updated = await syncSubscriptionStatusFromStripe(subscriptionId, 'past_due');

    expect(updated?.userId).toBe(user.id);
    expect(updated?.status).toBe('past_due');
    expect(updated?.stripeSyncedAt).not.toBeNull();
  });

  it('returns null when no row matches the given stripe_subscription_id', async () => {
    const result = await syncSubscriptionStatusFromStripe(uniqueId('sub_nonexistent'), 'canceled');

    expect(result).toBeNull();
  });
});

describe('getStaleSubscriptions (11 breakdown §E step 16)', () => {
  it('excludes a free-tier row with no stripe_subscription_id', async () => {
    const user = await createUser(`+1${Date.now()}11`);
    await getOrCreateSubscriptionForUser(user.id);

    const stale = await getStaleSubscriptions(new Date(Date.now() + 1000));

    expect(stale.some((s) => s.userId === user.id)).toBe(false);
  });

  it('includes a real subscription that has never been synced', async () => {
    const user = await createUser(`+1${Date.now()}12`);
    // Bypasses upsertSubscriptionFromCheckout (which always stamps
    // stripe_synced_at) so this row simulates one Stripe considers
    // subscribed but this app has never actually confirmed via webhook.
    await getPool().query(
      `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'active', $2, $3)`,
      [user.id, uniqueId('cus_never_synced'), uniqueId('sub_never_synced')],
    );

    const stale = await getStaleSubscriptions(new Date());

    expect(stale.some((s) => s.userId === user.id)).toBe(true);
  });

  it('excludes a subscription synced after staleSince, includes one synced before it', async () => {
    const freshUser = await createUser(`+1${Date.now()}13`);
    await upsertSubscriptionFromCheckout(freshUser.id, uniqueId('cus_fresh'), uniqueId('sub_fresh'));

    const staleUser = await createUser(`+1${Date.now()}14`);
    await upsertSubscriptionFromCheckout(staleUser.id, uniqueId('cus_stale'), uniqueId('sub_stale'));
    await getPool().query(
      `UPDATE subscription SET stripe_synced_at = now() - interval '2 days' WHERE user_id = $1`,
      [staleUser.id],
    );

    const staleSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await getStaleSubscriptions(staleSince);

    expect(stale.some((s) => s.userId === freshUser.id)).toBe(false);
    expect(stale.some((s) => s.userId === staleUser.id)).toBe(true);
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
