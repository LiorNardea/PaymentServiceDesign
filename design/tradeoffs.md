# Tradeoffs

## Decision 1: Fast Acknowledgement vs. Immediate Outcome ("Received" vs. "Approved/Declined")

**The core trade-off**: we consciously split the response into two separate moments:
- **Received** (~20ms) — `202 Received` + `paymentId`. "We have your request, it will be processed." This is what the HTTP response confirms.
- **Approved / Declined** (1–6s later) — the final outcome, delivered via SNS event (`PaymentStateChanged`) or poll (`GET /payments/:id`).

Callers get a fast, reliable acknowledgement immediately. They learn the outcome asynchronously. We prioritized **fast acknowledgement over immediate outcome**.

**What I chose**: The HTTP handler returns `202 Received` with a `paymentId` immediately. The actual Stripe call happens asynchronously via a worker queue.

**What I rejected**: Making the HTTP call wait for the Stripe response before returning a `200 OK` with the final charge result.

**Why**:
- Stripe can take 1–5 seconds under load. Holding HTTP connections open for 500 concurrent requests during a burst creates a thundering-herd problem — threads blocked on Stripe, connection pool exhausted, new requests timing out.
- The queue provides natural flow control and burst absorption. Callers don't need to hold a connection open for the duration of a Stripe call.
- This is how real-world payment systems work — ACH, PayPal, and Stripe's own async payment intents all use the same two-moment model. Callers in fintech already understand "received ≠ approved."

**What I gave up**:
- **Simplicity.** A synchronous design is much easier to reason about: call Stripe, get an answer, return it. One moment, not two.
- **Immediate outcome.** Callers must be designed to handle two moments — received and approved/declined — and must not take irreversible business actions (send a receipt, provision a service) between them. This adds complexity to every consumer.
- **Latency for small loads.** When there is no burst, the async path adds an unnecessary relay hop (~200ms) before any Stripe call happens.

**When I'd reconsider**: if Stripe were fast and reliable (< 200ms p99) and traffic were smooth and predictable, the synchronous design is simpler and arguably better — one moment is easier for callers to handle than two. For burst-heavy fintech workloads, the two-moment model is worth the added consumer complexity.

---

## Decision 2: Transactional Outbox vs. Direct Queue Enqueue

**What I chose**: Write to the `outbox` table in the same DB transaction as the `payments` insert. A relay process reads unprocessed outbox rows and enqueues them.

**What I rejected**: Calling SQS/AMQP `SendMessage` directly from the HTTP handler after the DB insert.

**Why I chose outbox**:
- Atomicity. If the process crashes between the DB write and the queue publish, the payment row exists but the job is never processed — silent data loss.
- The outbox row is written atomically with the payment row; even after a crash, the relay reads it and enqueues it.

**What I gave up**:
- Operational complexity. The outbox relay is another moving part that must run reliably. It needs its own retry logic, monitoring, and latency budget.
- Slight increased latency. Instead of enqueuing inline, there's a relay polling cycle (typically < 1s, but not zero).

**Alternative I seriously considered**: Two-phase approach — write payment row with status `pending`, return the ID, then enqueue synchronously in the HTTP handler, and if the enqueue fails, mark the payment as `enqueue_failed` and have a sweeper recover it. This is simpler but has a short window where the payment is `pending` without a job in the queue. The outbox pattern closes this window more cleanly.

---

## Decision 3: DB-Level Idempotency Key vs. Application-Level Check

**What I chose**: A `UNIQUE (consumer_id, idempotency_key)` constraint in Postgres as the primary idempotency guard.

**What I rejected**: Checking "does this idempotency key exist?" in application code before inserting.

**Why I chose DB constraint — mutual exclusion**:

The DB `UNIQUE` constraint provides **mutual exclusion** at the storage engine level. The engine enforces uniqueness atomically as part of the `INSERT` operation itself, inside the transaction. This means two concurrent requests with the same key cannot both succeed — regardless of how many application processes or threads are running. One wins, one gets a conflict error. There is no window between check and write.

The application-level alternative — read-then-write — has a classic **TOCTOU (Time Of Check, Time Of Use)** race:
```
Thread A: SELECT → "not found"
Thread B: SELECT → "not found"   ← both read before either writes
Thread A: INSERT → succeeds
Thread B: INSERT → also succeeds  ← duplicate payment row, potential double charge
```

The DB constraint collapses this to a single atomic operation. The engine is the mutex — no application-level locking, no distributed lock (Redis `SETNX`), no coordination between service instances needed.

