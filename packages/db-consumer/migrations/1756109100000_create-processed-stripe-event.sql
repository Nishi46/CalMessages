-- Up Migration
-- 04 §8.3: a short-lived dedup table so a webhook retry of an event already
-- processed can be recognized and skipped (§D step 14) rather than re-run.
CREATE TABLE processed_stripe_event (
    id              TEXT PRIMARY KEY, -- Stripe event ID (evt_...)
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS processed_stripe_event;
