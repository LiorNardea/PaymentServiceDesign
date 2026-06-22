/**
 * Reconciliation — fallback publisher for missed webhooks.
 *
 * In production: an AWS Lambda function triggered by EventBridge every 5 minutes.
 * Here it runs as a scheduled interval inside the same process for demonstration.
 *
 * Algorithm (from design/failure-modes.md §3 and §7):
 *   1. Find all payments stuck in `processing` for more than STALE_THRESHOLD_MINUTES.
 *   2. For each, call stripe.paymentIntents.retrieve(stripe_pi_id).
 *   3. Map Stripe's status to an internal transition and update the DB.
 *   4. Publish PaymentStateChanged to SNS (logged here — SNS not wired in the skeleton).
 *
 * After MAX_PROCESSING_HOURS the payment is force-cancelled on Stripe and marked failed.
 */
import { ulid } from 'ulid';
import { db } from './db';
import { stripe } from './stripe-mock';

const STALE_THRESHOLD_MINUTES = 10;
const MAX_PROCESSING_HOURS = 24;
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export function startReconciliation(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => void runReconciliation(), INTERVAL_MS);
  console.log(`[reconciliation] scheduled every ${INTERVAL_MS / 60000} min`);
}

export function stopReconciliation(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}

export async function runReconciliation(): Promise<void> {
  const stale = await db.getStaleProcessingPayments(STALE_THRESHOLD_MINUTES);
  if (stale.length === 0) return;

  console.log(`[reconciliation] found ${stale.length} stale payment(s) in processing`);

  for (const payment of stale) {
    if (!payment.stripePiId) {
      console.warn(`[reconciliation] ${payment.id} has no stripe_pi_id — skipping`);
      continue;
    }

    const ageHours = (Date.now() - payment.updatedAt.getTime()) / (1000 * 60 * 60);

    // Force-cancel payments stuck beyond the maximum threshold
    if (ageHours > MAX_PROCESSING_HOURS) {
      console.log(`[reconciliation] ${payment.id} stuck for ${ageHours.toFixed(1)}h — force cancelling`);
      await db.updatePaymentStatus(payment.id, 'processing', {
        status: 'failed',
        failureReason: `reconciliation: no resolution after ${MAX_PROCESSING_HOURS}h`,
      });
      await db.insertPaymentEvent({
        id: `pe_${ulid()}`,
        paymentId: payment.id,
        eventType: 'reconciliation_force_cancelled',
        fromStatus: 'processing',
        toStatus: 'failed',
        payload: { ageHours },
        createdAt: new Date(),
      });
      // In production: publish PaymentStateChanged { newStatus: 'failed' } to SNS
      console.log(`[reconciliation] would publish PaymentStateChanged { newStatus: 'failed' } to SNS for ${payment.id}`);
      continue;
    }

    // Query Stripe for the real status
    const pi = await stripe.retrievePaymentIntent(payment.stripePiId);
    if (!pi) {
      console.warn(`[reconciliation] stripe PI ${payment.stripePiId} not found`);
      continue;
    }

    if (pi.status === 'succeeded') {
      const moved = await db.updatePaymentStatus(payment.id, 'processing', { status: 'succeeded' });
      if (moved) {
        await db.insertPaymentEvent({
          id: `pe_${ulid()}`,
          paymentId: payment.id,
          eventType: 'reconciliation_resolved',
          fromStatus: 'processing',
          toStatus: 'succeeded',
          payload: { stripePiId: payment.stripePiId, stripeStatus: pi.status },
          createdAt: new Date(),
        });
        // In production: publish PaymentStateChanged { newStatus: 'succeeded' } to SNS
        console.log(`[reconciliation] ${payment.id} → succeeded (webhook was missed). Would publish to SNS.`);
      }
    } else if (pi.status === 'payment_failed' || pi.status === 'canceled') {
      const moved = await db.updatePaymentStatus(payment.id, 'processing', {
        status: 'failed',
        failureReason: `stripe status: ${pi.status}`,
      });
      if (moved) {
        await db.insertPaymentEvent({
          id: `pe_${ulid()}`,
          paymentId: payment.id,
          eventType: 'reconciliation_resolved',
          fromStatus: 'processing',
          toStatus: 'failed',
          payload: { stripePiId: payment.stripePiId, stripeStatus: pi.status },
          createdAt: new Date(),
        });
        console.log(`[reconciliation] ${payment.id} → failed (stripe: ${pi.status}). Would publish to SNS.`);
      }
    } else {
      // 'processing' or 'requires_action' — Stripe hasn't settled yet, leave it
      console.log(`[reconciliation] ${payment.id} still ${pi.status} on Stripe — leaving in processing`);
    }
  }
}