**What the application does on conflict:**
```
try {
  INSERT INTO payments (consumer_id, idempotency_key, ...)
} catch (UniqueConstraintError) {
  SELECT * FROM payments WHERE consumer_id = ? AND idempotency_key = ?
  → return existing row with current status   // idempotent response
}
```

**What I gave up**:
- Transparency. A unique constraint violation is a blunt error; the handler must catch it and distinguish "idempotency duplicate" from other constraint violations (e.g. a foreign key error).
- Multi-region portability. This mutual exclusion relies on a single shared Postgres primary. In a distributed multi-region setup without a shared DB, a different approach is needed — e.g. a dedicated idempotency store (Redis `SETNX` with a TTL, or a global DynamoDB conditional write). The DB constraint is the right choice here because we already have a single shared Postgres instance as the source of truth.

---

## Decision 4: One Centralized Payment Service vs. Each Service Calling Stripe Directly

**What I chose**: A dedicated Payment Service; consumers call it via REST.

**What I rejected**: Each internal service integrating with Stripe SDK independently.

**Why I chose centralized**:
- Single place to manage Stripe credentials, API version pinning, webhook secrets.
- Idempotency, retry logic, and state tracking implemented once, not duplicated.
- Compliance surface area: PCI scope is limited to the Payment Service only.
- Easier to swap processors (Stripe → Adyen) without touching every consumer.

**What I gave up**:
- Coupling risk. All payment traffic flows through one service. If it goes down, nothing can charge customers. Mitigated by redundancy (multiple instances, queue durability), but the blast radius is larger than a distributed approach.
- Latency. An extra network hop for every payment. Typically < 5ms on an internal network — acceptable.

---

## Decision 5: Push (Events) + Pull (Polling) vs. Either Alone

**What I chose**: Both. Consumers can poll `GET /payments/:id` and also subscribe to SNS events.

**What I rejected**: Events-only or polling-only.

**Why both**:
- Events alone: what if a consumer misses an event while it's down? It would never know the payment settled. Polling is the recovery mechanism.
- Polling alone: consumers must implement timers and backoff. For long-settling payments (minutes), polling every second is wasteful and adds load.
- Together: events for low-latency notification in the happy path; polling as the fallback and for consumers who don't need real-time notification.

**What I gave up**:
- Two integration paths to maintain. Consumers must choose and implement one (or both).
- Operational complexity: the event bus (SNS + SQS per consumer) must be provisioned and monitored.

---

## Decision 6: Idempotency Key Ownership — Trust Callers vs. Enforce via SDK

**The dilemma**: the Payment Service requires callers to supply an idempotency key derived from a stable business ID (e.g. `llc-service:charge:ord-123`). If a caller accidentally generates a random UUID on every attempt, the Payment Service cannot detect it — each retry looks like a new request, and the customer gets charged multiple times. The Payment Service cannot know the caller's business logic well enough to validate the key's stability.

**What I chose**: trust internal callers + publish an internal SDK.

The Payment Service enforces two things it *can* enforce:
1. The key is **present** — `400` if missing
2. The key is **scoped per consumer** — `UNIQUE(consumer_id, idempotency_key)` prevents cross-service collisions

Whether the key is *correctly derived* is delegated to the caller — but mitigated by providing an internal SDK that owns the derivation:

```ts
// Caller cannot get key derivation wrong
paymentClient.charge({ orderId: 'ord-123', amount: 5000 });
// SDK derives internally: "llc-service:charge:ord-123"
```

**What I rejected**: building server-side heuristics to detect unstable keys (e.g. flagging two requests with the same amount/customer/description but different keys within a short window). This would require the Payment Service to understand each caller's business semantics — which it explicitly does not. The heuristic would produce false positives and add complexity for a problem better solved at the integration layer.

**Why trust is reasonable here**: callers are internal services owned by the same engineering organization, not external third parties. The contract is documented, code-reviewed when callers integrate, and enforced structurally by the SDK. This is the same model Stripe uses — they document the idempotency key convention and trust their customers to follow it.

**What I gave up**:
- A caller that ignores the SDK and calls the REST API directly with a random key will silently produce duplicate charges. There is no server-side safety net for this case.
- The SDK must be maintained and kept in sync with the API as it evolves — another artifact to own.

**When I'd reconsider**: if the Payment Service were exposed to external third-party developers (not just internal services), trust alone would be insufficient. In that case, a short-lived server-side idempotency token — issued by the Payment Service and passed back by the caller — would shift key generation to the server and remove the derivation burden from the caller entirely.
