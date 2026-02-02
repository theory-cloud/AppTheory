import * as path from "node:path";
import { AppTheoryRestApiRouter } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/**
 * Example stack demonstrating AppTheoryRestApiRouter with:
 * - Multi-Lambda routing (different Lambdas for different routes)
 * - SSE streaming with full parity (responseTransferMode + URI + timeout)
 * - Stage controls (access logging, metrics, throttling)
 */
export class RestV1RouterStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // SSE streaming handler
        const sseFn = new lambda.Function(this, "SseFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "sse.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.minutes(15), // Allow long-running SSE connections
            description: "SSE streaming handler",
        });

        // GraphQL handler
        const graphqlFn = new lambda.Function(this, "GraphqlFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "graphql.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "GraphQL API handler",
        });

        // General API handler (catch-all)
        const apiFn = new lambda.Function(this, "ApiFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "api.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "General API handler (catch-all)",
        });

        // Inventory handler (inventory-driven path)
        const inventoryFn = new lambda.Function(this, "InventoryFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "inventory.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            timeout: cdk.Duration.seconds(30),
            description: "Inventory CRUD handler",
        });

        // Create the REST API router with stage configuration
        const router = new AppTheoryRestApiRouter(this, "Router", {
            apiName: "restv1-router-example",
            description: "REST API v1 router with multi-Lambda routing and SSE streaming",
            stage: {
                stageName: "prod",
                accessLogging: true,
                accessLogRetention: logs.RetentionDays.ONE_WEEK,
                detailedMetrics: true,
                throttlingRateLimit: 100,
                throttlingBurstLimit: 200,
            },
            cors: true, // Enable CORS with defaults
        });

        // Wire up the routes:
        // 1. SSE streaming route
        router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });

        // 2. GraphQL endpoint
        router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);

        // 3. Inventory-driven path (proof of multi-Lambda)
        router.addLambdaIntegration("/inventory/{id}", ["GET", "PUT", "DELETE"], inventoryFn);

        // 4. Catch-all proxy (must be last)
        router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);

        // Outputs
        new cdk.CfnOutput(this, "ApiUrl", {
            value: router.api.url ?? "",
            description: "REST API URL",
        });

        new cdk.CfnOutput(this, "SseUrl", {
            value: router.api.urlForPath("/sse") ?? "",
            description: "SSE streaming endpoint",
        });

        new cdk.CfnOutput(this, "GraphqlUrl", {
            value: router.api.urlForPath("/api/graphql") ?? "",
            description: "GraphQL endpoint",
        });
    }
}
