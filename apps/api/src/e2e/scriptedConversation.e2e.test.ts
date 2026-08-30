import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import {
  getOrCreateSubscriptionForUser,
  getPool,
  getSubscriptionStatus,
  getUserByPhone,
  uniqueTestPhone,
} from '@tally/db-consumer';
import { createCheckoutLink, createStripeCheckoutClient, type CheckoutClient } from '@tally/billing';
import { createTwilioSendClient, type TwilioSendClient } from '@tally/messaging';
import type { MealCandidate } from '@tally/shared-types';
import type { TextParser, VisionProvider } from '@tally/vision';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createInboundMessageHandler } from '../lib/router.js';
import { resolveOrCreateUser } from '../lib/users.js';
import { buildApp } from '../server.js';

// 13 breakdown §C (04 §14's "Conversation simulation" row): the whole
// build's individually-tested pieces (onboarding — 07 §D; meal logging —
// 09 §D; correction — 09 §E; paywall — 11 §B; checkout — 11 §C/§F) stitched
// into one continuous script, driven through the REAL HTTP webhook routes
// (registerTwilioInboundRoute, registerStripeWebhookRoute via buildApp +
// app.inject) with genuinely-computed signatures, rather than calling
// createInboundMessageHandler directly the way every other test in this repo
// does. That's the actual gap this step closes versus router.test.ts's own
// "end-to-end scripted flows" (09 §G) and stripe-webhook.test.ts's
// "awaiting_checkout -> idle round trip" (11 §F step 20): both already
// script multiple turns together, but neither goes through the Twilio
// inbound route at all — sendMessage/webhook dispatch was always mocked or
// bypassed. This file adds that missing leg for the inbound-signature-
// verification/dispatch wiring itself.
//
// What "real Twilio infrastructure" can and can't mean here, concretely:
//   - Inbound: Twilio calling back into this app requires a URL Twilio can
//     reach. There is no such URL in this environment, live or not — so
//     every inbound turn below is a *synthetic* webhook POST (this test
//     plays Twilio's role), never a message actually round-tripped through
//     Twilio's network. That's true regardless of live/fake mode.
//   - Outbound sends: genuinely real when LIVE_TWILIO is on below (real
//     network call to Twilio's Messages API via @tally/messaging's real
//     client) — this is the one leg that can actually be "real
//     infrastructure," and is gated off by default (see LIVE_TWILIO).
//   - Stripe checkout-session creation: same story as outbound sends, gated
//     by LIVE_STRIPE — and currently unreachable regardless of the flag,
//     since STRIPE_SECRET_KEY/STRIPE_PRICE_ID are unset in this repo's .env.
//   - Stripe webhook receipt: same limitation as Twilio inbound — always
//     synthetic, this test signs its own event with a locally-shared
//     webhook secret (exactly what stripe-webhook.test.ts's existing
//     precedent already does), live Stripe or not.
//
// 13 breakdown §C step 8's explicit warning, and worse than that step's own
// framing assumes: this account (AC7a48805257d9449516209e2bcbed2ff9, Trial
// tier, A2P still unfiled as of the Sprint 7 close-out re-check, 2026-08-29)
// doesn't just override outbound copy with a canned template — live-tested
// that same session, sending to a destination number that isn't on the
// account's verified-recipient list FAILS OUTRIGHT (Twilio error 572002,
// "No Twilio trial phone number is assigned for messaging to this
// destination number... add the 'to' number as a verified recipient"). And
// because handleInboundMessage only calls updateUserState() *after*
// applySideEffects' sendReply resolves, a failed send doesn't just mean
// "wrong copy" — it silently drops the entire state transition, confirmed
// live against this exact router.ts codepath. Concretely: running this file
// with LIVE_TWILIO on and E2E_TEST_PHONE_NUMBER pointed at a number that
// ISN'T a verified recipient on this account will not produce a green run
// with wrong copy — every waitUntilSendCount call below will time out, because
// the very first sendReply throws before conversation_state ever updates.
// E2E_TEST_PHONE_NUMBER must be added as a verified recipient (or the
// account upgraded + A2P filed) before LIVE_TWILIO can do anything useful
// here at all. Even once it can send, every assertion below reads
// sendClient.send's call arguments — what this app *tried* to send, correct
// and meaningful regardless of Trial-tier — which is NOT proof of what the
// phone actually received (the milder canned-template-override failure mode
// still applies for a verified recipient). A green run here, live or not,
// does not by itself clear 13 breakdown §E's A2P blocker. See the
// console.warn LIVE_TWILIO emits below for the same reminder at run time.

