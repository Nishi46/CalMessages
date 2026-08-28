-- Up Migration
-- 11 breakdown §E step 16 (Architecture §7's "not the webhook as the sole
-- source of truth" backstop): tracks when a row's status was last confirmed
-- against Stripe, by either a webhook or the daily reconciliation job — the
-- reconciliation job's own "hasn't been touched in an unexpectedly long
-- window" query reads this column. NULL for a subscription that has never
-- had a real Stripe subscription (a free-tier row from getOrCreateSubscriptionForUser)
-- — there's nothing on Stripe's side yet to have synced against.
ALTER TABLE subscription ADD COLUMN stripe_synced_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE subscription DROP COLUMN IF EXISTS stripe_synced_at;
