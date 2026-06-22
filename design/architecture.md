# Architecture

## Overview

The Payment Service is a dedicated internal microservice that centralizes all payment operations. Internal consumers (`llc-service`, `mortgage-service`, etc.) never touch Stripe directly — they call the Payment Service, which abstracts the processor entirely.

The Work Queue sits at the center of the system. It is populated by **many Payment API replicas** (producers) and drained by **many Worker replicas** (consumers). These are distinct service roles — separate deployable units with separate scaling axes.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           INTERNAL CALLERS                                  ║
║   llc-service       mortgage-service      appraisal-service      ...        ║
╚══════════╤═══════════════════╤═══════════════════╤══════════════════════════╝
           │ REST / HTTP       │                   │
           ▼                   ▼                   ▼
     ╔═══════════════════════════════════╗
     ║         Load Balancer / ALB       ║
     ╚══════╤═══════════════════╤════════╝
            ▼                   ▼
  ╔══════════════════╗  ╔══════════════════╗
  ║  Payment API #1  ║  ║  Payment API #2  ║  ...  M replicas
  ║                  ║  ║                  ║       stateless, identical
  ║  • Validate req  ║  ║  • Validate req  ║
  ║  • Write DB txn  ║  ║  • Write DB txn  ║
  ║  • Write outbox  ║  ║  • Write outbox  ║
  ║  • Return 202    ║  ║  • Return 202    ║
  ╚════════╤═════════╝  ╚════════╤═════════╝
           │  enqueue             │  enqueue
           │ (via outbox relay)   │ (via outbox relay)
           │                     │
           └──────────┬──────────┘
                      │
            ══════════╪═════════════════════════════════════
                 MANY PRODUCERS → WORK QUEUE ← MANY CONSUMERS
            ══════════╪═════════════════════════════════════
                      │
                      ▼
          ╔═══════════════════════════════════╗
          ║   Work Queue  (SQS / AMQP)        ║
          ║                                   ║
          ║   • Durable, shared               ║
          ║   • Visibility timeout + DLQ      ║
          ║   • Not owned by any replica      ║
          ╚═══════════════════════════════════╝
                      │
           ┌──────────┴──────────┐
           │  competing pull     │  competing pull
           ▼                     ▼
  ╔══════════════════╗  ╔══════════════════╗
  ║   Worker #1      ║  ║   Worker #2      ║  ...  K replicas
  ║                  ║  ║                  ║       scale independently
  ║  • Semaphore N   ║  ║  • Semaphore N   ║       from API tier
  ║  • Call Stripe   ║  ║  • Call Stripe   ║
  ║  • Update DB     ║  ║  • Update DB     ║
  ║  • Publish event ║  ║  • Publish event ║
  ╚════════╤═════════╝  ╚════════╤═════════╝
           │                     │
           └──────────┬──────────┘
                      ▼
          ╔═══════════════════════════════════╗
          ║       Stripe Client (wrapped)     ║
          ╚═══════════════════════════════════╝
                      │
                      ▼
          ╔═══════════════════════════════════╗
          ║              Stripe               ║
          ╚═══════════════════════════════════╝
                      │
                      │ webhooks (any replica behind ALB)
                      ▼
          ╔═══════════════════════════════════╗     ╔═════════════════╗
          ║    Webhook Handler                ║────▶║  Event Bus      ║──▶ SNS / EventBridge
          ║    /webhooks/stripe               ║     ║  Publisher      ║
          ╚═══════════════════════════════════╝     ╚═════════════════╝

  ╔═════════════════════════════════════════════════════════════╗
  ║   Payments DB (Postgres) — shared across ALL replicas       ║
  ║   API tier writes payments + outbox rows in one transaction ║
  ║   Worker tier reads outbox, updates payment state           ║
  ╚═════════════════════════════════════════════════════════════╝
