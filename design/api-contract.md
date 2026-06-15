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

**Response `202 Accepted`**
```json
{
  "paymentId": "pay_01HXYZ...",
  "status":    "pending",
  "createdAt": "2026-06-15T10:00:00Z"
}
```

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

**Response `202 Accepted`**
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

In addition to polling, consumers can subscribe to SNS/EventBridge events:

| Topic / Event Type | Payload |
|---|---|
| `payment.succeeded` | `{ paymentId, consumerId, amount, currency, metadata }` |
| `payment.failed` | `{ paymentId, consumerId, failureReason }` |
| `payment.refunded` | `{ paymentId, consumerId, amount }` |
| `payment.refund_failed` | `{ paymentId, consumerId, failureReason }` |

Consumers filter by `consumerId` so they only receive their own events.
