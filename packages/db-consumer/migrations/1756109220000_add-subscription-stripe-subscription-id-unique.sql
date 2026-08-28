-- Up Migration
-- 11 breakdown §E: syncSubscriptionStatusFromStripe (webhook + daily
-- reconciliation) looks a row up by stripe_subscription_id alone and
-- assumes at most one match — a real invariant (each Stripe subscription
-- belongs to exactly one local row), not just a query convenience, so it's
-- enforced here rather than left to application code to keep true. NULL is
-- unconstrained (a free-tier row with no Stripe subscription yet), per
-- ordinary SQL UNIQUE semantics — any number of NULLs coexist.
ALTER TABLE subscription ADD CONSTRAINT subscription_stripe_subscription_id_key UNIQUE (stripe_subscription_id);

-- Down Migration
ALTER TABLE subscription DROP CONSTRAINT IF EXISTS subscription_stripe_subscription_id_key;
