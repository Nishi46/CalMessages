import Stripe from 'stripe';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mapStripeSubscriptionStatus } from '@tally/billing';
import { applySideEffects, resolveTransition, type ConversationState } from '@tally/conversation';
import {
  getUserById,
  hasProcessedStripeEvent,
  markStripeEventProcessed,
  syncSubscriptionStatusFromStripe,
  updateUserState,
  upsertSubscriptionFromCheckout,
  withTransaction,
} from '@tally/db-consumer';
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

      // 11 breakdown §D step 14 (04 §8.3): checked before any processing.
      // Stripe explicitly documents at-least-once delivery, so a retried
      // event has to be recognized and skipped here, not reprocessed.
      if (await hasProcessedStripeEvent(event.id)) {
        reply.code(200);
        return '';
      }

      if (event.type === 'checkout.session.completed') {
        await handleCheckoutSessionCompleted(event.id, event.data.object, deps.sendClient);
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        await handleSubscriptionStatusEvent(event.id, event.type, event.data.object);
      }
      // Every other event type is accepted (200, no retry storm) and
      // otherwise ignored — nothing else in the app reads Stripe events yet.

      reply.code(200);
      return '';
    },
  );
}

async function handleCheckoutSessionCompleted(
  eventId: string,
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
  // flow can produce. Still marked processed: retrying a malformed event
  // wouldn't produce a different result, so there's nothing to gain by
  // leaving it eligible for endless reprocessing.
  if (!userId || !stripeCustomerId || !stripeSubscriptionId) {
    await markStripeEventProcessed(eventId);
    return;
  }

  const user = await getUserById(userId);
  if (!user) {
    await markStripeEventProcessed(eventId);
    return;
  }

  // 11 breakdown §C step 13: same synthetic-trigger route as the paywall
  // trigger itself (§B step 9) — one auditable mechanism for every
  // conversation_state change, not a second direct-write path from billing
  // code. Resolved once, up front, against the user's actual current state,
  // so the transaction below only writes a state change when there's a real
  // one to make.
  const transition = resolveTransition(user.conversationState as ConversationState, 'checkout_completed');

  // 11 breakdown §D step 14: the subscription upsert, the state transition,
  // and the processed-event marker all commit in one transaction — the
  // marker is never written after them, since a crash in between would
  // leave this event's processing undone but also unmarked, making it
  // eligible for a retry to redo (and, worse, re-send the confirmation text
  // for) work that already happened.
  await withTransaction(async (client) => {
    await upsertSubscriptionFromCheckout(userId, stripeCustomerId, stripeSubscriptionId, client);
    if (!transition.isFallback) {
      await updateUserState(userId, transition.toState, undefined, client);
    }
    await markStripeEventProcessed(eventId, client);
  });

  if (transition.isFallback) {
    return;
  }

  // The confirmation text itself is sent only after the transaction above
  // has committed — same ordering as the meal-log write's transaction-then-
  // reply pattern (11 breakdown §A step 4), so a message never goes out for
  // a DB write that ended up rolled back.
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
}

// 11 breakdown §E step 15 (04 §8.4): keeps Subscription.status current for
// past_due/canceled outside the checkout flow — e.g. a card declines on
// renewal, or the customer cancels from Stripe's own billing portal. Same
// idempotency treatment as checkout.session.completed (§D step 14): the
// status write and the processed-event marker commit in one transaction.
async function handleSubscriptionStatusEvent(
  eventId: string,
  eventType: 'customer.subscription.updated' | 'customer.subscription.deleted',
  subscription: Stripe.Subscription,
): Promise<void> {
  // .deleted is Stripe's unambiguous "this subscription is gone" signal —
  // canceled outright, regardless of what subscription.status itself says
  // on the deleted object. .updated defers to mapStripeSubscriptionStatus,
  // the same mapping the reconciliation job uses (11 breakdown §E step 16),
  // so a webhook and a reconciliation run can never disagree on what a given
  // Stripe status means locally.
  const status =
    eventType === 'customer.subscription.deleted' ? 'canceled' : mapStripeSubscriptionStatus(subscription.status);

  // No confident local mapping (e.g. 'incomplete', 'paused') — still marked
  // processed, since retrying wouldn't change that; nothing to write.
  if (!status) {
    await markStripeEventProcessed(eventId);
    return;
  }

  await withTransaction(async (client) => {
    await syncSubscriptionStatusFromStripe(subscription.id, status, client);
    await markStripeEventProcessed(eventId, client);
  });
}
