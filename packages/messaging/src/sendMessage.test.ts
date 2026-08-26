import { createUser, getPool } from '@tally/db-consumer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sendMessage, type TwilioSendClient } from './sendMessage.js';

function fakeClient(sid = 'SM_fake_sid'): TwilioSendClient {
  return { send: vi.fn().mockResolvedValue({ sid }) };
}

describe('sendMessage (breakdown step 28, against a real Postgres)', () => {
  it('writes a queued MessageEvent row before calling Twilio, then attaches the twilio_sid', async () => {
    const user = await createUser(`+1${Date.now()}`);
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
    const user = await createUser(`+1${Date.now()}1`);
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

  afterAll(async () => {
    await getPool().end();
  });
});
