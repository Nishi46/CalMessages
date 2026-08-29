import Stripe from 'stripe';
import {
  createGoal,
  createUser,
  getPool,
  getSubscriptionStatus,
  getUserByPhone,
  upsertSubscriptionFromCheckout,
} from '@tally/db-consumer';
import type { TwilioSendClient } from '@tally/messaging';
import type { MealCandidate } from '@tally/shared-types';
import type { TextParser, VisionProvider } from '@tally/vision';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createInboundMessageHandler } from '../lib/router.js';
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
      objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
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
});

function fakeCandidate(overrides: Partial<MealCandidate> = {}): MealCandidate {
  return {
    items: [{ name: 'eggs', portion: '3', calories: 210, protein: 18, carbs: 2, fat: 15 }],
    calories: 210,
    protein: 18,
    carbs: 2,
    fat: 15,
    confidence: 'high',
    isFood: true,
    ...overrides,
  };
}

function noTextParser(): TextParser {
  return { parse: vi.fn().mockRejectedValue(new Error('textParser should not be called')) };
}

// 11 breakdown §F step 20: the whole checkout round trip told as one
// continuous script — a user hits the free-tier limit, gets the paywall,
// "completes checkout" via the real webhook route, and resumes logging with
// no re-onboarding. Uses createInboundMessageHandler directly (like every
// router.test.ts scenario) for the messaging side, and the real
// registerStripeWebhookRoute (via buildApp + app.inject) for the checkout
// side — the one piece this test actually needs to exercise at the HTTP
// layer, since that's where signature verification and idempotency live.
describe('awaiting_checkout -> idle round trip (11 breakdown §F step 20, end-to-end)', () => {
  it('hits the limit, pays, resumes logging normally with no re-onboarding — and a replayed checkout event stays a no-op', async () => {
    const phone = `+1${Date.now()}10`;
    const user = await createUser(phone);
    await getPool().query('UPDATE "user" SET conversation_state = $2 WHERE id = $1', [user.id, 'idle']);
    await createGoal(user.id, { type: 'maintain', dailyCalories: 2000, dailyProtein: 150 });
    // One log short of the limit — the very next one crosses it.
    await getPool().query('INSERT INTO subscription (user_id, free_analyses_used) VALUES ($1, 19)', [user.id]);

    const sendClient: TwilioSendClient & { send: ReturnType<typeof vi.fn> } = {
      send: vi.fn().mockResolvedValue({ sid: 'SM_fake' }),
    };
    const checkoutLink = 'https://checkout.stripe.com/c/e2e_fake';
    const handleInboundMessage = createInboundMessageHandler({
      sendClient,
      visionProvider: { recognize: vi.fn().mockResolvedValue(fakeCandidate()) } satisfies VisionProvider,
      textParser: noTextParser(),
      createCheckoutLink: vi.fn().mockResolvedValue(checkoutLink),
    });

    // Turn 1: the log that crosses the limit — delivered in full, followed
    // by the paywall message with a real checkout link.
    await handleInboundMessage({ userId: user.id, photoKey: 'meal-photos/1', currentState: 'idle' });

    expect(sendClient.send).toHaveBeenCalledTimes(2);
    const [, paywallBody] = sendClient.send.mock.calls[1] as [string, string];
    expect(paywallBody).toContain(checkoutLink);
    let current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('awaiting_checkout');

    // Turn 2: "completes checkout" — the real webhook route, signature-
    // verified, exactly as Stripe would call it.
    const app = buildApp(
      {
        authToken: 'twilio_auth_token_fake',
        publicBaseUrl: 'https://example.com',
        resolveOrCreateUser: vi.fn(),
        fetchMedia: vi.fn(),
        objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
        handleInboundMessage: vi.fn(),
        updateMessageEventStatus: vi.fn(),
        stripeSecretKey: STRIPE_SECRET_KEY,
        stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
        sendClient,
      },
      { logger: false },
    );
    const { payload, signature } = signedPayload(
      checkoutSessionCompletedEvent({ client_reference_id: user.id }),
    );

    const checkoutResponse = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });

    expect(checkoutResponse.statusCode).toBe(200);
    expect(sendClient.send).toHaveBeenCalledTimes(3); // + one confirmation text
    const subscriptionAfterCheckout = await getSubscriptionStatus(user.id);
    expect(subscriptionAfterCheckout?.status).toBe('active');
    current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');

    // 11 breakdown §F step 19: the same fixture, replayed — still a no-op,
    // not a second confirmation text and not a second subscription upsert.
    const replayResponse = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(sendClient.send).toHaveBeenCalledTimes(3);
    const { rows: subscriptionRows } = await getPool().query('SELECT id FROM subscription WHERE user_id = $1', [
      user.id,
    ]);
    expect(subscriptionRows).toHaveLength(1);

    // Turn 3: the very next meal photo — logs normally, no re-onboarding
    // prompt, resuming from exactly the 'idle' state normal logging uses
    // (Build Spec §4.6 step 3).
    current = await getUserByPhone(phone);
    await handleInboundMessage({
      userId: user.id,
      photoKey: 'meal-photos/2',
      currentState: current!.conversationState,
    });

    expect(sendClient.send).toHaveBeenCalledTimes(4);
    const [, resumedLogBody] = sendClient.send.mock.calls[3] as [string, string];
    expect(resumedLogBody).toContain('Logged: 210 cal, 18g protein, 2g carbs, 15g fat.');
    expect(resumedLogBody).not.toMatch(/goal|onboard/i);
    current = await getUserByPhone(phone);
    expect(current?.conversationState).toBe('idle');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
