import * as path from "node:path";
import {
    AppTheoryQueue,
    AppTheoryQueueConsumer,
    AppTheoryQueueProcessor,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
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
        // SNS: a standard topic with an inline Lambda subscription, a FIFO
        // topic with an inline SQS subscription, and the fan-out targets the
        // local runner proves. The local runner provisions both topics from
        // these L1 resources, observes publishes on moto and delivers every
        // subscription itself: a Lambda record, an SQS envelope or raw body,
        // an HTTP loopback POST and a FIFO queue with group/deduplication ids.
        // The L1 resources are deliberate: Ref returns the topic ARN and GetAtt
        // TopicName/TopicArn are the documented return values, while an L2
        // topic hides the generated logical id those attributes name.
        // ========================================================================

        const snsReceiptsQueue = new AppTheoryQueue(this, "SnsReceiptsQueue", {
            queueName: "sns-receipts",
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });

        const snsEventConsumerFn = new lambda.Function(this, "SnsEventConsumerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sns-consumer.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Records the SNS Lambda record the local runner delivers",
            environment: {
                RECEIPT_QUEUE_URL: snsReceiptsQueue.queueUrl,
                RECEIPT_KIND: "event",
            },
        });
        snsReceiptsQueue.grantSendMessages(snsEventConsumerFn);

        const eventsTopic = new sns.CfnTopic(this, "EventsTopic", {
            topicName: "apptheory-local-events",
            // The inline Subscription property is the second supported form.
            subscription: [{
                protocol: "lambda",
                endpoint: snsEventConsumerFn.functionArn,
            }],
        });
        snsEventConsumerFn.addPermission("SNSInvoke", {
            principal: new iam.ServicePrincipal("sns.amazonaws.com"),
            sourceArn: eventsTopic.ref,
        });
        new sns.CfnTopicPolicy(this, "EventsTopicPolicy", {
            topics: [eventsTopic.ref],
            policyDocument: { Version: "2012-10-17", Statement: [] },
        });

        const snsAttributeConsumerFn = new lambda.Function(this, "SnsAttributeConsumerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sns-consumer.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Records SNS messages that satisfy an attribute-scope filter policy",
            environment: {
                RECEIPT_QUEUE_URL: snsReceiptsQueue.queueUrl,
                RECEIPT_KIND: "attribute",
            },
        });
        snsReceiptsQueue.grantSendMessages(snsAttributeConsumerFn);

        const snsBodyConsumerFn = new lambda.Function(this, "SnsBodyConsumerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sns-consumer.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Records SNS messages that satisfy a body-scope filter policy",
            environment: {
                RECEIPT_QUEUE_URL: snsReceiptsQueue.queueUrl,
                RECEIPT_KIND: "body",
            },
        });
        snsReceiptsQueue.grantSendMessages(snsBodyConsumerFn);

        const filteredAttributesTopic = new sns.CfnTopic(this, "FilteredAttributesTopic", {
            topicName: "apptheory-local-attributes",
        });
        new sns.CfnSubscription(this, "AttributeFilteredSubscription", {
            topicArn: filteredAttributesTopic.ref,
            protocol: "lambda",
            endpoint: snsAttributeConsumerFn.functionArn,
            filterPolicy: {
                eventType: ["keep"],
                // AWS's standard "$or" form: the sibling key is ANDed with the
                // OR of the branch objects. SNS recognizes "$or" only when its
                // value is an array of at least two objects and no branch uses
                // a reserved keyword as a field name:
                // https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
                $or: [
                    { priority: [{ numeric: [">=", 10] }] },
                    { region: ["us-east-1"] },
                ],
            },
            filterPolicyScope: "MessageAttributes",
        });
        snsAttributeConsumerFn.addPermission("SNSAttributeInvoke", {
            principal: new iam.ServicePrincipal("sns.amazonaws.com"),
            sourceArn: filteredAttributesTopic.ref,
        });

        const filteredBodyTopic = new sns.CfnTopic(this, "FilteredBodyTopic", {
            topicName: "apptheory-local-body",
        });
        new sns.CfnSubscription(this, "BodyFilteredSubscription", {
            topicArn: filteredBodyTopic.ref,
            protocol: "lambda",
            endpoint: snsBodyConsumerFn.functionArn,
            filterPolicy: {
                kind: ["order"],
                amount: [{ numeric: [">=", 100] }],
                customer: { tier: ["premium"] },
            },
            filterPolicyScope: "MessageBody",
        });
        snsBodyConsumerFn.addPermission("SNSBodyInvoke", {
            principal: new iam.ServicePrincipal("sns.amazonaws.com"),
            sourceArn: filteredBodyTopic.ref,
        });

        const snsRawQueue = new AppTheoryQueue(this, "SnsRawQueue", {
            queueName: "sns-raw",
            enableDlq: false,
        });
        const snsEnvelopeQueue = new AppTheoryQueue(this, "SnsEnvelopeQueue", {
            queueName: "sns-envelope",
            enableDlq: false,
        });
        const rawTopic = new sns.CfnTopic(this, "RawTopic", {
            topicName: "apptheory-local-raw",
        });
        new sns.CfnSubscription(this, "RawSubscription", {
            topicArn: rawTopic.ref,
            protocol: "sqs",
            endpoint: snsRawQueue.queueArn,
            rawMessageDelivery: true,
        });
        new sns.CfnSubscription(this, "EnvelopeSubscription", {
            topicArn: rawTopic.ref,
            protocol: "sqs",
            endpoint: snsEnvelopeQueue.queueArn,
            rawMessageDelivery: false,
        });

        const httpTopic = new sns.CfnTopic(this, "HttpTopic", {
            topicName: "apptheory-local-http",
        });
        new sns.CfnSubscription(this, "HttpSubscription", {
            topicArn: httpTopic.ref,
            protocol: "http",
            // A fixed loopback port the harness serves for this row. The
            // runner refuses any non-loopback HTTP endpoint at plan time.
            endpoint: "http://127.0.0.1:18120/",
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
        // A second FIFO queue with no event-source mapping, so the proving row
        // reads the SNS fan-out itself instead of a consumer draining it.
        const snsFifoQueue = new AppTheoryQueue(this, "SnsFifoQueue", {
            queueName: "sns-fifo-events",
            fifo: true,
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        new sns.CfnSubscription(this, "SnsFifoTopicQueue", {
            topicArn: fifoTopic.ref,
            protocol: "sqs",
            endpoint: snsFifoQueue.queueArn,
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
            resources: [eventsTopic.ref, fifoTopic.ref, filteredAttributesTopic.ref, filteredBodyTopic.ref, rawTopic.ref, httpTopic.ref],
        }));

        const snsScenarioPublisherFn = new lambda.Function(this, "SnsScenarioPublisherFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sns-scenario-publisher.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Publishes a scenario's messages through the real SNS SDK",
            environment: {
                ATTRIBUTES_TOPIC_ARN: filteredAttributesTopic.ref,
                BODY_TOPIC_ARN: filteredBodyTopic.ref,
                RAW_TOPIC_ARN: rawTopic.ref,
                HTTP_TOPIC_ARN: httpTopic.ref,
            },
        });
        snsScenarioPublisherFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["sns:Publish"],
            resources: [eventsTopic.ref, fifoTopic.ref, filteredAttributesTopic.ref, filteredBodyTopic.ref, rawTopic.ref, httpTopic.ref],
        }));

        // ========================================================================
        // EventBridge targets, input shaping, retry and DLQ. The publisher calls
        // PutEvents through the real SDK; the local runner serves the bus,
        // matches each rule and performs the documented target delivery.
        // ========================================================================

        const ruleTargetQueue = new AppTheoryQueue(this, "RuleTargetQueue", {
            queueName: "rule-target-events",
            enableDlq: false,
        });
        const ruleReceipts = new AppTheoryQueue(this, "RuleReceipts", {
            queueName: "rule-receipts",
            enableDlq: false,
        });
        const ruleTargetFn = new lambda.Function(this, "RuleTargetFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "rule-target.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            environment: {
                RECEIPT_QUEUE_URL: ruleReceipts.queueUrl,
                RECEIPT_KIND: "static",
            },
        });
        ruleReceipts.grantSendMessages(ruleTargetFn);

        const ruleFailingFn = new lambda.Function(this, "RuleFailingFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "rule-failing-target.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
        });

        const ruleDlq = new AppTheoryQueue(this, "RuleDlq", {
            queueName: "rule-dlq",
            enableDlq: false,
        });

        const customRuleBus = new events.EventBus(this, "CustomRuleBus", {
            eventBusName: "apptheory-local-rules",
        });

        const ruleTopic = new sns.Topic(this, "RuleTopic", {
            topicName: "apptheory-local-rule-transform",
        });
        ruleTopic.addSubscription(new snsSubscriptions.LambdaSubscription(snsEventConsumerFn));

        new events.Rule(this, "SqsPathRule", {
            eventBus: customRuleBus,
            eventPattern: { source: ["apptheory.rule"], detailType: ["path"] },
            targets: [new targets.SqsQueue(ruleTargetQueue.queue, {
                message: events.RuleTargetInput.fromEventPath("$.detail"),
            })],
        });
        // InputTransformer is not exposed by the L2 SNS target in this CDK
        // version, so the row uses the L1 escape hatch it documents.
        new events.CfnRule(this, "SnsTransformRule", {
            eventBusName: customRuleBus.eventBusName,
            eventPattern: { source: ["apptheory.rule"], detailType: ["transform"] },
            targets: [{
                id: "transform",
                arn: ruleTopic.topicArn,
                inputTransformer: {
                    inputPathsMap: { item: "$.detail.item" },
                    inputTemplate: '{"item":"<item>","rule":"<aws.events.rule-name>"}',
                },
            }],
        });
        new events.Rule(this, "LambdaInputRule", {
            eventPattern: { source: ["apptheory.rule"], detailType: ["static"] },
            targets: [new targets.LambdaFunction(ruleTargetFn, {
                event: events.RuleTargetInput.fromObject({ static: true }),
            })],
        });
        new events.Rule(this, "FailRule", {
            eventBus: customRuleBus,
            eventPattern: { source: ["apptheory.rule"], detailType: ["fail"] },
            targets: [new targets.LambdaFunction(ruleFailingFn, {
                retryAttempts: 2,
                maxEventAge: cdk.Duration.hours(1),
                deadLetterQueue: ruleDlq.queue,
            })],
        });

        const rulePublisherFn = new lambda.Function(this, "RulePublisherFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "rule-publisher.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            environment: {
                BUS_NAME: customRuleBus.eventBusName,
                // PutEvents accepts the bus ARN as EventBusName; resolving the
                // attribute proves Fn::GetAtt on AWS::Events::EventBus too.
                // https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
                BUS_ARN: customRuleBus.eventBusArn,
            },
        });
        customRuleBus.grantPutEventsTo(rulePublisherFn);
        rulePublisherFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["events:PutEvents"],
            resources: [cdk.Stack.of(this).formatArn({
                service: "events",
                resource: "event-bus",
                resourceName: "default",
            })],
        }));

        // ========================================================================
        // S3 event notifications: one bucket with the three destination kinds
        // and the documented filter rules. S3 sends the s3:TestEvent message to
        // the SQS and SNS destinations when the configuration is applied, then
        // a record for every matching object change:
        // https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html
        // ========================================================================

        const notificationBucket = new s3.Bucket(this, "NotificationBucket", {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const s3RecordQueue = new AppTheoryQueue(this, "S3RecordQueue", {
            queueName: "s3-events",
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        const s3Topic = new sns.Topic(this, "S3Topic", {
            topicName: "apptheory-local-s3",
        });
        const s3RawQueue = new AppTheoryQueue(this, "S3RawQueue", {
            queueName: "s3-raw",
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        s3Topic.addSubscription(new snsSubscriptions.SqsSubscription(s3RawQueue.queue, {
            rawMessageDelivery: true,
        }));
        const s3Receipts = new AppTheoryQueue(this, "S3Receipts", {
            queueName: "s3-lambda-receipts",
            enableDlq: false,
            visibilityTimeout: cdk.Duration.minutes(5),
        });
        const s3ConsumerFn = new lambda.Function(this, "S3ConsumerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "s3-consumer.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Records the S3 notification record the local runner delivers",
            environment: {
                RECEIPT_QUEUE_URL: s3Receipts.queueUrl,
            },
        });
        s3Receipts.grantSendMessages(s3ConsumerFn);

        // The two ObjectCreated configurations share the incoming/ prefix, so
        // their suffixes must not overlap: .json goes to Lambda and .csv goes
        // to SNS. The ObjectRemoved configuration may reuse the prefix because
        // its event type is different.
        // https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html
        notificationBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(s3ConsumerFn),
            { prefix: "incoming/", suffix: ".json" },
        );
        notificationBucket.addEventNotification(
            s3.EventType.OBJECT_REMOVED,
            new s3n.SqsDestination(s3RecordQueue.queue),
            { prefix: "incoming/" },
        );
        notificationBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.SnsDestination(s3Topic),
            { prefix: "incoming/", suffix: ".csv" },
        );

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
