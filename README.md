# Payment Service Design — Waltz Take-Home Assignment

## How I Used AI

I used Claude Code (claude-sonnet-4-6) as a pair programmer throughout this assignment.

**What the AI did:**
- Helped structure and phrase design decisions I had already reasoned through
- Drafted ASCII and HTML diagrams from descriptions I gave it
- Generated the TypeScript skeleton structure, which I reviewed and adjusted to match my architectural decisions
- Caught gaps and inconsistencies in the docs as I evolved the design (e.g. flagged that two sections contradicted each other on who publishes SNS events)
- Produced the scenario walkthrough and interview Q&A as study aids

**What I did:**
- Made every architectural decision: sync/async split, outbox pattern, two-tier producer/consumer separation, idempotency key ownership, Webhook Handler as sole SNS publisher, Reconciliation Lambda model
- Caught design gaps and directed fixes (e.g. "the relay isn't explained anywhere", "who sets stripe_pi_id?", "202 Accepted is the wrong term")
- Reviewed and corrected everything the AI produced

Claude did not make the architectural decisions — those are mine. The AI accelerated writing and helped me articulate tradeoffs clearly.

---

## Deliverables — Assignment Checklist

| Requirement | Covered in |
|---|---|
| Architecture diagram | [design/architecture.md](design/architecture.md) · [design/architecture-diagram.html](design/architecture-diagram.html) |
| API contract | [design/api-contract.md](design/api-contract.md) |
| Payment state machine | [design/state-machine.md](design/state-machine.md) |
| Data model | [design/data-model.md](design/data-model.md) |
| Failure-mode analysis | [design/failure-modes.md](design/failure-modes.md) |
| Tradeoffs (≥3 decisions) | [design/tradeoffs.md](design/tradeoffs.md) — 5 decisions with alternatives and what I gave up |
| API & Decoupling | [design/api-contract.md](design/api-contract.md) · [design/architecture.md](design/architecture.md) §1, §5 |
| Event-Driven Architecture | [design/architecture.md](design/architecture.md) §4, §6 · [design/api-contract.md](design/api-contract.md) Events section |
| Concurrency & Reliability | [design/architecture.md](design/architecture.md) §2, §3 · [design/failure-modes.md](design/failure-modes.md) |
| Job Status & State Management | [design/state-machine.md](design/state-machine.md) · [design/failure-modes.md](design/failure-modes.md) §3, §7 |
| Idempotency | [design/architecture.md](design/architecture.md) §5 · [design/data-model.md](design/data-model.md) §Idempotency Key |
| AI usage disclosure | This file |
| Bonus code | [code/](code/) — see Quick Start below |

---

## Repo Structure

```
├── README.md                          # This file — deliverable checklist, AI usage, quick start
│
├── design/
│   ├── architecture.md                # System overview, two-tier diagram, all key design choices
│   ├── architecture-diagram.html      # Interactive visual diagram — open in any browser
│   ├── api-contract.md                # REST API contract: endpoints, payloads, event model
│   ├── state-machine.md               # Payment lifecycle: states, transitions, rules
│   ├── data-model.md                  # Core DB schema (Postgres), idempotency key spec
│   ├── failure-modes.md               # 8 failure scenarios with exact recovery steps
│   ├── tradeoffs.md                   # 5 significant decisions: what I chose, rejected, and why
│   ├── scenario-examples.md           # End-to-end happy-path walkthrough with sequence diagrams
│   └── interview-qa.md                # Likely interview questions with full answers
│
├── postman/
│   ├── Payment-Service.postman_collection.json
│   └── Payment-Service-Local.postman_environment.json
│
└── code/                              # Bonus: TypeScript skeleton
    ├── package.json
    ├── tsconfig.json
    ├── schema.sql                     # MySQL schema (ported from design/data-model.md)
    └── src/
        ├── types.ts
        ├── db.ts                      # MySQL-backed store (mysql2 pool)
        ├── stripe-mock.ts             # Stripe mock (no real Stripe integration)
        ├── queue.ts                   # Real SQS-backed queue (via LocalStack)
        ├── payment-service.ts         # Core service logic
        ├── worker.ts                  # Queue consumer / Stripe caller
        ├── webhook-handler.ts         # Stripe webhook processing
        └── index.ts                   # Express app entry point
    └── scripts/
        └── setup-queue.sh             # Creates the SQS queue + DLQ on LocalStack
```

### About the extra files

