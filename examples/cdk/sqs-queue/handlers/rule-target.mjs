import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

/**
 * Records the input an EventBridge rule delivered. The receipt is a real SQS
 * message, so the harness observes the handler effect rather than an engine
 * counter.
 */
export const handler = async (event) => {
  const queueUrl = process.env.RECEIPT_QUEUE_URL;
  if (!queueUrl) throw new Error("RECEIPT_QUEUE_URL must be configured");
  const receipt = { kind: process.env.RECEIPT_KIND ?? "static", received: event };
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(receipt) }));
  return { ok: true };
};
