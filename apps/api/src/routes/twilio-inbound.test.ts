import { createHmac } from 'node:crypto';
import {
  getActiveUsersForScheduling,
  getPool,
  getUserByPhone,
  setUserOptOut,
  uniqueTestPhone,
  updateUserState,
} from '@tally/db-consumer';
import { sendMessage } from '@tally/messaging';
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
    setUserOptOut: vi.fn(),
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

  // 12 §C step 9/10: OptOutType is Twilio's Advanced Opt-Out field on this
  // same inbound-message webhook (not a separate URL, and not
  // twilio-status.ts's delivery-status route — confirmed against Twilio's
  // docs: https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).
  // Twilio has already matched the keyword and replied to the sender by the
  // time this request arrives, so these never reach handleInboundMessage.
  it('STOP sets opt_out_at and never reaches handleInboundMessage', async () => {
    const params = { From: '+15551234580', Body: 'STOP', OptOutType: 'STOP' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-stop', conversationState: 'idle' });
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
    expect(deps.setUserOptOut).toHaveBeenCalledWith('user-stop', expect.any(Date));
    expect(deps.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('START clears opt_out_at symmetrically and never reaches handleInboundMessage', async () => {
    const params = { From: '+15551234581', Body: 'START', OptOutType: 'START' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-start', conversationState: 'idle' });
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
    expect(deps.setUserOptOut).toHaveBeenCalledWith('user-start', null);
    expect(deps.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('HELP writes no column and never reaches handleInboundMessage — Twilio already answered it', async () => {
    const params = { From: '+15551234582', Body: 'HELP', OptOutType: 'HELP' };
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const signature = computeTwilioSignature(AUTH_TOKEN, url, params);

    const deps = noopDeps();
    deps.resolveOrCreateUser.mockResolvedValue({ id: 'user-help', conversationState: 'idle' });
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
    expect(deps.setUserOptOut).not.toHaveBeenCalled();
    expect(deps.handleInboundMessage).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/twilio/inbound — against a real Postgres (breakdown step 20)', () => {
  it('creates a user row on first contact and reuses the same row on the next message', async () => {
    const phone = uniqueTestPhone();
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
      setUserOptOut: vi.fn(),
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

  // 12 §G step 21: the real STOP/START round trip against the real webhook
  // route, plus confirmation that sendMessage() and the scheduler both skip
  // the user while opted out — the whole point of writing opt_out_at, not
  // just that the column gets set.
  it('STOP then START round-trips opt_out_at, and both sendMessage() and the scheduler respect it while set', async () => {
    const phone = uniqueTestPhone();
    const url = `${PUBLIC_BASE_URL}${PATH}`;
    const sendClient = { send: vi.fn().mockResolvedValue({ sid: 'SM_fake' }) };
    const app = buildApp(
      {
        authToken: AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveOrCreateUser,
        fetchMedia: vi.fn(),
        objectStore: { putObject: vi.fn(), getObject: vi.fn(), deleteObject: vi.fn() },
        handleInboundMessage: vi.fn().mockResolvedValue(undefined),
        setUserOptOut,
        updateMessageEventStatus: vi.fn(),
        stripeSecretKey: 'sk_test_fake',
        stripeWebhookSecret: 'whsec_fake',
        sendClient,
      },
      { logger: false },
    );

    const stopParams = { From: phone, Body: 'stop', OptOutType: 'STOP' };
    const stopSignature = computeTwilioSignature(AUTH_TOKEN, url, stopParams);
    const stopResponse = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': stopSignature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(stopParams).toString(),
    });
    expect(stopResponse.statusCode).toBe(200);

    const optedOut = await getUserByPhone(phone);
    expect(optedOut?.optOutAt).not.toBeNull();
    await updateUserState(optedOut!.id, 'idle');

    // sendMessage() skips silently rather than calling Twilio for a send
    // that would just fail with error 21610 (packages/messaging, Sprint 1).
    const sendResult = await sendMessage(sendClient, optedOut!.id, 'a nudge', 'nudge');
    expect(sendResult).toBeNull();
    expect(sendClient.send).not.toHaveBeenCalled();

    // The scheduler's active-user set also excludes them (09 breakdown §C
    // step 7's filter, confirmed against opt_out_at actually being set via
    // this real webhook path rather than a raw SQL write).
    const activeWhileOptedOut = await getActiveUsersForScheduling();
    expect(activeWhileOptedOut.some((u) => u.id === optedOut!.id)).toBe(false);

    const startParams = { From: phone, Body: 'start', OptOutType: 'START' };
    const startSignature = computeTwilioSignature(AUTH_TOKEN, url, startParams);
    const startResponse = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-twilio-signature': startSignature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(startParams).toString(),
    });
    expect(startResponse.statusCode).toBe(200);

    const optedBackIn = await getUserByPhone(phone);
    expect(optedBackIn?.optOutAt).toBeNull();

    const sendResultAfterStart = await sendMessage(sendClient, optedBackIn!.id, 'a nudge', 'nudge');
    expect(sendResultAfterStart).not.toBeNull();
    expect(sendClient.send).toHaveBeenCalledWith(phone, 'a nudge');

    const activeAfterStart = await getActiveUsersForScheduling();
    expect(activeAfterStart.some((u) => u.id === optedBackIn!.id)).toBe(true);
  });

  afterAll(async () => {
    await getPool().end();
  });
});
