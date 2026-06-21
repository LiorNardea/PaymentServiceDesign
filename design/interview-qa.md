# Interview Q&A — Payment Service Design

---

## Reliability & Correctness

**Q: What happens if the Payment API crashes right after writing to the database but before the message reaches the queue?**

The outbox row written in the same DB transaction has `enqueued_at = NULL`. The outbox relay polls for exactly those rows every ~200ms and enqueues them to SQS, then marks `enqueued_at = now()`. The crash is invisible to the system — the row survives and the relay picks it up on the next cycle. This is the whole point of the outbox pattern: the durable record that an enqueue is needed lives in the DB, not in process memory.

---

**Q: What happens if a worker crashes mid-flight — after calling Stripe but before updating the database?**

The SQS visibility timeout saves us. When a worker dequeues a message, SQS hides it from other workers for ~30 seconds. If the worker crashes, it never calls `deleteMessage()`, so after the timeout expires the message becomes visible again and another worker picks it up. That worker calls Stripe again with the same Stripe idempotency key (`{consumer_id}:{idempotency_key}`). Stripe recognizes it and returns the same PaymentIntent result without charging the card again. The worker then writes `succeeded` to the DB and deletes the message. The customer is charged exactly once.

---

**Q: Stripe guarantees at-least-once webhook delivery. How does your system handle receiving the same webhook twice?**

The `stripe_webhook_events` table deduplicates by `stripe_event_id`. On the first delivery, the handler inserts the event ID. On the second delivery, it attempts the same insert and gets a conflict (`ON CONFLICT DO NOTHING`). Zero rows inserted means already processed — the handler returns `200 OK` immediately without re-updating the payment status or re-publishing to SNS.

Note: this is distinct from the Stripe idempotency key, which applies to *outgoing* calls from us to Stripe. Webhooks are *incoming* — Stripe calls us, and deduplication is handled purely by the `stripe_event_id`.

---

**Q: Two workers pick up the same job simultaneously. Walk me through what happens.**

Before calling Stripe, each worker runs an atomic optimistic-lock update:
```sql
UPDATE payments SET status='processing'
WHERE id=$id AND status='pending'
```
Only one worker's update succeeds because only one finds `status='pending'` — the other gets 0 rows affected and aborts without ever reaching Stripe. Even if both somehow did reach Stripe, the same Stripe idempotency key would prevent a second charge. Two independent safety layers: DB optimistic locking + Stripe idempotency.

---

## Idempotency

**Q: Who generates the idempotency key, and why can't the Payment Service generate it itself?**

The calling service generates it. The Payment Service cannot generate it because the key must be identical across retries — it must be derived deterministically from the business operation, not at call time. Only the caller knows the business intent (e.g. "charge for order ord-123"). If the Payment Service generated a random key on each request, a retry would produce a different key, creating a second payment row and a second charge.

Callers derive the key from stable, immutable business identifiers — e.g. `llc-service:charge:ord-123` or `mortgage-service:charge:loan-456:2024-06`.

---

**Q: A consumer retries a charge request after a network timeout. How does your system ensure they aren't charged twice?**

The `UNIQUE (consumer_id, idempotency_key)` constraint in the DB catches the duplicate insert. The handler returns `200 OK` with the existing payment record and its current status. No second payment row is created, so no second job is enqueued, so no second Stripe call is ever made.

---

**Q: How do you prevent a double refund on the same payment?**

The same idempotency mechanism applies. The caller derives the refund key as `{caller}:refund:{original-payment-id}` — stable and deterministic. The `UNIQUE (consumer_id, idempotency_key)` constraint blocks a second refund row at the DB level. If the worker retries the Stripe refund call, the same Stripe idempotency key returns the existing refund result. The `parent_payment_id` foreign key on the `payments` table also gives reconciliation an explicit structural record to detect double-refund attempts.

---

## Scalability & Performance

**Q: You have M API replicas and K worker replicas — why are these two separate scaling axes? When would you scale one but not the other?**

