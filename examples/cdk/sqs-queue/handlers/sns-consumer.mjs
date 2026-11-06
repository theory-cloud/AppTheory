import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

/**
 * Records the SNS Lambda record the local runner delivers. The receipt is a
 * real SQS message, so the harness observes the handler effect rather than an
 * engine counter. Every documented Lambda SNS record field is carried through.
 */
export const handler = async (event) => {
    const record = event?.Records?.[0];
    if (record?.EventSource !== "aws:sns") {
        throw new Error("sns-consumer expects an aws:sns record");
    }
    if (!process.env.RECEIPT_QUEUE_URL) {
        throw new Error("RECEIPT_QUEUE_URL must be configured");
    }
    const sns = record.Sns ?? {};
    const receipt = {
        kind: process.env.RECEIPT_KIND ?? "event",
        eventSource: record.EventSource,
        eventVersion: record.EventVersion,
        eventSubscriptionArn: record.EventSubscriptionArn,
        type: sns.Type,
        messageId: sns.MessageId,
        topicArn: sns.TopicArn,
        subject: sns.Subject,
        message: sns.Message,
        timestamp: sns.Timestamp,
        signatureVersion: sns.SignatureVersion,
        unsubscribeUrl: sns.UnsubscribeUrl,
        messageAttributes: sns.MessageAttributes ?? {},
    };
    await sqs.send(
        new SendMessageCommand({
            QueueUrl: process.env.RECEIPT_QUEUE_URL,
            MessageBody: JSON.stringify(receipt),
        }),
    );
    return { ok: true, kind: receipt.kind, messageId: receipt.messageId };
};
