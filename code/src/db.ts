/**
 * In-memory store standing in for Postgres.
 * Real implementation would use pg / Prisma / Drizzle with proper transactions.
 */
import { Payment, OutboxEntry } from './types';

class InMemoryDb {
  private payments = new Map<string, Payment>();
  // idempotency index: `${consumerId}:${idempotencyKey}` -> paymentId
  private idempotencyIndex = new Map<string, string>();
  private outbox = new Map<string, OutboxEntry>();
  private processedWebhookEvents = new Set<string>();

  // ---------- payments ----------

  insertPayment(payment: Payment): Payment {
    const idemKey = `${payment.consumerId}:${payment.idempotencyKey}`;
    if (this.idempotencyIndex.has(idemKey)) {
      // Simulate the unique-constraint conflict: return existing
      const existingId = this.idempotencyIndex.get(idemKey)!;
      return this.payments.get(existingId)!;
    }
    this.payments.set(payment.id, payment);
    this.idempotencyIndex.set(idemKey, payment.id);
    return payment;
  }

  getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  /**
   * Conditional update — only proceeds if current status matches expectedStatus.
   * Simulates `UPDATE payments SET ... WHERE id=$id AND status=$expected`.
   */
  updatePaymentStatus(
    id: string,
    expectedStatus: Payment['status'],
    patch: Partial<Payment>,
  ): boolean {
    const p = this.payments.get(id);
    if (!p || p.status !== expectedStatus) return false;
    const updated = { ...p, ...patch, updatedAt: new Date() };
    this.payments.set(id, updated);
    return true;
  }

  forceUpdatePayment(id: string, patch: Partial<Payment>): void {
    const p = this.payments.get(id);
    if (!p) return;
    this.payments.set(id, { ...p, ...patch, updatedAt: new Date() });
  }

  getPaymentsByStatus(status: Payment['status']): Payment[] {
    return [...this.payments.values()].filter(p => p.status === status);
  }

  // ---------- outbox ----------

  insertOutboxEntry(entry: OutboxEntry): void {
    this.outbox.set(entry.id, entry);
  }

  getPendingOutboxEntries(): OutboxEntry[] {
    return [...this.outbox.values()].filter(e => !e.enqueuedAt);
  }

  markOutboxEnqueued(id: string): void {
    const e = this.outbox.get(id);
    if (e) this.outbox.set(id, { ...e, enqueuedAt: new Date() });
  }

  // ---------- webhook dedup ----------

  markWebhookProcessed(stripeEventId: string): boolean {
    if (this.processedWebhookEvents.has(stripeEventId)) return false;
    this.processedWebhookEvents.add(stripeEventId);
    return true;
  }
}

export const db = new InMemoryDb();
