import Stripe from 'stripe';
import { createUser, getPool, getSubscriptionStatus, getUserByPhone } from '@tally/db-consumer';
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

function checkoutSessionCompletedEvent(
  overrides: Partial<{ client_reference_id: string | null; customer: string | null; subscription: string | null }> = {},
): Record<string, unknown> {
  return {
    id: 'evt_test_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: 'user-123',
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
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
    const { payload, signature } = signedPayload(
      checkoutSessionCompletedEvent({
        client_reference_id: user.id,
        customer: 'cus_real_flow',
        subscription: 'sub_real_flow',
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
    expect(subscription?.stripeCustomerId).toBe('cus_real_flow');
    expect(subscription?.stripeSubscriptionId).toBe('sub_real_flow');

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

    // Same fixture, replayed — the route doesn't dedup on Stripe's event ID
    // yet (that's 11 breakdown §D), but by the second delivery the user is
    // already back in 'idle', so resolveTransition('idle', 'checkout_completed')
    // falls back to a no-op rather than sending a second text.
    const second = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
    expect(second.statusCode).toBe(200);

    const { rows } = await getPool().query('SELECT 1 FROM message_event WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });

  afterAll(async () => {
    await getPool().end();
  });
});
