/**
 * MySQL-backed store. Schema: ../schema.sql
 * Connects to a local MySQL instance (DATABASE_URL env var, defaults below).
 */
import mysql from 'mysql2/promise';
import { Payment, OutboxEntry } from './types';

const pool = mysql.createPool(
  process.env.DATABASE_URL ?? 'mysql://root@localhost:3306/payment_service',
);

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

class MySqlDb {
  async insertPayment(payment: Payment): Promise<Payment> {
    try {
      await pool.execute(
        `INSERT INTO payments
          (id, consumer_id, idempotency_key, customer_id, amount, currency, description, metadata, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          payment.id,
          payment.consumerId,
          payment.idempotencyKey,
          payment.customerId,
          payment.amount,
          payment.currency,
          payment.description ?? null,
          payment.metadata ? JSON.stringify(payment.metadata) : null,
          payment.status,
          payment.createdAt,
          payment.updatedAt,
        ],
      );
      return (await this.getPayment(payment.id))!;
    } catch (err: any) {
      // ER_DUP_ENTRY on (consumer_id, idempotency_key) -> idempotent replay
      if (err.code === 'ER_DUP_ENTRY') {
        const [rows] = await pool.execute(
          `SELECT * FROM payments WHERE consumer_id = ? AND idempotency_key = ?`,
          [payment.consumerId, payment.idempotencyKey],
        );
        return rowToPayment((rows as any[])[0]);
      }
      throw err;
    }
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    const [rows] = await pool.execute(`SELECT * FROM payments WHERE id = ?`, [id]);
    const row = (rows as any[])[0];
    return row ? rowToPayment(row) : undefined;
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
    const [res] = await pool.execute(
      `UPDATE payments
       SET status = ?,
           stripe_pi_id = COALESCE(?, stripe_pi_id),
           failure_reason = COALESCE(?, failure_reason)
       WHERE id = ? AND status = ?`,
      [patch.status ?? expectedStatus, patch.stripePiId ?? null, patch.failureReason ?? null, id, expectedStatus],
    );
    return (res as any).affectedRows > 0;
  }

  async forceUpdatePayment(id: string, patch: Partial<Payment>): Promise<void> {
    await pool.execute(
      `UPDATE payments
       SET status = COALESCE(?, status),
           stripe_pi_id = COALESCE(?, stripe_pi_id),
           failure_reason = COALESCE(?, failure_reason)
       WHERE id = ?`,
      [patch.status ?? null, patch.stripePiId ?? null, patch.failureReason ?? null, id],
    );
  }

  async getPaymentsByStatus(status: Payment['status']): Promise<Payment[]> {
    const [rows] = await pool.execute(`SELECT * FROM payments WHERE status = ?`, [status]);
    return (rows as any[]).map(rowToPayment);
  }

  // ---------- outbox ----------

  async insertOutboxEntry(entry: OutboxEntry): Promise<void> {
    await pool.execute(
      `INSERT INTO outbox (id, payment_id, payload, created_at) VALUES (?,?,?,?)`,
      [entry.id, entry.paymentId, JSON.stringify(entry.payload), entry.createdAt],
    );
  }

  async getPendingOutboxEntries(): Promise<OutboxEntry[]> {
    const [rows] = await pool.execute(`SELECT * FROM outbox WHERE enqueued_at IS NULL`);
    return (rows as any[]).map(r => ({
      id: r.id,
      paymentId: r.payment_id,
      payload: r.payload,
      enqueuedAt: r.enqueued_at ?? undefined,
      createdAt: r.created_at,
    }));
  }

  async markOutboxEnqueued(id: string): Promise<void> {
    await pool.execute(`UPDATE outbox SET enqueued_at = NOW(3) WHERE id = ?`, [id]);
  }

  // ---------- webhook dedup ----------

  async markWebhookProcessed(stripeEventId: string, eventType = 'unknown'): Promise<boolean> {
    try {
      await pool.execute(
        `INSERT INTO stripe_webhook_events (stripe_event_id, event_type) VALUES (?, ?)`,
        [stripeEventId, eventType],
      );
      return true;
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  }
}

export const db = new MySqlDb();
