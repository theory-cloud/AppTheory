/**
 * DLQ Handler Lambda that processes failed messages from the Dead Letter Queue.
 * Used for debugging, alerting, or manual retry workflows.
 */
export const handler = async (event) => {
    console.log(`Processing ${event.Records.length} DLQ records`);

    for (const record of event.Records) {
        try {
            const body = JSON.parse(record.body);
            console.log(`DLQ message: ${record.messageId}`, {
                body,
                approximateReceiveCount: record.attributes?.ApproximateReceiveCount,
                sentTimestamp: record.attributes?.SentTimestamp,
                approximateFirstReceiveTimestamp: record.attributes?.ApproximateFirstReceiveTimestamp,
            });

            // In production, you might:
            // 1. Log to CloudWatch with detailed debugging info
            // 2. Send alerts (SNS, PagerDuty, Slack, etc.)
            // 3. Store in S3 for later analysis
            // 4. Push to a retry topic with backoff
            // 5. Update a dashboard/metric

            console.log(`DLQ record processed: ${record.messageId}`);
        } catch (error) {
            console.error(`Failed to process DLQ record: ${record.messageId}`, error);
            // DLQ handlers typically shouldn't fail - log and continue
        }
    }

    // DLQ handlers typically return success to remove messages from DLQ
    return { batchItemFailures: [] };
};
