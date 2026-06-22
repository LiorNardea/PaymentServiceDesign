# Scenario Examples

---

## Scenario 1 — Happy Path: `llc-service` Charges a Customer

**Business context**: `llc-service` charges $299.00 for an LLC formation. Order ID `ord-5501`, customer `cust_waltz_789`.

### Flow

```
llc-service          Payment API           DB                  Outbox Relay
    │                      │                │                       │
    │  POST /payments       │                │                       │
    │──────────────────────▶│                │                       │
    │                       │  BEGIN TXN     │                       │
    │                       │  INSERT payments (status=pending)      │
    │                       │  INSERT outbox  (enqueued_at=NULL)     │
    │                       │  COMMIT        │                       │
    │  202 Received         │                │                       │
    │  { paymentId:         │                │                       │
    │    "pay_01HABC" }     │                │                       │
    │◀──────────────────────│                │                       │
    │                       │                │  SELECT WHERE         │
    │                       │                │  enqueued_at IS NULL  │
    │                       │                │◀──────────────────────│
    │                       │                │  → pay_01HABC         │
    │                       │                │──────────────────────▶│
```

```
Outbox Relay         SQS                  Worker                Stripe
    │                 │                     │                      │
    │  sendMessage    │                     │                      │
    │────────────────▶│                     │                      │
    │  UPDATE outbox  │                     │                      │
    │  SET enqueued_  │                     │                      │
    │  at=now()       │                     │                      │
    │                 │  receiveMessage     │                      │
    │                 │◀────────────────────│                      │
    │                 │  → pay_01HABC       │                      │
    │                 │────────────────────▶│                      │
    │                 │    UPDATE payments  │                      │
    │                 │    SET status=processing                   │
    │                 │    SET stripe_pi_id=pi_3Nxxx              │
    │                 │    WHERE status=pending                    │
    │                 │    stripe.paymentIntents.create()          │
    │                 │                     │─────────────────────▶│
    │                 │                     │  → succeeded         │
    │                 │                     │◀─────────────────────│
    │                 │  deleteMessage      │                      │
    │                 │◀────────────────────│                      │
```

```
Stripe               Webhook Handler       DB                   SNS              llc-service
    │                      │                │                    │                    │
    │  POST /webhooks/stripe│                │                    │                    │
    │  payment_intent.      │                │                    │                    │
    │  succeeded (evt_3Nxxx)│                │                    │                    │
    │──────────────────────▶│                │                    │                    │
    │                       │  INSERT stripe_webhook_events       │                    │
    │                       │  ON CONFLICT DO NOTHING             │                    │
    │                       │  → 1 row inserted (not duplicate)   │                    │
    │                       │  SELECT WHERE stripe_pi_id=pi_3Nxxx│                    │
    │                       │  UPDATE status=succeeded            │                    │
    │                       │  INSERT payment_events              │                    │
    │                       │────────────────────────────────────▶│                    │
    │                       │  publish PaymentStateChanged        │                    │
    │                       │  { newStatus: "succeeded" }         │                    │
    │                       │────────────────────────────────────▶│                    │
    │  200 OK               │                │                    │  SNS fan-out       │
    │◀──────────────────────│                │                    │───────────────────▶│
```

### DB State

| Step | `status` | `stripe_pi_id` | `outbox.enqueued_at` |
|---|---|---|---|
| After API returns 202 | `pending` | NULL | NULL |
| After relay enqueues | `pending` | NULL | 2024-06-18T10:00:00Z |
| After worker claims job | `processing` | `pi_3Nxxx` | unchanged |
| After webhook handler | `succeeded` | `pi_3Nxxx` | unchanged |

### Timing

| Segment | Latency |
|---|---|
| Request → 202 Received | ~20 ms |
| 202 → job in SQS | ~200 ms |
| Job dequeued → Stripe call | ~5 ms |
| Stripe call → response | ~300–800 ms |
| Stripe → webhook delivered | ~1–5 s |
| **Total: request → consumer notified** | **~1–6 s** |

