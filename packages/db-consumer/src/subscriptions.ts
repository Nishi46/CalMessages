import type pg from 'pg';
import { getPool, type DbClient } from './pool.js';

export interface Subscription {
  id: string;
  userId: string;
  plan: string;
  status: 'active' | 'past_due' | 'canceled';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  freeAnalysesUsed: number;
  freeAnalysesLimit: number;
  renewsAt: Date | null;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan: string;
  status: Subscription['status'];
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  free_analyses_used: number;
  free_analyses_limit: number;
  renews_at: Date | null;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    plan: row.plan,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    freeAnalysesUsed: row.free_analyses_used,
    freeAnalysesLimit: row.free_analyses_limit,
    renewsAt: row.renews_at,
  };
}

// 11 breakdown §A step 1: the `subscription` table has existed since Sprint
// 1, but nothing inserted into it until the free-tier metering path needs a
// row to increment. ON CONFLICT DO UPDATE (a no-op self-assignment) rather
// than DO NOTHING, because DO NOTHING has no RETURNING row on a conflict —
// this needs the existing row back just as much as a freshly-inserted one.
// Defaults (plan='free', free_analyses_used=0, free_analyses_limit=20) come
// from the table itself, not from this insert.
export async function getOrCreateSubscriptionForUser(userId: string): Promise<Subscription> {
  const { rows } = await getPool().query<SubscriptionRow>(
    `INSERT INTO subscription (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = subscription.user_id
     RETURNING *`,
    [userId],
  );
  return rowToSubscription(rows[0]);
}

// 11 breakdown §A step 2: takes an already-open transaction client rather
// than calling getPool() itself, so the caller (router's fast-path log
// write) can commit this in the same transaction as the meal_log insert
// (04 §8.1). Assumes a subscription row already exists for userId — callers
// are expected to have called getOrCreateSubscriptionForUser first.
export async function incrementFreeAnalysesUsed(
  client: pg.PoolClient,
  userId: string,
): Promise<Subscription> {
  const { rows } = await client.query<SubscriptionRow>(
    `UPDATE subscription SET free_analyses_used = free_analyses_used + 1
     WHERE user_id = $1
     RETURNING *`,
    [userId],
  );
  return rowToSubscription(rows[0]);
}

// 11 breakdown §A step 5: for the checkout webhook handler (§C) to look up a
// user's current plan/usage state before deciding what to do.
export async function getSubscriptionStatus(userId: string): Promise<Subscription | null> {
  const { rows } = await getPool().query<SubscriptionRow>(
    `SELECT * FROM subscription WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

// 11 breakdown §A step 5: called from checkout.session.completed (§C step
// 13). ON CONFLICT (user_id) rather than an assumed-existing UPDATE, since a
// user who somehow reaches checkout before ever logging a meal (and so
// before getOrCreateSubscriptionForUser has run) would otherwise have no row
// for this to update. `client` defaults to the pool so §C's usage is
// unaffected — 11 breakdown §D step 14 passes an open transaction client
// here instead, so this write and the processed_stripe_event marker commit
// atomically.
export async function upsertSubscriptionFromCheckout(
  userId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  client: DbClient = getPool(),
): Promise<Subscription> {
  const { rows } = await client.query<SubscriptionRow>(
    `INSERT INTO subscription (user_id, status, stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'active', $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET status = 'active', stripe_customer_id = $2, stripe_subscription_id = $3
     RETURNING *`,
    [userId, stripeCustomerId, stripeSubscriptionId],
  );
  return rowToSubscription(rows[0]);
}
