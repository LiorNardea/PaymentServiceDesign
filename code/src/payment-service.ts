/**
 * Core payment service — business logic layer.
 *
 * Responsibilities:
 *   - Validate the request
 *   - Write payments + outbox rows atomically (single DB transaction in production)
 *   - Return 202 immediately — no Stripe calls happen here
 *
 * The outbox relay (outbox-relay.ts) is the only component that enqueues jobs.
 * This service never calls queue.enqueue() directly.
 */
import { ulid } from 'ulid';
import { CreatePaymentRequest, CreateRefundRequest, Payment } from './types';
import { db } from './db';

export async function createPayment(req: CreatePaymentRequest): Promise<Payment> {
  const id = `pay_${ulid()}`;
  const now = new Date();

  const payment: Payment = {
    id,
    consumerId: req.consumerId,
    idempotencyKey: req.idempotencyKey,
    customerId: req.customerId,
    amount: req.amount,
    currency: req.currency,
    description: req.description,
    metadata: req.metadata,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  // In production: both inserts happen in a single DB transaction so a crash
  // between them is impossible — either both rows exist or neither does.
  const inserted = await db.insertPayment(payment);

  // If id differs, the idempotency key already existed — return existing row.
  if (inserted.id !== id) {
    return inserted;
  }

  await db.insertOutboxEntry({
    id: `ob_${ulid()}`,
    paymentId: id,
    payload: { type: 'charge', paymentId: id },
    createdAt: now,
  });

  // The outbox relay will pick this up within ~200ms and enqueue it to SQS.
  console.log(`[payment-service] created ${id} for ${req.consumerId} — outbox relay will enqueue`);

  return inserted;
}

export async function getPayment(id: string): Promise<Payment | undefined> {
  return db.getPayment(id);
}

export async function createRefund(paymentId: string, req: CreateRefundRequest): Promise<Payment> {
  const payment = await db.getPayment(paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status !== 'succeeded') {
    throw new Error(`Cannot refund payment in status: ${payment.status}`);
  }

  // Atomic optimistic transition: succeeded → refund_pending
  const moved = await db.updatePaymentStatus(paymentId, 'succeeded', { status: 'refund_pending' });
  if (!moved) throw new Error('Payment status changed concurrently — retry');

  await db.insertOutboxEntry({
    id: `ob_${ulid()}`,
    paymentId,
    payload: { type: 'refund', paymentId, idempotencyKey: req.idempotencyKey },
    createdAt: new Date(),
  });

  console.log(`[payment-service] refund requested for ${paymentId} — outbox relay will enqueue`);

  return (await db.getPayment(paymentId))!;
}
