# Failure Mode Analysis

## 1. Consumer Retries the Same Charge Request

**Scenario**: `llc-service` calls `POST /payments` with an idempotency key derived from its order ID (e.g. `llc-service:charge:ord-123`), gets a 5xx (network hiccup), and retries with the **same key**.

> For the full idempotency key contract — who generates it, how to derive it, and both enforcement layers — see [data-model.md § Idempotency Key](data-model.md#idempotency-key----ownership-derivation-and-enforcement).

**How it's handled**:
- DB `UNIQUE (consumer_id, idempotency_key)` constraint catches the duplicate insert.
- The handler returns `200 OK` with the existing payment record and its current `status`.
- No second payment row is created; no second charge is ever initiated.

**Risk**: the first request created the payment row but the Stripe call hasn't happened yet. Consumer receives `status: pending` — this is correct and expected; the worker will process it shortly.

---

## 2. Worker Crashes Mid-Flight

There are two distinct crash windows, and they are handled differently.

### 2a. Crash after calling Stripe, before updating DB

**Scenario**: worker sets `status=processing`, calls Stripe, gets `succeeded` back, then crashes before writing the final status to the DB.

**How it's handled**:
1. SQS visibility timeout expires (30s). The message is re-delivered.
2. Second worker does `UPDATE WHERE status='pending'` → 0 rows (already `processing`).
3. Worker checks `stripe_pi_id` — it is set (the first worker wrote it before crashing).
4. Worker concludes Stripe was already called and skips the Stripe call.
5. Webhook arrives from Stripe and drives the transition to `succeeded`. Customer charged once.

### 2b. Crash after setting `status=processing`, before calling Stripe

**Scenario**: worker updates `status=processing` (and `stripe_pi_id` is still NULL), then crashes immediately — Stripe was never called.

**Why this is the harder case**: the SQS message is re-delivered, but the second worker does `UPDATE WHERE status='pending'` → 0 rows. Without the `stripe_pi_id` check it would skip the job entirely, leaving the payment stuck in `processing` with `stripe_pi_id=NULL` forever — the Reconciliation Lambda cannot recover it because there is no PI to retrieve.

**How it's handled**:
The worker uses `stripe_pi_id` as a sentinel to distinguish the two cases:

```
UPDATE payments SET status='processing' WHERE id=$id AND status='pending'
→ 0 rows affected (already processing)

SELECT stripe_pi_id FROM payments WHERE id=$id
→ NULL   → Stripe was never called → proceed with the Stripe call
→ SET    → Stripe was called → skip, webhook will arrive
```

If `stripe_pi_id IS NULL`, the worker calls Stripe as if it were the first attempt. Stripe returns a new PaymentIntent (no prior call was made), and processing continues normally.

**What prevents a double charge if two workers race on the NULL check?**
Both workers would call Stripe, but both use the same Stripe idempotency key (`{consumer_id}:{idempotency_key}`). Stripe deduplicates and returns the same PaymentIntent — one charge, regardless of how many concurrent Stripe calls are made.

---

## 3. Stripe Returns 200 but Webhook Never Arrives (Missed Webhook)

**Scenario**: Stripe confirms a `payment_intent.succeeded` event but the webhook POST fails or is dropped (network partition, service restart).

**How it's handled**:
- The Reconciliation Lambda runs every 5 minutes, triggered by an AWS EventBridge scheduled rule. It is a short-lived stateless function — not an always-running service.
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

> **Bonus code status**: in-flight jobs now live in real SQS, not process memory, so a crash here behaves as described above — the message is redelivered to whichever process restarts the worker, no data loss. The remaining gap is the same narrow one as scenario 2: a crash between the DB insert and the inline enqueue call itself, before any SQS message exists at all.

---

## 7. Payment Stuck in `processing` (Stripe Never Responds)

**Scenario**: Stripe accepted the PaymentIntent but the card requires 3D Secure, and the customer never completes it. Or Stripe is having an incident.

**How it's handled**:
- The **Reconciliation Lambda** (EventBridge cron, every 5 min) detects payments in `processing` for > 10 minutes.
- It fetches the Stripe PaymentIntent status via `stripe.paymentIntents.retrieve(stripe_pi_id)`.
  - If `succeeded`: update to `succeeded`, publish `PaymentStateChanged` to SNS.
  - If `requires_action` (3DS pending): leave in `processing`, extend timeout, optionally notify consumer.
  - If `canceled` or `payment_failed`: update to `failed`, publish `PaymentStateChanged` to SNS.
  - If Stripe API itself is down: log and skip; the Lambda will retry on its next scheduled invocation.
- After a configurable max-age **appropriate for the payment method**, the Lambda **cancels the PaymentIntent on Stripe first**, then marks the payment `failed` locally and publishes `PaymentStateChanged { newStatus: failed }` to SNS.

**Why cancel on Stripe before marking failed**: if we mark `failed` locally first and Stripe later completes the charge, the customer is charged but our DB says `failed`. The consumer would never receive a `succeeded` event and might retry — causing a double charge. Cancelling on Stripe first ensures the PaymentIntent can never settle after we declare it failed.

**Why the timeout is payment-method-dependent**: Stripe does not guarantee a fixed settlement window — it varies by payment method:

| Payment method | Typical settlement | Suggested timeout |
|---|---|---|
| Card (no 3DS) | Seconds–minutes | 1 hour |
| Card with 3DS | Up to customer action | 24 hours |
| ACH / bank transfer | 1–5 business days | 6 days |
| SEPA Direct Debit | 2–3 business days | 4 days |

Cancelling too early risks aborting a legitimate in-progress payment (e.g. a customer who hasn't completed 3DS yet). The timeout should be stored per payment row and driven by the payment method, not hardcoded globally.

---

## 8. Double-Charge from Two Concurrent Workers

**Scenario**: network partition causes a queue message to be delivered to two workers simultaneously (should not happen with SQS visibility timeout, but edge case).

**How it's handled**:
- Workers do an optimistic status check before calling Stripe: `UPDATE payments SET status='processing', stripe_pi_id=$pi WHERE id=$id AND status='pending'`.
- Only one update succeeds (`status='pending'` guard). The other worker sees 0 rows affected and aborts.
- Even if both somehow reach Stripe: the same Stripe idempotency key (derived as `{consumer_id}:{idempotency_key}`) prevents a second charge.

Two independent safety layers: DB optimistic locking + Stripe idempotency. See [data-model.md § Idempotency Key](data-model.md#idempotency-key----ownership-derivation-and-enforcement) for the full derivation contract.
