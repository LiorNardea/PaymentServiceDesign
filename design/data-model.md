# Data Model

All tables live in Postgres. The `payments` table is the **single source of truth** for payment state. Stripe is an external system we sync against, not the source of truth.

> **Note on the bonus code**: the running TypeScript skeleton in `code/` uses **MySQL** instead of Postgres — a pragmatic substitution made after this doc was written, purely so the data is browsable in Sequel Ace. The schema in [code/schema.sql](../code/schema.sql) is a direct port (`JSONB`→`JSON`, `now()`→`CURRENT_TIMESTAMP(3)`, etc.); the table shapes, constraints, and semantics below are unchanged. Postgres remains the production recommendation — better JSON indexing (`GIN`), and `SELECT ... FOR UPDATE SKIP LOCKED` is a cleaner primitive for safe concurrent job claiming than the MySQL equivalent.

---

## `payments`

The core record for every charge or refund request.

```sql
CREATE TABLE payments (
  id                    TEXT PRIMARY KEY,          -- ULID, e.g. pay_01HXYZ...
  consumer_id           TEXT NOT NULL,             -- "llc-service"
  idempotency_key       TEXT NOT NULL,             -- consumer-supplied
  customer_id           TEXT NOT NULL,             -- Waltz internal customer ID
  amount                INTEGER NOT NULL,          -- cents
  currency              TEXT NOT NULL DEFAULT 'usd',
  description           TEXT,
  metadata              JSONB,
  status                TEXT NOT NULL,             -- enum: see state machine
  stripe_pi_id          TEXT,                      -- PaymentIntent ID, set when processing starts
  failure_reason        TEXT,
  parent_payment_id     TEXT REFERENCES payments(id), -- set for refunds
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (consumer_id, idempotency_key)            -- idempotency enforcement
);

CREATE INDEX ON payments (status, updated_at);     -- reconciliation queries
CREATE INDEX ON payments (stripe_pi_id);           -- webhook lookups
```

**Notes**:
- `id` is a ULID (sortable, k-sortable, URL-safe). UUIDs work too; ULIDs give free time-ordering.
- `stripe_pi_id` is `NULL` until the worker starts processing. **Set by the Worker**, atomically in the same `UPDATE` that transitions status from `pending` → `processing`:
  ```sql
  UPDATE payments
  SET status = 'processing', stripe_pi_id = $pi_id
  WHERE id = $id AND status = 'pending'
  ```
  The Worker calls `stripe.paymentIntents.create()` first, receives the PaymentIntent ID (`pi_3Nxxx...`) in the response, then immediately writes it to the DB in this guarded update. This means `stripe_pi_id` is never `NULL` for a payment in `processing`, `succeeded`, or `failed` status — the Webhook Handler and Reconciliation job both rely on this index to look up the internal payment when Stripe sends a notification.

---

### Idempotency Key — ownership, derivation, and enforcement

**Who supplies it**: the calling service (`llc-service`, `mortgage-service`, etc.). The Payment Service never generates it. Only the caller knows the business operation the key represents, and only the caller retries the same call — so the caller must own the key.

**How to derive it**: the key must be **deterministic** — derived from stable, immutable business identifiers, never from a UUID generated at call time. A call-time UUID would be different on every retry, producing a new payment row each time instead of returning the existing one.

Recommended pattern: `{caller-service}:{operation}:{stable-business-id}`

| Caller | Operation | Key |
|---|---|---|
| `llc-service` | Charge for order `ord-123` | `llc-service:charge:ord-123` |
| `mortgage-service` | Monthly payment, loan `loan-456`, period `2024-06` | `mortgage-service:charge:loan-456:2024-06` |
| Any caller | Refund payment `pay_01HXYZ` | `{caller}:refund:pay_01HXYZ` |

**DB-level enforcement**: `UNIQUE (consumer_id, idempotency_key)`. A concurrent or retried insert that conflicts returns `0 rows inserted`. The handler reads and returns the existing row. This is atomic — no application-level locking needed.

**Stripe-level enforcement**: the Worker derives a Stripe idempotency key as `{consumer_id}:{idempotency_key}` and passes it on every Stripe API call. If the Worker retries (crash + queue redelivery), Stripe returns the same PaymentIntent result rather than creating a new charge at the card level.

**What the consumer receives on a retry**: `200 OK` with the existing payment record and its current `status`. Consumers must treat this identically to the original `202 Received`.

---

## `payment_events`

