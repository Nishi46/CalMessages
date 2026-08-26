-- Up Migration
CREATE TABLE "user" (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164      TEXT NOT NULL UNIQUE,
    timezone        TEXT NOT NULL DEFAULT 'America/New_York',
    plan_status     TEXT NOT NULL DEFAULT 'free', -- free | active | past_due | canceled
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    opt_out_at      TIMESTAMPTZ,
    paused_at       TIMESTAMPTZ,
    referral_code   TEXT,
    conversation_state TEXT NOT NULL DEFAULT 'new',
    conversation_context JSONB
);
CREATE INDEX idx_user_phone ON "user"(phone_e164);
CREATE INDEX idx_user_state ON "user"(conversation_state) WHERE opt_out_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS "user";
