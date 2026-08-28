import { afterAll, describe, expect, it } from 'vitest';
import { getPool, withTransaction } from './pool.js';
import { hasProcessedStripeEvent, markStripeEventProcessed } from './stripeEvents.js';

describe('stripeEvents (11 breakdown §D step 14, against a real Postgres)', () => {
  it('is false for an event id that has never been marked processed', async () => {
    expect(await hasProcessedStripeEvent(`evt_${Date.now()}`)).toBe(false);
  });

  it('is true once markStripeEventProcessed has recorded the id', async () => {
    const eventId = `evt_${Date.now()}1`;

    await markStripeEventProcessed(eventId);

    expect(await hasProcessedStripeEvent(eventId)).toBe(true);
  });

  it('marking the same event id twice outside a transaction throws (the primary key is the dedup guarantee)', async () => {
    const eventId = `evt_${Date.now()}2`;
    await markStripeEventProcessed(eventId);

    await expect(markStripeEventProcessed(eventId)).rejects.toThrow();
  });

  it('rolls back the marker along with the rest of the transaction on failure', async () => {
    const eventId = `evt_${Date.now()}3`;

    await expect(
      withTransaction(async (client) => {
        await markStripeEventProcessed(eventId, client);
        throw new Error('simulated failure after recording the marker');
      }),
    ).rejects.toThrow('simulated failure after recording the marker');

    expect(await hasProcessedStripeEvent(eventId)).toBe(false);
  });

  afterAll(async () => {
    await getPool().end();
  });
});
