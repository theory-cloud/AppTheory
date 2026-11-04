import {
    GetTopicAttributesCommand,
    PublishCommand,
    SNSClient,
} from "@aws-sdk/client-sns";

const sns = new SNSClient({});

/**
 * Publishes to the stack's standard and FIFO SNS topics through the real AWS
 * SDK. The local runner provisions the topics on moto, observes each publish
 * and performs the subscription fan-out itself.
 *
 * The FIFO publish set proves ordering and deduplication:
 *   - three messages in one message group with explicit deduplication ids;
 *   - two identical bodies with no deduplication id, which the topic's
 *     ContentBasedDeduplication setting must collapse to one delivery.
 */
export const handler = async () => {
    const standardTopicArn = process.env.TOPIC_ARN;
    const fifoTopicArn = process.env.FIFO_TOPIC_ARN;
    if (!standardTopicArn || !fifoTopicArn) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "TOPIC_ARN and FIFO_TOPIC_ARN must be configured" }),
        };
    }

    const standardPublish = await sns.send(
        new PublishCommand({
            TopicArn: standardTopicArn,
            Message: JSON.stringify({ eventType: "local-sns-publish", n: 1 }),
            Subject: "local standard publish",
            MessageAttributes: {
                eventType: { DataType: "String", StringValue: "local-sns-publish" },
            },
        }),
    );

    const ordered = [];
    for (let n = 1; n <= 3; n += 1) {
        const published = await sns.send(
            new PublishCommand({
                TopicArn: fifoTopicArn,
                Message: JSON.stringify({ eventType: "local-sns-fifo", n }),
                MessageGroupId: "local-group",
                MessageDeduplicationId: `local-dedup-${n}`,
            }),
        );
        ordered.push(published.MessageId);
    }
    const contentBody = JSON.stringify({ eventType: "local-sns-fifo", contentBased: true });
    const contentFirst = await sns.send(
        new PublishCommand({
            TopicArn: fifoTopicArn,
            Message: contentBody,
            MessageGroupId: "cbd-group",
        }),
    );
    const contentSecond = await sns.send(
        new PublishCommand({
            TopicArn: fifoTopicArn,
            Message: contentBody,
            MessageGroupId: "cbd-group",
        }),
    );

    const standard = await sns.send(new GetTopicAttributesCommand({ TopicArn: standardTopicArn }));
    const fifo = await sns.send(new GetTopicAttributesCommand({ TopicArn: fifoTopicArn }));

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "published to the standard and FIFO SNS topics",
            standard: {
                topicArn: standard.Attributes?.TopicArn,
                expectedArn: standardTopicArn,
                expectedName: process.env.TOPIC_NAME,
                fifoTopic: standard.Attributes?.FifoTopic === "true",
                messageId: standardPublish.MessageId,
            },
            fifo: {
                topicArn: fifo.Attributes?.TopicArn,
                expectedArn: fifoTopicArn,
                expectedName: process.env.FIFO_TOPIC_NAME,
                fifoTopic: fifo.Attributes?.FifoTopic === "true",
                contentBasedDeduplication: fifo.Attributes?.ContentBasedDeduplication === "true",
                orderedMessageIds: ordered,
                contentBasedMessageIds: [contentFirst.MessageId, contentSecond.MessageId],
                contentBody,
                queueArn: process.env.FIFO_QUEUE_ARN,
            },
        }),
    };
};
