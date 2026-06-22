/**
 * Queue worker — processes charge and refund jobs.
 * In production: multiple worker processes each polling SQS independently.
 * Each worker maintains a semaphore of N concurrent in-flight Stripe calls
 * (sliding window — not a batch). Here N=1 for the skeleton.
 */
import { ulid } from 'ulid';
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
  // Optimistic lock: only one worker can claim a pending job.
  const moved = await db.updatePaymentStatus(payment.id, 'pending', { status: 'processing' });
  if (!moved) {
    // Already processing — check stripe_pi_id to distinguish two crash windows:
    //   stripe_pi_id IS SET  → Stripe was called before crash → skip, webhook will arrive
    //   stripe_pi_id IS NULL → Stripe was never called → must proceed with the call
    const current = await db.getPayment(payment.id);
    if (current?.stripePiId) {
      console.log(`[worker] ${payment.id} already processing with PI ${current.stripePiId} — skipping`);
      return;
    }
    console.log(`[worker] ${payment.id} processing but stripe_pi_id is NULL — crash before Stripe, retrying call`);
    // Fall through and call Stripe below
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

    // Write stripe_pi_id atomically with the processing transition so the
    // Webhook Handler and Reconciliation can resolve this payment by PI id.
    await db.forceUpdatePayment(payment.id, { stripePiId: pi.id });

    await db.insertPaymentEvent({
      id: `pe_${ulid()}`,
      paymentId: payment.id,
      eventType: 'stripe_charge_initiated',
      fromStatus: 'pending',
      toStatus: 'processing',
      payload: { stripePiId: pi.id, stripeStatus: pi.status },
      createdAt: new Date(),
    });

    console.log(`[worker] ${payment.id} → stripe PI ${pi.id} created (status: ${pi.status})`);

    // Synchronous confirmation (rare). Normally the webhook drives this transition.
    if (pi.status === 'succeeded') {
      await db.updatePaymentStatus(payment.id, 'processing', { status: 'succeeded' });
      await db.insertPaymentEvent({
        id: `pe_${ulid()}`,
        paymentId: payment.id,
        eventType: 'status_changed',
        fromStatus: 'processing',
        toStatus: 'succeeded',
        payload: { source: 'stripe_sync_response' },
        createdAt: new Date(),
      });
      console.log(`[worker] ${payment.id} → succeeded (sync)`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.forceUpdatePayment(payment.id, { status: 'failed', failureReason: reason });
    await db.insertPaymentEvent({
      id: `pe_${ulid()}`,
      paymentId: payment.id,
      eventType: 'stripe_charge_failed',
      fromStatus: 'processing',
      toStatus: 'failed',
      payload: { reason },
      createdAt: new Date(),
    });
    console.error(`[worker] ${payment.id} → failed: ${reason}`);
    throw err; // let queue handle redelivery
  }
}

async function processRefund(job: QueueJob, payment: Payment): Promise<void> {
  if (payment.status !== 'refund_pending') {
    console.log(`[worker] ${payment.id} not in refund_pending — skipping`);
    return;
  }

  if (!payment.stripePiId) {
    // Look up the original payment's PI id via parent_payment_id
    const original = payment.parentPaymentId ? await db.getPayment(payment.parentPaymentId) : undefined;
    if (!original?.stripePiId) {
      await db.forceUpdatePayment(payment.id, { status: 'refund_failed', failureReason: 'no stripe PI id' });
      return;
    }
    // Set stripe_pi_id on the refund row so charge.refunded webhook can find it
    await db.forceUpdatePayment(payment.id, { stripePiId: original.stripePiId });
    payment = { ...payment, stripePiId: original.stripePiId };
  }

  try {
    await stripe.createRefund({
      paymentIntentId: payment.stripePiId!,
      amount: payment.amount,
      idempotencyKey: `refund:${payment.id}`,
    });

    await db.insertPaymentEvent({
      id: `pe_${ulid()}`,
      paymentId: payment.id,
      eventType: 'stripe_refund_initiated',
      fromStatus: 'refund_pending',
      payload: { stripePiId: payment.stripePiId },
      createdAt: new Date(),
    });

    console.log(`[worker] ${payment.id} → refund initiated on Stripe (PI: ${payment.stripePiId})`);
    // Webhook drives the final transition to 'refunded'
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.forceUpdatePayment(payment.id, { status: 'refund_failed', failureReason: reason });
    await db.insertPaymentEvent({
      id: `pe_${ulid()}`,
      paymentId: payment.id,
      eventType: 'stripe_refund_failed',
      fromStatus: 'refund_pending',
      toStatus: 'refund_failed',
      payload: { reason },
      createdAt: new Date(),
    });
    console.error(`[worker] ${payment.id} → refund failed: ${reason}`);
    throw err;
  }
}

export function startWorker(): void {
  queue.registerHandler(processJob);
  queue.startPolling();
  console.log('[worker] started, polling SQS');
}
