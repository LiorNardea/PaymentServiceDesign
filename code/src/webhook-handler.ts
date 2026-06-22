/**
 * Stripe webhook processor — the sole publisher of final payment state.
 *
 * Two entry points:
 *   handleStripeWebhook  — Express route handler (real HTTP from Stripe)
 *   processStripeEvent   — pure async function (used by the mock callback in index.ts)
 *
 * Both paths share the same dedup + business logic so there is no duplicate
 * processing code between the HTTP route and the in-process mock.
 */
import { Request, Response } from 'express';
import { ulid } from 'ulid';
import { db } from './db';

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// HTTP adapter — called by Express for real Stripe webhook deliveries
// ---------------------------------------------------------------------------
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  // In production: verify req.headers['stripe-signature'] with
  // stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)
  const event = req.body as StripeWebhookEvent;

  if (!event?.id || !event?.type) {
    res.status(400).json({ error: 'invalid event' });
    return;
  }

  try {
    await processStripeEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] processing error:', err);
    // Return 500 so Stripe retries delivery
    res.status(500).json({ error: 'processing failed' });
  }
}

// ---------------------------------------------------------------------------
// Core business logic — idempotent, no HTTP concerns
// ---------------------------------------------------------------------------
export async function processStripeEvent(event: StripeWebhookEvent): Promise<void> {
  // Step 1 — deduplicate: INSERT ... ON CONFLICT → skip if already processed
  const isNew = await db.markWebhookProcessed(event.id, event.type);
  if (!isNew) {
    console.log(`[webhook] ${event.id} already processed — skipping`);
    return;
  }

  // Step 2–4 — resolve payment, update status, append audit event
  const obj = event.data.object;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const piId = obj['id'] as string | undefined;
      // Prefer looking up by stripe_pi_id (indexed). Fall back to metadata.paymentId
      // for the mock, which embeds paymentId directly.
      let payment = piId ? await db.getPaymentByStripePiId(piId) : undefined;
      if (!payment) {
        const metaPaymentId = (obj['metadata'] as Record<string, string> | undefined)?.['paymentId'];
        if (metaPaymentId) payment = await db.getPayment(metaPaymentId);
      }
      if (!payment) {
        console.warn(`[webhook] payment_intent.succeeded: no payment found for PI ${piId}`);
        break;
      }
      const moved = await db.updatePaymentStatus(payment.id, 'processing', { status: 'succeeded' });
      if (moved) {
        await db.insertPaymentEvent({
          id: `pe_${ulid()}`,
          paymentId: payment.id,
          eventType: 'stripe_webhook_received',
          fromStatus: 'processing',
          toStatus: 'succeeded',
          payload: { stripeEventId: event.id, stripeEventType: event.type },
          createdAt: new Date(),
        });
        console.log(`[webhook] ${event.id} → payment ${payment.id} succeeded`);
        // In production: publish PaymentStateChanged { newStatus: 'succeeded' } to SNS here
      } else {
        console.log(`[webhook] payment ${payment.id} already past processing — no-op`);
      }
      break;
    }

    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const piId = obj['id'] as string | undefined;
      let payment = piId ? await db.getPaymentByStripePiId(piId) : undefined;
      if (!payment) {
        const metaPaymentId = (obj['metadata'] as Record<string, string> | undefined)?.['paymentId'];
        if (metaPaymentId) payment = await db.getPayment(metaPaymentId);
      }
      if (!payment) {
        console.warn(`[webhook] ${event.type}: no payment found for PI ${piId}`);
        break;
      }
      const reason =
        (obj['last_payment_error'] as Record<string, string> | undefined)?.['message'] ??
        (event.type === 'payment_intent.canceled' ? 'canceled' : 'unknown');
      const moved = await db.updatePaymentStatus(payment.id, 'processing', {
        status: 'failed',
        failureReason: reason,
      });
      if (moved) {
        await db.insertPaymentEvent({
          id: `pe_${ulid()}`,
          paymentId: payment.id,
          eventType: 'stripe_webhook_received',
          fromStatus: 'processing',
          toStatus: 'failed',
          payload: { stripeEventId: event.id, stripeEventType: event.type, reason },
          createdAt: new Date(),
        });
        console.log(`[webhook] ${event.id} → payment ${payment.id} failed: ${reason}`);
        // In production: publish PaymentStateChanged { newStatus: 'failed' } to SNS here
      }
      break;
    }

    case 'charge.refunded': {
      const piId = obj['payment_intent'] as string | undefined;
      if (!piId) {
        console.warn('[webhook] charge.refunded: missing payment_intent field');
        break;
      }
      // The refund row has stripe_pi_id set to the same PI as the original payment
      // (set by the worker in processRefund). Use the indexed lookup.
      const payment = await db.getPaymentByStripePiId(piId);
      if (!payment) {
        console.warn(`[webhook] charge.refunded: no payment found for PI ${piId}`);
        break;
      }
      // payment could be the original (succeeded) or the refund row (refund_pending).
      // The refund row is what we need to transition.
      const target = payment.status === 'refund_pending' ? payment : await db.getRefundPendingByParentId(payment.id);
      if (!target) {
        console.warn(`[webhook] charge.refunded: no refund_pending row found for PI ${piId}`);
        break;
      }
      await db.updatePaymentStatus(target.id, 'refund_pending', { status: 'refunded' });
      await db.insertPaymentEvent({
        id: `pe_${ulid()}`,
        paymentId: target.id,
        eventType: 'stripe_webhook_received',
        fromStatus: 'refund_pending',
        toStatus: 'refunded',
        payload: { stripeEventId: event.id, stripeEventType: event.type },
        createdAt: new Date(),
      });
      console.log(`[webhook] ${event.id} → payment ${target.id} refunded`);
      // In production: publish PaymentStateChanged { newStatus: 'refunded' } to SNS here
      break;
    }

    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
  }
}
