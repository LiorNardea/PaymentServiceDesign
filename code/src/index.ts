import express, { Request, Response, NextFunction } from 'express';
import { createPayment, getPayment, createRefund } from './payment-service';
import { handleStripeWebhook, processStripeEvent, StripeWebhookEvent } from './webhook-handler';
import { startWorker } from './worker';
import { startOutboxRelay } from './outbox-relay';
import { startReconciliation, runReconciliation } from './reconciliation';
import { stripe } from './stripe-mock';
import { db } from './db';
import { ulid } from 'ulid';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// POST /payments — initiate a charge
// Returns 202 Received for new payments; 200 for idempotent replays.
// ---------------------------------------------------------------------------
app.post('/payments', async (req: Request, res: Response) => {
  const { consumerId, idempotencyKey, customerId, amount, currency, description, metadata } = req.body;

  if (!consumerId || !idempotencyKey || !customerId || !amount || !currency) {
    res.status(400).json({ error: 'consumerId, idempotencyKey, customerId, amount, currency are required' });
    return;
  }

  const payment = await createPayment({ consumerId, idempotencyKey, customerId, amount, currency, description, metadata });
  // 202 for new payments, 200 for idempotent replay (existing row returned)
  const statusCode = payment.status === 'pending' ? 202 : 200;
  res.status(statusCode).json(payment);
});

// ---------------------------------------------------------------------------
// GET /payments/:id — poll payment status
// ---------------------------------------------------------------------------
app.get('/payments/:id', async (req: Request, res: Response) => {
  const payment = await getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(payment);
});

// ---------------------------------------------------------------------------
// POST /payments/:id/refund — initiate a refund (only for succeeded payments)
// ---------------------------------------------------------------------------
app.post('/payments/:id/refund', async (req: Request, res: Response) => {
  const { idempotencyKey, amount, reason } = req.body;
  if (!idempotencyKey) {
    res.status(400).json({ error: 'idempotencyKey is required' });
    return;
  }
  try {
    const payment = await createRefund(req.params.id, { idempotencyKey, amount, reason });
    res.status(202).json(payment);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 422;
    res.status(status).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /payments — admin / reconciliation query
// Query params: status, consumerId, limit (default 50), cursor (updated_at ISO string)
// ---------------------------------------------------------------------------
app.get('/payments', async (req: Request, res: Response) => {
  const { status, consumerId, limit = '50', cursor } = req.query;

  if (status && !['pending', 'processing', 'succeeded', 'failed', 'refund_pending', 'refunded', 'refund_failed'].includes(status as string)) {
    res.status(400).json({ error: 'invalid status' });
    return;
  }

  const payments = await db.queryPayments({
    status: status as string | undefined,
    consumerId: consumerId as string | undefined,
    limit: Math.min(parseInt(limit as string, 10) || 50, 200),
    cursor: cursor as string | undefined,
  });

  res.json({ payments, count: payments.length });
});

// ---------------------------------------------------------------------------
// POST /webhooks/stripe — Stripe async event delivery
// Not callable by internal services — Stripe only.
// ---------------------------------------------------------------------------
app.post('/webhooks/stripe', handleStripeWebhook);

// ---------------------------------------------------------------------------
// POST /reconcile — manually trigger reconciliation (useful for demo/testing)
// ---------------------------------------------------------------------------
app.post('/reconcile', async (_req: Request, res: Response) => {
  await runReconciliation();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal server error' });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ?? 3000;

// Wire the mock Stripe callback to the real processStripeEvent function.
// This ensures the mock and the real HTTP webhook path share identical logic —
// no duplicate status-update code here.
stripe.registerWebhookCallback((event) => {
  void (async () => {
    const stripeEvent: StripeWebhookEvent = {
      id: `evt_mock_${ulid()}`,
      type: event.type,
      data: { object: event.data.object as Record<string, unknown> },
    };
    await processStripeEvent(stripeEvent);
  })();
});

startWorker();
startOutboxRelay();
startReconciliation();

app.listen(PORT, () => {
  console.log(`[server] Payment Service running on :${PORT}`);
  console.log(`[server] POST /payments  → initiate charge`);
  console.log(`[server] GET  /payments/:id → poll status`);
  console.log(`[server] POST /payments/:id/refund → refund`);
  console.log(`[server] GET  /payments → admin query (?status=processing&consumerId=llc-service)`);
  console.log(`[server] POST /reconcile → trigger reconciliation manually`);
});
