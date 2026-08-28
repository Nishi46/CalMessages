import { describe, expect, it, vi } from 'vitest';
import { createCheckoutLink, type CheckoutClient } from './checkoutClient.js';

function fakeClient(url = 'https://checkout.stripe.com/c/fake'): CheckoutClient & {
  createCheckoutSession: ReturnType<typeof vi.fn>;
} {
  return { createCheckoutSession: vi.fn().mockResolvedValue({ url }) };
}

describe('createCheckoutLink (11 breakdown §C step 10)', () => {
  it('passes userId as client_reference_id-worthy input and the given URLs through to the client', async () => {
    const client = fakeClient();

    await createCheckoutLink(client, 'user-123', {
      successUrl: 'https://example.com/checkout/success',
      cancelUrl: 'https://example.com/checkout/cancel',
    });

    expect(client.createCheckoutSession).toHaveBeenCalledWith({
      userId: 'user-123',
      successUrl: 'https://example.com/checkout/success',
      cancelUrl: 'https://example.com/checkout/cancel',
    });
  });

  it('returns the session url the client produces', async () => {
    const client = fakeClient('https://checkout.stripe.com/c/session_abc');

    const link = await createCheckoutLink(client, 'user-123', {
      successUrl: 'https://example.com/checkout/success',
      cancelUrl: 'https://example.com/checkout/cancel',
    });

    expect(link).toBe('https://checkout.stripe.com/c/session_abc');
  });
});
