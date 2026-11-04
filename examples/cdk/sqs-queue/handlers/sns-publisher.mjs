import {
    GetTopicAttributesCommand,
    PublishCommand,
    SNSClient,
} from "@aws-sdk/client-sns";

const sns = new SNSClient({});

/**
 * Publishes to the stack's standard and FIFO SNS topics through the real AWS
 * SDK. The local runner provisions the topics on moto; the subscriptions are
 * registered with the delivery engine (E6 supplies the deliverer).
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
            MessageAttributes: {
                eventType: { DataType: "String", StringValue: "local-sns-publish" },
            },
        }),
    );
    const fifoPublish = await sns.send(
        new PublishCommand({
            TopicArn: fifoTopicArn,
            Message: JSON.stringify({ eventType: "local-sns-fifo", n: 1 }),
            MessageGroupId: "local-group",
            MessageDeduplicationId: "local-dedup-1",
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
                messageId: fifoPublish.MessageId,
                queueArn: process.env.FIFO_QUEUE_ARN,
            },
        }),
    };
};