---

## Scenario 2 — Payment Declined: Insufficient Funds

**Business context**: `mortgage-service` charges a monthly loan payment of $1,200. The customer's card is declined by Stripe.

### What is different from the happy path

Steps 1–5 are identical — request accepted, outbox relay enqueues, worker claims job, Stripe call is made. The difference starts at step 6 when Stripe returns a failure.

### Flow (diverges at Stripe)

```
Worker                         DB                    Stripe
    │                           │                       │
    │  stripe.paymentIntents    │                       │
    │  .create()                │                       │
    │──────────────────────────────────────────────────▶│
    │                           │   → payment_failed    │
    │                           │     code:             │
    │                           │     insufficient_funds│
    │◀──────────────────────────────────────────────────│
    │  deleteMessage() from SQS │                       │
    │  (job is done — no retry) │                       │
```

```
Stripe               Webhook Handler       DB                   SNS           mortgage-service
    │                      │                │                    │                   │
    │  POST /webhooks/stripe│                │                    │                   │
    │  payment_intent.      │                │                    │                   │
    │  payment_failed       │                │                    │                   │
    │  (evt_fail_001)       │                │                    │                   │
    │──────────────────────▶│                │                    │                   │
    │                       │  INSERT stripe_webhook_events       │                   │
    │                       │  ON CONFLICT DO NOTHING             │                   │
    │                       │  SELECT WHERE stripe_pi_id=pi_xxx   │                   │
    │                       │  UPDATE status=failed               │                   │
    │                       │  SET failure_reason=                │                   │
    │                       │  "insufficient_funds"               │                   │
    │                       │  INSERT payment_events              │                   │
    │                       │  publish PaymentStateChanged        │                   │
    │                       │  { newStatus: "failed",             │                   │
    │                       │    failureReason:                   │                   │
    │                       │    "insufficient_funds" }           │                   │
    │                       │────────────────────────────────────▶│                   │
    │  200 OK               │                │                    │  SNS fan-out      │
    │◀──────────────────────│                │                    │──────────────────▶│
    │                       │                │                    │  mortgage-service │
    │                       │                │                    │  flags loan as    │
    │                       │                │                    │  past-due,        │
    │                       │                │                    │  triggers         │
    │                       │                │                    │  collections flow │
```

### DB State

| Step | `status` | `failure_reason` |
|---|---|---|
| After API returns 202 | `pending` | NULL |
| After worker claims job | `processing` | NULL |
| After webhook handler | `failed` | `insufficient_funds` |

### Key points

- The worker **does not retry** a card decline — it is a permanent failure, not a transient error. The job is deleted from SQS immediately.
- The worker **does not** update the status to `failed` — that comes from the Stripe webhook, same as the happy path.
- `mortgage-service` receives `newStatus: failed` with `failureReason` and decides what to do next — retry later, notify the customer, trigger collections. The Payment Service does not make that decision.

---

## Scenario 3 — Consumer Retry (Idempotency)

**Business context**: `llc-service` sends a charge request. The network times out before the 202 response arrives. `llc-service` retries the same request with the same idempotency key.

### Flow

