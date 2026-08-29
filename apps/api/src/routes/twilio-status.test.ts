import { createHmac } from 'node:crypto';
import {
  createMessageEvent,
  createUser,
  getPool,
  updateMessageEventStatusBySid,
  updateMessageEventTwilioSid,
} from '@tally/db-consumer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server.js';

const AUTH_TOKEN = 'test_auth_token';
const PUBLIC_BASE_URL = 'https://example.com';
const PATH = '/webhooks/twilio/status';

function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function buildTestApp(updateMessageEventStatus: (sid: string, status: string) => Promise<unknown>) {
  return buildApp(
    {
      authToken: AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveOrCreateUser: vi.fn(),
      fetchMedia: vi.fn(),
      objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
      handleInboundMessage: vi.fn(),
      setUserOptOut: vi.fn(),
      updateMessageEventStatus,
      stripeSecretKey: 'sk_test_fake',
      stripeWebhookSecret: 'whsec_fake',
      sendClient: { send: vi.fn() },
    },
    { logger: false },
  );
}

describe('POST /webhooks/twilio/status', () => {
  it('rejects a request with an invalid signature and never updates anything', async () => {
    const updateMessageEventStatus = vi.fn();
    const app = buildTestApp(updateMessageEventStatus);

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': 'not-a-real-signature',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'MessageSid=SM123&MessageStatus=delivered',
    });

    expect(response.statusCode).toBe(403);
    expect(updateMessageEventStatus).not.toHaveBeenCalled();
  });

  it('updates delivery status for a validly signed callback', async () => {
    const updateMessageEventStatus = vi.fn().mockResolvedValue(undefined);
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const app = buildTestApp(updateMessageEventStatus);

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(response.statusCode).toBe(204);
    expect(updateMessageEventStatus).toHaveBeenCalledWith('SM123', 'delivered');
  });
});

describe('POST /webhooks/twilio/status — against a real Postgres (breakdown step 28)', () => {
  it('moves a queued MessageEvent to delivered end to end', async () => {
    const user = await createUser(`+1${Date.now()}`);
    const event = await createMessageEvent(user.id, 'outbound', 'nudge');
    expect(event.deliveryStatus).toBe('queued');
    const withSid = await updateMessageEventTwilioSid(event.id, 'SM_real_flow');

    const params = { MessageSid: withSid.twilioSid ?? '', MessageStatus: 'delivered' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const app = buildTestApp(updateMessageEventStatusBySid);

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(response.statusCode).toBe(204);
    const { rows } = await getPool().query<{ delivery_status: string }>(
      'SELECT delivery_status FROM message_event WHERE id = $1',
      [event.id],
    );
    expect(rows[0]?.delivery_status).toBe('delivered');
  });

  afterAll(async () => {
    await getPool().end();
  });
});
