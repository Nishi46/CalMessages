-- Up Migration
CREATE TABLE subscription (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES "user"(id),
    plan                    TEXT NOT NULL DEFAULT 'free',
    status                  TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    free_analyses_used      INT NOT NULL DEFAULT 0,
    free_analyses_limit     INT NOT NULL DEFAULT 20,
    renews_at               TIMESTAMPTZ
);

-- Down Migration
DROP TABLE IF EXISTS subscription;
