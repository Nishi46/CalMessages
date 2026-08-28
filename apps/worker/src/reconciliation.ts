import { getStaleSubscriptions, syncSubscriptionStatusFromStripe } from '@tally/db-consumer';
import type { SubscriptionStatusClient } from '@tally/billing';

// 11 breakdown §E step 16 (04 §8.4, Architecture §7's "not the webhook as
// the sole source of truth"): backstop for a missed or delayed Stripe
// webhook. Re-fetches status directly from Stripe's API for any account
// whose local row hasn't been confirmed in longer than staleAfterMs.
// `now` is threaded through (not read via Date.now()) so this can be driven
// by an injected clock in tests, same posture as the nudge evaluation loop.
export async function runReconciliationTick(
  client: SubscriptionStatusClient,
  now: Date,
  staleAfterMs: number,
): Promise<void> {
  const staleSince = new Date(now.getTime() - staleAfterMs);
  const stale = await getStaleSubscriptions(staleSince);

  const results = await Promise.allSettled(
    stale.map(async (subscription) => {
      // Guaranteed non-null by getStaleSubscriptions' own WHERE clause —
      // narrowed here only so TypeScript doesn't need to know that.
      const stripeSubscriptionId = subscription.stripeSubscriptionId;
      if (!stripeSubscriptionId) return;

      const status = await client.getSubscriptionStatus(stripeSubscriptionId);
      if (!status) {
        // No confident local mapping (e.g. Stripe reports 'incomplete') —
        // leave stripe_synced_at untouched so this account is picked up
        // again on the next tick instead of being falsely marked fresh.
        return;
      }
      await syncSubscriptionStatusFromStripe(stripeSubscriptionId, status);
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      // One account's Stripe lookup failing (rate limit, transient network
      // error) shouldn't abort the rest of the daily sweep — same posture
      // as the nudge evaluation loop's per-user resilience.
      console.error('[worker] reconciliation failed for a subscription', result.reason);
    }
  }
}
