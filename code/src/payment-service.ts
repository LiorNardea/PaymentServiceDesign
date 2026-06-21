/**
 * Core payment service — business logic layer.
 * Orchestrates DB writes, outbox, and queue enqueue atomically.
 */
import { ulid } from 'ulid';
import { CreatePaymentRequest, CreateRefundRequest, Payment } from './types';
import { db } from './db';
import { queue } from './queue';

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

  // Atomic write: in production this is a single DB transaction that also
  // inserts an outbox row.
  const inserted = await db.insertPayment(payment);

  // If inserted.id !== id, the idempotency key was already used — return existing.
  if (inserted.id !== id) {
    return inserted;
  }

  // Write outbox entry (in production: same transaction as insertPayment)
  await db.insertOutboxEntry({
    id: ulid(),
    paymentId: id,
    payload: { type: 'charge', paymentId: id },
    createdAt: now,
  });

  // In production: an outbox relay reads this entry and calls queue.enqueue().
  // Here we call it inline for simplicity — see design/data-model.md's
  // "Note on the bonus code" for why this differs from the production design.
  await queue.enqueue(id, 'charge');
  console.log(`[payment-service] created ${id} for ${req.consumerId}`);

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

  // Atomic transition: succeeded → refund_pending
  const moved = await db.updatePaymentStatus(paymentId, 'succeeded', {
    status: 'refund_pending',
  });
  if (!moved) throw new Error('Payment status changed concurrently — retry');

  await db.insertOutboxEntry({
    id: ulid(),
    paymentId,
    payload: { type: 'refund', paymentId, idempotencyKey: req.idempotencyKey },
    createdAt: new Date(),
  });

  await queue.enqueue(paymentId, 'refund');
  console.log(`[payment-service] refund enqueued for ${paymentId}`);

  return (await db.getPayment(paymentId))!;
}
