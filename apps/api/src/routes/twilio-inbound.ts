import twilio from 'twilio';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@tally/db-consumer';
import type { ObjectStore } from '@tally/object-store';
import type { FetchedMedia } from '../lib/media.js';
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
  // 12 §C step 10: STOP sets opt_out_at, START clears it — "symmetrically"
  // (04 §4.3). Typed loosely (return value unused) same posture as
  // twilio-status.ts's updateMessageEventStatus dep.
  setUserOptOut: (userId: string, optOutAt: Date | null) => Promise<unknown>;
}

interface TwilioInboundBody {
  From?: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  // 12 §C step 9: present only when Advanced Opt-Out is enabled on the
  // Messaging Service, and only on the request that matched one of its
  // keywords — https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
  // confirms this arrives as a field on the *same* inbound-message webhook
  // request (this route), not a separate opt-out-specific URL, and that
  // Twilio has already replied to the sender with its own confirmation by
  // the time this request is even sent. Twilio also auto-blocks subsequent
  // sends to a STOP'd number at the API level (error 21610) regardless of
  // what this app does — opt_out_at is written purely so sendMessage() and
  // the scheduler can skip a send that would otherwise just fail (step 11).
  OptOutType?: 'STOP' | 'START' | 'HELP';
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

      // 12 §C step 10/11: handled here, not routed through
      // handleInboundMessage/classifyTrigger at all — Twilio's Advanced
      // Opt-Out already matched the keyword and replied before this request
      // was even sent (step 9), so there's no conversation-state decision
      // left for the app to make, only the opt_out_at column to keep in
      // sync. HELP needs no column write (Twilio's own reply already
      // answered it) but still short-circuits here so it's never
      // misclassified as real message content downstream.
      if (body.OptOutType === 'STOP') {
        await deps.setUserOptOut(user.id, new Date());
      }
      if (body.OptOutType === 'START') {
        await deps.setUserOptOut(user.id, null);
      }
      if (body.OptOutType) {
        reply.header('Content-Type', 'text/xml');
        return EMPTY_TWIML;
      }

      let photoKey: string | undefined;
      const numMedia = Number(body.NumMedia ?? '0');
      if (numMedia > 0 && body.MediaUrl0) {
        const media = await deps.fetchMedia(body.MediaUrl0);
        photoKey = await deps.objectStore.putObject(media.buffer, media.contentType);
      }

      // Not awaited: the meal_content path can block on a multi-second
      // vision call (09 §D step 19), and Twilio retries a webhook that
      // doesn't respond promptly — awaiting here would risk the same
      // inbound message being processed twice. Replies go out async via the
      // REST API regardless (04 §4.1 step 6), so the TwiML response itself
      // never needed to wait on this. The .catch keeps a rejection from
      // vanishing as a silent, unhandled promise rejection.
      void deps.handleInboundMessage({
        userId: user.id,
        text: body.Body,
        photoKey,
        currentState: user.conversationState,
      }).catch((error: unknown) => {
        request.log.error(error, 'handleInboundMessage failed');
      });

      reply.header('Content-Type', 'text/xml');
      return EMPTY_TWIML;
    },
  );
}
