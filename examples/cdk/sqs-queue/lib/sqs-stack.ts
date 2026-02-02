import * as path from "node:path";
import {
    AppTheoryQueue,
    AppTheoryQueueConsumer,
    AppTheoryQueueProcessor,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
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
