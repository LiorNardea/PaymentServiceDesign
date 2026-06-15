/**
 * Mock Stripe client.
 * Simulates async confirmation: create() returns "processing",
 * and after a delay the payment "succeeds" — in reality Stripe sends a webhook.
 * The webhook simulation is done via webhookCallbacks registered here.
 */

export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'processing'
  | 'succeeded'
  | 'canceled'
  | 'payment_failed';

export interface StripePaymentIntent {
  id: string;
  status: StripePaymentIntentStatus;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface StripeRefund {
  id: string;
  paymentIntentId: string;
  amount: number;
  status: 'succeeded' | 'failed';
}

type WebhookCallback = (event: { type: string; data: { object: unknown } }) => void;

class StripeMock {
  private paymentIntents = new Map<string, StripePaymentIntent>();
  private refunds = new Map<string, StripeRefund>();
  private webhookCallback?: WebhookCallback;
  private piCounter = 0;
  private refundCounter = 0;

  registerWebhookCallback(cb: WebhookCallback): void {
    this.webhookCallback = cb;
  }

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    customerId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<StripePaymentIntent> {
    // Check idempotency: same key → return same PI
    for (const pi of this.paymentIntents.values()) {
      if (pi.metadata['_idempotencyKey'] === params.idempotencyKey) {
        return pi;
      }
    }

    const pi: StripePaymentIntent = {
      id: `pi_mock_${++this.piCounter}`,
      status: 'processing',
      amount: params.amount,
      currency: params.currency,
      metadata: { ...params.metadata, _idempotencyKey: params.idempotencyKey },
    };

    this.paymentIntents.set(pi.id, pi);

    // Simulate async Stripe webhook confirmation after 500ms
    setTimeout(() => {
      const stored = this.paymentIntents.get(pi.id)!;
      const succeeded = { ...stored, status: 'succeeded' as const };
      this.paymentIntents.set(pi.id, succeeded);

      this.webhookCallback?.({
        type: 'payment_intent.succeeded',
        data: { object: succeeded },
      });
    }, 500);

    return pi;
  }

  async retrievePaymentIntent(id: string): Promise<StripePaymentIntent | null> {
    return this.paymentIntents.get(id) ?? null;
  }

  async createRefund(params: {
    paymentIntentId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<StripeRefund> {
    for (const r of this.refunds.values()) {
      if (r.paymentIntentId === params.paymentIntentId) {
        return r; // idempotent
      }
    }

    const refund: StripeRefund = {
      id: `re_mock_${++this.refundCounter}`,
      paymentIntentId: params.paymentIntentId,
      amount: params.amount,
      status: 'succeeded',
    };

    this.refunds.set(refund.id, refund);

    setTimeout(() => {
      this.webhookCallback?.({
        type: 'charge.refunded',
        data: { object: { payment_intent: params.paymentIntentId, refunds: { data: [refund] } } },
      });
    }, 300);

    return refund;
  }
}

export const stripe = new StripeMock();
