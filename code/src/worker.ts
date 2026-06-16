/**
 * Queue worker — processes charge and refund jobs.
 * In production: multiple worker processes each polling SQS independently.
 */
import { QueueJob, Payment } from './types';
import { db } from './db';
import { stripe } from './stripe-mock';
import { queue } from './queue';

async function processJob(job: QueueJob): Promise<void> {
  const payment = await db.getPayment(job.paymentId);
  if (!payment) {
    console.warn(`[worker] payment ${job.paymentId} not found — skipping`);
    return;
  }

  if (job.type === 'charge') {
    await processCharge(job, payment);
  } else {
    await processRefund(job, payment);
  }
}

async function processCharge(job: QueueJob, payment: Payment): Promise<void> {
  // Atomic transition: pending → processing
  // Guards against concurrent workers or double-delivery
  const moved = await db.updatePaymentStatus(payment.id, 'pending', {
    status: 'processing',
  });
  if (!moved) {
    console.log(`[worker] ${payment.id} already past pending — skipping`);
    return;
  }

  const stripeIdempotencyKey = `${payment.consumerId}:${payment.idempotencyKey}`;

  try {
    const pi = await stripe.createPaymentIntent({
      amount: payment.amount,
      currency: payment.currency,
      customerId: payment.customerId,
      idempotencyKey: stripeIdempotencyKey,
      metadata: { paymentId: payment.id, consumerId: payment.consumerId },
    });

    // Record the Stripe PI id so webhook handler and reconciliation can look it up
    await db.forceUpdatePayment(payment.id, { stripePiId: pi.id });
    console.log(`[worker] ${payment.id} → stripe PI ${pi.id} created (status: ${pi.status})`);

    // If Stripe returns synchronous confirmation (rare but possible for some payment methods)
    if (pi.status === 'succeeded') {
      await db.updatePaymentStatus(payment.id, 'processing', { status: 'succeeded' });
      console.log(`[worker] ${payment.id} → succeeded (sync)`);
    }
    // Otherwise, webhook will drive the next transition
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.forceUpdatePayment(payment.id, { status: 'failed', failureReason: reason });
    console.error(`[worker] ${payment.id} → failed: ${reason}`);
    throw err; // let queue handle retry logic
  }
}

async function processRefund(job: QueueJob, payment: Payment): Promise<void> {
  if (payment.status !== 'refund_pending') {
    console.log(`[worker] ${payment.id} not in refund_pending — skipping`);
    return;
  }

  if (!payment.stripePiId) {
    await db.forceUpdatePayment(payment.id, { status: 'refund_failed', failureReason: 'no stripe PI id' });
    return;
  }

  try {
    await stripe.createRefund({
      paymentIntentId: payment.stripePiId,
      amount: payment.amount,
      idempotencyKey: `refund:${payment.id}`,
    });
    console.log(`[worker] ${payment.id} → refund initiated on Stripe`);
    // Webhook drives the final transition to 'refunded'
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.forceUpdatePayment(payment.id, { status: 'refund_failed', failureReason: reason });
    console.error(`[worker] ${payment.id} → refund failed: ${reason}`);
    throw err;
  }
}

export function startWorker(): void {
  queue.registerHandler(processJob);
  console.log('[worker] started');
}
