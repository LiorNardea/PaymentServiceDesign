# Architecture

## Overview

The Payment Service is a dedicated internal microservice that centralizes all payment operations. Internal consumers (`llc-service`, `mortgage-service`, etc.) never touch Stripe directly — they call the Payment Service, which abstracts the processor entirely.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Internal Services                              │
│   llc-service    mortgage-service    appraisal-service    ...           │
└────────┬────────────────┬──────────────────┬────────────────────────────┘
         │  REST          │                  │
         ▼                ▼                  ▼
              ┌─────────────────────────┐
              │   Load Balancer / ALB    │
              └────┬────────────────┬────┘
                   ▼                ▼
     ┌───────────────────┐  ┌───────────────────┐        ...M replicas
     │ Payment Service #1 │  │ Payment Service #2 │       total, identical,
     │ ┌─────────────────┐│  │┌─────────────────┐ │       stateless
     │ │  HTTP API       ││  ││  HTTP API       │ │
     │ │  (Express)      ││  ││  (Express)      │ │
     │ └────────┬────────┘│  │└────────┬────────┘ │
     │          │ enqueue │  │         │ enqueue   │
     │ ┌────────▼────────┐│  │┌────────▼────────┐ │
     │ │ Worker pool      ││  ││ Worker pool      │ │       Each replica runs
     │ │ (N concurrent    ││  ││ (N concurrent    │ │       its own worker
     │ │  async jobs)     ││  ││  async jobs)     │ │       pool — N is an
     │ └────────┬────────┘│  │└────────┬────────┘ │       in-process
     └──────────┼──────────┘  └──────────┼──────────┘       concurrency limit,
                │                        │                  not separate OS
                ▼                        ▼                  threads (Stripe
        ┌──────────────────────────────────────┐            calls are I/O-
        │       Work Queue (SQS / AMQP)         │            bound).
        │  shared — NOT owned by any 1 replica  │
        └──────────────────────────────────────┘
                │  competing consumers: every
                │  replica's worker pool pulls
                │  from the same shared queue
                ▼
        ┌──────────────────────────────────────┐
        │        Stripe Client (wrapped)        │
        └──────────────────────────────────────┘
                │
                ▼
        ┌──────────────────────────────────────┐
        │              Stripe                   │
        └──────────────────────────────────────┘
                │ webhooks (delivered to any replica
                │ behind the load balancer)
                ▼
     ┌──────────────────────┐      ┌──────────────┐
     │   Webhook Handler     │────▶│  Event Bus    │──▶ SNS/EventBridge
     │   /webhooks/stripe    │     │  Publisher    │     topics
     └──────────────────────┘     └──────────────┘

     ┌──────────────────────────────────────────┐
     │   Payments DB (Postgres) — shared,        │
     │   single source of truth for all replicas │
     └──────────────────────────────────────────┘
```

**Total concurrent job processing capacity = M replicas × N concurrent jobs per replica.** M is ordinary horizontal scaling (more pods/tasks, for redundancy and request-handling capacity). N is a concurrency limit *within* a single replica's worker pool — since calling Stripe is I/O-bound, one Node process can have many calls in flight at once without needing N separate OS threads or processes; N is enforced with a concurrency limiter (e.g., process up to N items pulled from the queue at a time), not by spawning workers.

The work queue and database are **shared infrastructure**, not owned by any one replica — that's what makes replicas interchangeable: any replica's worker pool can pick up any job, and a crashed replica's in-flight jobs simply become visible again (via SQS visibility timeout) for another replica to claim.

> **Note on the bonus code**: the diagram above is the production architecture. The bonus TypeScript skeleton in `code/` runs as **M=1, N=1** — a single Node process with a single sequential in-memory queue consumer (see [queue.ts](../code/src/queue.ts)), not a real multi-replica, multi-worker deployment. It implements the database, idempotency, and webhook-handling pieces for real, but stubs the Work Queue (in-memory array instead of SQS/AMQP) and does not implement the Event Bus at all. See the "Design vs. bonus code" table in the [root README](../README.md) for the full breakdown of what's real vs. simplified.

## Key Design Choices

### 1. Hybrid Sync/Async API

Consumers get a **synchronous acknowledgement** (HTTP 202 + `paymentId`) within milliseconds. The actual charge is processed asynchronously. This decouples consumer latency from Stripe's latency and allows burst absorption.

### 2. Work Queue as the Reliability Backbone

Accepted payment requests are enqueued **before** any Stripe call. Workers pull jobs and call Stripe. This means:
- Bursts are smoothed (queue buffers load)
- A worker crash only drops in-flight processing — the job is re-queued after visibility timeout
- The queue is the source of durability, not the HTTP thread
- Throughput scales two ways independently: add more **replicas** (M) for more total capacity and redundancy, or raise the **per-replica concurrency limit** (N) since Stripe calls are I/O-bound and don't need a 1:1 OS thread per in-flight call. The queue's competing-consumers pattern means scaling M requires no coordination — every replica just pulls from the same shared queue.

### 3. Outbox for Atomicity

When accepting a charge request, the service writes to the `payments` table and the `outbox` table in a **single DB transaction**. The worker reads from the outbox. This eliminates the gap: "payment written to DB but never enqueued."

### 4. Webhook Handler is Idempotent

Stripe webhooks land at a dedicated endpoint. Every event is deduplicated by `stripe_event_id` before processing. Duplicate webhook deliveries (Stripe's at-least-once guarantee) are silently ignored.

### 5. Event Publishing for Push Notifications

After any state transition, the service publishes a `PaymentStateChanged` event to the event bus (SNS topic per event type, or EventBridge). Consumer services subscribe to relevant events for their own flows without polling.
