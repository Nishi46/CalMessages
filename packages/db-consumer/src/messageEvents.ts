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

export async function updateMessageEventStatusBySid(
  twilioSid: string,
  deliveryStatus: string,
): Promise<MessageEvent | null> {
  const { rows } = await getPool().query<MessageEventRow>(
    `UPDATE message_event SET delivery_status = $2 WHERE twilio_sid = $1 RETURNING *`,
    [twilioSid, deliveryStatus],
  );
  return rows[0] ? rowToMessageEvent(rows[0]) : null;
}