```

## Service Roles

| Role | Replica count | Scales with | Responsibility |
|---|---|---|---|
| **Payment API** | M | inbound request rate | Accept, validate, persist, acknowledge (202) |
| **Worker** | K | queue depth / Stripe throughput | Dequeue, call Stripe, transition to `processing` → `succeeded`/`failed` in DB |
| **Webhook Handler** | — (runs on API replicas) | — | Receive Stripe webhook, deduplicate, update final state, publish to SNS |
| **Reconciliation Lambda** | — (EventBridge cron, every 5 min) | — | Detect stale `processing` payments, sync from Stripe, publish to SNS as fallback |
| **Work Queue** | 1 logical queue | — (managed service) | Buffer, durability, competing-consumer delivery |
| **Payments DB** | 1 primary + replicas | read traffic | Single source of truth |

M and K are **independent** scaling axes. A traffic spike may require more API replicas without needing more workers, and a processing backlog may require more workers without changing the API tier.

**Total Stripe throughput = K replicas × N concurrent jobs per worker.**  
N is a **concurrency limit (semaphore), not a batch size**. The worker maintains a sliding window of exactly N jobs in-flight at all times — as each job completes, the worker immediately pulls the next message from SQS to refill the slot. This keeps the pipeline always full rather than idling while waiting for a slow batch to drain. Since Stripe calls are I/O-bound, a single Node.js process can hold N calls in-flight without N OS threads — Node's event loop handles the concurrency.

One SQS constraint: `ReceiveMessage` returns at most 10 messages per call (AWS hard limit). If N > 10 the worker makes multiple SQS calls to fill its slots; if N ≤ 10 it pulls `min(available_slots, 10)` per call.

## Key Design Choices

### 1. Hybrid Sync/Async API

Consumers get a **synchronous acknowledgement** (HTTP 202 Received + `paymentId`) within milliseconds. The actual charge is processed asynchronously by the Worker tier. This decouples consumer latency from Stripe's latency and allows burst absorption.

### 2. Work Queue as the Reliability Backbone

Accepted payment requests are enqueued **before** any Stripe call. Workers pull jobs and call Stripe. This means:
- Bursts are smoothed (queue buffers load)
- A worker crash leaves the SQS message intact — it reappears after the visibility timeout and is redelivered. The worker uses `stripe_pi_id` as a sentinel on redelivery: `NULL` means Stripe was never called (retry the call); set means Stripe was called (skip and let the webhook arrive). See [failure-modes.md §2](failure-modes.md#2-worker-crashes-mid-flight) for the full breakdown.
- The queue is the source of durability, not the HTTP thread
- API tier and Worker tier scale **independently** — add API replicas for request throughput, add Worker replicas for Stripe throughput, tune N for I/O concurrency per worker

### 3. Outbox for Atomicity

When accepting a charge request, the Payment API writes to the `payments` table and the `outbox` table in a **single DB transaction**. An outbox relay process reads unprocessed outbox rows and enqueues them into the Work Queue. This eliminates the gap: "payment written to DB but never enqueued."

### 4. Webhook Handler — Processing Pipeline

Stripe delivers webhook events to `POST /webhooks/stripe`, routed by the ALB to any API replica. The handler follows a strict pipeline:

**Step 1 — Deduplicate**
```sql
INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
VALUES ($1, $2)
ON CONFLICT (stripe_event_id) DO NOTHING
```
If 0 rows inserted → already processed → return `200 OK` immediately, do nothing else. This handles Stripe's at-least-once delivery guarantee.

**Step 2 — Resolve the internal payment**
Look up the payment by `stripe_pi_id` (the PaymentIntent ID carried in the webhook body). This is why `payments.stripe_pi_id` is indexed.

**Step 3 — Update payment status**
Map the Stripe event type to an internal status transition:

| Stripe event | Internal status transition |
|---|---|
| `payment_intent.succeeded` | `processing` → `succeeded` |
| `payment_intent.payment_failed` | `processing` → `failed` |
| `payment_intent.canceled` | `processing` → `failed` |
| `charge.refunded` | `succeeded` → `refunded` |

Write the new status to `payments` and append a row to `payment_events` (audit log).

**Step 4 — Publish to Event Bus**
Publish a `PaymentStateChanged` event to SNS/EventBridge:
```json
{
  "paymentId": "pay_01HABC",
  "consumerId": "llc-service",
  "previousStatus": "processing",
  "newStatus": "succeeded",
  "amount": 29900,
  "currency": "usd",
  "occurredAt": "2024-06-18T10:00:06Z"
}
```

**Step 5 — Return 200 to Stripe**
Stripe considers the webhook delivered. If we return anything other than 2xx, Stripe will retry.

---

**Who subscribes and what do they do?**

Each internal service subscribes to the SNS topic for the event types it cares about. The Payment Service does not know or care who is subscribed — that is the subscriber's concern.

| Subscriber | Listens for | Action on receipt |
|---|---|---|
| `llc-service` | `succeeded` for its own payments | Mark LLC order as paid, trigger next step in formation flow |
| `llc-service` | `failed` for its own payments | Notify customer, retry or cancel the order |
| `mortgage-service` | `succeeded` | Record payment against loan ledger, update next due date |
| `mortgage-service` | `failed` | Flag loan as payment-past-due, trigger collections flow |
| Notifications service | `succeeded` / `failed` | Send email/SMS receipt or failure notice to end customer |
| Finance / audit service | all events | Append to immutable ledger for reporting and reconciliation |

Subscribers filter by `consumerId` so each service only acts on its own payments — `llc-service` ignores events for `mortgage-service` payments and vice versa.

**Why SNS and not direct callbacks?**
The Payment Service does not call consumer services directly. That would couple it to every downstream service's availability — if `llc-service` is down, the Payment Service would need retry logic, circuit breakers, and knowledge of every subscriber. SNS decouples this: the Payment Service publishes once, SNS fans out to all subscribers, and each subscriber is responsible for its own retry and dead-letter handling.

### 5. Idempotency Key Contract

Every charge request carries a **caller-supplied idempotency key**. The Payment Service never generates this key — it is the caller's responsibility, because only the caller knows the business intent behind the request.

**Why caller-supplied?**  
The key must be the same across retries. That means it must be derived deterministically from the business operation, not generated at call time. A randomly-generated key on each attempt would defeat the entire mechanism.

**Derivation convention** — callers must derive the key from stable, immutable business identifiers:

| Caller | Operation | Recommended key |
|---|---|---|
| `llc-service` | Charge for order `ord-123` | `llc-service:charge:ord-123` |
| `mortgage-service` | Monthly payment for loan `loan-456`, period `2024-06` | `mortgage-service:charge:loan-456:2024-06` |
| Any caller | Refund payment `pay_01HXYZ` | `{caller}:refund:pay_01HXYZ` |

**Two enforcement layers:**

1. **Payment Service DB** — `UNIQUE (consumer_id, idempotency_key)` constraint. A retry hitting a conflict returns the existing payment row with its current status. No second payment row, no second charge.

2. **Stripe** — the Worker passes `{consumer_id}:{idempotency_key}` as Stripe's own idempotency key when creating a PaymentIntent. If a Worker retries a Stripe call (e.g., after crash-and-redelivery), Stripe returns the same PaymentIntent result — **no second charge at the card level**.

Both layers are independent. Either one alone would prevent a duplicate; together they cover every failure window from consumer retry to worker crash mid-flight.

**What the consumer receives on a retry:**  
`200 OK` with the existing payment and its current `status`. The consumer should treat this identically to the original `202` — it means the request was received and is being (or has been) processed.

### 6. Event Publishing — Ownership and Responsibilities

**Who publishes:** the **Webhook Handler** is the sole publisher of final-state `PaymentStateChanged` events. The Worker does not publish — its job ends after transitioning the payment to `processing` and calling Stripe. The final state (`succeeded` / `failed`) is confirmed by Stripe via webhook, and only then is the event published.

The one exception is the **Reconciliation Lambda**: if a webhook is missed entirely (Stripe delivery failure or service downtime), it detects the stale `processing` state, syncs from Stripe directly, and publishes the `PaymentStateChanged` event itself. For payments stuck beyond a configurable max-age **per payment method** (cards ~1h, 3DS ~24h, ACH ~6 days — Stripe does not guarantee a fixed window), it **cancels the PaymentIntent on Stripe first**, then marks `failed` locally and publishes — the order is critical to prevent a double-charge if the consumer retried after receiving a `failed` event while Stripe was still able to settle the charge.

**Deployment model — scheduled Lambda, not an always-running service.**
The Reconciliation Lambda is triggered by an **AWS EventBridge scheduled rule** every 5 minutes. It runs, does its work, and exits. It is not a long-running process. Reasons:
- The work is inherently periodic — there is nothing to do between runs.
- It is fully stateless — no in-memory state is needed between invocations.
- Lambda + EventBridge eliminates idle cost and operational overhead (no health checks, no crash recovery, no scaling config for a sleeping process).
- An always-running service would be appropriate only if the interval needed to drop below ~1 minute (Lambda's minimum cron granularity via EventBridge). At 5-minute intervals, Lambda is the correct primitive.

**Why the Worker does not publish final state:**
If the Worker published `succeeded` after a Stripe call and then the webhook also arrived and published again, subscribers would receive duplicate events for the same transition. Centralizing publishing in the Webhook Handler (which deduplicates by `stripe_event_id`) means exactly one event is published per state transition.

**Who owns what:**

| Component | Owner | Responsibility |
|---|---|---|
| SNS topic (`PaymentStateChanged`) | Payment Service | Create, manage, publish to |
| SQS queue subscribed to SNS | Each consumer service | Create, subscribe, consume, handle DLQ |
| Event filtering by `consumerId` | Each consumer service | Only process events where `consumerId` matches |
| Retry on failed delivery | SNS → each subscriber's SQS | SNS retries delivery to SQS; SQS provides DLQ after N failures |

The Payment Service has no knowledge of who is subscribed. Adding a new consumer service requires no changes to the Payment Service — the new service creates its SQS queue and subscribes to the SNS topic independently.

**Subscriber responsibilities:**
Each consumer service must:
1. Maintain its own SQS queue subscribed to the SNS topic
2. Filter events by `consumerId` — ignore events belonging to other services
3. Process events idempotently — SNS/SQS guarantees at-least-once delivery; the same `PaymentStateChanged` event may arrive more than once
4. Define its own DLQ and alerting for events it fails to process
5. Not take irreversible business actions until a terminal event (`succeeded` or `failed`) is received

---

> **Note on the bonus code**: the diagram above is the production architecture. The bonus TypeScript skeleton in `code/` runs as M=1, K=1 — a single Node process for both roles, not a real multi-replica deployment — but its Work Queue is **real SQS** (via LocalStack, see [queue.ts](../code/src/queue.ts)), with genuine visibility timeouts, redelivery on failure, and a dead-letter queue (`maxReceiveCount=5`). The outbox relay is not a separate process; the inline `queue.enqueue()` call goes directly against SQS rather than through a relay reading unprocessed outbox rows. See the "Design vs. bonus code" table in the [root README](../README.md) for the full breakdown.
