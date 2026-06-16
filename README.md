# Payment Service Design — Waltz Take-Home Assignment

## How I Used AI

I used Claude Code (claude-sonnet-4-6) as a pair programmer throughout this assignment:

- **Problem decomposition**: I described the five design areas to Claude, which helped me organize my thinking into distinct documents.
- **Code scaffolding**: Claude generated the TypeScript skeleton structure; I reviewed, adjusted, and refined each piece to match my architectural decisions.
- **Tradeoff articulation**: I reasoned through each decision first; Claude helped me phrase them clearly and identify edge cases I might state explicitly.
- **Architecture diagram**: ASCII diagram drafted by me, refined with Claude's help.

Claude did not make the architectural decisions — those are mine. The AI accelerated writing; the thinking is original.

---

## Repo Structure

```
├── README.md                   # This file
├── design/
│   ├── architecture.md         # System overview & diagram
│   ├── api-contract.md         # REST API contract
│   ├── state-machine.md        # Payment lifecycle
│   ├── data-model.md           # Core DB schema
│   ├── failure-modes.md        # Failure analysis
│   └── tradeoffs.md            # Key decisions & alternatives
├── postman/                    # Postman collection + environment for manual testing
│   ├── Payment-Service.postman_collection.json
│   └── Payment-Service-Local.postman_environment.json
└── code/                       # Bonus: TypeScript skeleton
    ├── package.json
    ├── tsconfig.json
    ├── schema.sql               # MySQL schema (ported from design/data-model.md, see note below)
    └── src/
        ├── types.ts
        ├── db.ts               # MySQL-backed store (mysql2 pool)
        ├── stripe-mock.ts      # Stripe mock
        ├── queue.ts            # In-process queue stub (see "Design vs. bonus code" below)
        ├── payment-service.ts  # Core service logic
        ├── worker.ts           # Queue consumer / Stripe caller
        ├── webhook-handler.ts  # Stripe webhook processing
        └── index.ts            # Express app entry point
```

## Design vs. bonus code — what's real and what's stubbed

The design document describes the production architecture I'd build at Waltz. The bonus code is explicitly a **skeleton of one flow** (per the assignment: *"we value structure and clarity over completeness"*), so several production components are stubbed or simplified. Being upfront about the gap:

| Component | Design doc says | Bonus code actually does |
|---|---|---|
| Database | Postgres (see [data-model.md](design/data-model.md)) | **MySQL** — switched after the design was written, purely so the data is inspectable in Sequel Ace locally. Schema is a straight port (`JSONB`→`JSON`, etc.); semantics are identical. |
| Work queue | SQS or RabbitMQ | **In-memory JS array** in [queue.ts](code/src/queue.ts). Durable only as long as the process is alive — see the crash-safety caveat in [failure-modes.md](design/failure-modes.md). |
| Event bus (push to consumers) | SNS or EventBridge | **Not implemented.** No code publishes payment-state-changed events to other services. |
| Outbox relay | Reads `outbox` rows and enqueues them; the recovery path after a crash | **Not implemented.** `outbox` rows are written correctly (so the data model is demonstrated), but `payment-service.ts` calls `queue.enqueue()` directly inline rather than via a relay reading from the table — so today the outbox is descriptive, not yet load-bearing. |
| Stripe | Real Stripe API | Mock in [stripe-mock.ts](code/src/stripe-mock.ts) — simulates async confirmation via `setTimeout` + a registered webhook callback, per the assignment's instruction not to integrate with real Stripe. |
| Webhook dedup, DB-level idempotency, optimistic status transitions | As designed | **Implemented for real** — these run against actual MySQL constraints and conditional updates, not mocked. |

## Quick Start (Bonus Code)

Requires a local MySQL instance (matches the schema in [code/schema.sql](code/schema.sql), ported from [design/data-model.md](design/data-model.md)):

```bash
# one-time setup
brew install mysql
brew services start mysql
mysql -u root < code/schema.sql   # creates the payment_service database + tables
```

By default the app connects to `mysql://root@localhost:3306/payment_service`. Override with `DATABASE_URL` if needed.

```bash
cd code
npm install
npm run dev        # starts on :3000
# or
npm run build && npm start
```

### Inspecting the data

Connect with Sequel Ace (or any MySQL client) to `127.0.0.1:3306`, user `root`, no password, database `payment_service`, to watch rows land in `payments`, `outbox`, and `stripe_webhook_events` in real time as you exercise the API.

### Testing with Postman

Import `postman/Payment-Service.postman_collection.json` and `postman/Payment-Service-Local.postman_environment.json` into Postman. The collection has 10 requests covering the happy path, idempotency, refunds, and webhook handling — see folder descriptions in the collection itself for the suggested run order.

### Try it

```bash
# Create a payment
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"consumerId":"llc-service","idempotencyKey":"llc-order-123","amount":5000,"currency":"usd","description":"LLC formation fee"}'

# Poll status
curl http://localhost:3000/payments/<id>

# Simulate a Stripe webhook (async confirmation)
curl -X POST http://localhost:3000/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{"id":"pi_xxx","metadata":{"paymentId":"<id>"}}}}'
```
