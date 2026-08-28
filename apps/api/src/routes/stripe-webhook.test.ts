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

let eventCounter = 0;

// Each call gets a fresh event id by default — now that idempotency is
// enforced (11 breakdown §D step 14), reusing one hardcoded id across tests
// would make every test after the first look like a replay of the first and
// get silently skipped. Tests that specifically exercise replay behavior
// pass the same signed payload to app.inject twice instead of calling this
// twice, so they're unaffected.
function checkoutSessionCompletedEvent(
  overrides: Partial<{ client_reference_id: string | null; customer: string | null; subscription: string | null }> = {},
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: `evt_test_${Date.now()}_${eventCounter}`,
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

  afterAll(async () => {
    await getPool().end();
  });
});
