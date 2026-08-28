import Stripe from 'stripe';

export interface CreateCheckoutSessionParams {
  userId: string;
  successUrl: string;
  cancelUrl: string;
}

// Mirrors @tally/messaging's TwilioSendClient — a thin interface over the
// third-party SDK so createCheckoutLink is testable against a fake, and the
// real Stripe wiring (API version, price ID) lives in one place.
export interface CheckoutClient {
  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<{ url: string }>;
}

export interface StripeCheckoutClientConfig {
  secretKey: string;
  // 04 §8.2 step 1's $9.99/mo plan, as a Stripe Price ID — Checkout Sessions
  // in subscription mode need a Price to build line_items from, and this
  // repo's env vars have nowhere else that value would come from.
  priceId: string;
}

export function createStripeCheckoutClient(config: StripeCheckoutClientConfig): CheckoutClient {
  const stripe = new Stripe(config.secretKey);
  return {
    async createCheckoutSession({ userId, successUrl, cancelUrl }) {
      // client_reference_id, not metadata — it's what checkout.session.completed
      // hands back directly on the session object (04 §8.2 step 3), no extra
      // lookup needed to resolve which user just paid.
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: userId,
        line_items: [{ price: config.priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      if (!session.url) {
        throw new Error('Stripe created a checkout session without a url');
      }
      return { url: session.url };
    },
  };
}

// 11 breakdown §C step 10. No account creation on the confirmation page the
// success/cancel URLs point at — the phone number is the identity, so
// client_reference_id = userId is all checkout.session.completed needs to
// resume the right thread.
export async function createCheckoutLink(
  client: CheckoutClient,
  userId: string,
  urls: { successUrl: string; cancelUrl: string },
): Promise<string> {
  const session = await client.createCheckoutSession({ userId, ...urls });
  return session.url;
}