```
llc-service          Payment API           DB
    │                      │                │
    │  POST /payments       │                │
    │  idempotencyKey:      │                │
    │  "llc-service:        │                │
    │   charge:ord-5501"    │                │
    │──────────────────────▶│                │
    │                       │  INSERT payments
    │                       │  (consumer_id, idempotency_key)
    │                       │────────────────▶│
    │  [network timeout]    │                │
    │  ✗ no response        │                │  ← payment row EXISTS in DB
    │                       │                │  ← outbox row written
    │                       │                │  ← relay will enqueue it
    │
    │  [llc-service retries — same idempotency key]
    │
    │  POST /payments       │                │
    │  idempotencyKey:      │                │
    │  "llc-service:        │                │
    │   charge:ord-5501"    │                │
    │──────────────────────▶│                │
    │                       │  INSERT payments
    │                       │  → UNIQUE CONSTRAINT VIOLATION
    │                       │  (consumer_id, idempotency_key)
    │                       │────────────────▶│
    │                       │  catch conflict │
    │                       │  SELECT existing row
    │                       │────────────────▶│
    │                       │  → pay_01HABC, status=pending
    │  200 OK               │                │
    │  { paymentId:         │                │
    │    "pay_01HABC",      │                │
    │    status: "pending" }│                │
    │◀──────────────────────│                │
```

### Key points

- The retry returns **`200 OK`** (not `202`) with the existing payment record.
- **No second payment row** is created. No second job is enqueued. No second Stripe call is ever made.
- `status: pending` is correct — the worker hasn't processed it yet. `llc-service` should wait for the `PaymentStateChanged` SNS event or poll `GET /payments/:id`.
- This works correctly whether the retry arrives before or after the worker processes the original job — the DB constraint fires regardless.

---

## Scenario 4 — Worker Crashes Mid-Flight

There are two distinct crash windows with different outcomes.

### 4a — Crash after calling Stripe, before `deleteMessage()`

**Business context**: Worker #1 calls Stripe and gets `succeeded` back, then crashes before deleting the SQS message.

```
Worker #1             Stripe               SQS
    │                    │                   │
    │  UPDATE status=processing, stripe_pi_id=pi_3Nxxx
    │  stripe.create()   │                   │
    │───────────────────▶│                   │
    │  → succeeded       │                   │
    │◀───────────────────│                   │
    │  [CRASH — deleteMessage() never called]│
    │                    │  [30s visibility  │
    │                    │   timeout expires]│
    │                    │                   │  message visible again

Worker #2             DB                  Stripe
    │                   │                    │
    │  receiveMessage() │                    │
    │  UPDATE WHERE status=pending → 0 rows  │
    │  (already processing)                  │
    │  SELECT stripe_pi_id → pi_3Nxxx (SET) │
    │  → Stripe was called, skip Stripe call │
    │  deleteMessage()  │                    │
    │                   │                    │
    │  [Stripe webhook arrives normally]     │
    │  Webhook Handler: processing→succeeded │
```

**Outcome**: customer charged once. Webhook drives the final status update.

---

### 4b — Crash after setting `status=processing`, before calling Stripe

**Business context**: Worker #1 updates the DB to `processing` (`stripe_pi_id` stays NULL), then crashes immediately before the Stripe call.

```
Worker #1             DB
    │                   │
    │  UPDATE status=processing
    │  stripe_pi_id still NULL
    │  [CRASH — Stripe never called]
    │                   │
    │                   │  message visible again after 30s

Worker #2             DB                  Stripe
    │                   │                    │
    │  receiveMessage() │                    │
    │  UPDATE WHERE status=pending → 0 rows  │
    │  (already processing)                  │
    │  SELECT stripe_pi_id → NULL            │
    │  → Stripe was NOT called, proceed      │
    │  stripe.create() [same idempotency key]│
    │──────────────────────────────────────▶│
    │  → new PaymentIntent created           │
    │  UPDATE stripe_pi_id=pi_3Nyyy          │
    │  deleteMessage()  │                    │
    │                   │                    │
    │  [Stripe webhook arrives]              │
    │  Webhook Handler: processing→succeeded │
```

**Outcome**: customer charged once. `stripe_pi_id` was NULL so the worker knew it was safe to call Stripe.

### Key points

- The **`stripe_pi_id` sentinel** is what distinguishes the two crash windows:
  - `stripe_pi_id IS NULL` → Stripe was never called → retry the call
  - `stripe_pi_id IS SET` → Stripe was called → skip, wait for webhook
