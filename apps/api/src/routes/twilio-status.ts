import twilio from 'twilio';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface TwilioStatusDeps {
  authToken: string;
  publicBaseUrl: string;
  updateMessageEventStatus: (twilioSid: string, deliveryStatus: string) => Promise<unknown>;
}

interface TwilioStatusBody {
  MessageSid?: string;
  MessageStatus?: string;
  [key: string]: string | undefined;
}

export function registerTwilioStatusRoute(app: FastifyInstance, deps: TwilioStatusDeps): void {
  app.post(
    '/webhooks/twilio/status',
    async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
      const signature = request.headers['x-twilio-signature'];
      const body = (request.body ?? {}) as TwilioStatusBody;
      const url = new URL(request.url, deps.publicBaseUrl).toString();

      const isValid =
        typeof signature === 'string' &&
        twilio.validateRequest(deps.authToken, signature, url, body as Record<string, string>);

      if (!isValid) {
        reply.code(403);
        return '';
      }

      const { MessageSid, MessageStatus } = body;
      if (MessageSid && MessageStatus) {
        await deps.updateMessageEventStatus(MessageSid, MessageStatus);
      }

      reply.code(204);
      return '';
    },
  );
}
