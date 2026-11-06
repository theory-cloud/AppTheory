import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

/**
 * Records the S3 event notification record the local runner delivers to a
 * Lambda destination. The receipt is a real SQS message, so the row observes
 * the handler effect rather than an engine counter. Every documented record
 * field the notification carries is passed through:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html
 */
export const handler = async (event) => {
    const record = event?.Records?.[0];
    if (record?.eventSource !== "aws:s3") {
        throw new Error("s3-consumer expects an aws:s3 record");
    }
    if (!process.env.RECEIPT_QUEUE_URL) {
        throw new Error("RECEIPT_QUEUE_URL must be configured");
    }
    const s3 = record.s3 ?? {};
    const object = s3.object ?? {};
    const receipt = {
        eventVersion: record.eventVersion,
        eventSource: record.eventSource,
        awsRegion: record.awsRegion,
        eventTime: record.eventTime,
        eventName: record.eventName,
        bucket: s3.bucket?.name,
        bucketArn: s3.bucket?.arn,
        key: object.key,
        size: object.size,
        eTag: object.eTag,
        sequencer: object.sequencer,
        configurationId: s3.configurationId,
        requestId: record.responseElements?.["x-amz-request-id"],
    };
    await sqs.send(
        new SendMessageCommand({
            QueueUrl: process.env.RECEIPT_QUEUE_URL,
            MessageBody: JSON.stringify(receipt),
        }),
    );
    return { ok: true, eventName: receipt.eventName, key: receipt.key };
};