**`architecture-diagram.html`** — a visual version of the architecture diagram. Open it directly in a browser. Shows all service tiers (API replicas, Outbox Relay, Work Queue, Workers, Webhook Handler, SNS, Reconciliation Lambda) with color-coded roles and annotations. Easier to read than the ASCII version in `architecture.md`.

**`scenario-examples.md`** — 8 end-to-end scenarios with sequence diagrams and DB state tables: happy path, payment declined, consumer retry (idempotency), worker crash mid-flight, duplicate webhook delivery, missed webhook (Reconciliation Lambda recovery), refund flow, and end-of-month burst (500 requests). Each scenario shows exactly what happens at every layer and why no data is lost or double-charged.

**`interview-qa.md`** — anticipated questions for the 25-minute review session, with full answers grounded in the design. Covers reliability, idempotency, scalability, architecture trade-offs, and edge cases.

---

## Design vs. Bonus Code — What's Real and What's Stubbed

The design documents describe the production architecture. The bonus code is a skeleton of one flow, per the assignment's note that *"we value structure and clarity over completeness."*

| Component | Design doc says | Bonus code actually does |
|---|---|---|
| Database | Postgres | **MySQL** — switched after the design was written so the data is inspectable in Sequel Ace locally. Schema is a straight port (`JSONB`→`JSON` etc.); semantics are identical. |
| Work queue | SQS or AMQP | **Real SQS** via [LocalStack](https://localstack.cloud/) in Docker — see [queue.ts](code/src/queue.ts). Uses real `@aws-sdk/client-sqs` calls, real visibility timeouts, and a real DLQ with `maxReceiveCount=5`. A crash mid-processing genuinely leaves the message for redelivery. |
| Outbox relay | Separate process: polls `outbox` WHERE `enqueued_at IS NULL`, enqueues to SQS, marks done. The only enqueue path. | **Not implemented as a separate relay.** `outbox` rows are written correctly, but `payment-service.ts` calls `queue.enqueue()` inline (against real SQS) rather than via a relay reading the outbox table. The queue is durable; the "survives a crash before enqueue" guarantee is not demonstrated. |
| Event bus | SNS/EventBridge — Webhook Handler publishes `PaymentStateChanged` after each Stripe webhook | **Not implemented.** No SNS publishing in the skeleton. |
| Reconciliation Lambda | EventBridge cron every 5 min — detects stale `processing` payments, syncs from Stripe | **Not implemented.** |
| Stripe | Real Stripe API | Mock in [stripe-mock.ts](code/src/stripe-mock.ts) — simulates async confirmation via `setTimeout` + webhook callback, per assignment instructions. |
| Webhook dedup, DB-level idempotency, optimistic status transitions | As designed | **Implemented for real** — against actual MySQL constraints and conditional `UPDATE ... WHERE status='pending'`. |

---

## Quick Start (Bonus Code)

Requires a local MySQL instance and LocalStack (Docker):

```bash
# MySQL
brew install mysql
brew services start mysql
mysql -u root < code/schema.sql   # creates payment_service DB + tables

# SQS via LocalStack (requires Docker Desktop)
docker run -d --name localstack -p 4566:4566 -e SERVICES=sqs localstack/localstack:3.4
cd code && ./scripts/setup-queue.sh   # creates queue + DLQ
```

Default connections: `mysql://root@localhost:3306/payment_service` and SQS at `http://localhost:4566`. Override with `DATABASE_URL` / `SQS_ENDPOINT` / `SQS_QUEUE_URL`.

```bash
cd code
npm install
npm run dev        # starts on :3000
```

### Testing with Postman

Import `postman/Payment-Service.postman_collection.json` and `postman/Payment-Service-Local.postman_environment.json`. The collection covers the happy path, idempotency, refunds, and webhook handling — see folder descriptions in the collection for the suggested run order.

### Try it manually

```bash
# Create a payment
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"consumerId":"llc-service","idempotencyKey":"llc-order-123","customerId":"cust-456","amount":5000,"currency":"usd","description":"LLC formation fee"}'

# Poll status
curl http://localhost:3000/payments/<paymentId>

# Simulate a Stripe webhook (async confirmation)
curl -X POST http://localhost:3000/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{"id":"pi_xxx","metadata":{"paymentId":"<paymentId>"}}}}'
```

### Inspecting the data

Connect with Sequel Ace (or any MySQL client) to `127.0.0.1:3306`, user `root`, no password, database `payment_service`. Watch rows land in `payments`, `outbox`, and `stripe_webhook_events` in real time as you exercise the API.
