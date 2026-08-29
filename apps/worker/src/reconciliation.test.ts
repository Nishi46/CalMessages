import {
  createUser,
  getPool,
  getSubscriptionStatus,
  uniqueTestPhone,
  upsertSubscriptionFromCheckout,
} from '@tally/db-consumer';
import type { SubscriptionStatusClient } from '@tally/billing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runReconciliationTick } from './reconciliation.js';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function fakeStatusClient(getSubscriptionStatus: SubscriptionStatusClient['getSubscriptionStatus']): SubscriptionStatusClient {
  return { getSubscriptionStatus };
}

// subscription.stripe_subscription_id is uniquely constrained (11 breakdown
// §E) — every fixture needs its own id, not a fixed literal reused across
// runs, or a repeat test run collides with a still-live row from a previous
// one.
let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

describe('runReconciliationTick (11 breakdown §E step 16, against a real Postgres)', () => {
  it('syncs a subscription that has never been synced', async () => {
    const user = await createUser(uniqueTestPhone());
    const stripeSubscriptionId = uniqueId('sub_recon');
    await getPool().query(
      `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'active', $2, $3)`,
      [user.id, uniqueId('cus_recon'), stripeSubscriptionId],
    );
    const client = fakeStatusClient(vi.fn().mockResolvedValue('past_due'));

    await runReconciliationTick(client, new Date(), STALE_AFTER_MS);

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('past_due');
    expect(subscription?.stripeSyncedAt).not.toBeNull();
    expect(client.getSubscriptionStatus).toHaveBeenCalledWith(stripeSubscriptionId);
  });

  it('syncs a subscription last synced before staleSince, skips one synced after it', async () => {
    const staleUser = await createUser(uniqueTestPhone());
    const staleSubId = uniqueId('sub_recon');
    await upsertSubscriptionFromCheckout(staleUser.id, uniqueId('cus_recon'), staleSubId);
    await getPool().query(`UPDATE subscription SET stripe_synced_at = now() - interval '2 days' WHERE user_id = $1`, [
      staleUser.id,
    ]);

    const freshUser = await createUser(uniqueTestPhone());
    const freshSubId = uniqueId('sub_recon');
    await upsertSubscriptionFromCheckout(freshUser.id, uniqueId('cus_recon'), freshSubId);

    const client = fakeStatusClient(vi.fn().mockResolvedValue('canceled'));

    await runReconciliationTick(client, new Date(), STALE_AFTER_MS);

    expect(client.getSubscriptionStatus).toHaveBeenCalledWith(staleSubId);
    expect(client.getSubscriptionStatus).not.toHaveBeenCalledWith(freshSubId);

    const staleSubscription = await getSubscriptionStatus(staleUser.id);
    expect(staleSubscription?.status).toBe('canceled');
    const freshSubscription = await getSubscriptionStatus(freshUser.id);
    expect(freshSubscription?.status).toBe('active');
  });

  it('ignores a free-tier row with no stripe_subscription_id', async () => {
    const user = await createUser(uniqueTestPhone());
    await getPool().query(`INSERT INTO subscription (user_id) VALUES ($1)`, [user.id]);
    const client = fakeStatusClient(vi.fn());

    await runReconciliationTick(client, new Date(), STALE_AFTER_MS);

    expect(client.getSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('leaves stripe_synced_at untouched when Stripe reports a status with no confident local mapping', async () => {
    const user = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'active', $2, $3)`,
      [user.id, uniqueId('cus_recon'), uniqueId('sub_recon')],
    );
    const client = fakeStatusClient(vi.fn().mockResolvedValue(null));

    await runReconciliationTick(client, new Date(), STALE_AFTER_MS);

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active'); // unchanged
    expect(subscription?.stripeSyncedAt).toBeNull(); // still eligible next tick
  });

  it('one account failing does not stop the rest of the sweep from being reconciled', async () => {
    const failingUser = await createUser(uniqueTestPhone());
    const failingSubId = uniqueId('sub_recon');
    await getPool().query(
      `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'active', $2, $3)`,
      [failingUser.id, uniqueId('cus_recon'), failingSubId],
    );
    const okUser = await createUser(uniqueTestPhone());
    await getPool().query(
      `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'active', $2, $3)`,
      [okUser.id, uniqueId('cus_recon'), uniqueId('sub_recon')],
    );
    const client = fakeStatusClient(
      vi.fn().mockImplementation(async (stripeSubscriptionId: string) => {
        if (stripeSubscriptionId === failingSubId) {
          throw new Error('simulated Stripe API failure');
        }
        return 'past_due';
      }),
    );

    await expect(runReconciliationTick(client, new Date(), STALE_AFTER_MS)).resolves.toBeUndefined();

    const okSubscription = await getSubscriptionStatus(okUser.id);
    expect(okSubscription?.status).toBe('past_due');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
