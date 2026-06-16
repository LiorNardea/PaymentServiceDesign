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
└── code/                       # Bonus: TypeScript skeleton
    ├── package.json
    ├── tsconfig.json
    ├── schema.sql               # Postgres schema (matches design/data-model.md)
    └── src/
        ├── types.ts
        ├── db.ts               # Postgres-backed store (pg pool)
        ├── stripe-mock.ts      # Stripe mock
        ├── queue.ts            # In-process queue stub
        ├── payment-service.ts  # Core service logic
        ├── worker.ts           # Queue consumer / Stripe caller
        ├── webhook-handler.ts  # Stripe webhook processing
        └── index.ts            # Express app entry point
```

## Quick Start (Bonus Code)

Requires a local Postgres instance (matches the `payments` / `outbox` / `stripe_webhook_events` schema in [design/data-model.md](design/data-model.md)):

```bash
# one-time setup
brew install postgresql@16
brew services start postgresql@16
createdb payment_service
psql -d payment_service -f code/schema.sql
```

By default the app connects to `postgresql://localhost:5432/payment_service`. Override with `DATABASE_URL` if needed.

```bash
cd code
npm install
npm run dev        # starts on :3000
# or
npm run build && npm start
```

### Inspecting the data

Connect with Sequel Ace, TablePlus, or `psql` to `payment_service` on `localhost:5432` (no password by default with Homebrew's Postgres) to watch rows land in `payments`, `outbox`, and `stripe_webhook_events` in real time as you exercise the API.

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
