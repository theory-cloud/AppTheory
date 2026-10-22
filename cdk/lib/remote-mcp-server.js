"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryRemoteMcpServer = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const constructs_1 = require("constructs");
const rest_api_router_1 = require("./rest-api-router");
const mcp_paths_1 = require("./mcp-paths");
const mcp_route_algebra_1 = require("./mcp-route-algebra");
const string_utils_1 = require("./private/string-utils");
const STREAM_SPILL_INLINE_DEFAULT_BYTES = 32 * 1024;
const STREAM_SPILL_INLINE_SAFE_MAX_BYTES = 350 * 1024;
const STREAM_MAX_EVENT_DEFAULT_BYTES = 10 * 1024 * 1024;
/**
 * A Claude-first Remote MCP server construct that provisions:
 * - API Gateway REST API v1
 * - Streaming-enabled Lambda proxy integrations for `/mcp` (POST/GET) using
 *   Lambda response streaming (`/response-streaming-invocations`)
 * - Optional DynamoDB tables for sessions, streams, and task runtime state
 *
 * This construct is designed for MCP Streamable HTTP (2025-06-18).
 */
class AppTheoryRemoteMcpServer extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer", version: "6.3.1" };
    /**
     * The underlying REST API router.
     */
    router;
    /**
     * The MCP endpoint URL or template (`.../mcp` or `.../mcp/{actor}`).
     */
    endpoint;
    /**
     * The route-derived RFC 9728 protected-resource metadata URL template.
     *
     * Derived from the same route model as `endpoint` through the shared MCP
     * route algebra: the algebra's resource-path → protected-resource-path
     * derivation applied to the transport resource path, mounted on the same
     * origin. With `actorPath` enabled this is a per-actor template such as
     * `https://{apiId}.execute-api.{region}.amazonaws.com/prod/.well-known/oauth-protected-resource/mcp/{actor}`;
     * otherwise it is the family-wide
     * `https://{apiId}.execute-api.{region}.amazonaws.com/prod/.well-known/oauth-protected-resource/mcp`.
     *
     * This is the construct's route-derived per-actor challenge surface. The
     * construct injects no environment variable (the framework-injected
     * `MCP_ENDPOINT` is retired), so pass this value into the adopter's own app
     * code and configure it as the runtime's bearer template option —
     * `oauth.RequireBearerTokenOptions{ResourceMetadataURLTemplate: ...}` (Go),
     * `requireBearerTokenMiddleware({ resourceMetadataURLTemplate: ... })`
     * (TypeScript), or
     * `RequireBearerTokenOptions(resource_metadata_url_template=...)` (Python) —
     * so the runtime resolves `{actor}` from the matched route and advertises a
     * matching `WWW-Authenticate` challenge. Passing it as a static
     * `ResourceMetadataURL` would advertise the literal `{actor}`.
     */
    protectedResourceMetadataUrl;
    /**
     * The DynamoDB session table (if enabled).
     */
    sessionTable;
    /**
     * The DynamoDB stream/event log table (if enabled).
     */
    streamTable;
    /**
     * The DynamoDB task runtime table (if enabled).
     */
    taskTable;
    /**
     * The S3 spill bucket for large stream event payloads (if stream storage is enabled).
     */
    streamSpillBucket;
    constructor(scope, id, props) {
        super(scope, id);
        this.router = new rest_api_router_1.AppTheoryRestApiRouter(this, "Api", {
            apiName: props.apiName,
            description: props.description,
            stage: props.stage,
            cors: props.cors,
            domain: props.domain,
            allowTestInvoke: props.allowTestInvoke,
            scopePermissionToMethod: props.scopePermissionToMethod,
            authorizer: props.authorizer,
            authorizationType: props.authorizationType,
        });
        const routeModel = remoteMcpRouteModel(props.actorPath);
        const transportPath = routeModel.resourcePath;
        // Streamable HTTP routes (streaming enabled for SSE delivery)
        this.router.addLambdaIntegration(transportPath, ["POST"], props.handler, { streaming: true });
        this.router.addLambdaIntegration(transportPath, ["GET"], props.handler, { streaming: true });
        this.router.addLambdaIntegration(transportPath, ["DELETE"], props.handler);
        if (props.actorPath) {
            this.router.addLambdaIntegration(routeModel.protectedResourcePath, ["GET"], props.handler);
            // ADV-1148-1: the per-actor route is advertised as `protectedResourceMetadataUrl`
            // (a URL template ending in `/mcp/{actor}`). No environment variable is injected,
            // so the adopter must wire the value explicitly in their own app code.
            aws_cdk_lib_1.Annotations.of(this).addWarning(`actorPath: true mounts the per-actor route "${routeModel.protectedResourcePath}" and advertises it via the "protectedResourceMetadataUrl" property. ` +
                "This construct injects no environment variable (the framework-injected MCP_ENDPOINT is retired), so pass \"protectedResourceMetadataUrl\" into your own app configuration and set it as the runtime's bearer template option: " +
                "Go oauth.RequireBearerTokenOptions{ResourceMetadataURLTemplate: ...}, " +
                "TypeScript requireBearerTokenMiddleware({ resourceMetadataURLTemplate: ... }), " +
                "Python RequireBearerTokenOptions(resource_metadata_url_template=...). " +
                "Without that wiring the protected per-actor route advertises only the bare \"Bearer\" challenge.");
        }
        if (props.enableWellKnownMcpDiscovery) {
            this.router.addLambdaIntegration("/.well-known/mcp.json", ["GET"], props.handler);
        }
        // Optional session table (matches runtime/mcp/session_dynamo.go schema)
        if (props.enableSessionTable) {
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: props.sessionTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.sessionTable = table;
        }
        if (this.sessionTable) {
            this.addEnvironment(props.handler, "MCP_SESSION_TABLE", this.sessionTable.tableName);
            this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(props.sessionTtlMinutes ?? 60));
        }
        this.validateStreamSpillThresholds(props);
        // Optional stream/event log table (schema is opinionated but intentionally flexible)
        if (props.enableStreamTable) {
            const table = new dynamodb.Table(this, "StreamTable", {
                tableName: props.streamTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                sortKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.streamTable = table;
            const spillBucket = new s3.Bucket(this, "StreamSpillBucket", {
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                lifecycleRules: [
                    {
                        enabled: true,
                        expiration: aws_cdk_lib_1.Duration.days(streamSpillExpirationDays(props.streamTtlMinutes ?? 60)),
                    },
                ],
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
            });
            spillBucket.grantReadWrite(props.handler);
            this.streamSpillBucket = spillBucket;
        }
        if (this.streamTable) {
            this.addEnvironment(props.handler, "MCP_STREAM_TABLE", this.streamTable.tableName);
            this.addEnvironment(props.handler, "MCP_STREAM_TTL_MINUTES", String(props.streamTtlMinutes ?? 60));
            if (this.streamSpillBucket) {
                this.addEnvironment(props.handler, "MCP_STREAM_SPILL_BUCKET", this.streamSpillBucket.bucketName);
                this.addEnvironment(props.handler, "MCP_STREAM_SPILL_PREFIX", "mcp-stream-events");
                this.addEnvironment(props.handler, "MCP_STREAM_SPILL_INLINE_MAX_BYTES", String(props.streamSpillInlineMaxBytes ?? STREAM_SPILL_INLINE_DEFAULT_BYTES));
                this.addEnvironment(props.handler, "MCP_STREAM_MAX_EVENT_BYTES", String(props.streamMaxEventBytes ?? STREAM_MAX_EVENT_DEFAULT_BYTES));
            }
        }
        // Optional task table (matches runtime/mcp/task_dynamo.go schema)
        if (props.enableTaskTable) {
            const table = new dynamodb.Table(this, "TaskTable", {
                tableName: props.taskTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                sortKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.taskTable = table;
        }
        if (this.taskTable) {
            this.addEnvironment(props.handler, "MCP_TASK_TABLE", this.taskTable.tableName);
            this.addEnvironment(props.handler, "MCP_TASK_TTL_MINUTES", String(props.taskTtlMinutes ?? 10));
        }
        const stageName = props.stage?.stageName ?? "prod";
        const endpointOrigin = computeEndpointOrigin(this.router, stageName, props.domain);
        this.endpoint = `${endpointOrigin}${routeModel.resourcePath}`;
        this.protectedResourceMetadataUrl = `${endpointOrigin}${routeModel.protectedResourcePath}`;
    }
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise no-op for imported functions.
     */
    addEnvironment(handler, key, value) {
        if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
            handler.addEnvironment(key, value);
        }
    }
    validateStreamSpillThresholds(props) {
        const inlineMax = props.streamSpillInlineMaxBytes ?? STREAM_SPILL_INLINE_DEFAULT_BYTES;
        const eventMax = props.streamMaxEventBytes ?? STREAM_MAX_EVENT_DEFAULT_BYTES;
        if (!Number.isInteger(inlineMax) || inlineMax <= 0) {
            throw new Error("AppTheoryRemoteMcpServer: streamSpillInlineMaxBytes must be a positive integer");
        }
        if (inlineMax > STREAM_SPILL_INLINE_SAFE_MAX_BYTES) {
            throw new Error(`AppTheoryRemoteMcpServer: streamSpillInlineMaxBytes must be less than or equal to ${STREAM_SPILL_INLINE_SAFE_MAX_BYTES}`);
        }
        if (!Number.isInteger(eventMax) || eventMax <= 0) {
            throw new Error("AppTheoryRemoteMcpServer: streamMaxEventBytes must be a positive integer");
        }
        if (eventMax < inlineMax) {
            throw new Error("AppTheoryRemoteMcpServer: streamMaxEventBytes must be greater than or equal to streamSpillInlineMaxBytes");
        }
    }
}
exports.AppTheoryRemoteMcpServer = AppTheoryRemoteMcpServer;
function streamSpillExpirationDays(ttlMinutes) {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
        return 1;
    }
    return Math.max(1, Math.ceil(ttlMinutes / (24 * 60)));
}
/**
 * Build the route model from the shared MCP route-algebra surface.
 *
 * The protected-resource route is never hand-written: it is the algebra's
 * resource-path → protected-resource-path derivation, so the mounted metadata
 * route and the `protectedResourceMetadataUrl` template cannot drift. The
 * `{actor}` placeholder survives the derivation intact.
 */
