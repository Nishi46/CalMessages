-- Up Migration
CREATE TABLE meal_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES "user"(id),
    photo_url           TEXT,
    items               JSONB NOT NULL DEFAULT '[]', -- [{name, portion, calories, protein, carbs, fat}]
    calories            INT,
    protein             INT,
    carbs               INT,
    fat                 INT,
    confidence          TEXT NOT NULL, -- high | medium | low
    source              TEXT NOT NULL, -- photo | text | voice
    logged_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    local_date          DATE NOT NULL, -- day bucket in user's timezone, set at write time
    corrected_from_id   UUID REFERENCES meal_log(id),
    soft_deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_meal_user_date ON meal_log(user_id, local_date) WHERE soft_deleted_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS meal_log;
