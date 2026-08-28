import Stripe from 'stripe';
import { mapStripeSubscriptionStatus, type StripeSubscriptionStatus } from './subscriptionStatus.js';

// Thin interface over the SDK, same reason CheckoutClient is one — testable
// against a fake, real Stripe wiring lives in one place.
export interface SubscriptionStatusClient {
  getSubscriptionStatus(stripeSubscriptionId: string): Promise<StripeSubscriptionStatus | null>;
}

export interface StripeSubscriptionStatusClientConfig {
  secretKey: string;
}

// 11 breakdown §E step 16: the daily reconciliation job's read path back to
// Stripe's API — Architecture §7's "not the webhook as the sole source of
// truth" backstop for a missed or delayed webhook.
export function createStripeSubscriptionStatusClient(
  config: StripeSubscriptionStatusClientConfig,
): SubscriptionStatusClient {
  const stripe = new Stripe(config.secretKey);
  return {
    async getSubscriptionStatus(stripeSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      return mapStripeSubscriptionStatus(subscription.status);
    },
  };
}
