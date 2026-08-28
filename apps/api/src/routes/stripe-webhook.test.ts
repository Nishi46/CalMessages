import Stripe from 'stripe';
import {
  createUser,
  getPool,
  getSubscriptionStatus,
  getUserByPhone,
  upsertSubscriptionFromCheckout,
} from '@tally/db-consumer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server.js';

const STRIPE_SECRET_KEY = 'sk_test_fake';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
const PATH = '/webhooks/stripe';

function signedPayload(event: Record<string, unknown>): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_SECRET_KEY).webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  });
  return { payload, signature };
}

let eventCounter = 0;

// Every id below defaults to a fresh, unique value — event ids because
// idempotency is enforced (11 breakdown §D step 14) and a reused literal
// would make every test after the first look like a replay of the first and
// get silently skipped; Stripe customer/subscription ids because
// stripe_subscription_id is uniquely constrained (11 breakdown §E) and a
// reused literal collides with a still-live row from a previous run. Tests
// that specifically exercise replay behavior pass the same signed payload
// to app.inject twice instead of building a fresh event twice, so they're
// unaffected.
function uniqueId(prefix: string): string {
  eventCounter += 1;
  return `${prefix}_${Date.now()}_${eventCounter}`;
}

function checkoutSessionCompletedEvent(
  overrides: Partial<{ client_reference_id: string | null; customer: string | null; subscription: string | null }> = {},
): Record<string, unknown> {
  return {
    id: uniqueId('evt_test'),
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: uniqueId('cs_test'),
        object: 'checkout.session',
        client_reference_id: 'user-123',
        customer: uniqueId('cus_test'),
        subscription: uniqueId('sub_test'),
        ...overrides,
      },
    },
  };
}

function subscriptionStatusEvent(
  type: 'customer.subscription.updated' | 'customer.subscription.deleted',
  overrides: Partial<{ id: string; status: string }> = {},
): Record<string, unknown> {
  return {
    id: uniqueId('evt_test'),
    object: 'event',
    type,
    data: {
      object: {
        id: uniqueId('sub_test'),
        object: 'subscription',
        status: 'past_due',
        ...overrides,
      },
    },
  };
}

function buildTestApp() {
  return buildApp(
    {
      authToken: 'twilio_auth_token_fake',
      publicBaseUrl: 'https://example.com',
      resolveOrCreateUser: vi.fn(),
      fetchMedia: vi.fn(),
      objectStore: { putObject: vi.fn(), getObject: vi.fn() },
      handleInboundMessage: vi.fn(),
      updateMessageEventStatus: vi.fn(),
      stripeSecretKey: STRIPE_SECRET_KEY,
      stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
      sendClient: { send: vi.fn().mockResolvedValue({ sid: 'SM_fake' }) },
    },
    { logger: false },
  );
}

describe('POST /webhooks/stripe — signature verification', () => {
  it('rejects a request with an invalid signature and never processes the event', async () => {
    const app = buildTestApp();
    const { payload } = signedPayload(checkoutSessionCompletedEvent());

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'stripe-signature': 't=1,v1=not-a-real-signature',
        'content-type': 'application/json',
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a request with a missing signature header', async () => {
    const app = buildTestApp();
    const { payload } = signedPayload(checkoutSessionCompletedEvent());

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /webhooks/stripe — checkout.session.completed (11 breakdown §C step 13, against a real Postgres)', () => {
  it('upserts the subscription, transitions awaiting_checkout -> idle, and sends one confirmation text', async () => {
    const phone = `+1${Date.now()}`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'awaiting_checkout']);
    const app = buildTestApp();
    const customerId = uniqueId('cus_real_flow');
    const subscriptionId = uniqueId('sub_real_flow');
    const { payload, signature } = signedPayload(
      checkoutSessionCompletedEvent({
        client_reference_id: user.id,
        customer: customerId,
        subscription: subscriptionId,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(200);

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active');
    expect(subscription?.stripeCustomerId).toBe(customerId);
    expect(subscription?.stripeSubscriptionId).toBe(subscriptionId);

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const { rows } = await getPool().query<{ type: string }>(
      'SELECT type FROM message_event WHERE user_id = $1',
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('system');
  });

  it('is a no-op (no confirmation text, no state change) when the user is not in awaiting_checkout', async () => {
    const phone = `+1${Date.now()}1`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      checkoutSessionCompletedEvent({ client_reference_id: user.id }),
    );

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(200);

    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    const { rows } = await getPool().query('SELECT 1 FROM message_event WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);

    // The subscription upsert itself isn't gated on conversation_state — a
    // duplicate delivery re-applying the same values is harmless (04 §8.3
    // notes idempotency is handled separately, 11 breakdown §D).
    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active');
  });

  it('replaying the same event a second time does not send a second confirmation text', async () => {
    const phone = `+1${Date.now()}2`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'awaiting_checkout']);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      checkoutSessionCompletedEvent({ client_reference_id: user.id }),
    );

    const first = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
    expect(first.statusCode).toBe(200);

    // 11 breakdown §D step 14: same fixture (same event id), replayed. Reset
    // the user back to 'awaiting_checkout' first — if this were only ever
    // protected by resolveTransition falling back on the user's real state
    // (the incidental protection §C step 13 landed with, before this event-
    // ID dedup existed), that reset would defeat it and a second text would
    // go out. It doesn't, because hasProcessedStripeEvent now catches the
    // replay before any of that logic even runs.
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'awaiting_checkout']);
    const second = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
    expect(second.statusCode).toBe(200);

    const { rows } = await getPool().query('SELECT 1 FROM message_event WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
    // The user is left exactly where the reset put it — the replay never
    // reached updateUserState either.
    const current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_checkout');
  });

  it('records the Stripe event id in processed_stripe_event after handling it', async () => {
    const phone = `+1${Date.now()}3`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'awaiting_checkout']);
    const app = buildTestApp();
    const event = checkoutSessionCompletedEvent({ client_reference_id: user.id });
    const { payload, signature } = signedPayload(event);

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    const { rows } = await getPool().query('SELECT 1 FROM processed_stripe_event WHERE id = $1', [event.id]);
    expect(rows).toHaveLength(1);
  });
});

