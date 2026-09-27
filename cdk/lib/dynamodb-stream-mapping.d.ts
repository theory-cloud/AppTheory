import type { Duration } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryDynamoDBStreamMappingProps {
    readonly consumer: lambda.Function;
    readonly table: dynamodb.ITable;
    readonly startingPosition?: lambda.StartingPosition;
    readonly batchSize?: number;
    readonly bisectBatchOnError?: boolean;
    readonly parallelizationFactor?: number;
    readonly retryAttempts?: number;
    readonly maxBatchingWindow?: Duration;
    readonly maxRecordAge?: Duration;
    readonly reportBatchItemFailures?: boolean;
    /**
     * Destination for the records Lambda discards after retries are exhausted or `maxRecordAge` elapses.
     *
     * Pass an event source DLQ, such as `new lambdaEventSources.SqsDlq(queue)` or
     * `new lambdaEventSources.SnsDlq(topic)`. Binding that DLQ grants the consumer role exactly the
     * permission the destination needs (`sqs:SendMessage` or `sns:Publish`); an Amazon S3 bucket
     * (`new lambdaEventSources.S3OnFailureDestination(bucket)`) is also supported.
     *
     * The destination receives metadata about the discarded batch, not the records themselves: the
     * shard ID and sequence numbers identify records to re-read from the stream while they are still
     * inside the stream retention window. It only receives anything once retries are exhausted or
     * `maxRecordAge` is exceeded, so a mapping that leaves both unbounded (the AWS Lambda default is
     * `-1`, retry until the record expires) has nothing to send. Pair this prop with a bounded
     * `retryAttempts` and `bisectBatchOnError: true` so a poison record is retained for repair instead
     * of blocking its shard.
     *
     * @default - discarded records are dropped
     */
    readonly onFailure?: lambda.IEventSourceDlq;
}
export declare class AppTheoryDynamoDBStreamMapping extends Construct {
    constructor(scope: Construct, id: string, props: AppTheoryDynamoDBStreamMappingProps);
}