function remoteMcpRouteModel(actorPath) {
    const resourcePath = actorPath
        ? `${mcp_paths_1.AppTheoryMcpPaths.MCP}/{actor}`
        : mcp_paths_1.AppTheoryMcpPaths.MCP;
    return {
        resourcePath,
        protectedResourcePath: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.protectedResourcePathFromMcpPath(resourcePath),
    };
}
function computeEndpointOrigin(router, stageName, domain) {
    if (!domain) {
        const stack = aws_cdk_lib_1.Stack.of(router);
        const stage = String(stageName ?? "").trim() || "prod";
        return `https://${router.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${stage}`;
    }
    const basePath = (0, string_utils_1.trimRepeatedChar)(String(domain.basePath ?? "").trim(), "/");
    const prefix = basePath ? `/${basePath}` : "";
    return `https://${domain.domainName}${prefix}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVtb3RlLW1jcC1zZXJ2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZW1vdGUtbWNwLXNlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTBFO0FBRTFFLG1FQUFxRDtBQUVyRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBRXZDLHVEQUsyQjtBQUMzQiwyQ0FBZ0Q7QUFDaEQsMkRBQStEO0FBQy9ELHlEQUEwRDtBQUUxRCxNQUFNLGlDQUFpQyxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDcEQsTUFBTSxrQ0FBa0MsR0FBRyxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ3RELE1BQU0sOEJBQThCLEdBQUcsRUFBRSxHQUFHLElBQUksR0FBRyxJQUFJLENBQUM7QUFpTnhEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSx3QkFBeUIsU0FBUSxzQkFBUzs7SUFDckQ7O09BRUc7SUFDYSxNQUFNLENBQXlCO0lBRS9DOztPQUVHO0lBQ2EsUUFBUSxDQUFTO0lBRWpDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O09Bc0JHO0lBQ2EsNEJBQTRCLENBQVM7SUFFckQ7O09BRUc7SUFDYSxZQUFZLENBQW1CO0lBRS9DOztPQUVHO0lBQ2EsV0FBVyxDQUFtQjtJQUU5Qzs7T0FFRztJQUNhLFNBQVMsQ0FBbUI7SUFFNUM7O09BRUc7SUFDYSxpQkFBaUIsQ0FBYztJQUUvQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW9DO1FBQzVFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLHdDQUFzQixDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDcEQsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ3RCLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztZQUM5QixLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7WUFDbEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTTtZQUNwQixlQUFlLEVBQUUsS0FBSyxDQUFDLGVBQWU7WUFDdEMsdUJBQXVCLEVBQUUsS0FBSyxDQUFDLHVCQUF1QjtZQUN0RCxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtTQUMzQyxDQUFDLENBQUM7UUFFSCxNQUFNLFVBQVUsR0FBRyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDeEQsTUFBTSxhQUFhLEdBQUcsVUFBVSxDQUFDLFlBQVksQ0FBQztRQUU5Qyw4REFBOEQ7UUFDOUQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxhQUFhLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDOUYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxhQUFhLEVBQUUsQ0FBQyxLQUFLLENBQUMsRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDN0YsSUFBSSxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxhQUFhLEVBQUUsQ0FBQyxRQUFRLENBQUMsRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFM0UsSUFBSSxLQUFLLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FDOUIsVUFBVSxDQUFDLHFCQUFxQixFQUNoQyxDQUFDLEtBQUssQ0FBQyxFQUNQLEtBQUssQ0FBQyxPQUFPLENBQ2QsQ0FBQztZQUVGLGtGQUFrRjtZQUNsRixrRkFBa0Y7WUFDbEYsdUVBQXVFO1lBQ3ZFLHlCQUFXLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFVBQVUsQ0FDN0IsK0NBQStDLFVBQVUsQ0FBQyxxQkFBcUIsdUVBQXVFO2dCQUN0SixnT0FBZ087Z0JBQ2hPLHdFQUF3RTtnQkFDeEUsaUZBQWlGO2dCQUNqRix3RUFBd0U7Z0JBQ3hFLGtHQUFrRyxDQUNuRyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLDJCQUEyQixFQUFFLENBQUM7WUFDdEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyx1QkFBdUIsRUFBRSxDQUFDLEtBQUssQ0FBQyxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNwRixDQUFDO1FBRUQsd0VBQXdFO1FBQ3hFLElBQUksS0FBSyxDQUFDLGtCQUFrQixFQUFFLENBQUM7WUFDN0IsTUFBTSxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7Z0JBQ3JELFNBQVMsRUFBRSxLQUFLLENBQUMsZ0JBQWdCO2dCQUNqQyxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO2dCQUNqRCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDeEUsbUJBQW1CLEVBQUUsV0FBVztnQkFDaEMsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztnQkFDcEMsZ0NBQWdDLEVBQUU7b0JBQ2hDLDBCQUEwQixFQUFFLElBQUk7aUJBQ2pDO2dCQUNELFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7YUFDakQsQ0FBQyxDQUFDO1lBRUgsS0FBSyxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN4QyxJQUFJLENBQUMsWUFBWSxHQUFHLEtBQUssQ0FBQztRQUM1QixDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLElBQUksQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDckYsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsaUJBQWlCLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztRQUN2RyxDQUFDO1FBRUQsSUFBSSxDQUFDLDZCQUE2QixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRTFDLHFGQUFxRjtRQUNyRixJQUFJLEtBQUssQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1lBQzVCLE1BQU0sS0FBSyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO2dCQUNwRCxTQUFTLEVBQUUsS0FBSyxDQUFDLGVBQWU7Z0JBQ2hDLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7Z0JBQ2pELFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO2dCQUN4RSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDakUsbUJBQW1CLEVBQUUsV0FBVztnQkFDaEMsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztnQkFDcEMsZ0NBQWdDLEVBQUU7b0JBQ2hDLDBCQUEwQixFQUFFLElBQUk7aUJBQ2pDO2dCQUNELFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7YUFDakQsQ0FBQyxDQUFDO1lBRUgsS0FBSyxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN4QyxJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQztZQUV6QixNQUFNLFdBQVcsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO2dCQUMzRCxpQkFBaUIsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsU0FBUztnQkFDakQsVUFBVSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVO2dCQUMxQyxVQUFVLEVBQUUsSUFBSTtnQkFDaEIsY0FBYyxFQUFFO29CQUNkO3dCQUNFLE9BQU8sRUFBRSxJQUFJO3dCQUNiLFVBQVUsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLElBQUksRUFBRSxDQUFDLENBQUM7cUJBQ25GO2lCQUNGO2dCQUNELGFBQWEsRUFBRSwyQkFBYSxDQUFDLE9BQU87Z0JBQ3BDLGlCQUFpQixFQUFFLElBQUk7YUFDeEIsQ0FBQyxDQUFDO1lBQ0gsV0FBVyxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDMUMsSUFBSSxDQUFDLGlCQUFpQixHQUFHLFdBQVcsQ0FBQztRQUN2QyxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDckIsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLGtCQUFrQixFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDbkYsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLHdCQUF3QixFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztZQUNuRyxJQUFJLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO2dCQUMzQixJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUseUJBQXlCLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUNqRyxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUseUJBQXlCLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztnQkFDbkYsSUFBSSxDQUFDLGNBQWMsQ0FDakIsS0FBSyxDQUFDLE9BQU8sRUFDYixtQ0FBbUMsRUFDbkMsTUFBTSxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsSUFBSSxpQ0FBaUMsQ0FBQyxDQUM3RSxDQUFDO2dCQUNGLElBQUksQ0FBQyxjQUFjLENBQ2pCLEtBQUssQ0FBQyxPQUFPLEVBQ2IsNEJBQTRCLEVBQzVCLE1BQU0sQ0FBQyxLQUFLLENBQUMsbUJBQW1CLElBQUksOEJBQThCLENBQUMsQ0FDcEUsQ0FBQztZQUNKLENBQUM7UUFDSCxDQUFDO1FBRUQsa0VBQWtFO1FBQ2xFLElBQUksS0FBSyxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQzFCLE1BQU0sS0FBSyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO2dCQUNsRCxTQUFTLEVBQUUsS0FBSyxDQUFDLGFBQWE7Z0JBQzlCLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7Z0JBQ2pELFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO2dCQUN4RSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDaEUsbUJBQW1CLEVBQUUsV0FBVztnQkFDaEMsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztnQkFDcEMsZ0NBQWdDLEVBQUU7b0JBQ2hDLDBCQUEwQixFQUFFLElBQUk7aUJBQ2pDO2dCQUNELFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7YUFDakQsQ0FBQyxDQUFDO1lBRUgsS0FBSyxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN4QyxJQUFJLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQztRQUN6QixDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDbkIsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDL0UsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLHNCQUFzQixFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsY0FBYyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDakcsQ0FBQztRQUVELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLEVBQUUsU0FBUyxJQUFJLE1BQU0sQ0FBQztRQUNuRCxNQUFNLGNBQWMsR0FBRyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbkYsSUFBSSxDQUFDLFFBQVEsR0FBRyxHQUFHLGNBQWMsR0FBRyxVQUFVLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDOUQsSUFBSSxDQUFDLDRCQUE0QixHQUFHLEdBQUcsY0FBYyxHQUFHLFVBQVUsQ0FBQyxxQkFBcUIsRUFBRSxDQUFDO0lBQzdGLENBQUM7SUFFRDs7O09BR0c7SUFDSyxjQUFjLENBQUMsT0FBeUIsRUFBRSxHQUFXLEVBQUUsS0FBYTtRQUMxRSxJQUFJLGdCQUFnQixJQUFJLE9BQU8sSUFBSSxPQUFPLE9BQU8sQ0FBQyxjQUFjLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDaEYsT0FBTyxDQUFDLGNBQWMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDckMsQ0FBQztJQUNILENBQUM7SUFFTyw2QkFBNkIsQ0FBQyxLQUFvQztRQUN4RSxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMseUJBQXlCLElBQUksaUNBQWlDLENBQUM7UUFDdkYsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLG1CQUFtQixJQUFJLDhCQUE4QixDQUFDO1FBRTdFLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQyxJQUFJLFNBQVMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUNuRCxNQUFNLElBQUksS0FBSyxDQUFDLGdGQUFnRixDQUFDLENBQUM7UUFDcEcsQ0FBQztRQUNELElBQUksU0FBUyxHQUFHLGtDQUFrQyxFQUFFLENBQUM7WUFDbkQsTUFBTSxJQUFJLEtBQUssQ0FDYixxRkFBcUYsa0NBQWtDLEVBQUUsQ0FDMUgsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDakQsTUFBTSxJQUFJLEtBQUssQ0FBQywwRUFBMEUsQ0FBQyxDQUFDO1FBQzlGLENBQUM7UUFDRCxJQUFJLFFBQVEsR0FBRyxTQUFTLEVBQUUsQ0FBQztZQUN6QixNQUFNLElBQUksS0FBSyxDQUFDLDBHQUEwRyxDQUFDLENBQUM7UUFDOUgsQ0FBQztJQUNILENBQUM7O0FBL09ILDREQWdQQztBQUVELFNBQVMseUJBQXlCLENBQUMsVUFBa0I7SUFDbkQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDLElBQUksVUFBVSxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3BELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEdBQUcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3hELENBQUM7QUFXRDs7Ozs7OztHQU9HO0FBQ0gsU0FBUyxtQkFBbUIsQ0FBQyxTQUFtQjtJQUM5QyxNQUFNLFlBQVksR0FBRyxTQUFTO1FBQzVCLENBQUMsQ0FBQyxHQUFHLDZCQUFpQixDQUFDLEdBQUcsVUFBVTtRQUNwQyxDQUFDLENBQUMsNkJBQWlCLENBQUMsR0FBRyxDQUFDO0lBQzFCLE9BQU87UUFDTCxZQUFZO1FBQ1oscUJBQXFCLEVBQ25CLDRDQUF3QixDQUFDLGdDQUFnQyxDQUFDLFlBQVksQ0FBQztLQUMxRSxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQzVCLE1BQThCLEVBQzlCLFNBQWlCLEVBQ2pCLE1BQTRDO0lBRTVDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNaLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQy9CLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLElBQUksTUFBTSxDQUFDO1FBQ3ZELE9BQU8sV0FBVyxNQUFNLENBQUMsR0FBRyxDQUFDLFNBQVMsZ0JBQWdCLEtBQUssQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLEVBQUUsQ0FBQztJQUNuRyxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQUcsSUFBQSwrQkFBZ0IsRUFBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUM3RSxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUM5QyxPQUFPLFdBQVcsTUFBTSxDQUFDLFVBQVUsR0FBRyxNQUFNLEVBQUUsQ0FBQztBQUNqRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQW5ub3RhdGlvbnMsIER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBTdGFjayB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7XG4gIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIsXG4gIHR5cGUgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zLFxuICB0eXBlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zLFxuICB0eXBlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG59IGZyb20gXCIuL3Jlc3QtYXBpLXJvdXRlclwiO1xuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUGF0aHMgfSBmcm9tIFwiLi9tY3AtcGF0aHNcIjtcbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuY29uc3QgU1RSRUFNX1NQSUxMX0lOTElORV9ERUZBVUxUX0JZVEVTID0gMzIgKiAxMDI0O1xuY29uc3QgU1RSRUFNX1NQSUxMX0lOTElORV9TQUZFX01BWF9CWVRFUyA9IDM1MCAqIDEwMjQ7XG5jb25zdCBTVFJFQU1fTUFYX0VWRU5UX0RFRkFVTFRfQllURVMgPSAxMCAqIDEwMjQgKiAxMDI0O1xuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyIGNvbnN0cnVjdC5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBpbnRlbmRlZCBmb3IgQ2xhdWRlLWZpcnN0IFJlbW90ZSBNQ1AgZGVwbG95bWVudHM6XG4gKiAtIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIChyZXF1aXJlZCBmb3IgcmVzcG9uc2Ugc3RyZWFtaW5nKVxuICogLSBTdHJlYW1hYmxlIEhUVFAgbW91bnQgYXQgYC9tY3BgIChQT1NUL0dFVC9ERUxFVEUpXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyUHJvcHMge1xuICAvKipcbiAgICogVGhlIExhbWJkYSBmdW5jdGlvbiB0aGF0IGhhbmRsZXMgTUNQIFN0cmVhbWFibGUgSFRUUCByZXF1ZXN0cy5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBkZXNjcmlwdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChyb3V0ZXIgZGVmYXVsdHMgYXBwbGllZClcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkuXG4gICAqXG4gICAqIE5vdGU6IEZvciBicm93c2VyIGNsaWVudHMsIHlvdXIgTGFtYmRhIGhhbmRsZXIgc3RpbGwgbmVlZHMgdG8gZW1pdFxuICAgKiB0aGUgYXBwcm9wcmlhdGUgYEFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbmAgaGVhZGVycy5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBDT1JTIHByZWZsaWdodClcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgQVBJIEdhdGV3YXkgY29uc29sZSB0ZXN0IGludm9jYXRpb25zIHNob3VsZCBiZSBncmFudGVkIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3Qgc3VwcHJlc3NlcyB0aGUgZXh0cmEgYHRlc3QtaW52b2tlLXN0YWdlYCBMYW1iZGEgcGVybWlzc2lvbnNcbiAgICogdGhhdCBDREsgYWRkcyBmb3IgZWFjaCBSRVNUIEFQSSBtZXRob2QuIFRoaXMgcmVkdWNlcyBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemUgd2hpbGVcbiAgICogcHJlc2VydmluZyBkZXBsb3llZC1zdGFnZSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgUkVTVCBBUEkgbWV0aG9kcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciBtZXRob2QvcGF0aCBwYWlyLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIFJlbW90ZSBNQ1BcbiAgICogcm91dGUgYnVuZGxlcyB0aGF0IHNoYXJlIG9uZSBoYW5kbGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBwZXItYWN0b3IgTUNQIGVuZHBvaW50IGJ1bmRsZXMuXG4gICAqXG4gICAqIFdoZW4gZW5hYmxlZCwgdGhlIGNvbnN0cnVjdCBtb3VudHMgdGhlIHRyYW5zcG9ydCBhdCBgL21jcC97YWN0b3J9YCBhbmRcbiAgICogY28tcmVnaXN0ZXJzIHRoZSBSRkMgOTcyOCBkaXNjb3Zlcnkgcm91dGUgYXRcbiAgICogYC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvbWNwL3thY3Rvcn1gLlxuICAgKlxuICAgKiBUaGUgcHVibGljIGBlbmRwb2ludGAgYW5kIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhVXJsYCB0aGVuIGJlY29tZSByb3V0ZVxuICAgKiB0ZW1wbGF0ZXMgZW5kaW5nIGluIGAvbWNwL3thY3Rvcn1gIGFuZFxuICAgKiBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS9tY3Ave2FjdG9yfWAgcmVzcGVjdGl2ZWx5LiBCb3RoIGFyZVxuICAgKiBkZXJpdmVkIGZyb20gdGhlIHNhbWUgcm91dGUgbW9kZWwgdGhyb3VnaCB0aGUgc2hhcmVkIE1DUCByb3V0ZSBhbGdlYnJhLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWN0b3JQYXRoPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmVnaXN0ZXIgYEdFVCAvLndlbGwta25vd24vbWNwLmpzb25gIGFuZCByb3V0ZSBpdCB0byB0aGUgaGFuZGxlci5cbiAgICpcbiAgICogVGhpcyBsZXRzIHRoZSBjb25zdHJ1Y3Qgb3duIHRoZSBmaW5hbCBNQ1AgZGlzY292ZXJ5IHJvdXRlIGFsb25nc2lkZSB0aGVcbiAgICogdHJhbnNwb3J0IGFuZCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEgcm91dGVzLiBUaGUgaGFuZGxlciByZW1haW5zXG4gICAqIHJlc3BvbnNpYmxlIGZvciBzZXJ2aW5nIHRoZSBkaXNjb3ZlcnkgZG9jdW1lbnQgY29udGVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVdlbGxLbm93bk1jcERpc2NvdmVyeT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIER5bmFtb0RCIHRhYmxlIGZvciBNQ1Agc2Vzc2lvbiBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiBEeW5hbW9EQiB0YWJsZSBuYW1lIChvbmx5IHVzZWQgd2hlbiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZSkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoYXV0by1nZW5lcmF0ZWQpXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIFRUTCBpbiBtaW51dGVzIChleHBvc2VkIHRvIHRoZSBoYW5kbGVyIGFzIE1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTKS5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBEeW5hbW9EQiB0YWJsZSBmb3Igc3RyZWFtL2V2ZW50IGxvZyBzdG9yYWdlLlxuICAgKlxuICAgKiBUaGlzIGlzIGludGVuZGVkIGZvciBkdXJhYmxlIHJlc3VtYWJsZSBTU0UgaW1wbGVtZW50YXRpb25zIHdoZXJlIHN0cmVhbVxuICAgKiBldmVudHMgbXVzdCBzdXJ2aXZlIExhbWJkYSBjb250YWluZXIgcmVjeWNsaW5nLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU3RyZWFtVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTdHJlYW0gRHluYW1vREIgdGFibGUgbmFtZSAob25seSB1c2VkIHdoZW4gZW5hYmxlU3RyZWFtVGFibGUgaXMgdHJ1ZSkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoYXV0by1nZW5lcmF0ZWQpXG4gICAqL1xuICByZWFkb25seSBzdHJlYW1UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0cmVhbS9ldmVudCBUVEwgaW4gbWludXRlcyAoZXhwb3NlZCB0byB0aGUgaGFuZGxlciBhcyBNQ1BfU1RSRUFNX1RUTF9NSU5VVEVTKS5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHN0cmVhbVR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIER5bmFtb0RCIHRhYmxlIGZvciBNQ1AgdGFzayBydW50aW1lIHN0YXRlLlxuICAgKlxuICAgKiBUYXNrIHN0YXRlIGlzIHNlc3Npb24tc2NvcGVkIGFuZCBkdXJhYmxlIHNvIHRhc2stYXVnbWVudGVkIHRvb2wgZXhlY3V0aW9uXG4gICAqIGNhbiBzdXJ2aXZlIExhbWJkYSBjb250YWluZXIgcmVjeWNsaW5nIHdoaWxlIHByZXNlcnZpbmcgQXBwVGhlb3J5J3NcbiAgICogZmFpbC1jbG9zZWQgc2Vzc2lvbiBib3VuZGFyeS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVRhc2tUYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRhc2sgRHluYW1vREIgdGFibGUgbmFtZSAob25seSB1c2VkIHdoZW4gZW5hYmxlVGFza1RhYmxlIGlzIHRydWUpLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGF1dG8tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgdGFza1RhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGFzayBUVEwgaW4gbWludXRlcyAoZXhwb3NlZCB0byB0aGUgaGFuZGxlciBhcyBNQ1BfVEFTS19UVExfTUlOVVRFUykuXG4gICAqIEBkZWZhdWx0IDEwXG4gICAqL1xuICByZWFkb25seSB0YXNrVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogSW5saW5lIGJ5dGUgdGhyZXNob2xkIGZvciBNQ1Agc3RyZWFtIGV2ZW50cyBiZWZvcmUgQXBwVGhlb3J5IHNwaWxscyB0aGVcbiAgICogbG9naWNhbCBldmVudCBwYXlsb2FkIHRvIHRoZSBtYW5hZ2VkIFMzIHNwaWxsIGJ1Y2tldC5cbiAgICpcbiAgICogVGhpcyBpcyBhIHN0b3JhZ2UgdGhyZXNob2xkIG9ubHkuIE1DUCBjbGllbnRzIHN0aWxsIHJlY2VpdmUgb25lIGxvZ2ljYWxcbiAgICogSlNPTi1SUEMgcmVzcG9uc2UgZXZlbnQgYW5kIHJlcGxheSBjb250aW51ZXMgdG8gdXNlIExhc3QtRXZlbnQtSUQuIFRoZVxuICAgKiB2YWx1ZSBtdXN0IG5vdCBleGNlZWQgQXBwVGhlb3J5J3MgRHluYW1vREItc2FmZSBpbmxpbmUgY2VpbGluZyBvZiAzNTg0MDBcbiAgICogYnl0ZXMuXG4gICAqXG4gICAqIEBkZWZhdWx0IDMyNzY4XG4gICAqL1xuICByZWFkb25seSBzdHJlYW1TcGlsbElubGluZU1heEJ5dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBIYXJkIG1heGltdW0gYnl0ZSBzaXplIGZvciBhIHNpbmdsZSBsb2dpY2FsIE1DUCBzdHJlYW0gZXZlbnQuXG4gICAqXG4gICAqIEV2ZW50cyBvdmVyIHRoaXMgc2l6ZSBmYWlsIGNsb3NlZCB3aXRoIGEgc3RhYmxlIHN0cmVhbSBkZWxpdmVyeSBlcnJvclxuICAgKiByYXRoZXIgdGhhbiB0aW1pbmcgb3V0IGFmdGVyIGEgZmFpbGVkIHBlcnNpc3RlbmNlIGFwcGVuZC5cbiAgICpcbiAgICogQGRlZmF1bHQgMTA0ODU3NjBcbiAgICovXG4gIHJlYWRvbmx5IHN0cmVhbU1heEV2ZW50Qnl0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBHYXRld2F5IGF1dGhvcml6ZXIgYXBwbGllZCB0byB0aGUgTUNQIHJvdXRlcy5cbiAgICpcbiAgICogVGhpcyBhZGRzIGVkZ2UtbGV2ZWwgYXV0aG9yaXphdGlvbiBpbiBmcm9udCBvZiB0aGUgTGFtYmRhIGhhbmRsZXIuIEl0IGRvZXNcbiAgICogbm90IHJlcGxhY2UgdGhlIGFwcC1sZXZlbCBPQXV0aCBtaWRkbGV3YXJlLCB3aGljaCBzdGlsbCBvd25zIHRoZSBSRkMgOTcyOFxuICAgKiBkaXNjb3ZlcnkgY2hhbGxlbmdlIGFuZCBiZWFyZXItdG9rZW4gdmFsaWRhdGlvbi5cbiAgICpcbiAgICogV2hlbiBvbWl0dGVkLCB0aGUgcm91dGVzIGtlZXAgQVBJIEdhdGV3YXkncyBvcGVuIGRlZmF1bHRcbiAgICogKGBBdXRob3JpemF0aW9uVHlwZS5OT05FYCkuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gYXV0aG9yaXplcilcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemF0aW9uIHR5cGUgZm9yIHRoZSBNQ1Agcm91dGVzLlxuICAgKlxuICAgKiBVc3VhbGx5IG9taXR0ZWQ6IHdoZW4gYGF1dGhvcml6ZXJgIGlzIHNldCwgQVBJIEdhdGV3YXkgZGVyaXZlcyB0aGUgdHlwZVxuICAgKiBmcm9tIHRoZSBhdXRob3JpemVyIGl0c2VsZi4gU2V0IHRoaXMgZXhwbGljaXRseSB0byBvdmVycmlkZSB0aGF0IGluZmVyZW5jZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChkZXJpdmVkIGZyb20gYGF1dGhvcml6ZXJgLCBvciBgTk9ORWAgd2hlbiBubyBhdXRob3JpemVyIGlzIHNldClcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25UeXBlPzogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZTtcbn1cblxuLyoqXG4gKiBBIENsYXVkZS1maXJzdCBSZW1vdGUgTUNQIHNlcnZlciBjb25zdHJ1Y3QgdGhhdCBwcm92aXNpb25zOlxuICogLSBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MVxuICogLSBTdHJlYW1pbmctZW5hYmxlZCBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb25zIGZvciBgL21jcGAgKFBPU1QvR0VUKSB1c2luZ1xuICogICBMYW1iZGEgcmVzcG9uc2Ugc3RyZWFtaW5nIChgL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc2ApXG4gKiAtIE9wdGlvbmFsIER5bmFtb0RCIHRhYmxlcyBmb3Igc2Vzc2lvbnMsIHN0cmVhbXMsIGFuZCB0YXNrIHJ1bnRpbWUgc3RhdGVcbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBkZXNpZ25lZCBmb3IgTUNQIFN0cmVhbWFibGUgSFRUUCAoMjAyNS0wNi0xOCkuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgUkVTVCBBUEkgcm91dGVyLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlcjogQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjtcblxuICAvKipcbiAgICogVGhlIE1DUCBlbmRwb2ludCBVUkwgb3IgdGVtcGxhdGUgKGAuLi4vbWNwYCBvciBgLi4uL21jcC97YWN0b3J9YCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHJvdXRlLWRlcml2ZWQgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIFVSTCB0ZW1wbGF0ZS5cbiAgICpcbiAgICogRGVyaXZlZCBmcm9tIHRoZSBzYW1lIHJvdXRlIG1vZGVsIGFzIGBlbmRwb2ludGAgdGhyb3VnaCB0aGUgc2hhcmVkIE1DUFxuICAgKiByb3V0ZSBhbGdlYnJhOiB0aGUgYWxnZWJyYSdzIHJlc291cmNlLXBhdGgg4oaSIHByb3RlY3RlZC1yZXNvdXJjZS1wYXRoXG4gICAqIGRlcml2YXRpb24gYXBwbGllZCB0byB0aGUgdHJhbnNwb3J0IHJlc291cmNlIHBhdGgsIG1vdW50ZWQgb24gdGhlIHNhbWVcbiAgICogb3JpZ2luLiBXaXRoIGBhY3RvclBhdGhgIGVuYWJsZWQgdGhpcyBpcyBhIHBlci1hY3RvciB0ZW1wbGF0ZSBzdWNoIGFzXG4gICAqIGBodHRwczovL3thcGlJZH0uZXhlY3V0ZS1hcGkue3JlZ2lvbn0uYW1hem9uYXdzLmNvbS9wcm9kLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS9tY3Ave2FjdG9yfWA7XG4gICAqIG90aGVyd2lzZSBpdCBpcyB0aGUgZmFtaWx5LXdpZGVcbiAgICogYGh0dHBzOi8ve2FwaUlkfS5leGVjdXRlLWFwaS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3Byb2QvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlL21jcGAuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIGNvbnN0cnVjdCdzIHJvdXRlLWRlcml2ZWQgcGVyLWFjdG9yIGNoYWxsZW5nZSBzdXJmYWNlLiBUaGVcbiAgICogY29uc3RydWN0IGluamVjdHMgbm8gZW52aXJvbm1lbnQgdmFyaWFibGUgKHRoZSBmcmFtZXdvcmstaW5qZWN0ZWRcbiAgICogYE1DUF9FTkRQT0lOVGAgaXMgcmV0aXJlZCksIHNvIHBhc3MgdGhpcyB2YWx1ZSBpbnRvIHRoZSBhZG9wdGVyJ3Mgb3duIGFwcFxuICAgKiBjb2RlIGFuZCBjb25maWd1cmUgaXQgYXMgdGhlIHJ1bnRpbWUncyBiZWFyZXIgdGVtcGxhdGUgb3B0aW9uIOKAlFxuICAgKiBgb2F1dGguUmVxdWlyZUJlYXJlclRva2VuT3B0aW9uc3tSZXNvdXJjZU1ldGFkYXRhVVJMVGVtcGxhdGU6IC4uLn1gIChHbyksXG4gICAqIGByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlKHsgcmVzb3VyY2VNZXRhZGF0YVVSTFRlbXBsYXRlOiAuLi4gfSlgXG4gICAqIChUeXBlU2NyaXB0KSwgb3JcbiAgICogYFJlcXVpcmVCZWFyZXJUb2tlbk9wdGlvbnMocmVzb3VyY2VfbWV0YWRhdGFfdXJsX3RlbXBsYXRlPS4uLilgIChQeXRob24pIOKAlFxuICAgKiBzbyB0aGUgcnVudGltZSByZXNvbHZlcyBge2FjdG9yfWAgZnJvbSB0aGUgbWF0Y2hlZCByb3V0ZSBhbmQgYWR2ZXJ0aXNlcyBhXG4gICAqIG1hdGNoaW5nIGBXV1ctQXV0aGVudGljYXRlYCBjaGFsbGVuZ2UuIFBhc3NpbmcgaXQgYXMgYSBzdGF0aWNcbiAgICogYFJlc291cmNlTWV0YWRhdGFVUkxgIHdvdWxkIGFkdmVydGlzZSB0aGUgbGl0ZXJhbCBge2FjdG9yfWAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgRHluYW1vREIgc2Vzc2lvbiB0YWJsZSAoaWYgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgRHluYW1vREIgc3RyZWFtL2V2ZW50IGxvZyB0YWJsZSAoaWYgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RyZWFtVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBEeW5hbW9EQiB0YXNrIHJ1bnRpbWUgdGFibGUgKGlmIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHRhc2tUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICAvKipcbiAgICogVGhlIFMzIHNwaWxsIGJ1Y2tldCBmb3IgbGFyZ2Ugc3RyZWFtIGV2ZW50IHBheWxvYWRzIChpZiBzdHJlYW0gc3RvcmFnZSBpcyBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdHJlYW1TcGlsbEJ1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMucm91dGVyID0gbmV3IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5kZXNjcmlwdGlvbixcbiAgICAgIHN0YWdlOiBwcm9wcy5zdGFnZSxcbiAgICAgIGNvcnM6IHByb3BzLmNvcnMsXG4gICAgICBkb21haW46IHByb3BzLmRvbWFpbixcbiAgICAgIGFsbG93VGVzdEludm9rZTogcHJvcHMuYWxsb3dUZXN0SW52b2tlLFxuICAgICAgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kLFxuICAgICAgYXV0aG9yaXplcjogcHJvcHMuYXV0aG9yaXplcixcbiAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBwcm9wcy5hdXRob3JpemF0aW9uVHlwZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJvdXRlTW9kZWwgPSByZW1vdGVNY3BSb3V0ZU1vZGVsKHByb3BzLmFjdG9yUGF0aCk7XG4gICAgY29uc3QgdHJhbnNwb3J0UGF0aCA9IHJvdXRlTW9kZWwucmVzb3VyY2VQYXRoO1xuXG4gICAgLy8gU3RyZWFtYWJsZSBIVFRQIHJvdXRlcyAoc3RyZWFtaW5nIGVuYWJsZWQgZm9yIFNTRSBkZWxpdmVyeSlcbiAgICB0aGlzLnJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbih0cmFuc3BvcnRQYXRoLCBbXCJQT1NUXCJdLCBwcm9wcy5oYW5kbGVyLCB7IHN0cmVhbWluZzogdHJ1ZSB9KTtcbiAgICB0aGlzLnJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbih0cmFuc3BvcnRQYXRoLCBbXCJHRVRcIl0sIHByb3BzLmhhbmRsZXIsIHsgc3RyZWFtaW5nOiB0cnVlIH0pO1xuICAgIHRoaXMucm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKHRyYW5zcG9ydFBhdGgsIFtcIkRFTEVURVwiXSwgcHJvcHMuaGFuZGxlcik7XG5cbiAgICBpZiAocHJvcHMuYWN0b3JQYXRoKSB7XG4gICAgICB0aGlzLnJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgcm91dGVNb2RlbC5wcm90ZWN0ZWRSZXNvdXJjZVBhdGgsXG4gICAgICAgIFtcIkdFVFwiXSxcbiAgICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgICk7XG5cbiAgICAgIC8vIEFEVi0xMTQ4LTE6IHRoZSBwZXItYWN0b3Igcm91dGUgaXMgYWR2ZXJ0aXNlZCBhcyBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybGBcbiAgICAgIC8vIChhIFVSTCB0ZW1wbGF0ZSBlbmRpbmcgaW4gYC9tY3Ave2FjdG9yfWApLiBObyBlbnZpcm9ubWVudCB2YXJpYWJsZSBpcyBpbmplY3RlZCxcbiAgICAgIC8vIHNvIHRoZSBhZG9wdGVyIG11c3Qgd2lyZSB0aGUgdmFsdWUgZXhwbGljaXRseSBpbiB0aGVpciBvd24gYXBwIGNvZGUuXG4gICAgICBBbm5vdGF0aW9ucy5vZih0aGlzKS5hZGRXYXJuaW5nKFxuICAgICAgICBgYWN0b3JQYXRoOiB0cnVlIG1vdW50cyB0aGUgcGVyLWFjdG9yIHJvdXRlIFwiJHtyb3V0ZU1vZGVsLnByb3RlY3RlZFJlc291cmNlUGF0aH1cIiBhbmQgYWR2ZXJ0aXNlcyBpdCB2aWEgdGhlIFwicHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybFwiIHByb3BlcnR5LiBgICtcbiAgICAgICAgXCJUaGlzIGNvbnN0cnVjdCBpbmplY3RzIG5vIGVudmlyb25tZW50IHZhcmlhYmxlICh0aGUgZnJhbWV3b3JrLWluamVjdGVkIE1DUF9FTkRQT0lOVCBpcyByZXRpcmVkKSwgc28gcGFzcyBcXFwicHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybFxcXCIgaW50byB5b3VyIG93biBhcHAgY29uZmlndXJhdGlvbiBhbmQgc2V0IGl0IGFzIHRoZSBydW50aW1lJ3MgYmVhcmVyIHRlbXBsYXRlIG9wdGlvbjogXCIgK1xuICAgICAgICBcIkdvIG9hdXRoLlJlcXVpcmVCZWFyZXJUb2tlbk9wdGlvbnN7UmVzb3VyY2VNZXRhZGF0YVVSTFRlbXBsYXRlOiAuLi59LCBcIiArXG4gICAgICAgIFwiVHlwZVNjcmlwdCByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlKHsgcmVzb3VyY2VNZXRhZGF0YVVSTFRlbXBsYXRlOiAuLi4gfSksIFwiICtcbiAgICAgICAgXCJQeXRob24gUmVxdWlyZUJlYXJlclRva2VuT3B0aW9ucyhyZXNvdXJjZV9tZXRhZGF0YV91cmxfdGVtcGxhdGU9Li4uKS4gXCIgK1xuICAgICAgICBcIldpdGhvdXQgdGhhdCB3aXJpbmcgdGhlIHByb3RlY3RlZCBwZXItYWN0b3Igcm91dGUgYWR2ZXJ0aXNlcyBvbmx5IHRoZSBiYXJlIFxcXCJCZWFyZXJcXFwiIGNoYWxsZW5nZS5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5lbmFibGVXZWxsS25vd25NY3BEaXNjb3ZlcnkpIHtcbiAgICAgIHRoaXMucm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKFwiLy53ZWxsLWtub3duL21jcC5qc29uXCIsIFtcIkdFVFwiXSwgcHJvcHMuaGFuZGxlcik7XG4gICAgfVxuXG4gICAgLy8gT3B0aW9uYWwgc2Vzc2lvbiB0YWJsZSAobWF0Y2hlcyBydW50aW1lL21jcC9zZXNzaW9uX2R5bmFtby5nbyBzY2hlbWEpXG4gICAgaWYgKHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLnNlc3Npb25UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNlc3Npb25UYWJsZSkge1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHByb3BzLnNlc3Npb25UdGxNaW51dGVzID8/IDYwKSk7XG4gICAgfVxuXG4gICAgdGhpcy52YWxpZGF0ZVN0cmVhbVNwaWxsVGhyZXNob2xkcyhwcm9wcyk7XG5cbiAgICAvLyBPcHRpb25hbCBzdHJlYW0vZXZlbnQgbG9nIHRhYmxlIChzY2hlbWEgaXMgb3BpbmlvbmF0ZWQgYnV0IGludGVudGlvbmFsbHkgZmxleGlibGUpXG4gICAgaWYgKHByb3BzLmVuYWJsZVN0cmVhbVRhYmxlKSB7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlN0cmVhbVRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5zdHJlYW1UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IFwiZXZlbnRJZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnN0cmVhbVRhYmxlID0gdGFibGU7XG5cbiAgICAgIGNvbnN0IHNwaWxsQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIlN0cmVhbVNwaWxsQnVja2V0XCIsIHtcbiAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBleHBpcmF0aW9uOiBEdXJhdGlvbi5kYXlzKHN0cmVhbVNwaWxsRXhwaXJhdGlvbkRheXMocHJvcHMuc3RyZWFtVHRsTWludXRlcyA/PyA2MCkpLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHNwaWxsQnVja2V0LmdyYW50UmVhZFdyaXRlKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zdHJlYW1TcGlsbEJ1Y2tldCA9IHNwaWxsQnVja2V0O1xuICAgIH1cblxuICAgIGlmICh0aGlzLnN0cmVhbVRhYmxlKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NUUkVBTV9UQUJMRVwiLCB0aGlzLnN0cmVhbVRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NUUkVBTV9UVExfTUlOVVRFU1wiLCBTdHJpbmcocHJvcHMuc3RyZWFtVHRsTWludXRlcyA/PyA2MCkpO1xuICAgICAgaWYgKHRoaXMuc3RyZWFtU3BpbGxCdWNrZXQpIHtcbiAgICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TVFJFQU1fU1BJTExfQlVDS0VUXCIsIHRoaXMuc3RyZWFtU3BpbGxCdWNrZXQuYnVja2V0TmFtZSk7XG4gICAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU1RSRUFNX1NQSUxMX1BSRUZJWFwiLCBcIm1jcC1zdHJlYW0tZXZlbnRzXCIpO1xuICAgICAgICB0aGlzLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICAgICAgXCJNQ1BfU1RSRUFNX1NQSUxMX0lOTElORV9NQVhfQllURVNcIixcbiAgICAgICAgICBTdHJpbmcocHJvcHMuc3RyZWFtU3BpbGxJbmxpbmVNYXhCeXRlcyA/PyBTVFJFQU1fU1BJTExfSU5MSU5FX0RFRkFVTFRfQllURVMpLFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmFkZEVudmlyb25tZW50KFxuICAgICAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICAgICAgXCJNQ1BfU1RSRUFNX01BWF9FVkVOVF9CWVRFU1wiLFxuICAgICAgICAgIFN0cmluZyhwcm9wcy5zdHJlYW1NYXhFdmVudEJ5dGVzID8/IFNUUkVBTV9NQVhfRVZFTlRfREVGQVVMVF9CWVRFUyksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gT3B0aW9uYWwgdGFzayB0YWJsZSAobWF0Y2hlcyBydW50aW1lL21jcC90YXNrX2R5bmFtby5nbyBzY2hlbWEpXG4gICAgaWYgKHByb3BzLmVuYWJsZVRhc2tUYWJsZSkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJUYXNrVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLnRhc2tUYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IFwidGFza0lkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG5cbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMudGFza1RhYmxlID0gdGFibGU7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMudGFza1RhYmxlKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1RBU0tfVEFCTEVcIiwgdGhpcy50YXNrVGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfVEFTS19UVExfTUlOVVRFU1wiLCBTdHJpbmcocHJvcHMudGFza1R0bE1pbnV0ZXMgPz8gMTApKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFnZU5hbWUgPSBwcm9wcy5zdGFnZT8uc3RhZ2VOYW1lID8/IFwicHJvZFwiO1xuICAgIGNvbnN0IGVuZHBvaW50T3JpZ2luID0gY29tcHV0ZUVuZHBvaW50T3JpZ2luKHRoaXMucm91dGVyLCBzdGFnZU5hbWUsIHByb3BzLmRvbWFpbik7XG4gICAgdGhpcy5lbmRwb2ludCA9IGAke2VuZHBvaW50T3JpZ2lufSR7cm91dGVNb2RlbC5yZXNvdXJjZVBhdGh9YDtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFVcmwgPSBgJHtlbmRwb2ludE9yaWdpbn0ke3JvdXRlTW9kZWwucHJvdGVjdGVkUmVzb3VyY2VQYXRofWA7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGFuIGVudmlyb25tZW50IHZhcmlhYmxlIHRvIHRoZSBMYW1iZGEgZnVuY3Rpb24uXG4gICAqIFVzZXMgYWRkRW52aXJvbm1lbnQgaWYgYXZhaWxhYmxlIChGdW5jdGlvbiksIG90aGVyd2lzZSBuby1vcCBmb3IgaW1wb3J0ZWQgZnVuY3Rpb25zLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgdmFsaWRhdGVTdHJlYW1TcGlsbFRocmVzaG9sZHMocHJvcHM6IEFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gICAgY29uc3QgaW5saW5lTWF4ID0gcHJvcHMuc3RyZWFtU3BpbGxJbmxpbmVNYXhCeXRlcyA/PyBTVFJFQU1fU1BJTExfSU5MSU5FX0RFRkFVTFRfQllURVM7XG4gICAgY29uc3QgZXZlbnRNYXggPSBwcm9wcy5zdHJlYW1NYXhFdmVudEJ5dGVzID8/IFNUUkVBTV9NQVhfRVZFTlRfREVGQVVMVF9CWVRFUztcblxuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihpbmxpbmVNYXgpIHx8IGlubGluZU1heCA8PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXI6IHN0cmVhbVNwaWxsSW5saW5lTWF4Qnl0ZXMgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJcIik7XG4gICAgfVxuICAgIGlmIChpbmxpbmVNYXggPiBTVFJFQU1fU1BJTExfSU5MSU5FX1NBRkVfTUFYX0JZVEVTKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXI6IHN0cmVhbVNwaWxsSW5saW5lTWF4Qnl0ZXMgbXVzdCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gJHtTVFJFQU1fU1BJTExfSU5MSU5FX1NBRkVfTUFYX0JZVEVTfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoZXZlbnRNYXgpIHx8IGV2ZW50TWF4IDw9IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlcjogc3RyZWFtTWF4RXZlbnRCeXRlcyBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlclwiKTtcbiAgICB9XG4gICAgaWYgKGV2ZW50TWF4IDwgaW5saW5lTWF4KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXI6IHN0cmVhbU1heEV2ZW50Qnl0ZXMgbXVzdCBiZSBncmVhdGVyIHRoYW4gb3IgZXF1YWwgdG8gc3RyZWFtU3BpbGxJbmxpbmVNYXhCeXRlc1wiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gc3RyZWFtU3BpbGxFeHBpcmF0aW9uRGF5cyh0dGxNaW51dGVzOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh0dGxNaW51dGVzKSB8fCB0dGxNaW51dGVzIDw9IDApIHtcbiAgICByZXR1cm4gMTtcbiAgfVxuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKHR0bE1pbnV0ZXMgLyAoMjQgKiA2MCkpKTtcbn1cblxuLyoqIFRoZSBjb25zdHJ1Y3QncyByb3V0ZSBtb2RlbCwgZGVyaXZlZCB0aHJvdWdoIHRoZSBzaGFyZWQgTUNQIHJvdXRlIGFsZ2VicmEuICovXG5pbnRlcmZhY2UgUmVtb3RlTWNwUm91dGVNb2RlbCB7XG4gIC8qKiBNQ1AgdHJhbnNwb3J0IHJlc291cmNlIHBhdGggKGAvbWNwYCBvciBgL21jcC97YWN0b3J9YCkuICovXG4gIHJlYWRvbmx5IHJlc291cmNlUGF0aDogc3RyaW5nO1xuXG4gIC8qKiBBbGdlYnJhLWRlcml2ZWQgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHJvdXRlLiAqL1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6IHN0cmluZztcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgcm91dGUgbW9kZWwgZnJvbSB0aGUgc2hhcmVkIE1DUCByb3V0ZS1hbGdlYnJhIHN1cmZhY2UuXG4gKlxuICogVGhlIHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZSBpcyBuZXZlciBoYW5kLXdyaXR0ZW46IGl0IGlzIHRoZSBhbGdlYnJhJ3NcbiAqIHJlc291cmNlLXBhdGgg4oaSIHByb3RlY3RlZC1yZXNvdXJjZS1wYXRoIGRlcml2YXRpb24sIHNvIHRoZSBtb3VudGVkIG1ldGFkYXRhXG4gKiByb3V0ZSBhbmQgdGhlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhVXJsYCB0ZW1wbGF0ZSBjYW5ub3QgZHJpZnQuIFRoZVxuICogYHthY3Rvcn1gIHBsYWNlaG9sZGVyIHN1cnZpdmVzIHRoZSBkZXJpdmF0aW9uIGludGFjdC5cbiAqL1xuZnVuY3Rpb24gcmVtb3RlTWNwUm91dGVNb2RlbChhY3RvclBhdGg/OiBib29sZWFuKTogUmVtb3RlTWNwUm91dGVNb2RlbCB7XG4gIGNvbnN0IHJlc291cmNlUGF0aCA9IGFjdG9yUGF0aFxuICAgID8gYCR7QXBwVGhlb3J5TWNwUGF0aHMuTUNQfS97YWN0b3J9YFxuICAgIDogQXBwVGhlb3J5TWNwUGF0aHMuTUNQO1xuICByZXR1cm4ge1xuICAgIHJlc291cmNlUGF0aCxcbiAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRnJvbU1jcFBhdGgocmVzb3VyY2VQYXRoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY29tcHV0ZUVuZHBvaW50T3JpZ2luKFxuICByb3V0ZXI6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIsXG4gIHN0YWdlTmFtZTogc3RyaW5nLFxuICBkb21haW4/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyxcbik6IHN0cmluZyB7XG4gIGlmICghZG9tYWluKSB7XG4gICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihyb3V0ZXIpO1xuICAgIGNvbnN0IHN0YWdlID0gU3RyaW5nKHN0YWdlTmFtZSA/PyBcIlwiKS50cmltKCkgfHwgXCJwcm9kXCI7XG4gICAgcmV0dXJuIGBodHRwczovLyR7cm91dGVyLmFwaS5yZXN0QXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH0vJHtzdGFnZX1gO1xuICB9XG5cbiAgY29uc3QgYmFzZVBhdGggPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhkb21haW4uYmFzZVBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gIGNvbnN0IHByZWZpeCA9IGJhc2VQYXRoID8gYC8ke2Jhc2VQYXRofWAgOiBcIlwiO1xuICByZXR1cm4gYGh0dHBzOi8vJHtkb21haW4uZG9tYWluTmFtZX0ke3ByZWZpeH1gO1xufVxuIl19