import { updateMessageEventStatusBySid } from '@tally/db-consumer';
import { createTwilioSendClient } from '@tally/messaging';
import { createTextModelClient, createTextParser, createVisionModelClient, createVisionProvider } from '@tally/vision';
import { fetchTwilioMedia } from './lib/media.js';
import { createS3ObjectStore } from './lib/objectStore.js';
import { createInboundMessageHandler } from './lib/router.js';
import { resolveOrCreateUser } from './lib/users.js';
import { buildApp } from './server.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
if (!accountSid.startsWith('AC')) {
  throw new Error(
    "TWILIO_ACCOUNT_SID must be the Account SID from the Twilio Console (starts with 'AC') — " +
      "not an API Key SID (starts with 'SK'). Using the wrong one fails both outbound sends " +
      'and inbound webhook signature verification.',
  );
}
const authToken = requireEnv('TWILIO_AUTH_TOKEN');
const publicBaseUrl = requireEnv('PUBLIC_BASE_URL');
const fromNumber = requireEnv('TWILIO_PHONE_NUMBER');
const visionProviderApiKey = requireEnv('VISION_PROVIDER_API_KEY');

const objectStore = createS3ObjectStore({
  endpoint: requireEnv('S3_ENDPOINT'),
  bucket: requireEnv('S3_BUCKET'),
  accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
});

const sendClient = createTwilioSendClient({ accountSid, authToken, fromNumber });

// Same provider, two thin clients (04 §5.1: "the same or a lighter hosted
// model" for text) — recognize()'s FetchByKey reads back whatever the
// inbound webhook already wrote to the object store, keyed by photoKey.
const visionProvider = createVisionProvider({
  fetchByKey: async (photoKey) => {
    const object = await objectStore.getObject(photoKey);
    return { bytes: object.bytes, contentType: object.contentType };
  },
  visionClient: createVisionModelClient({ apiKey: visionProviderApiKey }),
});
const textParser = createTextParser({
  textClient: createTextModelClient({ apiKey: visionProviderApiKey }),
});

const handleInboundMessage = createInboundMessageHandler({ sendClient, visionProvider, textParser });

const app = buildApp({
  authToken,
  publicBaseUrl,
  resolveOrCreateUser,
  fetchMedia: (mediaUrl) => fetchTwilioMedia(mediaUrl, accountSid, authToken),
  objectStore,
  handleInboundMessage,
  updateMessageEventStatus: updateMessageEventStatusBySid,
});

app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