- Without this check, a crash in window 4b would leave the payment stuck in `processing` with `stripe_pi_id=NULL` permanently — the Reconciliation Lambda cannot recover it because there is no PI to query.
- Even if two workers race on the NULL check and both call Stripe, the **Stripe idempotency key** (`{consumer_id}:{idempotency_key}`) deduplicates at Stripe's level — one charge, regardless of concurrent calls.

---

## Scenario 5 — Duplicate Webhook Delivery

**Business context**: Stripe delivers `payment_intent.succeeded` (evt_3Nxxx) twice — its normal at-least-once guarantee.

### Flow

```
Stripe               Webhook Handler       DB
    │                      │                │
    │  [First delivery]     │                │
    │  POST /webhooks/stripe│                │
    │  evt_3Nxxx            │                │
    │──────────────────────▶│                │
    │                       │  INSERT stripe_webhook_events
    │                       │  (evt_3Nxxx)   │
    │                       │  ON CONFLICT DO NOTHING
    │                       │────────────────▶│
    │                       │  → 1 row inserted
    │                       │  UPDATE payments SET status=succeeded
    │                       │  publish PaymentStateChanged to SNS
    │  200 OK               │                │
    │◀──────────────────────│                │
    │                       │                │
    │  [Second delivery     │                │
    │   — Stripe retries]   │                │
    │  POST /webhooks/stripe│                │
    │  evt_3Nxxx            │                │
    │──────────────────────▶│                │
    │                       │  INSERT stripe_webhook_events
    │                       │  (evt_3Nxxx)   │
    │                       │  ON CONFLICT DO NOTHING
    │                       │────────────────▶│
    │                       │  → 0 rows inserted (conflict)
    │                       │  STOP — already processed
    │                       │  do NOT update DB
    │                       │  do NOT publish to SNS
    │  200 OK               │                │
    │◀──────────────────────│                │
```

### Key points

- The second delivery returns `200 OK` immediately — Stripe must receive 2xx or it keeps retrying.
- The DB is **not updated** a second time. The SNS event is **not published** a second time.
- `llc-service` receives exactly **one** `PaymentStateChanged` event.
- This is atomic and lock-free — `ON CONFLICT DO NOTHING` is a single engine operation, no application-level locking needed.

---

## Scenario 6 — Missed Webhook (Reconciliation Lambda)

**Business context**: Stripe processes the payment successfully but the webhook is never delivered — the Payment Service was down during Stripe's retry window, or a network partition dropped the delivery.

### Flow

```
Stripe               Payment Service       DB
    │                      │                │
    │  [Payment succeeded   │                │
    │   on Stripe side]     │                │
    │  POST /webhooks/stripe│                │
    │  [never delivered]  ✗ │                │
    │                       │                │  payment stuck in
    │                       │                │  status=processing
    │                       │                │  for > 10 minutes

EventBridge (cron)    Reconciliation Lambda  DB              Stripe
    │                        │                │                │
    │  trigger every 5 min   │                │                │
    │───────────────────────▶│                │                │
    │                        │  SELECT payments                │
    │                        │  WHERE status=processing        │
    │                        │  AND updated_at <               │
    │                        │  now() - 10min                  │
    │                        │────────────────▶│                │
    │                        │  → pay_01HABC   │                │
    │                        │                 │                │
    │                        │  stripe.paymentIntents          │
    │                        │  .retrieve(pi_3Nxxx)            │
    │                        │────────────────────────────────▶│
    │                        │  → status=succeeded             │
    │                        │◀────────────────────────────────│
    │                        │                 │                │
    │                        │  UPDATE payments SET status=succeeded
    │                        │  INSERT payment_events          │
    │                        │────────────────▶│                │
    │                        │  publish PaymentStateChanged     │
    │                        │  { newStatus: "succeeded" }      │
    │                        │  to SNS (fallback publisher)     │
```

### DB State

