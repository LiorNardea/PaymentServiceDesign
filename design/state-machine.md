# Payment State Machine

## States

| State | Meaning |
|-------|---------|
| `pending` | Request accepted and enqueued. Stripe not yet called. |
| `processing` | Worker dequeued the job and has called Stripe. Waiting for confirmation (sync or webhook). |
| `succeeded` | Stripe confirmed the charge as successful. |
| `failed` | Stripe declined or returned a terminal error. No money moved. |
| `refund_pending` | Refund requested and enqueued. |
| `refunded` | Stripe confirmed the refund. |
| `refund_failed` | Stripe refund attempt failed (e.g., already refunded, card expired). |

## Transitions

```
                  ┌──────────────┐
                  │   PENDING    │◀── initial state on POST /payments
                  └──────┬───────┘
                         │ worker picks up job
                         ▼
                  ┌──────────────┐
                  │  PROCESSING  │
                  └──────┬───────┘
              ┌──────────┴────────────┐
              │                       │
              ▼ (webhook / sync)      ▼ (terminal error / timeout)
       ┌─────────────┐         ┌────────────┐
       │  SUCCEEDED  │         │   FAILED   │
       └──────┬──────┘         └────────────┘
              │ POST /refund
              ▼
       ┌──────────────────┐
       │  REFUND_PENDING   │
       └──────┬────────────┘
          ┌───┴────────────────────────────┐
          ▼                                ▼
   ┌────────────┐                  ┌────────────────┐
   │  REFUNDED  │                  │  REFUND_FAILED │
   └────────────┘                  └────────────────┘
```

## Transition Rules

- Only the **worker** moves `pending → processing`. This transition is atomic: the worker updates the DB and marks the queue message in-flight in the same logical step (DB-first, then acknowledge the queue message only after saving state).
- `processing → succeeded/failed` is triggered by **Stripe's response** (sync PI confirmation or webhook).
- **Stuck processing**: a reconciliation job runs every 5 minutes and queries Stripe for any payment in `processing` state for more than 10 minutes. It updates internal state to match Stripe's reality.
- `failed` and `succeeded` are **terminal** for the charge lifecycle; no transitions out of `failed`. `succeeded` can transition to `refund_pending`.
- Refund transitions mirror the charge transitions, with their own idempotency key.

## What Happens on Crash Mid-Flight

Scenario: worker calls `stripe.paymentIntents.create()`, then crashes before writing `processing` to the DB.

1. Queue visibility timeout expires → job is re-delivered to another worker.
2. Worker has the original `idempotencyKey`. It constructs the same Stripe idempotency key (`consumerId:idempotencyKey`).
3. Stripe returns the *same* PaymentIntent it already created (Stripe's idempotency guarantee).
4. Worker upserts `processing` state and continues normally.

This is safe because the Stripe idempotency key ensures no double charge even across retries.
