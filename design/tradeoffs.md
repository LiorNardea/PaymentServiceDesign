# Tradeoffs

## Decision 1: Synchronous Acknowledgement + Async Processing vs. Fully Synchronous

**What I chose**: The HTTP handler returns `202 Accepted` with a `paymentId` immediately. The actual Stripe call happens asynchronously via a worker queue.

**What I rejected**: Making the HTTP call wait for the Stripe response before returning.

**Why I chose async**:
- Stripe can take 1–5 seconds under load; holding HTTP connections open for 500 concurrent requests during burst creates a thundering-herd problem.
- Queue provides natural flow control and retry without burdening the API tier.
- Consumers can poll or subscribe to events; they don't need to hold a connection open.

**What I gave up**:
- Simplicity. A synchronous design is much easier to reason about. You call Stripe, you get an answer, you return it.
- Immediate feedback. The consumer gets `pending` and must handle async state. This adds complexity to consumer code.
- Latency for small loads. When there's no burst, the async path adds unnecessary roundtrips.

**When I'd reconsider**: if Stripe were fast and reliable (< 200ms p99) and the traffic pattern were smooth, I'd go fully synchronous. For burst-heavy fintech workloads, async is worth the complexity.

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

**Why I chose DB constraint**:
- Races. Two concurrent requests with the same key arrive simultaneously. An application-level read-then-write has a TOCTOU window; both reads return "not found" and both inserts proceed. The DB constraint collapses this to a single winner with a conflict error.
- Simplicity. No locking, no distributed mutex, no Redis-based lock. The DB handles it.

**What I gave up**:
- Transparency. A unique constraint violation is a blunt error; the handler must catch and distinguish "idempotency duplicate" from other errors.
- Coupling. The idempotency logic is tied to the DB schema. If I wanted to support idempotency across a distributed multi-region setup without a shared DB, I'd need a different approach (e.g., a dedicated idempotency store like Redis with `SETNX`).

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