They do fundamentally different work with different bottlenecks. API replicas are CPU/network-bound around HTTP handling and DB writes — they scale with inbound request rate. Workers are I/O-bound around Stripe API calls — they scale with queue depth and Stripe throughput.

Scale M (API) without scaling K: a spike in inbound requests that are being accepted and enqueued quickly, but Stripe processing is keeping pace.

Scale K (Workers) without scaling M: a backlog building in the queue — payments accepted fine but workers can't drain the queue fast enough. Add more workers, the API tier is fine.

---

**Q: End of month — 500 charge requests arrive in 3 seconds. Walk me through what happens.**

API replicas receive the requests via the ALB and fan them out across M replicas. Each replica writes a `payments` row and an `outbox` row atomically — DB writes are fast (~5ms), so all 500 are accepted and 202 Received responses returned within seconds. The outbox relay picks up 500 unenqueued rows on its next poll cycles and pushes them to SQS. Workers drain the queue at Stripe's rate. If Stripe rate-limits us (429), workers back off with exponential jitter and retry. No requests are dropped — the queue absorbs the burst.

---

**Q: What is the latency a consumer experiences when calling `POST /payments`? What drives it?**

~10–30ms. It's driven by two synchronous DB writes in one transaction (INSERT payments + INSERT outbox). The consumer is not waiting for the queue, the relay, Stripe, or anything else. The 202 Received is returned as soon as the transaction commits. The actual charge processing happens asynchronously.

---

## Architecture & Trade-offs

**Q: Why does the outbox relay poll the database every 200ms instead of having the API replica enqueue directly to SQS after the transaction?**

Two reasons:

First, correctness. If the API replica enqueues directly after the transaction and crashes between those two steps, the payment exists in the DB but no SQS message exists. The relay has to exist anyway to recover from exactly that crash — which means there are now two enqueue paths, and the relay could enqueue a job that the API already enqueued inline, causing a double-enqueue. One path eliminates that race entirely.

Second, simplicity. The relay is a tight poll loop (~200ms interval), so the latency cost is small. The "proper" upgrade for near-zero latency is CDC (e.g. Debezium reading the Postgres WAL), which pushes inserts to SQS without polling — but that's operationally heavier and only needed if 200ms relay latency becomes the bottleneck.

---

**Q: Why does the Payment Service return 202 Received instead of waiting for the Stripe result and returning 200?**

Decoupling consumer latency from Stripe latency. A Stripe call takes 300–800ms. If the API waited synchronously, every consumer would block for nearly a second on every charge. With 202 Received, the consumer unblocks in ~20ms and moves on. It learns the final result either by polling `GET /payments/:id` or by subscribing to the `PaymentStateChanged` SNS event. The queue also absorbs bursts — the API can accept requests much faster than Stripe can process them.

---

**Q: Is the Reconciliation job an always-running service or a Lambda function? Why?**

A **scheduled Lambda**, triggered by an AWS EventBridge rule every 5 minutes. Not an always-running service.

Reasons:
- The work is inherently periodic — there is nothing to do between invocations. An always-running process would sleep 99% of the time.
- It is fully stateless — no in-memory state is needed between runs. Each invocation queries the DB fresh, calls Stripe, and exits.
- Lambda + EventBridge eliminates idle cost and removes operational overhead: no health checks, no crash recovery process, no scaling config for a sleeping service.
- The only reason to switch to an always-running service would be if the check interval needed to drop below ~1 minute. AWS EventBridge has a minimum cron granularity of 1 minute for Lambda triggers. At 5-minute intervals Lambda is the correct and cost-effective primitive.

**Invocation flow:**
```
EventBridge (every 5 min)
    → Lambda: Reconciliation
        → SELECT payments WHERE status='processing' AND updated_at < now() - 10min
        → For each: stripe.paymentIntents.retrieve(stripe_pi_id)
        → UPDATE payments + publish PaymentStateChanged to SNS
        → Exit
```

---

**Q: A payment is stuck in `processing` for 2 hours. What caused it, and how does your system recover?**

Causes: Stripe is having an incident, the card requires 3DS and the customer never completed it, or a worker crashed after the status was set to `processing` but the Stripe call never actually completed.

