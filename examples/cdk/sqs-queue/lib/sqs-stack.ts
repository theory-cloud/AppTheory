import * as path from "node:path";
import {
    AppTheoryQueue,
    AppTheoryQueueConsumer,
    AppTheoryQueueProcessor,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

/**
 * Example stack demonstrating AppTheory SQS constructs:
 * - AppTheoryQueue (queue + DLQ)
 * - AppTheoryQueueConsumer (event source mapping)
 * - AppTheoryQueueProcessor (combined convenience construct)
 */
export class SqsQueueStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // ========================================================================
        // Pattern 1: Queue-only (Contract Queue)
        // Use when external services produce messages and you manage consumption
        // ========================================================================

        const contractQueue = new AppTheoryQueue(this, "ContractQueue", {
            queueName: "contract-events",
            enableDlq: true,
            maxReceiveCount: 3,
            visibilityTimeout: cdk.Duration.seconds(60),
            dlqRetentionPeriod: cdk.Duration.days(14),
        });

        // Producer Lambda that sends messages to the queue
        const producerFn = new lambda.Function(this, "ProducerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "producer.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "API endpoint that produces messages",
            environment: {
                QUEUE_URL: contractQueue.queueUrl,
            },
        });

        // Grant producer permission to send messages
        contractQueue.grantSendMessages(producerFn);

        // A consumer makes the producer's real send observable end to end:
        // the harness invokes producer.handler and asserts that the mapping
        // delivered and deleted the message it sent (no manual receive).
        const producerWorkerFn = new lambda.Function(this, "ProducerWorkerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "worker.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Consumer for the contract queue the producer writes to",
        });
        new AppTheoryQueueConsumer(this, "ContractConsumer", {
            queue: contractQueue.queue,
            consumer: producerWorkerFn,
            batchSize: 10,
            reportBatchItemFailures: true,
        });

        // ========================================================================
        // Pattern 2: Queue + Consumer (Composable)
        // Use for maximum flexibility with separate queue and consumer config
        // ========================================================================

        const eventsQueue = new AppTheoryQueue(this, "EventsQueue", {
            queueName: "events-queue",
            enableDlq: true,
            maxReceiveCount: 5,
            visibilityTimeout: cdk.Duration.minutes(5), // 6x Lambda timeout
        });

        // Worker Lambda to process messages
        const workerFn = new lambda.Function(this, "WorkerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "worker.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(50),
            description: "Worker Lambda that processes queue messages",
        });

        // Consumer with full event-source options
        new AppTheoryQueueConsumer(this, "EventsConsumer", {
            queue: eventsQueue.queue,
            consumer: workerFn,
            batchSize: 100,
            maxBatchingWindow: cdk.Duration.seconds(10),
            reportBatchItemFailures: true,
            maxConcurrency: 50,
        });

        // DLQ handler for failed messages
        if (eventsQueue.deadLetterQueue) {
            const dlqHandlerFn = new lambda.Function(this, "DlqHandlerFn", {
                runtime: lambda.Runtime.NODEJS_24_X,
                handler: "dlq-handler.handler",
                code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
                timeout: cdk.Duration.seconds(30),
                description: "Handler for dead letter queue messages",
            });

            new AppTheoryQueueConsumer(this, "DlqConsumer", {
                queue: eventsQueue.deadLetterQueue,
                consumer: dlqHandlerFn,
                batchSize: 1, // Process one at a time for investigation
            });
        }

        // ========================================================================
        // Filter criteria and FIFO: the local runner evaluates FilterCriteria
        // as Lambda does (non-matching messages are deleted without invoking
        // the function) and processes one in-flight batch per FIFO group.
        // ========================================================================

        const filteredQueue = new AppTheoryQueue(this, "FilteredQueue", {
            queueName: "filtered-events",
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        workerFn.addEventSource(new lambdaEventSources.SqsEventSource(filteredQueue.queue, {
            batchSize: 10,
            reportBatchItemFailures: true,
            filters: [{ pattern: JSON.stringify({ body: { kind: ["keep"] } }) }],
        }));

        const fifoQueue = new AppTheoryQueue(this, "FifoQueue", {
            queueName: "fifo-events",
            fifo: true,
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        workerFn.addEventSource(new lambdaEventSources.SqsEventSource(fifoQueue.queue, {
            batchSize: 10,
            reportBatchItemFailures: true,
        }));

        // ========================================================================
        // SNS: a standard topic with a Lambda subscription and a FIFO topic with
        // an inline SQS subscription. The local runner provisions both topics
        // from these L1 resources and registers the subscriptions with the
        // delivery engine; E6 is the deliverer. The L1 resources are deliberate:
        // Ref returns the topic ARN and GetAtt TopicName/TopicArn are the
        // documented return values, while an L2 topic hides the generated
        // logical id those attributes name.
        // ========================================================================

        const eventsTopic = new sns.CfnTopic(this, "EventsTopic", {
            topicName: "apptheory-local-events",
            // The inline Subscription property is the second supported form.
            subscription: [{
                protocol: "lambda",
                endpoint: producerWorkerFn.functionArn,
            }],
        });
        producerWorkerFn.addPermission("SNSInvoke", {
            principal: new iam.ServicePrincipal("sns.amazonaws.com"),
            sourceArn: eventsTopic.ref,
        });
        new sns.CfnTopicPolicy(this, "EventsTopicPolicy", {
            topics: [eventsTopic.ref],
            policyDocument: { Version: "2012-10-17", Statement: [] },
        });

        const fifoTopic = new sns.CfnTopic(this, "FifoTopic", {
            topicName: "apptheory-local-events.fifo",
            fifoTopic: true,
            contentBasedDeduplication: true,
        });
        new sns.CfnSubscription(this, "FifoTopicQueue", {
            topicArn: fifoTopic.ref,
            protocol: "sqs",
            endpoint: fifoQueue.queueArn,
            rawMessageDelivery: true,
        });

        const snsPublisherFn = new lambda.Function(this, "SnsPublisherFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sns-publisher.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Publishes to the standard and FIFO SNS topics through the AWS SDK",
            environment: {
                TOPIC_ARN: eventsTopic.ref,
                TOPIC_NAME: cdk.Fn.getAtt("EventsTopic", "TopicName").toString(),
                FIFO_TOPIC_ARN: fifoTopic.ref,
                FIFO_TOPIC_NAME: cdk.Fn.getAtt("FifoTopic", "TopicName").toString(),
                FIFO_QUEUE_ARN: fifoQueue.queueArn,
            },
        });
        snsPublisherFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["sns:Publish", "sns:GetTopicAttributes"],
            resources: [eventsTopic.ref, fifoTopic.ref],
        }));

        // ========================================================================
        // Maximum concurrency: one message per batch and two concurrent
        // batches, observed through the delivery engine's live in-flight count.
        // ========================================================================

        const concurrencyQueue = new AppTheoryQueue(this, "ConcurrencyQueue", {
            queueName: "concurrency-events",
            enableDlq: false,
        });
        workerFn.addEventSource(new lambdaEventSources.SqsEventSource(concurrencyQueue.queue, {
            batchSize: 1,
            maxConcurrency: 2,
            reportBatchItemFailures: true,
        }));

        // ========================================================================
        // Pattern 3: Processor (Combined)
        // Use for quick queue + consumer setup with minimal configuration
        // ========================================================================

        const simpleWorkerFn = new lambda.Function(this, "SimpleWorkerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "worker.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Simple worker using AppTheoryQueueProcessor",
        });

        const processor = new AppTheoryQueueProcessor(this, "SimpleProcessor", {
            consumer: simpleWorkerFn,
            queueName: "simple-queue",
            enableDlq: true,
            maxReceiveCount: 3,
            batchSize: 50,
            maxBatchingWindow: cdk.Duration.seconds(5),
            reportBatchItemFailures: true,
            maxConcurrency: 10,
        });

        // ========================================================================
        // Outputs
        // ========================================================================

        new cdk.CfnOutput(this, "ContractQueueUrl", {
            value: contractQueue.queueUrl,
            description: "Contract queue URL (queue-only pattern)",
        });

        new cdk.CfnOutput(this, "ContractQueueDlqUrl", {
            value: contractQueue.deadLetterQueue?.queueUrl ?? "N/A",
            description: "Contract queue DLQ URL",
        });

        new cdk.CfnOutput(this, "EventsQueueUrl", {
            value: eventsQueue.queueUrl,
            description: "Events queue URL (queue + consumer pattern)",
        });

        new cdk.CfnOutput(this, "SimpleProcessorQueueUrl", {
            value: processor.queue.queueUrl,
            description: "Simple processor queue URL (processor pattern)",
        });
    }
}
