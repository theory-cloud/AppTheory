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

        // R8 intrinsic-limit proof. `lambda.Function` takes numbers for
        // memorySize and timeout, so a CloudFormation expression must go through
        // the L1 CfnFunction escape hatch. The local runner resolves Ref to a
        // parameter Default, Fn::If over a condition evaluable from defaults,
        // and Fn::FindInMap; this example exercises all three.
        new cdk.CfnParameter(this, "RouterMemoryMb", {
            type: "Number",
            default: 256,
            minValue: 128,
            maxValue: 1024,
            description: "Memory for the inventory function; the local runner resolves the Ref from this default",
        });
        new cdk.CfnCondition(this, "FastTimeouts", {
            expression: cdk.Fn.conditionEquals(cdk.Fn.ref("RouterMemoryMb"), "256"),
        });
        new cdk.CfnMapping(this, "RouterLimits", {
            mapping: {
                prod: { memory: 512, timeout: 30 },
            },
        });
        const inventoryCfn = inventoryFn.node.defaultChild as lambda.CfnFunction;
        inventoryCfn.memorySize = cdk.Token.asNumber(cdk.Fn.ref("RouterMemoryMb"));
        inventoryCfn.timeout = cdk.Token.asNumber(cdk.Fn.conditionIf("FastTimeouts", 10, 3));
        const graphqlCfn = graphqlFn.node.defaultChild as lambda.CfnFunction;
        graphqlCfn.memorySize = cdk.Token.asNumber(cdk.Fn.findInMap("RouterLimits", "prod", "memory"));
        graphqlCfn.timeout = cdk.Token.asNumber(cdk.Fn.findInMap("RouterLimits", "prod", "timeout"));

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