Recovery: the Reconciliation Lambda runs every 5 minutes and queries for payments in `processing` older than 10 minutes. For each, it calls `stripe.paymentIntents.retrieve(stripe_pi_id)` and syncs internal status to match:
- Stripe says `succeeded` → update to `succeeded`, publish event
- Stripe says `requires_action` → leave in `processing`, optionally notify consumer
- Stripe says `canceled` or `payment_failed` → update to `failed`, publish event
- Stripe API is down → log and skip, retry next cycle

After a configurable max-age (e.g. 24h), the job auto-cancels the PaymentIntent on Stripe and marks the payment `failed`.

---

**Q: What is `stripe_pi_id`? Who sets it, when, and how?**

`stripe_pi_id` is the Stripe PaymentIntent ID (e.g. `pi_3Nxxx...`) — Stripe's own identifier for a charge attempt. It is the link between our internal `payments` record and the object that lives on Stripe's side.

**Who sets it:** the **Worker**, and only the Worker.

**When:** when the Worker claims a job from the queue and is about to call Stripe. It is `NULL` from the moment the payment row is created until this point.

**How:** the Worker calls `stripe.paymentIntents.create()` first. Stripe responds with a PaymentIntent object that includes the `id` field. The Worker then writes that ID to the DB in the same atomic update that transitions the payment status:

```sql
UPDATE payments
SET status = 'processing', stripe_pi_id = 'pi_3Nxxx...'
WHERE id = $id AND status = 'pending'
```

This update is the optimistic lock — if `status` is no longer `pending` (another worker claimed it first), 0 rows are affected and the Worker aborts.

**Why it matters:** once set, `stripe_pi_id` is used by two other components:
- **Webhook Handler** — Stripe's webhook carries the PaymentIntent ID, not our internal `paymentId`. The handler looks up the internal payment via `WHERE stripe_pi_id = $pi_id` (indexed).
- **Reconciliation Lambda** — calls `stripe.paymentIntents.retrieve(stripe_pi_id)` to fetch the current Stripe state for any payment stuck in `processing`.

Without `stripe_pi_id`, neither the webhook handler nor the Reconciliation Lambda could correlate a Stripe event back to an internal payment.

---

**Q: What happens if we don't receive a notification from Stripe for a while? Who detects it and what does it do?**

The **Reconciliation Lambda** detects it. It runs on a schedule every 5 minutes and queries:

```sql
SELECT * FROM payments
WHERE status = 'processing'
AND updated_at < now() - interval '10 minutes'
```

For each stale payment it finds, it calls `stripe.paymentIntents.retrieve(stripe_pi_id)` directly — bypassing webhooks entirely — and syncs state based on what Stripe returns:

| Stripe status | Action |
|---|---|
| `succeeded` | UPDATE payments SET status=succeeded · append payment_events · publish PaymentStateChanged to SNS |
| `payment_failed` / `canceled` | UPDATE payments SET status=failed · append payment_events · publish PaymentStateChanged to SNS |
| `requires_action` | Leave in `processing` (3DS pending) · optionally notify the consumer to prompt the customer |
| Stripe API unavailable | Log, skip this payment, retry on the next reconciliation cycle |

After a configurable max-age (e.g. 24 hours), the job auto-cancels the PaymentIntent on Stripe and marks the payment `failed` to prevent it from hanging indefinitely.

**Why this matters:** Stripe guarantees at-least-once webhook delivery with retries for up to 3 days — but our service could be down during that window, or the webhook could be lost. The Reconciliation Lambda means no payment can be stuck in `processing` forever regardless of what happens to the webhook delivery. It is the safety net that makes the async design reliable end-to-end.

---

**Q: Why Postgres? What specific features does your design rely on?**

Three specific primitives:

