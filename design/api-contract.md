# API Contract

All endpoints are internal-only (not public-facing). Consumers authenticate via a shared internal mTLS cert or an internal API key header (`X-Service-Token`). Stripe-specific concepts never appear in request/response bodies.

---

## POST /payments

Initiate a charge. Returns immediately with a payment ID and `pending` status.

**Request**
```json
{
  "consumerId":      "llc-service",
  "idempotencyKey":  "llc-order-abc-123",
  "customerId":      "cust_waltz_456",
  "amount":          5000,
  "currency":        "usd",
  "description":     "LLC formation fee",
  "metadata": {
    "orderId":       "order-789"
  }
}
```

| Field | Notes |
|-------|-------|
| `consumerId` | Which internal service is initiating the charge |
| `idempotencyKey` | Consumer-generated unique key for this operation. Retrying with the same key returns the same result. Must be unique per consumer. |
| `customerId` | Waltz's internal customer ID (Payment Service resolves to Stripe customer internally) |
| `amount` | In the smallest currency unit (cents) |

**Response `202 Received`**
```json
{
  "paymentId": "pay_01HXYZ...",
  "status":    "pending",
  "createdAt": "2026-06-15T10:00:00Z"
}
```

> `202 Received` means the Payment Service has durably recorded the request and will process it. It is **not** a confirmation that the charge succeeded. Callers must not take irreversible business actions (send receipts, provision services, mark orders as paid) until they receive a `PaymentStateChanged` event with `status: succeeded` or poll `GET /payments/:id` to the same result.

**Idempotency behaviour**: if the same `consumerId` + `idempotencyKey` pair already exists, return the stored payment record (same shape, current status) with `200 OK`. No second charge is initiated.

---

## GET /payments/:paymentId

Poll payment status.

**Response `200 OK`**
```json
{
  "paymentId":   "pay_01HXYZ...",
  "status":      "succeeded",
  "amount":      5000,
  "currency":    "usd",
  "description": "LLC formation fee",
  "consumerId":  "llc-service",
  "createdAt":   "2026-06-15T10:00:00Z",
  "updatedAt":   "2026-06-15T10:00:04Z",
  "failureReason": null
}
```

**Possible `status` values**: `pending` | `processing` | `succeeded` | `failed` | `refund_pending` | `refunded` | `refund_failed`

---

## POST /payments/:paymentId/refund

Initiate a full or partial refund. Only valid for payments in `succeeded` status.

**Request**
```json
{
  "idempotencyKey": "llc-refund-abc-123",
  "amount":         5000,
  "reason":         "customer_request"
}
```

**Response `202 Received`**
```json
{
  "paymentId": "pay_01HXYZ...",
  "status":    "refund_pending"
}
```

---

## POST /webhooks/stripe

Stripe calls this endpoint for async payment events. Not callable by internal services.

**Stripe signature header**: `Stripe-Signature` (verified with webhook secret).

**Body**: raw Stripe event JSON (internal concern, not part of the consumer contract).

---

## GET /payments (admin / reconciliation)

Query payments by status and time range. Used by the reconciliation job.

**Query params**: `status`, `before`, `after`, `consumerId`, `limit`, `cursor`

---

## Events (Push Model)

In addition to polling `GET /payments/:id`, consumers can subscribe to `PaymentStateChanged` events published to an SNS topic.

**Who publishes:** the Payment Service's **Webhook Handler** is the sole publisher of final-state events. It publishes after receiving and deduplicating a Stripe webhook. The **Reconciliation job** also publishes as a fallback if the webhook is missed entirely. The Worker does not publish — it only transitions the payment to `processing`.

**SNS topic ownership:** the Payment Service owns and operates the SNS topic. Consumers do not interact with SNS directly — they subscribe via their own SQS queue.

**Subscriber setup (each consumer service must):**
1. Create an SQS queue and subscribe it to the Payment Service's SNS topic
2. Configure a Dead-Letter Queue on their SQS queue for events that fail to process after N retries
3. Filter messages by `consumerId` — SNS delivers all `PaymentStateChanged` events to all subscribers; each service must ignore events that do not belong to it
4. Process events idempotently — SNS/SQS guarantees at-least-once delivery

**Event types and payloads:**

| Event (`newStatus`) | Published by | Payload |
|---|---|---|
| `succeeded` | Webhook Handler | `{ paymentId, consumerId, previousStatus, newStatus, amount, currency, occurredAt }` |
| `failed` | Webhook Handler | `{ paymentId, consumerId, previousStatus, newStatus, failureReason, occurredAt }` |
| `refunded` | Webhook Handler | `{ paymentId, consumerId, previousStatus, newStatus, amount, occurredAt }` |
| `refund_failed` | Webhook Handler | `{ paymentId, consumerId, previousStatus, newStatus, failureReason, occurredAt }` |

**Example subscriber actions:**

| Subscriber | Listens for | Action |
|---|---|---|
| `llc-service` | `succeeded` | Mark order as paid, trigger formation flow |
| `llc-service` | `failed` | Notify customer, cancel or retry order |
| `mortgage-service` | `succeeded` | Record payment on loan ledger, update next due date |
| `mortgage-service` | `failed` | Flag as past-due, trigger collections flow |
| Notifications service | `succeeded` / `failed` | Send email/SMS to end customer |
| Finance / audit service | all events | Append to immutable ledger |

**Important:** consumers must not take irreversible business actions (send receipts, provision services) until a terminal event (`succeeded` or `failed`) is received. A `202 Received` on the original request is not a payment confirmation.