Append-only audit log of every state transition and notable event.

```sql
CREATE TABLE payment_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  event_type  TEXT NOT NULL,   -- "status_changed", "stripe_webhook_received", etc.
  from_status TEXT,
  to_status   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON payment_events (payment_id, created_at);
```

Consumers querying `GET /payments/:id` can optionally request the event log to see the full history.

---

## `outbox`

Enables the **transactional outbox pattern**. Written in the same DB transaction as the `payments` insert. A background relay reads this table and enqueues jobs into SQS/AMQP.

```sql
CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ,           -- NULL until successfully enqueued
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON outbox (enqueued_at) WHERE enqueued_at IS NULL;
```

**Why an outbox at all?** The naive alternative is: HTTP handler inserts the payment row, then calls `sqs.sendMessage()` directly, inline, in the same request. If the process crashes between those two steps, the payment is in `pending` forever with nothing processing it — there's no record that an enqueue was ever supposed to happen. The outbox closes that gap by making "needs to be enqueued" a durable, queryable fact (a row with `enqueued_at IS NULL`) rather than a transient in-flight HTTP call that vanishes if the process dies mid-request.

**Who enqueues, and when — exactly one path, not two.** The HTTP handler **never** calls the queue directly. Its entire job is the DB transaction (insert `payments` + insert `outbox`, then return `202`). **Only the relay's poll loop enqueues, always** — `WHERE enqueued_at IS NULL` is the single source of truth for "what still needs to reach the queue." The `payments` table is never scanned to decide what to enqueue. This means every request takes the same path through the relay — there's no separate "fast inline enqueue" with the relay merely as a crash-recovery backup; that would create a real double-enqueue risk (one trigger from an inline call, a second from the relay independently noticing the same unenqueued row) for no benefit, since the relay already has to exist for crash recovery anyway.

**How the relay runs**: a long-running poll loop (`SELECT ... WHERE enqueued_at IS NULL LIMIT 100`, sleep ~200ms, repeat) inside its own small service or thread — **not** a scheduled cloud function on a multi-minute cron. Since the relay is on the *normal* path (not just a rare-crash fallback), its poll interval directly becomes the latency every payment incurs before any worker starts on it — a 5-minute cron would add up to 5 minutes to every single charge, not just the crash-recovery case. The tight poll loop keeps that added latency down to ~200ms. The "proper" production answer for near-zero latency without polling overhead at all is CDC (e.g., Debezium reading the Postgres WAL and pushing inserts straight to SQS) — heavier to operate, so I didn't choose it as the default here, but it's the natural upgrade path if outbox latency ever becomes the bottleneck.

**Note on the bonus code**: [payment-service.ts](../code/src/payment-service.ts) takes a shortcut not present in this production design — it calls `queue.enqueue()` directly, inline, right after writing the outbox row, because there's no relay process implemented in the skeleton at all. That enqueue call now goes against real SQS (see [queue.ts](../code/src/queue.ts)), so the queue side is genuinely durable — but `markOutboxEnqueued()` in [db.ts](../code/src/db.ts) is still never called by anything, so outbox rows are written correctly but never marked enqueued, demonstrating the data model without demonstrating the relay's specific job (recovering an enqueue that never happened at all).

---

## `stripe_webhook_events`

Deduplication log for Stripe webhook deliveries. Stripe guarantees at-least-once delivery; this table ensures at-most-once processing.

```sql
CREATE TABLE stripe_webhook_events (
  stripe_event_id  TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Processing a webhook is: `INSERT INTO stripe_webhook_events ... ON CONFLICT DO NOTHING`. If 0 rows inserted → already processed → skip. This is atomic and lock-free.

---

## `customer_payment_methods`

Maps Waltz customer IDs to Stripe customer/payment-method IDs. The Payment Service manages this mapping; consumers never see Stripe IDs.

```sql
CREATE TABLE customer_payment_methods (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL,             -- Waltz internal
  stripe_customer_id    TEXT NOT NULL,
  stripe_pm_id          TEXT NOT NULL,             -- PaymentMethod ID
  is_default            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON customer_payment_methods (customer_id);
```

---

## Entity Relationships

```
customer_payment_methods
  └─▶ payments (via customer_id)
         ├─▶ payment_events (1:N)
         ├─▶ outbox (1:1 on creation)
         └─▶ payments (parent_payment_id, for refunds)

stripe_webhook_events (standalone dedup table)
```
