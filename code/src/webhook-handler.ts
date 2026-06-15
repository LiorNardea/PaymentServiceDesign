/**
 * Stripe webhook processor.
 * Idempotent: duplicate events are silently discarded.
 */
import { Request, Response } from 'express';
import { db } from './db';

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export function handleStripeWebhook(req: Request, res: Response): void {
  // In production: verify Stripe-Signature header with stripe.webhooks.constructEvent()
  const event = req.body as StripeWebhookEvent;

  if (!event?.id || !event?.type) {
    res.status(400).json({ error: 'invalid event' });
    return;
  }

  // Idempotency: if already processed, return 200 immediately
  const isNew = db.markWebhookProcessed(event.id);
  if (!isNew) {
    console.log(`[webhook] ${event.id} already processed — skipping`);
    res.status(200).json({ received: true });
    return;
  }

  try {
    processEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] processing error:', err);
    // Return 500 so Stripe retries delivery
    res.status(500).json({ error: 'processing failed' });
  }
}

function processEvent(event: StripeWebhookEvent): void {
  const obj = event.data.object;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentId = obj['metadata'] && (obj['metadata'] as Record<string, string>)['paymentId'];
      if (!paymentId) break;
      const moved = db.updatePaymentStatus(paymentId as string, 'processing', { status: 'succeeded' });
      console.log(`[webhook] payment_intent.succeeded → payment ${paymentId} ${moved ? 'succeeded' : 'already updated'}`);
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentId = obj['metadata'] && (obj['metadata'] as Record<string, string>)['paymentId'];
      const reason = (obj['last_payment_error'] as Record<string, string> | undefined)?.['message'] ?? 'unknown';
      if (!paymentId) break;
      db.updatePaymentStatus(paymentId as string, 'processing', { status: 'failed', failureReason: reason });
      console.log(`[webhook] payment_intent.payment_failed → payment ${paymentId} failed: ${reason}`);
      break;
    }

    case 'charge.refunded': {
      const piId = obj['payment_intent'] as string | undefined;
      if (!piId) break;
      // Look up payment by Stripe PI id
      const allProcessing = db.getPaymentsByStatus('refund_pending');
      const payment = allProcessing.find(p => p.stripePiId === piId);
      if (!payment) {
        console.warn(`[webhook] charge.refunded: no payment found for PI ${piId}`);
        break;
      }
      db.forceUpdatePayment(payment.id, { status: 'refunded' });
      console.log(`[webhook] charge.refunded → payment ${payment.id} refunded`);
      break;
    }

    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
  }
}
