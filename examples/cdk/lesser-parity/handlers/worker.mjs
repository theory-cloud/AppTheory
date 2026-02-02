/**
 * SQS Queue Worker handler.
 *
 * Processes messages from the events queue and writes to DynamoDB.
 * Demonstrates SQS consumer wiring with batch item failure reporting.
 */
export const handler = async (event) => {
    const tableName = process.env.TABLE_NAME || "unknown";
    const queueUrl = process.env.QUEUE_URL || "unknown";

    const batchItemFailures = [];
    const processedRecords = [];

    for (const record of event.Records || []) {
        try {
            const body = JSON.parse(record.body);
            processedRecords.push({
                messageId: record.messageId,
                body,
                timestamp: new Date().toISOString(),
            });
            console.log(`Processed message ${record.messageId}:`, body);
        } catch (error) {
            console.error(`Failed to process message ${record.messageId}:`, error.message);
            batchItemFailures.push({
                itemIdentifier: record.messageId,
            });
        }
    }

    console.log({
        handler: "lesser-parity-worker",
        tableName,
        queueUrl,
        recordsReceived: (event.Records || []).length,
        recordsProcessed: processedRecords.length,
        recordsFailed: batchItemFailures.length,
    });

    // Return batch item failures for partial batch failure reporting
    return {
        batchItemFailures,
    };
};
