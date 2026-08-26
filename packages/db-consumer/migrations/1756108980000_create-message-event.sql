-- Up Migration
CREATE TABLE message_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES "user"(id),
    direction       TEXT NOT NULL, -- inbound | outbound
    type            TEXT NOT NULL, -- nudge | recap | paywall | system | log_reply
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at    TIMESTAMPTZ,
    twilio_sid      TEXT,
    delivery_status TEXT -- queued | sent | delivered | failed | undelivered
);
CREATE INDEX idx_msgevent_user_type_sent ON message_event(user_id, type, sent_at);

-- Down Migration
DROP TABLE IF EXISTS message_event;