// --- Live-infrastructure gating -------------------------------------------
// Opt-in only: unset by default, so `npm run test` (and CI) never touches
// real Twilio/Stripe or sends a real SMS. Each requires BOTH its own flag
// AND real credentials actually present — flipping the flag alone with
// blank creds still runs the safe, fully-mocked path.
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthTokenEnv = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
// A real destination number the operator controls, deliberately not
// hardcoded or inferred — sending a real SMS to an unconsented real number
// would be a genuine harm, so live mode simply can't activate without a
// human explicitly supplying one.
const e2eTestPhoneNumber = process.env.E2E_TEST_PHONE_NUMBER;

const LIVE_TWILIO =
  process.env.E2E_LIVE_TWILIO === 'true' &&
  Boolean(twilioAccountSid) &&
  Boolean(twilioAuthTokenEnv) &&
  Boolean(twilioPhoneNumber) &&
  Boolean(e2eTestPhoneNumber);

const stripeSecretKeyEnv = process.env.STRIPE_SECRET_KEY;
const stripePriceIdEnv = process.env.STRIPE_PRICE_ID;
const LIVE_STRIPE =
  process.env.E2E_LIVE_STRIPE === 'true' && Boolean(stripeSecretKeyEnv) && Boolean(stripePriceIdEnv);

const PUBLIC_BASE_URL = 'https://example.com';
const TWILIO_AUTH_TOKEN = LIVE_TWILIO ? twilioAuthTokenEnv! : 'e2e_fake_twilio_auth_token';
// Webhook *receipt* is always synthetic (see the file-header note) — this
// secret only has to match between this file's own signer and the route's
// own verifier, never a real Stripe value, live checkout-creation or not.
const STRIPE_WEBHOOK_SECRET = 'whsec_e2e_fake';
const STRIPE_SECRET_KEY = LIVE_STRIPE ? stripeSecretKeyEnv! : 'sk_test_e2e_fake';

// Twilio's own signature algorithm (docs: "Validating Signatures from
// Twilio"), hand-rolled the same way twilio-inbound.test.ts does — produces
// a signature the real route's twilio.validateRequest will actually accept.
function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function postTwilioInbound(
  app: ReturnType<typeof buildApp>,
  params: Record<string, string>,
): Promise<void> {
  const url = new URL('/webhooks/twilio/inbound', PUBLIC_BASE_URL).toString();
  const signature = computeTwilioSignature(TWILIO_AUTH_TOKEN, url, params);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/twilio/inbound',
    headers: {
      'x-twilio-signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams(params).toString(),
  });
  expect(response.statusCode).toBe(200);
}

