import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoute } from './routes/health.js';
import { registerTwilioInboundRoute, type TwilioInboundDeps } from './routes/twilio-inbound.js';

export type { TwilioInboundDeps };

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(deps: TwilioInboundDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  app.register(formbody);
  registerHealthRoute(app);
  registerTwilioInboundRoute(app, deps);
  return app;
}
