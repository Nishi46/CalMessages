import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCheckoutConfirmationRoutes } from './routes/checkout-confirmation.js';
import { registerHealthRoute } from './routes/health.js';
import { registerStripeWebhookRoute, type StripeWebhookDeps } from './routes/stripe-webhook.js';
import { registerTwilioInboundRoute, type TwilioInboundDeps } from './routes/twilio-inbound.js';
import { registerTwilioStatusRoute, type TwilioStatusDeps } from './routes/twilio-status.js';

export type { TwilioInboundDeps, TwilioStatusDeps, StripeWebhookDeps };

export type AppDeps = TwilioInboundDeps & TwilioStatusDeps & StripeWebhookDeps;

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  app.register(formbody);
  // Stripe signs the exact raw bytes of the request, so the JSON parser
  // hands them back unparsed rather than pre-parsing into an object — the
  // stripe-webhook route itself verifies the signature and parses the event
  // in one step via stripe.webhooks.constructEvent. Nothing else in this app
  // receives an application/json body, so overriding the default globally
  // (rather than scoping it to one route) is safe.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  registerHealthRoute(app);
  registerTwilioInboundRoute(app, deps);
  registerTwilioStatusRoute(app, deps);
  registerStripeWebhookRoute(app, deps);
  registerCheckoutConfirmationRoutes(app);
  return app;
}