1. **Transactions** — atomically writing `payments` + `outbox` in one commit is the foundation of the outbox pattern. Without atomic writes, there's always a crash window between the two inserts.
2. **`UNIQUE` constraints with conflict handling** — `UNIQUE (consumer_id, idempotency_key)` is the DB-level idempotency guard. `ON CONFLICT DO NOTHING` makes webhook deduplication atomic and lock-free.
3. **`SELECT ... FOR UPDATE SKIP LOCKED`** — a clean primitive for the relay to claim outbox rows for enqueuing without multiple relay instances stepping on each other (relevant if the relay is scaled out).

---

## Failure & Edge Cases

**Q: The Stripe API goes down for 10 minutes. What happens to new charge requests, in-flight jobs, and already-succeeded payments?**

- **New charge requests**: accepted normally. API returns 202 Received, payments land in the queue. Workers attempt Stripe calls, get errors, back off with exponential jitter, and retry. Jobs stay in the queue — nothing is lost.
- **In-flight jobs**: workers retry with backoff until Stripe recovers. SQS visibility timeout keeps jobs visible to workers as long as they keep extending it. After `maxReceiveCount` (5) failures, jobs move to the Dead-Letter Queue for manual inspection.
- **Already-succeeded payments**: completely unaffected. They are in a terminal state in the DB.

---

**Q: A consumer calls `GET /payments/:id` immediately after receiving the 202. The status is `pending`. They panic — is this a bug?**

Not a bug — it is the correct and expected behavior. The 202 Received means "we have durably recorded this request and will process it." `pending` means the payment exists but the worker hasn't started on it yet. The consumer should either poll until a terminal status (`succeeded` or `failed`) or subscribe to the `PaymentStateChanged` SNS event to be notified when processing completes.

---

**Q: Your Reconciliation Lambda calls Stripe and finds a payment succeeded, but your DB still shows `processing`. How did that happen, and what does the job do?**

It happened because the worker called Stripe, Stripe returned `succeeded`, but the worker crashed before writing the status update to the DB. The SQS message was redelivered but the webhook also never arrived (or arrived after reconciliation ran). The Reconciliation Lambda detects this: `processing` for > 10 minutes, calls `stripe.paymentIntents.retrieve()`, sees `succeeded`, updates the DB to `succeeded`, appends to `payment_events`, and publishes a `PaymentStateChanged` event to SNS. Downstream services are notified as if the webhook had arrived normally.

---

**Q: What happens after the webhook handler receives a `payment_intent.succeeded` event from Stripe? Who gets notified and what do they do?**

The handler runs a 5-step pipeline:

1. **Deduplicate** — insert `stripe_event_id` into `stripe_webhook_events`. If conflict → already processed → stop.
2. **Resolve** — look up the internal payment by `stripe_pi_id`.
3. **Update status** — write `succeeded` to `payments`, append to `payment_events` audit log.
4. **Publish** — emit a `PaymentStateChanged` event to SNS/EventBridge with the payment ID, consumer ID, old/new status, amount, and timestamp.
5. **Return 200** to Stripe so it doesn't retry.

SNS fans the event out to all subscribers. Each service owns its own SQS queue subscribed to the SNS topic, filters by `consumerId`, and acts only on its own payments:

| Subscriber | Listens for | Action |
|---|---|---|
| `llc-service` | `succeeded` | Mark order as paid, trigger formation flow |
| `llc-service` | `failed` | Notify customer, cancel or retry order |
| `mortgage-service` | `succeeded` | Record payment on loan ledger, update next due date |
| `mortgage-service` | `failed` | Flag as past-due, trigger collections flow |
| Notifications service | `succeeded` / `failed` | Send email/SMS to end customer |
| Finance / audit service | all events | Append to immutable ledger |

The Payment Service has no knowledge of who is subscribed or what they do — it publishes once to SNS and fan-out is SNS's job. Each subscriber is responsible for its own SQS queue, DLQ, retry policy, and idempotency (SNS/SQS is at-least-once, so the same event may arrive twice).

Note: the **Worker does not publish** final-state events. It only transitions the payment to `processing`. The Webhook Handler is the sole publisher of `succeeded`/`failed` events (deduplicated by `stripe_event_id`). The Reconciliation Lambda publishes as a fallback if the Stripe webhook is never delivered.
