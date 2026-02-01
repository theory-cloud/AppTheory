import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { AppTheoryQueue } from "./queue";
import { AppTheoryQueueConsumer } from "./queue-consumer";

/**
 * Properties for the AppTheoryQueueProcessor construct.
 *
 * This construct maintains backwards compatibility with the original API
 * while leveraging the new composable AppTheoryQueue and AppTheoryQueueConsumer constructs.
 */
export interface AppTheoryQueueProcessorProps {
  /**
   * The Lambda function that will consume messages from the queue.
   */
  readonly consumer: lambda.IFunction;

  /**
   * Properties for the underlying SQS queue.
   * @deprecated Use queueName, visibilityTimeout, and other specific props instead
   */
  readonly queueProps?: sqs.QueueProps;

  /**
   * The name of the queue.
   * @default - CloudFormation-generated name
   */
  readonly queueName?: string;

  /**
   * The visibility timeout for messages in the queue.
   * @default Duration.seconds(30)
   */
  readonly visibilityTimeout?: Duration;

  /**
   * Whether to enable a Dead Letter Queue (DLQ).
   * @default false (for backwards compatibility with original behavior)
   */
  readonly enableDlq?: boolean;

  /**
   * The maximum number of times a message can be received before being sent to the DLQ.
   * Only applicable when enableDlq is true.
   * @default 3
   */
  readonly maxReceiveCount?: number;

  /**
   * The maximum number of records to retrieve per batch.
   * @default 10
   */
  readonly batchSize?: number;

  /**
   * The maximum amount of time to wait for a batch to be gathered.
   * @default - No batching window
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
   * The removal policy for the queue(s).
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * A combined queue + consumer construct for SQS processing workflows.
 *
 * This is a convenience construct that combines AppTheoryQueue and AppTheoryQueueConsumer
 * into a single, easy-to-use pattern. For more control, use the individual constructs.
 *
 * @example
 * // Basic processor (backwards compatible)
 * new AppTheoryQueueProcessor(stack, 'Processor', {
 *   consumer: myFunction,
 * });
 *
 * @example
 * // Processor with DLQ
 * new AppTheoryQueueProcessor(stack, 'Processor', {
 *   consumer: myFunction,
 *   enableDlq: true,
 *   maxReceiveCount: 5,
 * });
 *
 * @example
 * // Processor with full options
 * new AppTheoryQueueProcessor(stack, 'Processor', {
 *   consumer: myFunction,
 *   queueName: 'my-queue',
 *   enableDlq: true,
 *   batchSize: 100,
 *   maxBatchingWindow: Duration.seconds(10),
 *   reportBatchItemFailures: true,
 *   maxConcurrency: 50,
 * });
 */
export class AppTheoryQueueProcessor extends Construct {
  /**
   * The main SQS queue.
   */
  public readonly queue: sqs.IQueue;

  /**
   * The underlying AppTheoryQueue construct.
   */
  public readonly queueConstruct: AppTheoryQueue;

  /**
   * The underlying AppTheoryQueueConsumer construct.
   */
  public readonly consumerConstruct: AppTheoryQueueConsumer;

  /**
   * The Dead Letter Queue, if enabled.
   */
  public readonly deadLetterQueue?: sqs.Queue;

  constructor(scope: Construct, id: string, props: AppTheoryQueueProcessorProps) {
    super(scope, id);

    // Determine if we should use legacy queueProps or new props
    const useLegacyProps = props.queueProps !== undefined;

    // Create the queue using AppTheoryQueue
    // For backwards compatibility, DLQ is disabled by default (original behavior)
    this.queueConstruct = new AppTheoryQueue(this, "AppTheoryQueue", {
      queueName: useLegacyProps ? props.queueProps?.queueName : props.queueName,
      visibilityTimeout: useLegacyProps
        ? props.queueProps?.visibilityTimeout
        : props.visibilityTimeout,
      enableDlq: props.enableDlq ?? false, // Backwards compatible: no DLQ by default
      maxReceiveCount: props.maxReceiveCount,
      removalPolicy: props.removalPolicy,
    });

    this.queue = this.queueConstruct.queue;
    this.deadLetterQueue = this.queueConstruct.deadLetterQueue;

    // Create the consumer using AppTheoryQueueConsumer
    this.consumerConstruct = new AppTheoryQueueConsumer(this, "AppTheoryConsumer", {
      queue: this.queue,
      consumer: props.consumer,
      batchSize: props.batchSize,
      maxBatchingWindow: props.maxBatchingWindow,
      reportBatchItemFailures: props.reportBatchItemFailures,
      maxConcurrency: props.maxConcurrency,
      enabled: props.enabled,
      grantConsumeMessages: true,
    });
  }
}

