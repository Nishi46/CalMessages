import type { FastifyInstance } from 'fastify';

// 11 breakdown §C step 10: the success/cancel URLs a Checkout Session
// redirects to. "No account creation on that page — the phone number is the
// identity" (04 §8.2 step 1), and checkout.session.completed (not this
// page) is what actually unlocks the thread — so the smallest viable
// version is a static response, not a page app.
export function registerCheckoutConfirmationRoutes(app: FastifyInstance): void {
  app.get('/checkout/success', async (_request, reply) => {
    reply.type('text/html');
    return "<!doctype html><title>Tally</title><body>You're all set — close this tab and go back to texting Tally.</body>";
  });

  app.get('/checkout/cancel', async (_request, reply) => {
    reply.type('text/html');
    return '<!doctype html><title>Tally</title><body>Checkout canceled — close this tab. Text Tally again whenever you want to upgrade.</body>';
  });
}
