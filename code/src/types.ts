export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refund_pending'
  | 'refunded'
  | 'refund_failed';

export interface Payment {
  id: string;
  consumerId: string;
  idempotencyKey: string;
  customerId: string;
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
  status: PaymentStatus;
  stripePiId?: string;
  failureReason?: string;
  parentPaymentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentRequest {
  consumerId: string;
  idempotencyKey: string;
  customerId: string;
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CreateRefundRequest {
  idempotencyKey: string;
  amount?: number;
  reason?: string;
}

export interface OutboxEntry {
  id: string;
  paymentId: string;
  payload: Record<string, unknown>;
  enqueuedAt?: Date;
  createdAt: Date;
}

export interface QueueJob {
  jobId: string;
  paymentId: string;
  type: 'charge' | 'refund';
  enqueuedAt: Date;
  attempts: number;
}
