# Failure Mode Analysis

## 1. Consumer Retries the Same Charge Request

**Scenario**: `llc-service` calls `POST /payments` with `idempotencyKey: "llc-order-123"`, gets a 5xx (network hiccup), and retries.

**How it's handled**:
- DB has a `UNIQUE (consumer_id, idempotency_key)` constraint.
- The insert attempt on retry hits a conflict.
- The handler catches the conflict, reads the existing row, and returns `200 OK` with the current payment status.
- No second charge is ever initiated.

**Risk**: the first request created the payment row but the Stripe call hasn't happened yet. Consumer receives `status: pending` — this is correct and expected.

---

## 2. Worker Crashes After Calling Stripe, Before Updating DB

**Scenario**: worker calls `stripe.paymentIntents.confirm()`, Stripe returns `succeeded`, worker crashes before writing `succeeded` to the payments table.

**How it's handled**:
1. Queue visibility timeout expires (e.g., 30s). The job is re-delivered.
2. Worker attempts to call Stripe again with the **same Stripe idempotency key** (`{consumerId}:{idempotencyKey}`).
3. Stripe returns the same PaymentIntent in `succeeded` state — **no second charge**.
4. Worker writes `succeeded` to the DB. Customer is charged exactly once.

**Alternative scenario**: if the worker crashes *before* calling Stripe, the re-delivery results in a fresh Stripe call with the same idempotency key — same outcome.

---

## 3. Stripe Returns 200 but Webhook Never Arrives (Missed Webhook)

**Scenario**: Stripe confirms a `payment_intent.succeeded` event but the webhook POST fails or is dropped (network partition, service restart).

**How it's handled**:
- The reconciliation job runs every 5 minutes.
- It queries for all payments in `processing` status older than 10 minutes.
- For each, it calls `stripe.paymentIntents.retrieve(stripe_pi_id)` and updates internal status to match.
- Any consumers who missed the event will receive it via the reconciliation-triggered state change.

**Tradeoff**: 10-minute lag in worst case. Acceptable for this domain; can be reduced to 1–2 minutes if needed. The alternative (shorter poll) increases Stripe API usage.

---

## 4. Duplicate Webhook Delivery

**Scenario**: Stripe sends `payment_intent.succeeded` twice (their at-least-once guarantee).

**How it's handled**:
```sql
INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
VALUES ($1, $2)
ON CONFLICT (stripe_event_id) DO NOTHING;
-- if rows_affected == 0: already processed, return 200 immediately
```
The second webhook returns `200 OK` without re-processing. The status update is skipped.

---

## 5. Burst of 500 Simultaneous Charge Requests

**Scenario**: end-of-month loan fee collection — 500 charges arrive in seconds.

**How it's handled**:
- HTTP handlers insert payment rows and outbox entries synchronously (DB writes are fast).
- The outbox relay enqueues all 500 jobs to SQS.
- Workers (auto-scaled or pre-provisioned pool) process at Stripe's rate limit pace.
- If Stripe rate-limits us (429), workers back off with exponential jitter and retry.
- No requests are dropped — the queue buffers all load.

**Stripe rate limits**: Stripe allows ~100 req/s in test mode, higher in production with advance notice. The queue lets us absorb bursts and smooth them out.

---

## 6. Payment Service Itself Goes Down

**Scenario**: a deploy or crash takes the Payment Service offline for 60 seconds.

**How it's handled**:
- In-flight queue jobs: visibility timeout expires → re-queued → processed after restart. No data loss.
- New charge requests from consumers: fail with 503. Consumers should retry with the same idempotency key.
- Webhooks from Stripe: Stripe retries webhook delivery for up to 3 days with exponential backoff. No events lost.

---

## 7. Payment Stuck in `processing` (Stripe Never Responds)

**Scenario**: Stripe accepted the PaymentIntent but the card requires 3D Secure, and the customer never completes it. Or Stripe is having an incident.

**How it's handled**:
- Reconciliation job detects payments in `processing` for > 10 minutes.
- It fetches the Stripe PaymentIntent status.
  - If `requires_action` (3DS pending): leave in `processing`, extend timeout, optionally notify consumer.
  - If `canceled` or `payment_failed`: update to `failed`.
  - If Stripe API itself is down: log and skip; try again next reconciliation cycle.
- After a configurable max-age (e.g., 24h), auto-cancel the PaymentIntent on Stripe and mark `failed`.

---

## 8. Double-Charge from Two Concurrent Workers

**Scenario**: network partition causes a queue message to be delivered to two workers simultaneously (should not happen with SQS visibility timeout, but edge case).

**How it's handled**:
- Workers do an optimistic status check before calling Stripe: `UPDATE payments SET status='processing', stripe_pi_id=$pi WHERE id=$id AND status='pending'`.
- Only one update succeeds (`status='pending'` guard). The other worker sees 0 rows affected and aborts.
- Even if both somehow reach Stripe: the same Stripe idempotency key prevents a second charge.

Two independent safety layers: DB optimistic locking + Stripe idempotency.