describe('POST /webhooks/stripe — subscription lifecycle backstop (11 breakdown §E step 15, against a real Postgres)', () => {
  it('customer.subscription.updated sets status to past_due', async () => {
    const user = await createUser(`+1${Date.now()}4`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      subscriptionStatusEvent('customer.subscription.updated', { id: subscriptionId, status: 'past_due' }),
    );

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('past_due');
  });

  it('customer.subscription.updated recovering to active sets status back to active', async () => {
    const user = await createUser(`+1${Date.now()}5`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    await getPool().query(`UPDATE subscription SET status = 'past_due' WHERE user_id = $1`, [user.id]);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      subscriptionStatusEvent('customer.subscription.updated', { id: subscriptionId, status: 'active' }),
    );

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active');
  });

  it('customer.subscription.deleted sets status to canceled regardless of the object\'s own status field', async () => {
    const user = await createUser(`+1${Date.now()}6`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    const app = buildTestApp();
    // Stripe's deleted subscription object still reports status: 'canceled'
    // itself in practice, but the handler keys off the event type, not this
    // field — set to something else here to prove that.
    const { payload, signature } = signedPayload(
      subscriptionStatusEvent('customer.subscription.deleted', { id: subscriptionId, status: 'active' }),
    );

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('canceled');
  });

  it('stamps stripe_synced_at on the row it updates', async () => {
    const user = await createUser(`+1${Date.now()}7`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    await getPool().query(`UPDATE subscription SET stripe_synced_at = NULL WHERE user_id = $1`, [user.id]);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      subscriptionStatusEvent('customer.subscription.updated', { id: subscriptionId, status: 'past_due' }),
    );

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.stripeSyncedAt).not.toBeNull();
  });

  it('an unrecognized Stripe status is still marked processed, without writing a status', async () => {
    const user = await createUser(`+1${Date.now()}8`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    const app = buildTestApp();
    const event = subscriptionStatusEvent('customer.subscription.updated', {
      id: subscriptionId,
      status: 'incomplete',
    });
    const { payload, signature } = signedPayload(event);

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active'); // unchanged from upsertSubscriptionFromCheckout's default
    const { rows } = await getPool().query('SELECT 1 FROM processed_stripe_event WHERE id = $1', [event.id]);
    expect(rows).toHaveLength(1);
  });

  it('replaying the same subscription.updated event a second time is a no-op the second time', async () => {
    const user = await createUser(`+1${Date.now()}9`);
    const subscriptionId = uniqueId('sub_lifecycle');
    await upsertSubscriptionFromCheckout(user.id, uniqueId('cus_lifecycle'), subscriptionId);
    const app = buildTestApp();
    const { payload, signature } = signedPayload(
      subscriptionStatusEvent('customer.subscription.updated', { id: subscriptionId, status: 'past_due' }),
    );

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
    // Recover to active locally, out of band — if the replay below actually
    // reprocessed the event, it would stomp this back to past_due.
    await getPool().query(`UPDATE subscription SET status = 'active' WHERE user_id = $1`, [user.id]);

    const second = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(second.statusCode).toBe(200);
    const subscription = await getSubscriptionStatus(user.id);
    expect(subscription?.status).toBe('active');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
