-- Up Migration
-- 13 breakdown §A: coach-seat-attach-rate (04 §12) reads these tables. They're
-- part of 04 §3.1's schema but were never migrated in through Sprint 7 — the
-- coach dashboard itself isn't built until Sprint 9/10 (P1), but the metric
-- query needs real (empty) tables to query rather than throwing, so it can
-- legitimately return 0/N-A at P0 instead of erroring.
CREATE TABLE coach (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    org             TEXT,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    referral_code   TEXT NOT NULL UNIQUE,
    seat_status     TEXT NOT NULL DEFAULT 'active', -- active | suspended
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE client_link (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coach_id            UUID NOT NULL REFERENCES coach(id),
    user_id             UUID NOT NULL REFERENCES "user"(id),
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    unlinked_at         TIMESTAMPTZ,
    consent_confirmed   BOOLEAN NOT NULL DEFAULT false,
    consent_confirmed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_clientlink_active ON client_link(coach_id, user_id) WHERE unlinked_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS client_link;
DROP TABLE IF EXISTS coach;
