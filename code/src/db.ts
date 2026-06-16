/**
 * Postgres-backed store. Schema: ../schema.sql
 * Connects to a local Postgres instance (DATABASE_URL env var, defaults below).
 */
import { Pool } from 'pg';
import { Payment, OutboxEntry } from './types';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/payment_service',
});

function rowToPayment(row: any): Payment {
  return {
    id: row.id,
    consumerId: row.consumer_id,
    idempotencyKey: row.idempotency_key,
    customerId: row.customer_id,
    amount: row.amount,
    currency: row.currency,
    description: row.description ?? undefined,
    metadata: row.metadata ?? undefined,
    status: row.status,
    stripePiId: row.stripe_pi_id ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    parentPaymentId: row.parent_payment_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class PostgresDb {
  async insertPayment(payment: Payment): Promise<Payment> {
    try {
      const res = await pool.query(
        `INSERT INTO payments
          (id, consumer_id, idempotency_key, customer_id, amount, currency, description, metadata, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          payment.id,
          payment.consumerId,
          payment.idempotencyKey,
          payment.customerId,
          payment.amount,
          payment.currency,
          payment.description ?? null,
          payment.metadata ?? null,
          payment.status,
          payment.createdAt,
          payment.updatedAt,
        ],
      );
      return rowToPayment(res.rows[0]);
    } catch (err: any) {
      // unique_violation on (consumer_id, idempotency_key) -> idempotent replay
      if (err.code === '23505') {
        const existing = await pool.query(
          `SELECT * FROM payments WHERE consumer_id = $1 AND idempotency_key = $2`,
          [payment.consumerId, payment.idempotencyKey],
        );
        return rowToPayment(existing.rows[0]);
      }
      throw err;
    }
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    const res = await pool.query(`SELECT * FROM payments WHERE id = $1`, [id]);
    return res.rows[0] ? rowToPayment(res.rows[0]) : undefined;
  }

  /**
   * Conditional update — only proceeds if current status matches expectedStatus.
   * Returns true if a row was updated.
   */
  async updatePaymentStatus(
    id: string,
    expectedStatus: Payment['status'],
    patch: Partial<Payment>,
  ): Promise<boolean> {
    const res = await pool.query(
      `UPDATE payments
       SET status = $1,
           stripe_pi_id = COALESCE($2, stripe_pi_id),
           failure_reason = COALESCE($3, failure_reason),
           updated_at = now()
       WHERE id = $4 AND status = $5`,
      [patch.status, patch.stripePiId ?? null, patch.failureReason ?? null, id, expectedStatus],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async forceUpdatePayment(id: string, patch: Partial<Payment>): Promise<void> {
    await pool.query(
      `UPDATE payments
       SET status = COALESCE($1, status),
           stripe_pi_id = COALESCE($2, stripe_pi_id),
           failure_reason = COALESCE($3, failure_reason),
           updated_at = now()
       WHERE id = $4`,
      [patch.status ?? null, patch.stripePiId ?? null, patch.failureReason ?? null, id],
    );
  }

  async getPaymentsByStatus(status: Payment['status']): Promise<Payment[]> {
    const res = await pool.query(`SELECT * FROM payments WHERE status = $1`, [status]);
    return res.rows.map(rowToPayment);
  }

  // ---------- outbox ----------

  async insertOutboxEntry(entry: OutboxEntry): Promise<void> {
    await pool.query(
      `INSERT INTO outbox (id, payment_id, payload, created_at) VALUES ($1,$2,$3,$4)`,
      [entry.id, entry.paymentId, entry.payload, entry.createdAt],
    );
  }

  async getPendingOutboxEntries(): Promise<OutboxEntry[]> {
    const res = await pool.query(`SELECT * FROM outbox WHERE enqueued_at IS NULL`);
    return res.rows.map(r => ({
      id: r.id,
      paymentId: r.payment_id,
      payload: r.payload,
      enqueuedAt: r.enqueued_at ?? undefined,
      createdAt: r.created_at,
    }));
  }

  async markOutboxEnqueued(id: string): Promise<void> {
    await pool.query(`UPDATE outbox SET enqueued_at = now() WHERE id = $1`, [id]);
  }

  // ---------- webhook dedup ----------

  async markWebhookProcessed(stripeEventId: string, eventType = 'unknown'): Promise<boolean> {
    const res = await pool.query(
      `INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [stripeEventId, eventType],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

export const db = new PostgresDb();
