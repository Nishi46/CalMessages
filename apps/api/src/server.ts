import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoute } from './routes/health.js';
import { registerTwilioInboundRoute, type TwilioInboundDeps } from './routes/twilio-inbound.js';
import { registerTwilioStatusRoute, type TwilioStatusDeps } from './routes/twilio-status.js';

export type { TwilioInboundDeps, TwilioStatusDeps };

export type AppDeps = TwilioInboundDeps & TwilioStatusDeps;

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  app.register(formbody);
  registerHealthRoute(app);
  registerTwilioInboundRoute(app, deps);
  registerTwilioStatusRoute(app, deps);
  return app;
}
