import { getPool, type DbClient } from './pool.js';

// 11 breakdown §D step 14 (04 §8.3): checked before any webhook processing
// happens. `client` defaults to the pool since this check runs before a
// transaction is even opened — there's nothing to be atomic with yet.
export async function hasProcessedStripeEvent(eventId: string, client: DbClient = getPool()): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM processed_stripe_event WHERE id = $1) AS exists`,
    [eventId],
  );
  return rows[0].exists;
}

// 11 breakdown §D step 14: always called with an open transaction client
// wrapping the event's own DB-side effects — never after them — so a crash
// between processing and recording the ID can't leave the event half-done
// but still marked unprocessed, which would let a retry double-process it.
export async function markStripeEventProcessed(eventId: string, client: DbClient = getPool()): Promise<void> {
  await client.query(`INSERT INTO processed_stripe_event (id) VALUES ($1)`, [eventId]);
}