// twilio-inbound.ts dispatches to handleInboundMessage without awaiting
// (Twilio retries a slow-to-respond webhook), so app.inject() resolving
// doesn't mean the state transition/send has landed yet — poll instead of
// guessing a fixed delay, same technique router.test.ts's own waitUntil uses.
async function waitUntilSendCount(
  sendClient: { send: ReturnType<typeof vi.fn> },
  expectedCount: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (sendClient.send.mock.calls.length < expectedCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitUntilSendCount: expected ${expectedCount} send() calls, still at ${sendClient.send.mock.calls.length} after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function scriptedTextParser(byText: Record<string, MealCandidate>): TextParser {
  return {
    parse: vi.fn(async (text: string) => {
      const candidate = byText[text];
      if (!candidate) {
        throw new Error(`scriptedTextParser: no fixture registered for text ${JSON.stringify(text)}`);
      }
      return candidate;
    }),
  };
}

function noVisionProvider(): VisionProvider {
  return { recognize: vi.fn().mockRejectedValue(new Error('visionProvider should not be called — this script is text-only')) };
}

// Text-only throughout (no photoKey), per Build Spec §4.2's "text-only entry
// ... fully supported from P0" — sidesteps fetchMedia/objectStore entirely,
// which is real infrastructure of its own (S3) that 04 §14/13 breakdown §C
// don't ask this step to cover; Twilio infra is the thing under test here.
const LOW_CONFIDENCE_LOG_TEXT = 'some scrambled eggs, not totally sure how many';
const CLARIFICATION_ANSWER_TEXT = 'it was 3 eggs';
const CORRECTION_TEXT = 'actually that was 2 eggs, not 3';
const PAYWALL_CROSSING_LOG_TEXT = 'protein shake, unflavored';
const POST_CHECKOUT_LOG_TEXT = 'grilled chicken and rice';

const heldCandidate: MealCandidate = {
  items: [{ name: 'eggs', portion: '3', calories: 180, protein: 14, carbs: 2, fat: 12 }],
  calories: 180,
  protein: 14,
  carbs: 2,
  fat: 12,
  confidence: 'low',
  isFood: true,
};
const correctionCandidate: MealCandidate = {
  items: [{ name: 'eggs', portion: '2', calories: 150, protein: 12, carbs: 3, fat: 9 }],
  calories: 150,
  protein: 12,
  carbs: 3,
  fat: 9,
  confidence: 'high',
  isFood: true,
};
const paywallCandidate: MealCandidate = {
  items: [{ name: 'protein shake', portion: '1', calories: 300, protein: 25, carbs: 10, fat: 15 }],
  calories: 300,
  protein: 25,
  carbs: 10,
  fat: 15,
  confidence: 'high',
  isFood: true,
};
const postCheckoutCandidate: MealCandidate = {
  items: [{ name: 'chicken and rice', portion: '1', calories: 620, protein: 45, carbs: 60, fat: 12 }],
  calories: 620,
  protein: 45,
  carbs: 60,
  fat: 12,
  confidence: 'high',
  isFood: true,
};

function signedStripeCheckoutCompleted(userId: string): { payload: string; signature: string } {
  const event = {
    id: `evt_e2e_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${Date.now()}`,
        object: 'checkout.session',
        client_reference_id: userId,
        customer: `cus_e2e_${Date.now()}`,
        subscription: `sub_e2e_${Date.now()}`,
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_SECRET_KEY).webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  });
  return { payload, signature };
}

