import type Stripe from 'stripe';

export type StripeSubscriptionStatus = 'active' | 'past_due' | 'canceled';

// 11 breakdown §E steps 15-16: shared by the customer.subscription.updated
// webhook handler and the daily reconciliation job, so the two can't drift
// on what a given Stripe status means locally. Stripe's Subscription.status
// has more values than 04's Subscription.status tracks — trialing counts as
// active (a trialing user's thread should stay unlocked); incomplete and
// paused don't have a confident mapping onto our three states, so they're
// left alone (null) rather than guessed at.
export function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): StripeSubscriptionStatus | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}
