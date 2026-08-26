import twilio from 'twilio';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@tally/db-consumer';
import type { FetchedMedia } from '../lib/media.js';
import type { ObjectStore } from '../lib/objectStore.js';
import type { RouterHandoffPayload } from '../lib/router.js';

export interface TwilioInboundDeps {
  authToken: string;
  // Signature verification needs the exact URL Twilio signed against, and a proxy
  // in front of this service can't be trusted to report the right protocol/host —
  // so the public URL is configured, not inferred from the request (04 §4.1 step 1).
  publicBaseUrl: string;
  resolveOrCreateUser: (phoneE164: string) => Promise<User>;
  fetchMedia: (mediaUrl: string) => Promise<FetchedMedia>;
  objectStore: ObjectStore;
  handleInboundMessage: (payload: RouterHandoffPayload) => Promise<void>;
}

interface TwilioInboundBody {
  From?: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  [key: string]: string | undefined;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function registerTwilioInboundRoute(app: FastifyInstance, deps: TwilioInboundDeps): void {
  app.post(
    '/webhooks/twilio/inbound',
    async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
      const signature = request.headers['x-twilio-signature'];
      const body = (request.body ?? {}) as TwilioInboundBody;
      const url = new URL(request.url, deps.publicBaseUrl).toString();

      const isValid =
        typeof signature === 'string' &&
        twilio.validateRequest(deps.authToken, signature, url, body as Record<string, string>);

      if (!isValid) {
        reply.code(403);
        return '';
      }

      const from = body.From;
      if (!from) {
        reply.code(400);
        return '';
      }

      const user = await deps.resolveOrCreateUser(from);

      let photoKey: string | undefined;
      const numMedia = Number(body.NumMedia ?? '0');
      if (numMedia > 0 && body.MediaUrl0) {
        const media = await deps.fetchMedia(body.MediaUrl0);
        photoKey = await deps.objectStore.putObject(media.buffer, media.contentType);
      }

      await deps.handleInboundMessage({
        userId: user.id,
        text: body.Body,
        photoKey,
        currentState: user.conversationState,
      });

      reply.header('Content-Type', 'text/xml');
      return EMPTY_TWIML;
    },
  );
}