| Step | `status` | Time |
|---|---|---|
| Worker calls Stripe | `processing` | T+0 |
| Webhook never arrives | `processing` | T+10 min |
| Reconciliation Lambda runs | `processing` → `succeeded` | T+15 min (worst case) |

### Key points

- **Worst-case lag**: the payment can sit in `processing` for up to 10 min (threshold) + 5 min (Lambda interval) = **15 minutes** before reconciliation fixes it.
- The Reconciliation Lambda is the **fallback publisher** — it publishes to SNS exactly as the Webhook Handler would have. Subscribers receive the event and act normally.
- If Stripe returns `requires_action` (3DS pending), the Lambda leaves the payment in `processing` and tries again on the next cycle.
- After a configurable max-age **per payment method** (e.g. 1h for plain cards, 24h for 3DS, 6 days for ACH), the Lambda **cancels the PaymentIntent on Stripe first**, then marks the payment `failed` locally and publishes to SNS. Stripe does not guarantee a fixed settlement window — cancelling too early aborts a legitimate in-progress payment; too late risks holding funds indefinitely. The order (Stripe cancel → DB update → SNS) prevents a double-charge if the consumer retried after seeing `failed`.

---

## Scenario 7 — Refund

**Business context**: `llc-service` requests a full refund on a succeeded payment `pay_01HABC` after a customer cancels their LLC formation.

### Flow

```
llc-service          Payment API           DB
    │                      │                │
    │  POST /payments/      │                │
    │  pay_01HABC/refund    │                │
    │  idempotencyKey:      │                │
    │  "llc-service:        │                │
    │   refund:pay_01HABC"  │                │
    │──────────────────────▶│                │
    │                       │  SELECT payments WHERE id=pay_01HABC
    │                       │  → status=succeeded ✓ (refund allowed)
    │                       │  BEGIN TXN     │
    │                       │  INSERT payments (id=pay_01HDEF,
    │                       │    status=refund_pending,
    │                       │    parent_payment_id=pay_01HABC)
    │                       │  INSERT outbox  (enqueued_at=NULL)
    │                       │  COMMIT        │
    │  202 Received         │                │
    │  { paymentId:         │                │
    │    "pay_01HDEF",      │                │
    │    status:            │                │
    │    "refund_pending" } │                │
    │◀──────────────────────│                │
```

```
Outbox Relay    SQS            Worker                 Stripe
    │            │                │                      │
    │  enqueue   │                │                      │
    │───────────▶│                │                      │
    │            │  receiveMessage│                      │
    │            │◀───────────────│                      │
    │            │  → pay_01HDEF  │                      │
    │            │───────────────▶│                      │
    │            │  UPDATE status=processing             │
    │            │  WHERE status=refund_pending          │
    │            │  stripe.refunds.create(               │
    │            │    paymentIntentId: pi_3Nxxx,         │
    │            │    idempotencyKey:                    │
    │            │    "llc-service:refund:pay_01HABC")   │
    │            │                │─────────────────────▶│
    │            │                │  → refund succeeded  │
    │            │                │◀─────────────────────│
    │            │  deleteMessage │                      │
    │            │◀───────────────│                      │
```

```
Stripe              Webhook Handler      DB                  SNS           llc-service
    │                     │               │                   │                 │
    │  charge.refunded    │               │                   │                 │
    │  (evt_ref_001)      │               │                   │                 │
    │────────────────────▶│               │                   │                 │
    │                     │  Deduplicate  │                   │                 │
    │                     │  Resolve pay_01HDEF via stripe_pi_id               │
    │                     │  UPDATE status=refunded           │                 │
    │                     │  publish PaymentStateChanged      │                 │
    │                     │  { newStatus: "refunded" }        │                 │
    │                     │──────────────────────────────────▶│                 │
    │  200 OK             │               │                   │  SNS fan-out    │
    │◀────────────────────│               │                   │────────────────▶│
    │                     │               │                   │  llc-service    │
    │                     │               │                   │  issues customer│
    │                     │               │                   │  refund receipt │
```

