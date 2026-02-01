import * as path from "node:path";
import {
    AppTheoryDynamoTable,
    AppTheoryLambdaRole,
    AppTheoryMediaCdn,
    AppTheoryPathRoutedFrontend,
    AppTheoryQueue,
    AppTheoryQueueConsumer,
    AppTheoryRestApiRouter,
    AppTheoryKmsKey,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * Lesser Parity Example Stack
 *
 * This stack demonstrates the COMPLETE AppTheory CDK surface that can replace
 * all Lift CDK patterns used by Lesser's infra/cdk. It contains:
 *
 * 1. REST API v1 router with multiple Lambdas + SSE streaming route (M1)
 * 2. SQS with DLQ + optional consumer wiring (M2)
 * 3. DynamoDB table with deletion protection (M3)
 * 4. CloudFront distribution with multi-SPA routing + separate media CDN (M4)
 * 5. Lambda roles created via AppTheoryLambdaRole (M5)
 *
 * IMPORTANT: This example contains NO Lift CDK imports.
 */
export class LesserParityStack extends cdk.Stack {
    // Lambda roles (M5)
    public readonly apiRole: AppTheoryLambdaRole;
    public readonly workerRole: AppTheoryLambdaRole;

    // DynamoDB table (M3)
    public readonly mainTable: AppTheoryDynamoTable;

    // SQS queue (M2)
    public readonly eventsQueue: AppTheoryQueue;

    // REST API router (M1)
    public readonly apiRouter: AppTheoryRestApiRouter;

    // CloudFront distributions (M4)
    public readonly frontend: AppTheoryPathRoutedFrontend;
    public readonly mediaCdn: AppTheoryMediaCdn;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // =====================================================================
        // KMS Keys for environment encryption
        // =====================================================================

        const envEncryptionKey = new AppTheoryKmsKey(this, "EnvKey", {
            description: "KMS key for Lambda environment encryption",
            aliasName: "alias/lesser-parity-env",
        });

        // =====================================================================
        // M5: Lambda Roles via AppTheoryLambdaRole
        // Replaces LiftLambdaRole usage
        // =====================================================================

        // API Lambda role with X-Ray and environment encryption
        this.apiRole = new AppTheoryLambdaRole(this, "ApiRole", {
            roleName: "lesser-parity-api-role",
            description: "Lambda execution role for API handlers",
            enableXRay: true,
            environmentEncryptionKeys: [envEncryptionKey.key],
            tags: {
                Service: "lesser-parity-api",
                Environment: "demo",
            },
        });

        // Worker Lambda role with custom DynamoDB permissions
        this.workerRole = new AppTheoryLambdaRole(this, "WorkerRole", {
            roleName: "lesser-parity-worker-role",
            description: "Lambda execution role for queue worker",
            enableXRay: true,
            additionalStatements: [
                // DynamoDB permissions will be added after table creation
            ],
        });

        // =====================================================================
        // M3: DynamoDB Table with Deletion Protection
        // =====================================================================

        this.mainTable = new AppTheoryDynamoTable(this, "MainTable", {
            tableName: "lesser-parity-main",
            partitionKeyName: "pk",
            sortKeyName: "sk",
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            deletionProtection: true, // M3 requirement
            enablePointInTimeRecovery: true,
            timeToLiveAttribute: "ttl",
            enableStream: true,
            streamViewType: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            globalSecondaryIndexes: [
                {
                    indexName: "gsi1",
                    partitionKeyName: "gsi1pk",
                    sortKeyName: "gsi1sk",
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Grant worker role access to DynamoDB
        this.mainTable.table.grantReadWriteData(this.workerRole.role);

        // =====================================================================
        // M2: SQS Queue with DLQ + Consumer
        // =====================================================================

        // Events queue with DLQ
        this.eventsQueue = new AppTheoryQueue(this, "EventsQueue", {
            queueName: "lesser-parity-events",
            enableDlq: true,
            maxReceiveCount: 3,
            visibilityTimeout: cdk.Duration.minutes(5),
            dlqRetentionPeriod: cdk.Duration.days(14),
        });

        // Worker Lambda function processing the queue
        const workerFn = new lambda.Function(this, "WorkerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "worker.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: this.workerRole.role,
            timeout: cdk.Duration.seconds(50),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                TABLE_NAME: this.mainTable.table.tableName,
                QUEUE_URL: this.eventsQueue.queueUrl,
            },
            description: "Queue worker processing events",
        });

        // Consumer with full event-source options
        new AppTheoryQueueConsumer(this, "EventsConsumer", {
            queue: this.eventsQueue.queue,
            consumer: workerFn,
            batchSize: 50,
            maxBatchingWindow: cdk.Duration.seconds(5),
            reportBatchItemFailures: true,
            maxConcurrency: 20,
        });

        // =====================================================================
        // M1: REST API v1 Router with Multi-Lambda + Streaming
        // =====================================================================

        // SSE streaming handler
        const sseFn = new lambda.Function(this, "SseFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sse.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: this.apiRole.role,
            timeout: cdk.Duration.minutes(15),
            tracing: lambda.Tracing.ACTIVE,
            environmentEncryption: envEncryptionKey.key,
            description: "SSE streaming handler",
        });

        // GraphQL handler
        const graphqlFn = new lambda.Function(this, "GraphqlFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "graphql.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: this.apiRole.role,
            timeout: cdk.Duration.seconds(30),
            tracing: lambda.Tracing.ACTIVE,
            environmentEncryption: envEncryptionKey.key,
            environment: {
                TABLE_NAME: this.mainTable.table.tableName,
            },
            description: "GraphQL API handler",
        });

        // Grant GraphQL handler access to DynamoDB
        this.mainTable.table.grantReadWriteData(graphqlFn);

        // General API handler (catch-all)
        const apiFn = new lambda.Function(this, "ApiFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "api.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: this.apiRole.role,
            timeout: cdk.Duration.seconds(30),
            tracing: lambda.Tracing.ACTIVE,
            environmentEncryption: envEncryptionKey.key,
            environment: {
                TABLE_NAME: this.mainTable.table.tableName,
                QUEUE_URL: this.eventsQueue.queueUrl,
            },
            description: "General API handler",
        });

        // Grant API handler access to DynamoDB
        this.mainTable.table.grantReadWriteData(apiFn);

        // Grant API handler permission to send messages
        this.eventsQueue.grantSendMessages(apiFn);

        // REST API router with stage configuration
        this.apiRouter = new AppTheoryRestApiRouter(this, "ApiRouter", {
            apiName: "lesser-parity-api",
            description: "Lesser parity REST API with multi-Lambda routing and SSE streaming",
            stage: {
                stageName: "prod",
                accessLogging: true,
                accessLogRetention: logs.RetentionDays.ONE_WEEK,
                detailedMetrics: true,
                throttlingRateLimit: 100,
                throttlingBurstLimit: 200,
            },
            cors: true,
        });

        // Wire up the routes:
        // 1. SSE streaming route (demonstrates streaming parity)
        this.apiRouter.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });

        // 2. GraphQL endpoint
        this.apiRouter.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);

        // 3. Catch-all proxy (must be last)
        this.apiRouter.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);

        // =====================================================================
        // M4A: Path-Routed Frontend Distribution (Multi-SPA)
        // =====================================================================

        // S3 buckets for SPAs
        const clientBucket = new s3.Bucket(this, "ClientBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const authBucket = new s3.Bucket(this, "AuthBucket", {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Path-routed frontend distribution
        // Note: In production, you would use a static domain or configure this via context
        // The API Gateway URL cannot be used directly because it contains CDK tokens at synth time
        this.frontend = new AppTheoryPathRoutedFrontend(this, "Frontend", {
            apiOriginUrl: "https://api.example-lesser-parity.com",
            spaOrigins: [
                {
                    bucket: clientBucket,
                    pathPattern: "/l/*",
                },
                {
                    bucket: authBucket,
                    pathPattern: "/auth/*",
                },
            ],
            apiBypassPaths: [
                { pathPattern: "/auth/wallet/*" },
            ],
            comment: "Lesser parity frontend (client + auth SPAs)",
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // =====================================================================
        // M4B: Media CDN Distribution
        // =====================================================================

        this.mediaCdn = new AppTheoryMediaCdn(this, "MediaCdn", {
            comment: "Lesser parity media CDN",
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // =====================================================================
        // Stack Outputs
        // =====================================================================

        // API outputs
        new cdk.CfnOutput(this, "ApiUrl", {
            value: this.apiRouter.api.url ?? "",
            description: "REST API URL",
        });

        new cdk.CfnOutput(this, "SseUrl", {
            value: this.apiRouter.api.urlForPath("/sse") ?? "",
            description: "SSE streaming endpoint",
        });

        new cdk.CfnOutput(this, "GraphqlUrl", {
            value: this.apiRouter.api.urlForPath("/api/graphql") ?? "",
            description: "GraphQL endpoint",
        });

        // DynamoDB outputs
        new cdk.CfnOutput(this, "TableName", {
            value: this.mainTable.table.tableName,
            description: "DynamoDB table name",
        });

        // SQS outputs
        new cdk.CfnOutput(this, "QueueUrl", {
            value: this.eventsQueue.queueUrl,
            description: "SQS queue URL",
        });

        new cdk.CfnOutput(this, "DlqUrl", {
            value: this.eventsQueue.deadLetterQueue?.queueUrl ?? "N/A",
            description: "SQS dead letter queue URL",
        });

        // CloudFront outputs
        new cdk.CfnOutput(this, "FrontendDomain", {
            value: this.frontend.distribution.distributionDomainName,
            description: "CloudFront frontend distribution domain",
        });

        new cdk.CfnOutput(this, "MediaCdnDomain", {
            value: this.mediaCdn.distribution.distributionDomainName,
            description: "CloudFront media CDN domain",
        });

        // Role outputs
        new cdk.CfnOutput(this, "ApiRoleArn", {
            value: this.apiRole.roleArn,
            description: "API Lambda execution role ARN",
        });

        new cdk.CfnOutput(this, "WorkerRoleArn", {
            value: this.workerRole.roleArn,
            description: "Worker Lambda execution role ARN",
        });

        // Bucket outputs
        new cdk.CfnOutput(this, "ClientBucketName", {
            value: clientBucket.bucketName,
            description: "Client SPA S3 bucket",
        });

        new cdk.CfnOutput(this, "AuthBucketName", {
            value: authBucket.bucketName,
            description: "Auth SPA S3 bucket",
        });

        new cdk.CfnOutput(this, "MediaBucketName", {
            value: this.mediaCdn.bucket.bucketName,
            description: "Media CDN S3 bucket",
        });
    }
}
