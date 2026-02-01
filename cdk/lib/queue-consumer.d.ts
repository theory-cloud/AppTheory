import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
/**
 * Properties for AppTheoryQueueConsumer construct.
 */
export interface AppTheoryQueueConsumerProps {
    /**
     * The SQS queue to consume messages from.
     */
    readonly queue: sqs.IQueue;
    /**
     * The Lambda function that will process messages.
     */
    readonly consumer: lambda.IFunction;
    /**
     * The maximum number of records to retrieve per batch.
     * @default 10
     */
    readonly batchSize?: number;
    /**
     * The maximum amount of time to wait for a batch to be gathered.
     * @default - No batching window (messages processed immediately)
     */
    readonly maxBatchingWindow?: Duration;
    /**
     * Whether to report batch item failures.
     * When enabled, the function should return a partial failure response.
     * @default false
     */
    readonly reportBatchItemFailures?: boolean;
    /**
     * The maximum concurrency setting limits the number of concurrent instances of the function.
     * Valid range: 2-1000.
     * @default - No concurrency limit
     */
    readonly maxConcurrency?: number;
    /**
     * Whether the event source mapping is enabled.
     * @default true
     */
    readonly enabled?: boolean;
    /**
     * Whether to automatically grant consume permissions to the Lambda function.
     * @default true
     */
    readonly grantConsumeMessages?: boolean;
    /**
     * Optional filters to control which messages trigger the Lambda.
     * @default - All messages trigger the Lambda
     */
    readonly filters?: lambda.FilterCriteria[];
}
/**
 * A composable SQS consumer construct that wires a Lambda function to an SQS queue.
 *
 * This construct creates an event source mapping between an SQS queue and a Lambda function,
 * with full control over batching, concurrency, and failure reporting.
 *
 * @example
 * // Basic consumer with default settings
 * new AppTheoryQueueConsumer(stack, 'Consumer', {
 *   queue: myQueue.queue,
 *   consumer: myFunction,
 * });
 *
 * @example
 * // Consumer with full configuration
 * new AppTheoryQueueConsumer(stack, 'Consumer', {
 *   queue: myQueue.queue,
 *   consumer: myFunction,
 *   batchSize: 100,
 *   maxBatchingWindow: Duration.seconds(10),
 *   reportBatchItemFailures: true,
 *   maxConcurrency: 50,
 * });
 */
export declare class AppTheoryQueueConsumer extends Construct {
    /**
     * The event source mapping.
     */
    readonly eventSourceMapping: lambda.EventSourceMapping;
    /**
     * The consumer Lambda function.
     */
    readonly consumer: lambda.IFunction;
    /**
     * The SQS queue being consumed.
     */
    readonly queue: sqs.IQueue;
    constructor(scope: Construct, id: string, props: AppTheoryQueueConsumerProps);
    /**
     * Disable the event source mapping.
     * This can be used for circuit breaker patterns.
     */
    disable(): void;
}