describe('Scripted conversation: onboarding -> log -> correction -> paywall -> checkout (13 breakdown §C, 04 §14)', () => {
  it(
    'walks the full state machine through a real Twilio-signed inbound route and a real Stripe-signed checkout webhook',
    async () => {
      const phone = LIVE_TWILIO ? e2eTestPhoneNumber! : uniqueTestPhone();

      const sendClient: TwilioSendClient & { send: ReturnType<typeof vi.fn> } = LIVE_TWILIO
        ? (() => {
            const real = createTwilioSendClient({
              accountSid: twilioAccountSid!,
              authToken: twilioAuthTokenEnv!,
              fromNumber: twilioPhoneNumber!,
            });
            // 13 breakdown §C step 8: the loud, unmissable version of the
            // file-header caveat — printed only when a real send is about to
            // happen, so it can't be missed in CI output where LIVE_TWILIO
            // is never on.
            console.warn(
              `[e2e] LIVE_TWILIO is on — sending real SMS via Twilio to ${e2eTestPhoneNumber}. ` +
                'If this account is still Trial-tier and this number is NOT on its verified-recipient ' +
                'list, every send below will THROW (Twilio error 572002) and the whole script will time ' +
                'out waiting for a state transition that never happens — add it as a verified recipient ' +
                'first. If it IS verified, Trial-tier still silently substitutes a canned template on ' +
                "actual delivery — a passing assertion below only proves this app called Twilio's API " +
                'with the right copy and got a real message SID back, NOT that the phone received that ' +
                'copy. Manually verify the received texts.',
            );
            return { send: vi.fn((to: string, body: string) => real.send(to, body)) };
          })()
        : { send: vi.fn().mockResolvedValue({ sid: 'SM_e2e_fake' }) };

      const createCheckoutLinkFn: (userId: string) => Promise<string> = LIVE_STRIPE
        ? (() => {
            const client: CheckoutClient = createStripeCheckoutClient({
              secretKey: stripeSecretKeyEnv!,
              priceId: stripePriceIdEnv!,
            });
            return (userId: string) =>
              createCheckoutLink(client, userId, {
                successUrl: 'https://example.com/checkout/success',
                cancelUrl: 'https://example.com/checkout/cancel',
              });
          })()
        : vi.fn().mockResolvedValue('https://checkout.stripe.com/c/e2e_fake');

      const textParser = scriptedTextParser({
        [LOW_CONFIDENCE_LOG_TEXT]: heldCandidate,
        [CORRECTION_TEXT]: correctionCandidate,
        [PAYWALL_CROSSING_LOG_TEXT]: paywallCandidate,
        [POST_CHECKOUT_LOG_TEXT]: postCheckoutCandidate,
      });

      const handleInboundMessage = createInboundMessageHandler({
        sendClient,
        visionProvider: noVisionProvider(),
        textParser,
        createCheckoutLink: createCheckoutLinkFn,
      });

      const app = buildApp(
        {
          authToken: TWILIO_AUTH_TOKEN,
          publicBaseUrl: PUBLIC_BASE_URL,
          resolveOrCreateUser,
          fetchMedia: vi.fn().mockRejectedValue(new Error('fetchMedia should not be called — text-only script')),
          objectStore: {
            putObject: vi.fn().mockRejectedValue(new Error('objectStore should not be called — text-only script')),
            getObject: vi.fn(),
            deleteObject: vi.fn(),
          },
          handleInboundMessage,
          setUserOptOut: vi.fn(),
          updateMessageEventStatus: vi.fn(),
          stripeSecretKey: STRIPE_SECRET_KEY,
          stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
          sendClient,
        },
        { logger: false },
      );

      let sendCount = 0;

      // --- Onboarding: new -> onboarding_q1 -> onboarding_q2 -> onboarding_q3 -> idle ---
      // (Build Spec §4.1's transcript, same inputs as router.test.ts's
      // onboarding test — reused deliberately so the deterministic default-goal
      // computation this script depends on is already independently verified.)
      await postTwilioInbound(app, { From: phone, Body: 'hi' });
      await waitUntilSendCount(sendClient, ++sendCount);
      let user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('onboarding_q1');
      expect(sendClient.send.mock.calls[0]?.[1]).toContain("What's the goal");

      await postTwilioInbound(app, { From: phone, Body: 'lose weight, on a glp1' });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('onboarding_q2');

      await postTwilioInbound(app, { From: phone, Body: '190lbs, no target given' });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('onboarding_q3');

      await postTwilioInbound(app, { From: phone, Body: 'no' });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('idle');
      expect(sendClient.send.mock.calls[3]?.[1]).toContain('1650 cal and 120g protein');
      const userId = user!.id;

      // --- Meal log: idle -> awaiting_clarification (low confidence) -> idle ---
      await postTwilioInbound(app, { From: phone, Body: LOW_CONFIDENCE_LOG_TEXT });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('awaiting_clarification');
      expect(sendClient.send.mock.calls[4]?.[1]).toBe('Got a partial read. What was it, roughly?');

      await postTwilioInbound(app, { From: phone, Body: CLARIFICATION_ANSWER_TEXT });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('idle');
      expect(sendClient.send.mock.calls[5]?.[1]).toBe(
        'Logged: 180 cal, 14g protein, 2g carbs, 12g fat.\n\nToday: 180/1650 cal so far.',
      );

      // --- Correction: idle -> idle (side-effect only) ---
      await postTwilioInbound(app, { From: phone, Body: CORRECTION_TEXT });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('idle');
      expect(sendClient.send.mock.calls[6]?.[1]).toBe(
        'Updated — that entry is now 150 cal, 12g protein, 3g carbs, 9g fat. Total for that day is now 330 cal.',
      );

      // --- Paywall: idle -> awaiting_checkout ---
      // Sets the counter directly to one below the limit rather than sending
      // ~17 more scripted logs — the crossing arithmetic itself (11 breakdown
      // §B step 7) is already covered in isolation by subscriptions.test.ts
      // and router.test.ts; what this step needs to prove is that crossing it
      // through the real HTTP route still fires the paywall transition and a
      // real-shaped checkout link makes it into the outbound text.
      const subscriptionBeforeLimit = await getOrCreateSubscriptionForUser(userId);
      await getPool().query('UPDATE subscription SET free_analyses_used = $2 WHERE user_id = $1', [
        userId,
        subscriptionBeforeLimit.freeAnalysesLimit - 1,
      ]);

      await postTwilioInbound(app, { From: phone, Body: PAYWALL_CROSSING_LOG_TEXT });
      await waitUntilSendCount(sendClient, (sendCount += 2)); // log reply + paywall reply
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('awaiting_checkout');
      expect(sendClient.send.mock.calls[7]?.[1]).toContain('Logged: 300 cal'); // the crossing log, delivered in full
      const paywallBody = sendClient.send.mock.calls[8]?.[1] as string;
      expect(paywallBody).toContain("You've used all your free logs.");
      expect(paywallBody).toContain('checkout.stripe.com');

      // --- Checkout: awaiting_checkout -> idle, via the real Stripe webhook route ---
      const { payload, signature } = signedStripeCheckoutCompleted(userId);
      const checkoutResponse = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload,
      });
      expect(checkoutResponse.statusCode).toBe(200);
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('idle');
      expect(sendClient.send.mock.calls[9]?.[1]).toBe(
        "You're all set — logging is back on. Send your next meal whenever you're ready.",
      );
      const subscriptionAfterCheckout = await getSubscriptionStatus(userId);
      expect(subscriptionAfterCheckout?.status).toBe('active');

      // Replaying the same signed event stays a no-op (11 breakdown §D step
      // 14's idempotency guarantee) — worth reconfirming here since this is
      // the first time that guarantee is exercised as part of a longer,
      // stateful script rather than in isolation.
      const replayResponse = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload,
      });
      expect(replayResponse.statusCode).toBe(200);
      expect(sendClient.send).toHaveBeenCalledTimes(sendCount); // unchanged

      // --- Resumed logging: idle -> idle, no re-onboarding (Build Spec §4.6 step 3) ---
      await postTwilioInbound(app, { From: phone, Body: POST_CHECKOUT_LOG_TEXT });
      await waitUntilSendCount(sendClient, ++sendCount);
      user = await getUserByPhone(phone);
      expect(user?.conversationState).toBe('idle');
      const resumedBody = sendClient.send.mock.calls[10]?.[1] as string;
      expect(resumedBody).toContain('Logged: 620 cal');
      expect(resumedBody).not.toMatch(/goal|onboard/i);
    },
    LIVE_TWILIO ? 30000 : 10000, // real network calls need real headroom
  );

  afterAll(async () => {
    await getPool().end();
  });
});
