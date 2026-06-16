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
┌─────────────────────────────────────────────────────────────────────────┐
│                          Payment Service                                │
│                                                                         │
│  ┌─────────────┐     ┌──────────────┐     ┌──────────────────────────┐ │
│  │  HTTP API   │────▶│ Idempotency  │────▶│   Payments DB            │ │
│  │  (Express)  │     │  Key Store   │     │  (Postgres)              │ │
│  └──────┬──────┘     └──────────────┘     └──────────────────────────┘ │
│         │                                           ▲                   │
│         │ enqueue                                   │ update            │
│         ▼                                           │                   │
│  ┌──────────────┐      ┌──────────────────┐         │                   │
│  │  Work Queue  │─────▶│  Payment Worker  │─────────┘                  │
│  │  (SQS/AMQP) │      │  (pool of N)     │                            │
│  └──────────────┘      └───────┬──────────┘                            │
│                                │ calls                                  │
│         ┌──────────────────────┘                                        │
│         │                                                               │
│  ┌──────▼──────────────────────────────┐                               │
│  │        Stripe Client (wrapped)      │                               │
│  └──────────────────────────────────────┘                              │
│                                                                         │
│  ┌─────────────────┐      ┌──────────────┐                             │
│  │ Webhook Handler │─────▶│ Event Bus    │──▶ SNS/EventBridge topics   │
│  │  /webhooks/     │      │  Publisher   │                             │
│  │  stripe         │      └──────────────┘                             │
│  └─────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────────┘
                    ▲ webhooks
               ┌────┴──────────────┐
               │       Stripe      │
               └───────────────────┘
```

> **Note on the bonus code**: the diagram above is the production architecture. The bonus TypeScript skeleton in `code/` implements the database, idempotency, and webhook-handling pieces for real, but stubs the Work Queue (in-memory array instead of SQS/AMQP) and does not implement the Event Bus at all. See the "Design vs. bonus code" table in the [root README](../README.md) for the full breakdown of what's real vs. simplified.

## Key Design Choices

### 1. Hybrid Sync/Async API

Consumers get a **synchronous acknowledgement** (HTTP 202 + `paymentId`) within milliseconds. The actual charge is processed asynchronously. This decouples consumer latency from Stripe's latency and allows burst absorption.

### 2. Work Queue as the Reliability Backbone

Accepted payment requests are enqueued **before** any Stripe call. Workers pull jobs and call Stripe. This means:
- Bursts are smoothed (queue buffers load)
- A worker crash only drops in-flight processing — the job is re-queued after visibility timeout
- The queue is the source of durability, not the HTTP thread

### 3. Outbox for Atomicity

When accepting a charge request, the service writes to the `payments` table and the `outbox` table in a **single DB transaction**. The worker reads from the outbox. This eliminates the gap: "payment written to DB but never enqueued."

### 4. Webhook Handler is Idempotent

Stripe webhooks land at a dedicated endpoint. Every event is deduplicated by `stripe_event_id` before processing. Duplicate webhook deliveries (Stripe's at-least-once guarantee) are silently ignored.

### 5. Event Publishing for Push Notifications

After any state transition, the service publishes a `PaymentStateChanged` event to the event bus (SNS topic per event type, or EventBridge). Consumer services subscribe to relevant events for their own flows without polling.
