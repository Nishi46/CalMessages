import { createHmac } from 'node:crypto';
import { getPool, getUserByPhone } from '@tally/db-consumer';
import type { ObjectStore } from '@tally/object-store';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { resolveOrCreateUser } from '../lib/users.js';
import { buildApp } from '../server.js';

const AUTH_TOKEN = 'test_auth_token';
const PUBLIC_BASE_URL = 'https://example.com';
const PATH = '/webhooks/twilio/inbound';

// Twilio's own signature algorithm (docs: "Validating Signatures from Twilio"):
// sort the params, append key+value pairs to the URL, HMAC-SHA1 with the auth
// token, base64-encode. Hand-rolled here so tests can produce a signature the
// route will actually accept, independent of the `twilio` SDK's own verifier.
function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function noopDeps() {
  return {
    authToken: AUTH_TOKEN,
    publicBaseUrl: PUBLIC_BASE_URL,
    resolveOrCreateUser: vi.fn(),
    fetchMedia: vi.fn(),
    objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() } satisfies ObjectStore,
    handleInboundMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageEventStatus: vi.fn(),
    stripeSecretKey: 'sk_test_fake',
    stripeWebhookSecret: 'whsec_fake',
    sendClient: { send: vi.fn() },
  };
}

describe('POST /webhooks/twilio/inbound', () => {
  it('rejects a request with an invalid signature and never touches the user store', async () => {
    const deps = noopDeps();
    const app = buildApp(deps, { logger: false });

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': 'not-a-real-signature',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'From=%2B15551234567&Body=chicken+and+rice',
    });

    expect(response.statusCode).toBe(403);
    expect(deps.resolveOrCreateUser).not.toHaveBeenCalled();
    expect(deps.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header at all', async () => {
    const deps = noopDeps();
    const app = buildApp(deps, { logger: false });

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=%2B15551234567',
    });

    expect(response.statusCode).toBe(403);
    expect(deps.resolveOrCreateUser).not.toHaveBeenCalled();
  });

  it('accepts a validly signed text message and hands it to the router', async () => {
    const params = { From: '+15551234567', Body: 'chicken and rice' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-1', conversationState: 'idle' });
    const app = buildApp(deps, { logger: false });

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain('<Response');
    expect(deps.resolveOrCreateUser).toHaveBeenCalledWith('+15551234567');
    expect(deps.handleInboundMessage).toHaveBeenCalledWith({
      userId: 'user-1',
      text: 'chicken and rice',
      photoKey: undefined,
      currentState: 'idle',
    });
  });

  it('fetches and stores media when present, and passes the key to the router', async () => {
    const params = {
      From: '+15551234568',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME123',
    };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-2', conversationState: 'idle' });
    deps.fetchMedia.mockResolvedValue({ buffer: Buffer.from('fake-image'), contentType: 'image/jpeg' });
    deps.objectStore.putObject = vi.fn().mockResolvedValue('meal-photos/fake-key');
    const app = buildApp(deps, { logger: false });

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(deps.fetchMedia).toHaveBeenCalledWith('https://api.twilio.com/media/ME123');
    expect(deps.objectStore.putObject).toHaveBeenCalledWith(Buffer.from('fake-image'), 'image/jpeg');
    expect(deps.handleInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2', photoKey: 'meal-photos/fake-key' }),
    );
  });

  it('does not fetch media when NumMedia is 0', async () => {
    const params = { From: '+15551234569', Body: 'no photo here' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-3', conversationState: 'idle' });
    const app = buildApp(deps, { logger: false });

    await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(deps.fetchMedia).not.toHaveBeenCalled();
    expect(deps.objectStore.putObject).not.toHaveBeenCalled();
  });

  it('returns the TwiML response without waiting on handleInboundMessage, and logs a rejection instead of swallowing it (breakdown step 19)', async () => {
    const params = { From: '+15551234571', Body: 'chicken and rice' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-4', conversationState: 'idle' });
    // Constructed lazily inside the call, not before — a pre-built rejected
    // promise can trip Node's unhandled-rejection detector in the gap
    // before Fastify's async pipeline actually invokes the mock and the
    // route's own .catch attaches.
    deps.handleInboundMessage.mockImplementation(() => Promise.reject(new Error('boom')));
    const app = buildApp(deps, { logger: false });
    const errorSpy = vi.spyOn(app.log, 'error').mockImplementation(() => {});

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(params).toString(),
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error), 'handleInboundMessage failed');
  });
});

describe('POST /webhooks/twilio/inbound — against a real Postgres (breakdown step 20)', () => {
  it('creates a user row on first contact and reuses the same row on the next message', async () => {
    const phone = `+1${Date.now()}`;
    const params = { From: phone, Body: 'eggs and toast' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);
    const payload = new URLSearchParams(params).toString();
    const headers = {
      'x-twilio-signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    };

    const app = buildApp({
      authToken: AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveOrCreateUser,
      fetchMedia: vi.fn(),
      objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
      handleInboundMessage: vi.fn().mockResolvedValue(undefined),
      updateMessageEventStatus: vi.fn(),
      stripeSecretKey: 'sk_test_fake',
      stripeWebhookSecret: 'whsec_fake',
      sendClient: { send: vi.fn() },
    }, { logger: false });

    const first = await app.inject({ method: 'POST', url: PATH, headers, payload });
    expect(first.statusCode).toBe(200);

    const created = await getUserByPhone(phone);
    expect(created).not.toBeNull();
    expect(created?.conversationState).toBe('new');

    const second = await app.inject({ method: 'POST', url: PATH, headers, payload });
    expect(second.statusCode).toBe(200);

    const stillOneRow = await getUserByPhone(phone);
    expect(stillOneRow?.id).toBe(created?.id);
  });

  afterAll(async () => {
    await getPool().end();
  });
});
