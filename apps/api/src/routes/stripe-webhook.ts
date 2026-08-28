import Stripe from 'stripe';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { applySideEffects, resolveTransition, type ConversationState } from '@tally/conversation';
import { getUserById, updateUserState, upsertSubscriptionFromCheckout } from '@tally/db-consumer';
import { sendMessage, type TwilioSendClient } from '@tally/messaging';

export interface StripeWebhookDeps {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  sendClient: TwilioSendClient;
}

export function registerStripeWebhookRoute(app: FastifyInstance, deps: StripeWebhookDeps): void {
  const stripe = new Stripe(deps.stripeSecretKey);

  app.post(
    '/webhooks/stripe',
    async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
      const signature = request.headers['stripe-signature'];
      const rawBody = request.body;

      // Signature-first, mirroring the Twilio routes' posture — the payload
      // is never inspected before it's verified against the webhook secret.
      // Needs the raw request bytes (server.ts's JSON content-type parser
      // hands them back unparsed for exactly this reason); Stripe signs the
      // exact bytes on the wire, not a re-serialization of parsed JSON.
      let event: Stripe.Event;
      try {
        if (typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) {
          throw new Error('missing stripe-signature header or raw body');
        }
        event = stripe.webhooks.constructEvent(rawBody, signature, deps.stripeWebhookSecret);
      } catch {
        reply.code(400);
        return '';
      }

      // 11 breakdown §C step 13. Other event types (04 §8.4's subscription
      // updated/canceled backstop) are a later sprint step, not this one —
      // accepted (200, no retry storm) and otherwise ignored here.
      if (event.type === 'checkout.session.completed') {
        await handleCheckoutSessionCompleted(event.data.object, deps.sendClient);
      }

      reply.code(200);
      return '';
    },
  );
}

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  sendClient: TwilioSendClient,
): Promise<void> {
  const userId = session.client_reference_id;
  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const stripeSubscriptionId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

  // All three are set on every subscription-mode session this app creates
  // (createCheckoutLink always passes client_reference_id, and Stripe
  // populates customer/subscription once checkout actually completes) — this
  // guards a malformed or unexpected event rather than a path this app's own
  // flow can produce.
  if (!userId || !stripeCustomerId || !stripeSubscriptionId) {
    return;
  }

  await upsertSubscriptionFromCheckout(userId, stripeCustomerId, stripeSubscriptionId);

  const user = await getUserById(userId);
  if (!user) {
    return;
  }

  // 11 breakdown §C step 13: same synthetic-trigger route as the paywall
  // trigger itself (§B step 9) — one auditable mechanism for every
  // conversation_state change, not a second direct-write path from billing
  // code. Resolving against the user's actual current state (rather than
  // assuming 'awaiting_checkout') means a retried delivery of the same
  // event — this handler doesn't dedup on Stripe's event ID yet, that's 11
  // breakdown §D — finds the user already back in 'idle' and falls back to
  // a no-op instead of sending a second confirmation text. Not a full
  // idempotency guarantee (a race between two concurrent deliveries isn't
  // closed by this), just a free side benefit of reusing the real lookup.
  const transition = resolveTransition(user.conversationState as ConversationState, 'checkout_completed');
  if (transition.isFallback) {
    return;
  }

  await applySideEffects(transition.sideEffects, {
    sendReply: async (text) => {
      await sendMessage(sendClient, userId, text, 'system');
    },
    mergeContext: async () => {
      throw new Error('mergeContext should not fire on the checkout_completed path');
    },
    createGoal: async () => {
      throw new Error('createGoal should not fire on the checkout_completed path');
    },
  });
  await updateUserState(userId, transition.toState);
}