### DB State

| Table | Row | Value |
|---|---|---|
| `payments` | `pay_01HABC` (original) | `status=succeeded` — unchanged |
| `payments` | `pay_01HDEF` (refund) | `status=refunded`, `parent_payment_id=pay_01HABC` |

### Key points

- A refund is a **new payment row** (`pay_01HDEF`) linked to the original via `parent_payment_id`. The original row is never mutated.
- The refund idempotency key `"llc-service:refund:pay_01HABC"` is derived from the original payment ID — stable, deterministic, retry-safe.
- The same `UNIQUE (consumer_id, idempotency_key)` constraint prevents a double refund row.
- The Stripe refund call also carries an idempotency key — a worker crash and retry will not refund the customer twice.

---

## Scenario 8 — End-of-Month Burst (500 Requests in 3 Seconds)

**Business context**: `mortgage-service` triggers monthly loan fee collection. 500 charge requests arrive within 3 seconds.

### Flow

```
mortgage-service (x500)    ALB              API Replicas (M)      DB
        │                   │                     │                 │
        │  500 POST /payments│                     │                 │
        │  in 3 seconds     │                     │                 │
        │──────────────────▶│  fan-out across M   │                 │
        │                   │  replicas           │                 │
        │                   │────────────────────▶│                 │
        │                   │                     │  500 × (INSERT payments
        │                   │                     │         INSERT outbox)
        │                   │                     │  ~10ms each    │
        │                   │                     │────────────────▶│
        │  500 × 202 Received│                    │                 │
        │◀──────────────────────────────────────── │                │
        │  (all returned    │                     │                 │
        │   within ~3s)     │                     │                 │

Outbox Relay               SQS                    Workers (K)
        │                   │                          │
        │  SELECT WHERE enqueued_at IS NULL LIMIT 100  │
        │  → 100 rows per poll cycle (~200ms)          │
        │  sendMessage x100                            │
        │──────────────────▶│                          │
        │  [repeats 5 times to drain all 500]          │
        │                   │                          │
        │                   │  K workers compete       │
        │                   │  each maintaining N      │
        │                   │  in-flight Stripe calls  │
        │                   │◀─────────────────────────│
        │                   │                          │
        │                   │  [Stripe rate limit hit] │
        │                   │  → 429 Too Many Requests │
        │                   │  workers back off with   │
        │                   │  exponential jitter      │
        │                   │  → retry after delay     │
        │                   │  → queue drains at       │
        │                   │    Stripe's allowed pace │
```

### Key numbers

| Metric | Value |
|---|---|
| Requests accepted (202 returned) | 500 in ~3 seconds |
| Time to enqueue all 500 to SQS | ~1 second (relay batches 100/poll) |
| Stripe throughput per worker | N calls in-flight |
| Total throughput | K workers × N per worker |
| Queue depth during burst | peaks at 500, drains at Stripe's rate |
| Requests lost | **0** — queue is durable |
| Duplicate charges | **0** — idempotency key + Stripe idempotency |

### Key points

- The API tier handles the burst immediately — DB writes are fast (~10ms each), no Stripe calls in the API path. All 500 callers are unblocked within seconds.
- The queue **absorbs the burst** — jobs accumulate in SQS and drain at whatever pace the workers can sustain without overwhelming Stripe.
- If Stripe rate-limits workers (HTTP 429), workers back off with exponential jitter and retry. The job stays in SQS — nothing is lost.
- After `maxReceiveCount=5` failures, a job moves to the **Dead-Letter Queue** for manual inspection. This would indicate a structural problem (bad payload, customer account issue) not a transient one.
- M (API replicas) and K (workers) can be scaled **independently** — if the API tier is the bottleneck, add API replicas; if the queue is backing up, add workers.
