import type { MessageDirection, MessageType } from '@tally/shared-types';
import { getPool } from './pool.js';

export interface MessageEvent {
  id: string;
  userId: string;
  direction: MessageDirection;
  type: MessageType;
  sentAt: Date;
  respondedAt: Date | null;
  twilioSid: string | null;
  // Twilio's real callback vocabulary is wider than the doc's typical-values
  // comment (04 §3.1) — the column is unconstrained TEXT, so this stays a
  // plain string rather than a narrow union.
  deliveryStatus: string | null;
}

interface MessageEventRow {
  id: string;
  user_id: string;
  direction: MessageDirection;
  type: MessageType;
  sent_at: Date;
  responded_at: Date | null;
  twilio_sid: string | null;
  delivery_status: string | null;
}

function rowToMessageEvent(row: MessageEventRow): MessageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    direction: row.direction,
    type: row.type,
    sentAt: row.sent_at,
    respondedAt: row.responded_at,
    twilioSid: row.twilio_sid,
    deliveryStatus: row.delivery_status,
  };
}

// Written before the Twilio API call, per 04 §4.2 — twilio_sid is attached
// afterward via updateMessageEventTwilioSid once Twilio returns one.
export async function createMessageEvent(
  userId: string,
  direction: MessageDirection,
  type: MessageType,
): Promise<MessageEvent> {
  const { rows } = await getPool().query<MessageEventRow>(
    `INSERT INTO message_event (user_id, direction, type, delivery_status) VALUES ($1, $2, $3, 'queued') RETURNING *`,
    [userId, direction, type],
  );
  return rowToMessageEvent(rows[0]);
}

export async function updateMessageEventTwilioSid(
  id: string,
  twilioSid: string,
): Promise<MessageEvent> {
  const { rows } = await getPool().query<MessageEventRow>(
    `UPDATE message_event SET twilio_sid = $2 WHERE id = $1 RETURNING *`,
    [id, twilioSid],
  );
  return rowToMessageEvent(rows[0]);
}

// Used when a send fails before Twilio ever returns a sid, so there's nothing
// to key an UPDATE ... WHERE twilio_sid = $1 off of yet.
export async function updateMessageEventStatus(
  id: string,
  deliveryStatus: string,
): Promise<MessageEvent> {
  const { rows } = await getPool().query<MessageEventRow>(
    `UPDATE message_event SET delivery_status = $2 WHERE id = $1 RETURNING *`,
    [id, deliveryStatus],
  );
  return rowToMessageEvent(rows[0]);
}

// 09 breakdown §C step 9: the evaluation loop's frequency-cap pre-filter (04
// §7.1, §7.3) — counted against the user's LOCAL day, not a UTC calendar day
// (09 breakdown §B is why that distinction matters: a UTC-day count would
// under- or over-count near midnight for any non-UTC timezone). Bucketing
// happens via Postgres's own tz-aware AT TIME ZONE rather than converting
// day boundaries in JS, so the query needs only the caller's already-computed
// localDate; the join's user_id/type filter still uses idx_msgevent_user_type_sent.
export async function countNudgesSentToday(userId: string, localDate: string): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM message_event me
     JOIN "user" u ON u.id = me.user_id
     WHERE me.user_id = $1
       AND me.type = 'nudge'
       AND me.direction = 'outbound'
       AND (me.sent_at AT TIME ZONE u.timezone)::date = $2::date`,
    [userId, localDate],
  );
  return rows[0].count;
}

// Twilio delivers status callbacks out of order (documented behavior), so a
// delayed earlier-stage callback (e.g. "sent") can arrive after a later one
// ("delivered") already landed. Once a message reaches a terminal status, that
// status is locked — it's the actual final outcome the deliverability metric
// (04 §12) reads, and nothing later should be able to regress it.
const TERMINAL_DELIVERY_STATUSES = ['delivered', 'failed', 'undelivered'];

export async function updateMessageEventStatusBySid(
  twilioSid: string,
  deliveryStatus: string,
): Promise<MessageEvent | null> {
  const { rows } = await getPool().query<MessageEventRow>(
    `UPDATE message_event
     SET delivery_status = $2
     WHERE twilio_sid = $1
       AND (delivery_status IS NULL OR NOT (delivery_status = ANY($3::text[])))
     RETURNING *`,
    [twilioSid, deliveryStatus, TERMINAL_DELIVERY_STATUSES],
  );
  return rows[0] ? rowToMessageEvent(rows[0]) : null;
}
