/**
 * Real SQS-backed queue (via LocalStack locally, or real AWS in production).
 * Replaces the previous in-memory array — see design/architecture.md and
 * design/failure-modes.md for why durability requires this to be external
 * to the Node process, not held in process memory.
 */
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { QueueJob } from './types';
import { ulid } from 'ulid';

const QUEUE_URL =
  process.env.SQS_QUEUE_URL ??
  'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/payment-charge-queue';

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

type JobHandler = (job: QueueJob) => Promise<void>;

class SqsQueue {
  private handler?: JobHandler;
  private polling = false;

  async enqueue(paymentId: string, type: QueueJob['type']): Promise<void> {
    const job: QueueJob = {
      jobId: ulid(),
      paymentId,
      type,
      enqueuedAt: new Date(),
      attempts: 0,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(job),
      }),
    );
  }

  registerHandler(fn: JobHandler): void {
    this.handler = fn;
  }

  /**
   * Long-running poll loop. Mirrors real SQS semantics:
   * - ReceiveMessage makes the message invisible (VisibilityTimeout), not deleted.
   * - DeleteMessage only happens after the handler completes successfully.
   * - If the handler throws (or the process crashes before deleting), the message
   *   becomes visible again once the visibility timeout expires — SQS retries it
   *   automatically, with zero custom retry code required here.
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const res = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: QUEUE_URL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5, // long polling
            VisibilityTimeout: 30,
          }),
        );

        const messages = res.Messages ?? [];
        await Promise.all(messages.map((m) => this.handleMessage(m)));
      } catch (err) {
        console.error('[queue] poll error:', err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!this.handler || !message.Body || !message.ReceiptHandle) return;

    let job: QueueJob;
    try {
      job = JSON.parse(message.Body);
    } catch {
      console.error('[queue] malformed message body, dropping:', message.Body);
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }

    try {
      await this.handler(job);
      // Only delete after the handler succeeds — this is what makes a crash
      // mid-processing safe: the message stays in the queue and becomes
      // visible again for retry.
      await this.deleteMessage(message.ReceiptHandle);
    } catch (err) {
      console.error(`[queue] job ${job.jobId} failed, leaving for redelivery:`, err);
      // Deliberately do NOT delete — let the visibility timeout expire so
      // SQS redelivers it. No custom retry/backoff logic needed here.
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }),
    );
  }

  stopPolling(): void {
    this.polling = false;
  }
}

export const queue = new SqsQueue();
