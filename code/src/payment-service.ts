/**
 * Core payment service — business logic layer.
 * Orchestrates DB writes, outbox, and queue enqueue atomically.
 */
import { ulid } from 'ulid';
import { CreatePaymentRequest, CreateRefundRequest, Payment } from './types';
import { db } from './db';
import { queue } from './queue';

export function createPayment(req: CreatePaymentRequest): Payment {
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
  // inserts an outbox row. Here we simulate with sequential in-memory ops.
  const inserted = db.insertPayment(payment);

  // If inserted === payment, this is a new record. If it returned an existing
  // payment, the idempotency key was already used — return the existing one.
  if (inserted.id !== id) {
    // idempotency hit: return existing record without enqueuing
    return inserted;
  }

  // Write outbox entry (in production: same transaction as insertPayment)
  db.insertOutboxEntry({
    id: ulid(),
    paymentId: id,
    payload: { type: 'charge', paymentId: id },
    createdAt: now,
  });

  // In production: an outbox relay reads this entry and calls queue.enqueue().
  // Here we call it inline for simplicity.
  queue.enqueue(id, 'charge');
  console.log(`[payment-service] created ${id} for ${req.consumerId}`);

  return inserted;
}

export function getPayment(id: string): Payment | undefined {
  return db.getPayment(id);
}

export function createRefund(paymentId: string, req: CreateRefundRequest): Payment {
  const payment = db.getPayment(paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status !== 'succeeded') {
    throw new Error(`Cannot refund payment in status: ${payment.status}`);
  }

  // Atomic transition: succeeded → refund_pending
  const moved = db.updatePaymentStatus(paymentId, 'succeeded', {
    status: 'refund_pending',
  });
  if (!moved) throw new Error('Payment status changed concurrently — retry');

  db.insertOutboxEntry({
    id: ulid(),
    paymentId,
    payload: { type: 'refund', paymentId, idempotencyKey: req.idempotencyKey },
    createdAt: new Date(),
  });

  queue.enqueue(paymentId, 'refund');
  console.log(`[payment-service] refund enqueued for ${paymentId}`);

  return db.getPayment(paymentId)!;
}
