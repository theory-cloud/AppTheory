import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient();
const queueUrl = process.env.QUEUE_URL;

/**
 * Producer Lambda that sends messages to the SQS queue.
 * Demonstrates the "queue-only" pattern where the queue is used
 * for message production without a co-located consumer.
 */
export const handler = async (event) => {
    const body = JSON.parse(event.body || "{}");

    const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
            timestamp: new Date().toISOString(),
            eventType: body.eventType || "unknown",
            payload: body.payload || {},
        }),
    });

    const response = await sqs.send(command);

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "Message sent to queue",
            messageId: response.MessageId,
        }),
    };
};
