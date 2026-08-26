import {
  createMessageEvent,
  getUserById,
  updateMessageEventStatus,
  updateMessageEventTwilioSid,
  type MessageEvent,
} from '@tally/db-consumer';
import type { MessageType } from '@tally/shared-types';
import twilioLib from 'twilio';

export interface TwilioSendClient {
  send(to: string, body: string): Promise<{ sid: string }>;
}

export interface TwilioSendClientConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function createTwilioSendClient(config: TwilioSendClientConfig): TwilioSendClient {
  const client = twilioLib(config.accountSid, config.authToken);
  return {
    async send(to, body) {
      const message = await client.messages.create({ to, from: config.fromNumber, body });
      return { sid: message.sid };
    },
  };
}

// One send path for fast-path replies, nudges, recaps, and the paywall (04 §4.2).
// Returns null without writing anything when the user is opted out — defense in
// depth, since Twilio already suppresses STOP'd numbers at the carrier level.
export async function sendMessage(
  client: TwilioSendClient,
  userId: string,
  body: string,
  type: MessageType,
): Promise<MessageEvent | null> {
  const user = await getUserById(userId);
  if (!user || user.optOutAt) {
    return null;
  }

  const event = await createMessageEvent(userId, 'outbound', type);
  try {
    const { sid } = await client.send(user.phoneE164, body);
    return await updateMessageEventTwilioSid(event.id, sid);
  } catch (error) {
    // Without this, a failed send leaves the row at 'queued' forever — the
    // failure is otherwise invisible to everything downstream (04 §12's
    // deliverability metric included).
    await updateMessageEventStatus(event.id, 'failed');
    throw error;
  }
}
