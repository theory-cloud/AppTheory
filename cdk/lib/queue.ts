import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * Properties for AppTheoryQueue construct.
 */
export interface AppTheoryQueueProps {
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
     * The number of seconds that Amazon SQS retains a message.
     * @default Duration.days(4)
     */
    readonly retentionPeriod?: Duration;

    /**
     * The amount of time for which a ReceiveMessage call will wait for a message to arrive in the queue
     * before returning. Used for SQS long polling.
     * @default undefined
     */
    readonly receiveMessageWaitTime?: Duration;

    /**
     * Whether to enable a Dead Letter Queue (DLQ).
     * @default true
     */
    readonly enableDlq?: boolean;

    /**
     * The maximum number of times a message can be received before being sent to the DLQ.
     * Only applicable when enableDlq is true.
     * @default 3
     */
    readonly maxReceiveCount?: number;

    /**
     * The visibility timeout for the DLQ.
     * @default - Same as the main queue
     */
    readonly dlqVisibilityTimeout?: Duration;

    /**
     * The retention period for the DLQ.
     * @default Duration.days(14)
     */
    readonly dlqRetentionPeriod?: Duration;

    /**
     * Whether messages delivered to the queue will be encrypted.
     * @default - AWS managed encryption is used
     */
    readonly encryption?: sqs.QueueEncryption;

    /**
     * Whether to enable content-based deduplication for FIFO queues.
     * Only applicable for FIFO queues.
     * @default false
     */
    readonly contentBasedDeduplication?: boolean;

    /**
     * Whether the queue is a FIFO queue.
     * @default false
     */
    readonly fifo?: boolean;

    /**
     * Principals to grant send messages permission to.
     * @default - No additional principals
     */
    readonly grantSendMessagesTo?: lambda.IFunction[];

    /**
     * The removal policy for the queue(s).
     * @default RemovalPolicy.DESTROY
     */
    readonly removalPolicy?: RemovalPolicy;
}

/**
 * A composable SQS queue construct with optional DLQ support.
 *
 * This construct creates an SQS queue with optional Dead Letter Queue (DLQ) configuration.
 * It can be used standalone (for manual message production/consumption) or composed
 * with AppTheoryQueueConsumer for Lambda integration.
 *
 * @example
 * // Queue with DLQ (default)
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 * });
 *
 * @example
 * // Queue without DLQ
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 *   enableDlq: false,
 * });
 *
 * @example
 * // Queue with custom DLQ configuration
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 *   maxReceiveCount: 5,
 *   dlqRetentionPeriod: Duration.days(14),
 * });
 */
export class AppTheoryQueue extends Construct {
    /**
     * The main SQS queue.
     */
    public readonly queue: sqs.Queue;

    /**
     * The Dead Letter Queue, if enabled.
     */
    public readonly deadLetterQueue?: sqs.Queue;

    /**
     * The ARN of the main queue.
     */
    public readonly queueArn: string;

    /**
     * The URL of the main queue.
     */
    public readonly queueUrl: string;

    /**
     * The name of the main queue.
     */
    public readonly queueName: string;

    constructor(scope: Construct, id: string, props: AppTheoryQueueProps = {}) {
        super(scope, id);

        const enableDlq = props.enableDlq !== false;
        const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

        // Create DLQ if enabled
        if (enableDlq) {
            const dlqName = props.queueName ? `${props.queueName}-dlq` : undefined;
            this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
                queueName: props.fifo && dlqName ? `${dlqName}.fifo` : dlqName,
                visibilityTimeout: props.dlqVisibilityTimeout ?? props.visibilityTimeout,
                retentionPeriod: props.dlqRetentionPeriod ?? Duration.days(14),
                encryption: props.encryption,
                fifo: props.fifo,
                contentBasedDeduplication: props.fifo ? props.contentBasedDeduplication : undefined,
                removalPolicy,
            });
        }

        // Create main queue
        this.queue = new sqs.Queue(this, "Queue", {
            queueName: props.fifo && props.queueName ? `${props.queueName}.fifo` : props.queueName,
            visibilityTimeout: props.visibilityTimeout,
            retentionPeriod: props.retentionPeriod,
            receiveMessageWaitTime: props.receiveMessageWaitTime,
            encryption: props.encryption,
            fifo: props.fifo,
            contentBasedDeduplication: props.fifo ? props.contentBasedDeduplication : undefined,
            deadLetterQueue: this.deadLetterQueue
                ? {
                    queue: this.deadLetterQueue,
                    maxReceiveCount: props.maxReceiveCount ?? 3,
                }
                : undefined,
            removalPolicy,
        });

        // Expose convenience properties
        this.queueArn = this.queue.queueArn;
        this.queueUrl = this.queue.queueUrl;
        this.queueName = this.queue.queueName;

        // Grant send permissions if specified
        if (props.grantSendMessagesTo) {
            for (const fn of props.grantSendMessagesTo) {
                this.queue.grantSendMessages(fn);
            }
        }
    }

    /**
     * Grant send messages permission to a Lambda function.
     */
    public grantSendMessages(grantee: lambda.IFunction): void {
        this.queue.grantSendMessages(grantee);
    }

    /**
     * Grant consume messages permission to a Lambda function.
     */
    public grantConsumeMessages(grantee: lambda.IFunction): void {
        this.queue.grantConsumeMessages(grantee);
    }

    /**
     * Grant purge messages permission to a Lambda function.
     */
    public grantPurge(grantee: lambda.IFunction): void {
        this.queue.grantPurge(grantee);
    }
}
