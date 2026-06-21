#!/bin/bash
# Creates the SQS queue + a dead-letter queue against a local LocalStack instance.
# Run once after LocalStack is up: ./scripts/setup-queue.sh
set -euo pipefail

ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"

echo "Creating dead-letter queue..."
DLQ_RESPONSE=$(curl -s -X POST "$ENDPOINT/" \
  -H "Content-Type: application/x-amz-json-1.0" \
  -H "X-Amz-Target: AmazonSQS.CreateQueue" \
  -d '{"QueueName":"payment-charge-queue-dlq"}')
echo "$DLQ_RESPONSE"

DLQ_ARN="arn:aws:sqs:us-east-1:000000000000:payment-charge-queue-dlq"

echo "Creating main queue with redrive policy (maxReceiveCount=5)..."
curl -s -X POST "$ENDPOINT/" \
  -H "Content-Type: application/x-amz-json-1.0" \
  -H "X-Amz-Target: AmazonSQS.CreateQueue" \
  -d "{\"QueueName\":\"payment-charge-queue\",\"Attributes\":{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}}"

echo ""
echo "Done. Queue: payment-charge-queue, DLQ: payment-charge-queue-dlq"
