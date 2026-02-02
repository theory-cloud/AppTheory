/**
 * Worker Lambda that processes messages from the SQS queue.
 * Demonstrates partial batch failure reporting.
 */
export const handler = async (event) => {
    console.log(`Processing ${event.Records.length} records`);

    const batchItemFailures = [];

    for (const record of event.Records) {
        try {
            const body = JSON.parse(record.body);
            console.log(`Processing message: ${record.messageId}`, body);

            // Simulate processing
            if (body.shouldFail) {
                throw new Error(`Simulated failure for message: ${record.messageId}`);
            }

            // Process successfully
            console.log(`Successfully processed: ${record.messageId}`);
        } catch (error) {
            console.error(`Failed to process: ${record.messageId}`, error);

            // Report this item as failed (for partial batch failures)
            batchItemFailures.push({
                itemIdentifier: record.messageId,
            });
        }
    }

    // Return partial batch failure response
    return { batchItemFailures };
};
