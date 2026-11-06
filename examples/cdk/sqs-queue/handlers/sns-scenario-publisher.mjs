import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

/**
 * Publishes one scenario's messages through the real SNS SDK. The harness
 * passes the topic environment name and the messages; every publish is a real
 * SDK call to moto, so the runner observes it on the same path as a handler
 * publish.
 */
export const handler = async (event) => {
    const topicArn = process.env[event.topicEnv];
    if (!topicArn) {
        throw new Error(`topic environment ${event.topicEnv} is not configured`);
    }
    const messageIds = [];
    for (const message of event.messages ?? []) {
        const input = {
            TopicArn: topicArn,
            Message: message.message,
        };
        if (message.subject) {
            input.Subject = message.subject;
        }
        if (message.messageAttributes) {
            input.MessageAttributes = message.messageAttributes;
        }
        if (message.messageGroupId) {
            input.MessageGroupId = message.messageGroupId;
        }
        if (message.messageDeduplicationId) {
            input.MessageDeduplicationId = message.messageDeduplicationId;
        }
        const published = await sns.send(new PublishCommand(input));
        messageIds.push(published.MessageId);
    }
    return {
        statusCode: 200,
        body: JSON.stringify({ topicEnv: event.topicEnv, messageIds }),
    };
};
