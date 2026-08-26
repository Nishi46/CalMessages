import { fetchTwilioMedia } from './lib/media.js';
import { createS3ObjectStore } from './lib/objectStore.js';
import { handleInboundMessage } from './lib/router.js';
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
const authToken = requireEnv('TWILIO_AUTH_TOKEN');
const publicBaseUrl = requireEnv('PUBLIC_BASE_URL');

const objectStore = createS3ObjectStore({
  endpoint: requireEnv('S3_ENDPOINT'),
  bucket: requireEnv('S3_BUCKET'),
  accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
});

const app = buildApp({
  authToken,
  publicBaseUrl,
  resolveOrCreateUser,
  fetchMedia: (mediaUrl) => fetchTwilioMedia(mediaUrl, accountSid, authToken),
  objectStore,
  handleInboundMessage,
});

app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
