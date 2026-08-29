import { createUser, getPool, uniqueTestPhone } from '@tally/db-consumer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sendMessage, type TwilioSendClient } from './sendMessage.js';

function fakeClient(sid = 'SM_fake_sid'): TwilioSendClient {
  return { send: vi.fn().mockResolvedValue({ sid }) };
}

describe('sendMessage (breakdown step 28, against a real Postgres)', () => {
  it('writes a queued MessageEvent row before calling Twilio, then attaches the twilio_sid', async () => {
    const user = await createUser(uniqueTestPhone());
    const client = fakeClient('SM_123');

    const event = await sendMessage(client, user.id, 'hey, how was dinner?', 'nudge');

    expect(event).not.toBeNull();
    expect(event?.userId).toBe(user.id);
    expect(event?.direction).toBe('outbound');
    expect(event?.type).toBe('nudge');
    expect(event?.deliveryStatus).toBe('queued');
    expect(event?.twilioSid).toBe('SM_123');
    expect(client.send).toHaveBeenCalledWith(user.phoneE164, 'hey, how was dinner?');
  });

  it('does not send or write anything for an opted-out user', async () => {
    const user = await createUser(uniqueTestPhone());
    await getPool().query('UPDATE "user" SET opt_out_at = now() WHERE id = $1', [user.id]);

    const client = fakeClient();
    const event = await sendMessage(client, user.id, 'hey, how was dinner?', 'nudge');

    expect(event).toBeNull();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns null for an unknown user id without calling Twilio', async () => {
    const client = fakeClient();
    const event = await sendMessage(client, '00000000-0000-0000-0000-000000000000', 'hi', 'system');

    expect(event).toBeNull();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('marks the row failed and rethrows when the Twilio API call itself throws', async () => {
    const user = await createUser(uniqueTestPhone());
    const client: TwilioSendClient = { send: vi.fn().mockRejectedValue(new Error('twilio down')) };

    await expect(sendMessage(client, user.id, 'hi', 'nudge')).rejects.toThrow('twilio down');

    const { rows } = await getPool().query<{ delivery_status: string }>(
      'SELECT delivery_status FROM message_event WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0]?.delivery_status).toBe('failed');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
