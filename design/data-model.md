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
- The `UNIQUE (consumer_id, idempotency_key)` constraint is the DB-level idempotency guard. A race between two identical requests hits a unique violation; the loser reads the existing row and returns it.
- `stripe_pi_id` is `NULL` until the worker starts processing. Set by the worker atomically with the `processing` status transition.

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

**Why an outbox at all?** Without it: the HTTP handler inserts the payment row, then tries to enqueue — if the process crashes between those two steps, the payment is in `pending` forever with nothing processing it. The outbox makes the enqueue durable: even if the relay crashes, it re-reads un-enqueued rows on restart.

**How the relay runs**: a long-running poll loop (`SELECT ... WHERE enqueued_at IS NULL LIMIT 100`, sleep ~200ms, repeat) inside its own small service or thread — **not** a scheduled cloud function on a multi-minute cron. The HTTP handler already enqueues inline on the normal path, so the relay's only job is recovering the rare case where that inline enqueue was lost to a crash; even so, a 5-minute-cron relay would mean every payment that happens to hit that gap waits up to 5 minutes before any worker even starts on it. The tight poll loop keeps that worst case down to ~200ms. The "proper" production answer for near-zero latency without polling overhead is CDC (e.g., Debezium reading the Postgres WAL and pushing inserts straight to SQS) — heavier to operate, so I didn't choose it as the default here, but it's the natural upgrade path if outbox latency ever becomes the bottleneck.

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
