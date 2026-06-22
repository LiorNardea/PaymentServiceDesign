/**
 * Outbox relay — the only component that enqueues jobs into SQS.
 *
 * Design contract (from design/data-model.md):
 *   - The HTTP handler writes payments + outbox rows atomically, then returns 202.
 *   - The relay polls `outbox WHERE enqueued_at IS NULL` every POLL_MS milliseconds.
 *   - For each unprocessed row it calls queue.enqueue(), then marks the row as done.
 *   - This is the ONLY enqueue path — payment-service.ts never calls queue.enqueue() directly.
 *
 * Why this matters: if the process crashes between the DB write and an inline enqueue,
 * the payment would be stuck in `pending` forever with nothing processing it. Since the
 * outbox row survives the crash, the relay picks it up on the next poll and enqueues it.
 */
import { db } from './db';
import { queue } from './queue';

const POLL_MS = 200;

let running = false;

export function startOutboxRelay(): void {
  if (running) return;
  running = true;
  void pollLoop();
  console.log(`[outbox-relay] started, polling every ${POLL_MS}ms`);
}

export function stopOutboxRelay(): void {
  running = false;
}

async function pollLoop(): Promise<void> {
  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error('[outbox-relay] poll error:', err);
    }
    await sleep(POLL_MS);
  }
}

async function tick(): Promise<void> {
  const entries = await db.getPendingOutboxEntries();
  if (entries.length === 0) return;

  await Promise.all(
    entries.map(async (entry) => {
      try {
        const payload = entry.payload as { type: 'charge' | 'refund'; paymentId: string };
        await queue.enqueue(payload.paymentId, payload.type);
        await db.markOutboxEnqueued(entry.id);
        console.log(`[outbox-relay] enqueued ${payload.paymentId} (${payload.type})`);
      } catch (err) {
        console.error(`[outbox-relay] failed to enqueue outbox entry ${entry.id}:`, err);
        // Leave enqueued_at NULL so the next poll retries it
      }
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
