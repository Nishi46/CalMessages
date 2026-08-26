-- Up Migration
CREATE TABLE goal (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES "user"(id),
    type            TEXT NOT NULL, -- lose | maintain | gain | protein_only
    daily_calories  INT,
    daily_protein   INT,
    set_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    source          TEXT NOT NULL DEFAULT 'self', -- self | coach | clinic
    superseded_at   TIMESTAMPTZ -- null = currently active
);
CREATE INDEX idx_goal_active ON goal(user_id) WHERE superseded_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS goal;
