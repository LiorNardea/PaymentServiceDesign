import express, { Request, Response, NextFunction } from 'express';
import { ulid } from 'ulid';
import { createPayment, getPayment, createRefund } from './payment-service';
import { handleStripeWebhook } from './webhook-handler';
import { startWorker } from './worker';
import { stripe } from './stripe-mock';
import { db } from './db';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// POST /payments — initiate a charge
// ---------------------------------------------------------------------------
app.post('/payments', async (req: Request, res: Response) => {
  const { consumerId, idempotencyKey, customerId, amount, currency, description, metadata } = req.body;

  if (!consumerId || !idempotencyKey || !customerId || !amount || !currency) {
    res.status(400).json({ error: 'consumerId, idempotencyKey, customerId, amount, currency are required' });
    return;
  }

  const payment = await createPayment({ consumerId, idempotencyKey, customerId, amount, currency, description, metadata });
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
// POST /payments/:id/refund — initiate a refund
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
// POST /webhooks/stripe — Stripe async event delivery
// ---------------------------------------------------------------------------
app.post('/webhooks/stripe', handleStripeWebhook);

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

// Wire the mock Stripe webhook callback to simulate Stripe calling our endpoint.
// Each event gets a globally-unique id (ulid) — using Date.now() here previously caused
// id collisions under concurrent load (multiple events landing in the same millisecond),
// which made the dedup check in markWebhookProcessed() silently drop real events.
stripe.registerWebhookCallback((event) => {
  void (async () => {
    const stripeEvent = {
      id: `evt_mock_${ulid()}`,
      type: event.type,
      data: event.data,
    };

    const isNew = await db.markWebhookProcessed(stripeEvent.id, stripeEvent.type);
    if (!isNew) return;

    const obj = stripeEvent.data.object as Record<string, unknown>;

    if (stripeEvent.type === 'payment_intent.succeeded') {
      const meta = obj['metadata'] as Record<string, string> | undefined;
      const paymentId = meta?.['paymentId'];
      if (paymentId) {
        await db.updatePaymentStatus(paymentId, 'processing', { status: 'succeeded' });
        console.log(`[stripe-mock webhook] ${paymentId} → succeeded`);
      }
    } else if (stripeEvent.type === 'charge.refunded') {
      const piId = obj['payment_intent'] as string | undefined;
      if (piId) {
        const allPending = await db.getPaymentsByStatus('refund_pending');
        const p = allPending.find((pay) => pay.stripePiId === piId);
        if (p) {
          await db.forceUpdatePayment(p.id, { status: 'refunded' });
          console.log(`[stripe-mock webhook] ${p.id} → refunded`);
        }
      }
    }
  })();
});

startWorker();

app.listen(PORT, () => {
  console.log(`[server] Payment Service running on :${PORT}`);
  console.log(`[server] Try: curl -X POST http://localhost:${PORT}/payments -H 'Content-Type: application/json' -d '{"consumerId":"llc-service","idempotencyKey":"test-1","customerId":"cust_123","amount":5000,"currency":"usd"}'`);
});
