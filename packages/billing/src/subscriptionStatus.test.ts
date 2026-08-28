import { describe, expect, it } from 'vitest';
import { mapStripeSubscriptionStatus } from './subscriptionStatus.js';

describe('mapStripeSubscriptionStatus (11 breakdown §E steps 15-16)', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['canceled', 'canceled'],
    ['incomplete_expired', 'canceled'],
  ] as const)('maps Stripe status %s to %s', (stripeStatus, expected) => {
    expect(mapStripeSubscriptionStatus(stripeStatus)).toBe(expected);
  });

  it.each(['incomplete', 'paused'] as const)(
    'has no confident mapping for %s, so returns null rather than guessing',
    (stripeStatus) => {
      expect(mapStripeSubscriptionStatus(stripeStatus)).toBeNull();
    },
  );
});
