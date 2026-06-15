/**
 * In-process queue stub standing in for SQS / RabbitMQ.
 * In production: push to SQS, workers poll with long-polling and visibility timeouts.
 */
import { QueueJob } from './types';
import { ulid } from 'ulid';

type JobHandler = (job: QueueJob) => Promise<void>;

class InProcessQueue {
  private jobs: QueueJob[] = [];
  private handler?: JobHandler;
  private processing = false;

  enqueue(paymentId: string, type: QueueJob['type']): void {
    const job: QueueJob = {
      jobId: ulid(),
      paymentId,
      type,
      enqueuedAt: new Date(),
      attempts: 0,
    };
    this.jobs.push(job);
    // kick the loop without awaiting — fire and forget
    void this.drain();
  }

  registerHandler(fn: JobHandler): void {
    this.handler = fn;
  }

  private async drain(): Promise<void> {
    if (this.processing || !this.handler || this.jobs.length === 0) return;
    this.processing = true;

    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      job.attempts++;
      try {
        await this.handler(job);
      } catch (err) {
        console.error(`[queue] job ${job.jobId} failed (attempt ${job.attempts}):`, err);
        if (job.attempts < 3) {
          // re-enqueue with backoff
          setTimeout(() => this.jobs.push(job), job.attempts * 1000);
        } else {
          console.error(`[queue] job ${job.jobId} exhausted retries — dropping`);
        }
      }
    }

    this.processing = false;
  }
}

export const queue = new InProcessQueue();
