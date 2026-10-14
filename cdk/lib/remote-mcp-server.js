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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer", version: "6.0.0" };
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
     * This is the construct's route-derived per-actor challenge surface. Pass it
     * to `oauth.RequireBearerTokenOptions{ResourceMetadataURL: ...}` so the
     * runtime advertises a matching `WWW-Authenticate` challenge; the runtime no
     * longer reads an injected `MCP_ENDPOINT` environment variable.
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
        });
        const routeModel = remoteMcpRouteModel(props.actorPath);
        const transportPath = routeModel.resourcePath;
        // Streamable HTTP routes (streaming enabled for SSE delivery)
        this.router.addLambdaIntegration(transportPath, ["POST"], props.handler, { streaming: true });
        this.router.addLambdaIntegration(transportPath, ["GET"], props.handler, { streaming: true });
        this.router.addLambdaIntegration(transportPath, ["DELETE"], props.handler);
        if (props.actorPath) {
            this.router.addLambdaIntegration(routeModel.protectedResourcePath, ["GET"], props.handler);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVtb3RlLW1jcC1zZXJ2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZW1vdGUtbWNwLXNlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTZEO0FBQzdELG1FQUFxRDtBQUVyRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBRXZDLHVEQUsyQjtBQUMzQiwyQ0FBZ0Q7QUFDaEQsMkRBQStEO0FBQy9ELHlEQUEwRDtBQUUxRCxNQUFNLGlDQUFpQyxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDcEQsTUFBTSxrQ0FBa0MsR0FBRyxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ3RELE1BQU0sOEJBQThCLEdBQUcsRUFBRSxHQUFHLElBQUksR0FBRyxJQUFJLENBQUM7QUF5THhEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSx3QkFBeUIsU0FBUSxzQkFBUzs7SUFDckQ7O09BRUc7SUFDYSxNQUFNLENBQXlCO0lBRS9DOztPQUVHO0lBQ2EsUUFBUSxDQUFTO0lBRWpDOzs7Ozs7Ozs7Ozs7Ozs7T0FlRztJQUNhLDRCQUE0QixDQUFTO0lBRXJEOztPQUVHO0lBQ2EsWUFBWSxDQUFtQjtJQUUvQzs7T0FFRztJQUNhLFdBQVcsQ0FBbUI7SUFFOUM7O09BRUc7SUFDYSxTQUFTLENBQW1CO0lBRTVDOztPQUVHO0lBQ2EsaUJBQWlCLENBQWM7SUFFL0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFvQztRQUM1RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSx3Q0FBc0IsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ3BELE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTztZQUN0QixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDOUIsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLElBQUks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LENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRyxJQUFBLCtCQUFnQixFQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQzdFLE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQzlDLE9BQU8sV0FBVyxNQUFNLENBQUMsVUFBVSxHQUFHLE1BQU0sRUFBRSxDQUFDO0FBQ2pELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgU3RhY2sgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQge1xuICBBcHBUaGVvcnlSZXN0QXBpUm91dGVyLFxuICB0eXBlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyxcbiAgdHlwZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyxcbiAgdHlwZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zLFxufSBmcm9tIFwiLi9yZXN0LWFwaS1yb3V0ZXJcIjtcbmltcG9ydCB7IEFwcFRoZW9yeU1jcFBhdGhzIH0gZnJvbSBcIi4vbWNwLXBhdGhzXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmNvbnN0IFNUUkVBTV9TUElMTF9JTkxJTkVfREVGQVVMVF9CWVRFUyA9IDMyICogMTAyNDtcbmNvbnN0IFNUUkVBTV9TUElMTF9JTkxJTkVfU0FGRV9NQVhfQllURVMgPSAzNTAgKiAxMDI0O1xuY29uc3QgU1RSRUFNX01BWF9FVkVOVF9ERUZBVUxUX0JZVEVTID0gMTAgKiAxMDI0ICogMTAyNDtcblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlciBjb25zdHJ1Y3QuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgaXMgaW50ZW5kZWQgZm9yIENsYXVkZS1maXJzdCBSZW1vdGUgTUNQIGRlcGxveW1lbnRzOlxuICogLSBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSAocmVxdWlyZWQgZm9yIHJlc3BvbnNlIHN0cmVhbWluZylcbiAqIC0gU3RyZWFtYWJsZSBIVFRQIG1vdW50IGF0IGAvbWNwYCAoUE9TVC9HRVQvREVMRVRFKVxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlclByb3BzIHtcbiAgLyoqXG4gICAqIFRoZSBMYW1iZGEgZnVuY3Rpb24gdGhhdCBoYW5kbGVzIE1DUCBTdHJlYW1hYmxlIEhUVFAgcmVxdWVzdHMuXG4gICAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgZGVzY3JpcHRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAocm91dGVyIGRlZmF1bHRzIGFwcGxpZWQpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJLlxuICAgKlxuICAgKiBOb3RlOiBGb3IgYnJvd3NlciBjbGllbnRzLCB5b3VyIExhbWJkYSBoYW5kbGVyIHN0aWxsIG5lZWRzIHRvIGVtaXRcbiAgICogdGhlIGFwcHJvcHJpYXRlIGBBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5gIGhlYWRlcnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gQ09SUyBwcmVmbGlnaHQpXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIEFQSSBHYXRld2F5IGNvbnNvbGUgdGVzdCBpbnZvY2F0aW9ucyBzaG91bGQgYmUgZ3JhbnRlZCBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IHN1cHByZXNzZXMgdGhlIGV4dHJhIGB0ZXN0LWludm9rZS1zdGFnZWAgTGFtYmRhIHBlcm1pc3Npb25zXG4gICAqIHRoYXQgQ0RLIGFkZHMgZm9yIGVhY2ggUkVTVCBBUEkgbWV0aG9kLiBUaGlzIHJlZHVjZXMgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIHdoaWxlXG4gICAqIHByZXNlcnZpbmcgZGVwbG95ZWQtc3RhZ2UgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBhbGxvd1Rlc3RJbnZva2U/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIFJFU1QgQVBJIG1ldGhvZHMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgbWV0aG9kL3BhdGggcGFpci4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBSZW1vdGUgTUNQXG4gICAqIHJvdXRlIGJ1bmRsZXMgdGhhdCBzaGFyZSBvbmUgaGFuZGxlci5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgcGVyLWFjdG9yIE1DUCBlbmRwb2ludCBidW5kbGVzLlxuICAgKlxuICAgKiBXaGVuIGVuYWJsZWQsIHRoZSBjb25zdHJ1Y3QgbW91bnRzIHRoZSB0cmFuc3BvcnQgYXQgYC9tY3Ave2FjdG9yfWAgYW5kXG4gICAqIGNvLXJlZ2lzdGVycyB0aGUgUkZDIDk3MjggZGlzY292ZXJ5IHJvdXRlIGF0XG4gICAqIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlL21jcC97YWN0b3J9YC5cbiAgICpcbiAgICogVGhlIHB1YmxpYyBgZW5kcG9pbnRgIGFuZCBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybGAgdGhlbiBiZWNvbWUgcm91dGVcbiAgICogdGVtcGxhdGVzIGVuZGluZyBpbiBgL21jcC97YWN0b3J9YCBhbmRcbiAgICogYC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvbWNwL3thY3Rvcn1gIHJlc3BlY3RpdmVseS4gQm90aCBhcmVcbiAgICogZGVyaXZlZCBmcm9tIHRoZSBzYW1lIHJvdXRlIG1vZGVsIHRocm91Z2ggdGhlIHNoYXJlZCBNQ1Agcm91dGUgYWxnZWJyYS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjdG9yUGF0aD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJlZ2lzdGVyIGBHRVQgLy53ZWxsLWtub3duL21jcC5qc29uYCBhbmQgcm91dGUgaXQgdG8gdGhlIGhhbmRsZXIuXG4gICAqXG4gICAqIFRoaXMgbGV0cyB0aGUgY29uc3RydWN0IG93biB0aGUgZmluYWwgTUNQIGRpc2NvdmVyeSByb3V0ZSBhbG9uZ3NpZGUgdGhlXG4gICAqIHRyYW5zcG9ydCBhbmQgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHJvdXRlcy4gVGhlIGhhbmRsZXIgcmVtYWluc1xuICAgKiByZXNwb25zaWJsZSBmb3Igc2VydmluZyB0aGUgZGlzY292ZXJ5IGRvY3VtZW50IGNvbnRlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVXZWxsS25vd25NY3BEaXNjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBEeW5hbW9EQiB0YWJsZSBmb3IgTUNQIHNlc3Npb24gc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gRHluYW1vREIgdGFibGUgbmFtZSAob25seSB1c2VkIHdoZW4gZW5hYmxlU2Vzc2lvblRhYmxlIGlzIHRydWUpLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGF1dG8tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogU2Vzc2lvbiBUVEwgaW4gbWludXRlcyAoZXhwb3NlZCB0byB0aGUgaGFuZGxlciBhcyBNQ1BfU0VTU0lPTl9UVExfTUlOVVRFUykuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQ3JlYXRlIGEgRHluYW1vREIgdGFibGUgZm9yIHN0cmVhbS9ldmVudCBsb2cgc3RvcmFnZS5cbiAgICpcbiAgICogVGhpcyBpcyBpbnRlbmRlZCBmb3IgZHVyYWJsZSByZXN1bWFibGUgU1NFIGltcGxlbWVudGF0aW9ucyB3aGVyZSBzdHJlYW1cbiAgICogZXZlbnRzIG11c3Qgc3Vydml2ZSBMYW1iZGEgY29udGFpbmVyIHJlY3ljbGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVN0cmVhbVRhYmxlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU3RyZWFtIER5bmFtb0RCIHRhYmxlIG5hbWUgKG9ubHkgdXNlZCB3aGVuIGVuYWJsZVN0cmVhbVRhYmxlIGlzIHRydWUpLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGF1dG8tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc3RyZWFtVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdHJlYW0vZXZlbnQgVFRMIGluIG1pbnV0ZXMgKGV4cG9zZWQgdG8gdGhlIGhhbmRsZXIgYXMgTUNQX1NUUkVBTV9UVExfTUlOVVRFUykuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSBzdHJlYW1UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBEeW5hbW9EQiB0YWJsZSBmb3IgTUNQIHRhc2sgcnVudGltZSBzdGF0ZS5cbiAgICpcbiAgICogVGFzayBzdGF0ZSBpcyBzZXNzaW9uLXNjb3BlZCBhbmQgZHVyYWJsZSBzbyB0YXNrLWF1Z21lbnRlZCB0b29sIGV4ZWN1dGlvblxuICAgKiBjYW4gc3Vydml2ZSBMYW1iZGEgY29udGFpbmVyIHJlY3ljbGluZyB3aGlsZSBwcmVzZXJ2aW5nIEFwcFRoZW9yeSdzXG4gICAqIGZhaWwtY2xvc2VkIHNlc3Npb24gYm91bmRhcnkuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVUYXNrVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBUYXNrIER5bmFtb0RCIHRhYmxlIG5hbWUgKG9ubHkgdXNlZCB3aGVuIGVuYWJsZVRhc2tUYWJsZSBpcyB0cnVlKS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChhdXRvLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHRhc2tUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRhc2sgVFRMIGluIG1pbnV0ZXMgKGV4cG9zZWQgdG8gdGhlIGhhbmRsZXIgYXMgTUNQX1RBU0tfVFRMX01JTlVURVMpLlxuICAgKiBAZGVmYXVsdCAxMFxuICAgKi9cbiAgcmVhZG9ubHkgdGFza1R0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIElubGluZSBieXRlIHRocmVzaG9sZCBmb3IgTUNQIHN0cmVhbSBldmVudHMgYmVmb3JlIEFwcFRoZW9yeSBzcGlsbHMgdGhlXG4gICAqIGxvZ2ljYWwgZXZlbnQgcGF5bG9hZCB0byB0aGUgbWFuYWdlZCBTMyBzcGlsbCBidWNrZXQuXG4gICAqXG4gICAqIFRoaXMgaXMgYSBzdG9yYWdlIHRocmVzaG9sZCBvbmx5LiBNQ1AgY2xpZW50cyBzdGlsbCByZWNlaXZlIG9uZSBsb2dpY2FsXG4gICAqIEpTT04tUlBDIHJlc3BvbnNlIGV2ZW50IGFuZCByZXBsYXkgY29udGludWVzIHRvIHVzZSBMYXN0LUV2ZW50LUlELiBUaGVcbiAgICogdmFsdWUgbXVzdCBub3QgZXhjZWVkIEFwcFRoZW9yeSdzIER5bmFtb0RCLXNhZmUgaW5saW5lIGNlaWxpbmcgb2YgMzU4NDAwXG4gICAqIGJ5dGVzLlxuICAgKlxuICAgKiBAZGVmYXVsdCAzMjc2OFxuICAgKi9cbiAgcmVhZG9ubHkgc3RyZWFtU3BpbGxJbmxpbmVNYXhCeXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogSGFyZCBtYXhpbXVtIGJ5dGUgc2l6ZSBmb3IgYSBzaW5nbGUgbG9naWNhbCBNQ1Agc3RyZWFtIGV2ZW50LlxuICAgKlxuICAgKiBFdmVudHMgb3ZlciB0aGlzIHNpemUgZmFpbCBjbG9zZWQgd2l0aCBhIHN0YWJsZSBzdHJlYW0gZGVsaXZlcnkgZXJyb3JcbiAgICogcmF0aGVyIHRoYW4gdGltaW5nIG91dCBhZnRlciBhIGZhaWxlZCBwZXJzaXN0ZW5jZSBhcHBlbmQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDEwNDg1NzYwXG4gICAqL1xuICByZWFkb25seSBzdHJlYW1NYXhFdmVudEJ5dGVzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEEgQ2xhdWRlLWZpcnN0IFJlbW90ZSBNQ1Agc2VydmVyIGNvbnN0cnVjdCB0aGF0IHByb3Zpc2lvbnM6XG4gKiAtIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxXG4gKiAtIFN0cmVhbWluZy1lbmFibGVkIExhbWJkYSBwcm94eSBpbnRlZ3JhdGlvbnMgZm9yIGAvbWNwYCAoUE9TVC9HRVQpIHVzaW5nXG4gKiAgIExhbWJkYSByZXNwb25zZSBzdHJlYW1pbmcgKGAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zYClcbiAqIC0gT3B0aW9uYWwgRHluYW1vREIgdGFibGVzIGZvciBzZXNzaW9ucywgc3RyZWFtcywgYW5kIHRhc2sgcnVudGltZSBzdGF0ZVxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIGRlc2lnbmVkIGZvciBNQ1AgU3RyZWFtYWJsZSBIVFRQICgyMDI1LTA2LTE4KS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVJlbW90ZU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBSRVNUIEFQSSByb3V0ZXIuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVyOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyO1xuXG4gIC8qKlxuICAgKiBUaGUgTUNQIGVuZHBvaW50IFVSTCBvciB0ZW1wbGF0ZSAoYC4uLi9tY3BgIG9yIGAuLi4vbWNwL3thY3Rvcn1gKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgcm91dGUtZGVyaXZlZCBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEgVVJMIHRlbXBsYXRlLlxuICAgKlxuICAgKiBEZXJpdmVkIGZyb20gdGhlIHNhbWUgcm91dGUgbW9kZWwgYXMgYGVuZHBvaW50YCB0aHJvdWdoIHRoZSBzaGFyZWQgTUNQXG4gICAqIHJvdXRlIGFsZ2VicmE6IHRoZSBhbGdlYnJhJ3MgcmVzb3VyY2UtcGF0aCDihpIgcHJvdGVjdGVkLXJlc291cmNlLXBhdGhcbiAgICogZGVyaXZhdGlvbiBhcHBsaWVkIHRvIHRoZSB0cmFuc3BvcnQgcmVzb3VyY2UgcGF0aCwgbW91bnRlZCBvbiB0aGUgc2FtZVxuICAgKiBvcmlnaW4uIFdpdGggYGFjdG9yUGF0aGAgZW5hYmxlZCB0aGlzIGlzIGEgcGVyLWFjdG9yIHRlbXBsYXRlIHN1Y2ggYXNcbiAgICogYGh0dHBzOi8ve2FwaUlkfS5leGVjdXRlLWFwaS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3Byb2QvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlL21jcC97YWN0b3J9YDtcbiAgICogb3RoZXJ3aXNlIGl0IGlzIHRoZSBmYW1pbHktd2lkZVxuICAgKiBgaHR0cHM6Ly97YXBpSWR9LmV4ZWN1dGUtYXBpLntyZWdpb259LmFtYXpvbmF3cy5jb20vcHJvZC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvbWNwYC5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgY29uc3RydWN0J3Mgcm91dGUtZGVyaXZlZCBwZXItYWN0b3IgY2hhbGxlbmdlIHN1cmZhY2UuIFBhc3MgaXRcbiAgICogdG8gYG9hdXRoLlJlcXVpcmVCZWFyZXJUb2tlbk9wdGlvbnN7UmVzb3VyY2VNZXRhZGF0YVVSTDogLi4ufWAgc28gdGhlXG4gICAqIHJ1bnRpbWUgYWR2ZXJ0aXNlcyBhIG1hdGNoaW5nIGBXV1ctQXV0aGVudGljYXRlYCBjaGFsbGVuZ2U7IHRoZSBydW50aW1lIG5vXG4gICAqIGxvbmdlciByZWFkcyBhbiBpbmplY3RlZCBgTUNQX0VORFBPSU5UYCBlbnZpcm9ubWVudCB2YXJpYWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhVXJsOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBEeW5hbW9EQiBzZXNzaW9uIHRhYmxlIChpZiBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBEeW5hbW9EQiBzdHJlYW0vZXZlbnQgbG9nIHRhYmxlIChpZiBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdHJlYW1UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICAvKipcbiAgICogVGhlIER5bmFtb0RCIHRhc2sgcnVudGltZSB0YWJsZSAoaWYgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdGFza1RhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgUzMgc3BpbGwgYnVja2V0IGZvciBsYXJnZSBzdHJlYW0gZXZlbnQgcGF5bG9hZHMgKGlmIHN0cmVhbSBzdG9yYWdlIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHN0cmVhbVNwaWxsQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5yb3V0ZXIgPSBuZXcgQXBwVGhlb3J5UmVzdEFwaVJvdXRlcih0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgc3RhZ2U6IHByb3BzLnN0YWdlLFxuICAgICAgY29yczogcHJvcHMuY29ycyxcbiAgICAgIGRvbWFpbjogcHJvcHMuZG9tYWluLFxuICAgICAgYWxsb3dUZXN0SW52b2tlOiBwcm9wcy5hbGxvd1Rlc3RJbnZva2UsXG4gICAgICBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QsXG4gICAgfSk7XG5cbiAgICBjb25zdCByb3V0ZU1vZGVsID0gcmVtb3RlTWNwUm91dGVNb2RlbChwcm9wcy5hY3RvclBhdGgpO1xuICAgIGNvbnN0IHRyYW5zcG9ydFBhdGggPSByb3V0ZU1vZGVsLnJlc291cmNlUGF0aDtcblxuICAgIC8vIFN0cmVhbWFibGUgSFRUUCByb3V0ZXMgKHN0cmVhbWluZyBlbmFibGVkIGZvciBTU0UgZGVsaXZlcnkpXG4gICAgdGhpcy5yb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24odHJhbnNwb3J0UGF0aCwgW1wiUE9TVFwiXSwgcHJvcHMuaGFuZGxlciwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gICAgdGhpcy5yb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24odHJhbnNwb3J0UGF0aCwgW1wiR0VUXCJdLCBwcm9wcy5oYW5kbGVyLCB7IHN0cmVhbWluZzogdHJ1ZSB9KTtcbiAgICB0aGlzLnJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbih0cmFuc3BvcnRQYXRoLCBbXCJERUxFVEVcIl0sIHByb3BzLmhhbmRsZXIpO1xuXG4gICAgaWYgKHByb3BzLmFjdG9yUGF0aCkge1xuICAgICAgdGhpcy5yb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHJvdXRlTW9kZWwucHJvdGVjdGVkUmVzb3VyY2VQYXRoLFxuICAgICAgICBbXCJHRVRcIl0sXG4gICAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMuZW5hYmxlV2VsbEtub3duTWNwRGlzY292ZXJ5KSB7XG4gICAgICB0aGlzLnJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbihcIi8ud2VsbC1rbm93bi9tY3AuanNvblwiLCBbXCJHRVRcIl0sIHByb3BzLmhhbmRsZXIpO1xuICAgIH1cblxuICAgIC8vIE9wdGlvbmFsIHNlc3Npb24gdGFibGUgKG1hdGNoZXMgcnVudGltZS9tY3Avc2Vzc2lvbl9keW5hbW8uZ28gc2NoZW1hKVxuICAgIGlmIChwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5zZXNzaW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcblxuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zZXNzaW9uVGFibGUpIHtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhwcm9wcy5zZXNzaW9uVHRsTWludXRlcyA/PyA2MCkpO1xuICAgIH1cblxuICAgIHRoaXMudmFsaWRhdGVTdHJlYW1TcGlsbFRocmVzaG9sZHMocHJvcHMpO1xuXG4gICAgLy8gT3B0aW9uYWwgc3RyZWFtL2V2ZW50IGxvZyB0YWJsZSAoc2NoZW1hIGlzIG9waW5pb25hdGVkIGJ1dCBpbnRlbnRpb25hbGx5IGZsZXhpYmxlKVxuICAgIGlmIChwcm9wcy5lbmFibGVTdHJlYW1UYWJsZSkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTdHJlYW1UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogcHJvcHMuc3RyZWFtVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBcImV2ZW50SWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcblxuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zdHJlYW1UYWJsZSA9IHRhYmxlO1xuXG4gICAgICBjb25zdCBzcGlsbEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJTdHJlYW1TcGlsbEJ1Y2tldFwiLCB7XG4gICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgZXhwaXJhdGlvbjogRHVyYXRpb24uZGF5cyhzdHJlYW1TcGlsbEV4cGlyYXRpb25EYXlzKHByb3BzLnN0cmVhbVR0bE1pbnV0ZXMgPz8gNjApKSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICBzcGlsbEJ1Y2tldC5ncmFudFJlYWRXcml0ZShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc3RyZWFtU3BpbGxCdWNrZXQgPSBzcGlsbEJ1Y2tldDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zdHJlYW1UYWJsZSkge1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TVFJFQU1fVEFCTEVcIiwgdGhpcy5zdHJlYW1UYWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TVFJFQU1fVFRMX01JTlVURVNcIiwgU3RyaW5nKHByb3BzLnN0cmVhbVR0bE1pbnV0ZXMgPz8gNjApKTtcbiAgICAgIGlmICh0aGlzLnN0cmVhbVNwaWxsQnVja2V0KSB7XG4gICAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU1RSRUFNX1NQSUxMX0JVQ0tFVFwiLCB0aGlzLnN0cmVhbVNwaWxsQnVja2V0LmJ1Y2tldE5hbWUpO1xuICAgICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NUUkVBTV9TUElMTF9QUkVGSVhcIiwgXCJtY3Atc3RyZWFtLWV2ZW50c1wiKTtcbiAgICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAgICAgIFwiTUNQX1NUUkVBTV9TUElMTF9JTkxJTkVfTUFYX0JZVEVTXCIsXG4gICAgICAgICAgU3RyaW5nKHByb3BzLnN0cmVhbVNwaWxsSW5saW5lTWF4Qnl0ZXMgPz8gU1RSRUFNX1NQSUxMX0lOTElORV9ERUZBVUxUX0JZVEVTKSxcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAgICAgIFwiTUNQX1NUUkVBTV9NQVhfRVZFTlRfQllURVNcIixcbiAgICAgICAgICBTdHJpbmcocHJvcHMuc3RyZWFtTWF4RXZlbnRCeXRlcyA/PyBTVFJFQU1fTUFYX0VWRU5UX0RFRkFVTFRfQllURVMpLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9wdGlvbmFsIHRhc2sgdGFibGUgKG1hdGNoZXMgcnVudGltZS9tY3AvdGFza19keW5hbW8uZ28gc2NoZW1hKVxuICAgIGlmIChwcm9wcy5lbmFibGVUYXNrVGFibGUpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiVGFza1RhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy50YXNrVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBcInRhc2tJZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnRhc2tUYWJsZSA9IHRhYmxlO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnRhc2tUYWJsZSkge1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9UQVNLX1RBQkxFXCIsIHRoaXMudGFza1RhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1RBU0tfVFRMX01JTlVURVNcIiwgU3RyaW5nKHByb3BzLnRhc2tUdGxNaW51dGVzID8/IDEwKSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gcHJvcHMuc3RhZ2U/LnN0YWdlTmFtZSA/PyBcInByb2RcIjtcbiAgICBjb25zdCBlbmRwb2ludE9yaWdpbiA9IGNvbXB1dGVFbmRwb2ludE9yaWdpbih0aGlzLnJvdXRlciwgc3RhZ2VOYW1lLCBwcm9wcy5kb21haW4pO1xuICAgIHRoaXMuZW5kcG9pbnQgPSBgJHtlbmRwb2ludE9yaWdpbn0ke3JvdXRlTW9kZWwucmVzb3VyY2VQYXRofWA7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhVXJsID0gYCR7ZW5kcG9pbnRPcmlnaW59JHtyb3V0ZU1vZGVsLnByb3RlY3RlZFJlc291cmNlUGF0aH1gO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZCBhbiBlbnZpcm9ubWVudCB2YXJpYWJsZSB0byB0aGUgTGFtYmRhIGZ1bmN0aW9uLlxuICAgKiBVc2VzIGFkZEVudmlyb25tZW50IGlmIGF2YWlsYWJsZSAoRnVuY3Rpb24pLCBvdGhlcndpc2Ugbm8tb3AgZm9yIGltcG9ydGVkIGZ1bmN0aW9ucy5cbiAgICovXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHZhbGlkYXRlU3RyZWFtU3BpbGxUaHJlc2hvbGRzKHByb3BzOiBBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICAgIGNvbnN0IGlubGluZU1heCA9IHByb3BzLnN0cmVhbVNwaWxsSW5saW5lTWF4Qnl0ZXMgPz8gU1RSRUFNX1NQSUxMX0lOTElORV9ERUZBVUxUX0JZVEVTO1xuICAgIGNvbnN0IGV2ZW50TWF4ID0gcHJvcHMuc3RyZWFtTWF4RXZlbnRCeXRlcyA/PyBTVFJFQU1fTUFYX0VWRU5UX0RFRkFVTFRfQllURVM7XG5cbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoaW5saW5lTWF4KSB8fCBpbmxpbmVNYXggPD0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyOiBzdHJlYW1TcGlsbElubGluZU1heEJ5dGVzIG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAoaW5saW5lTWF4ID4gU1RSRUFNX1NQSUxMX0lOTElORV9TQUZFX01BWF9CWVRFUykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyOiBzdHJlYW1TcGlsbElubGluZU1heEJ5dGVzIG11c3QgYmUgbGVzcyB0aGFuIG9yIGVxdWFsIHRvICR7U1RSRUFNX1NQSUxMX0lOTElORV9TQUZFX01BWF9CWVRFU31gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGV2ZW50TWF4KSB8fCBldmVudE1heCA8PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZW1vdGVNY3BTZXJ2ZXI6IHN0cmVhbU1heEV2ZW50Qnl0ZXMgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJcIik7XG4gICAgfVxuICAgIGlmIChldmVudE1heCA8IGlubGluZU1heCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVtb3RlTWNwU2VydmVyOiBzdHJlYW1NYXhFdmVudEJ5dGVzIG11c3QgYmUgZ3JlYXRlciB0aGFuIG9yIGVxdWFsIHRvIHN0cmVhbVNwaWxsSW5saW5lTWF4Qnl0ZXNcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHN0cmVhbVNwaWxsRXhwaXJhdGlvbkRheXModHRsTWludXRlczogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodHRsTWludXRlcykgfHwgdHRsTWludXRlcyA8PSAwKSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGguY2VpbCh0dGxNaW51dGVzIC8gKDI0ICogNjApKSk7XG59XG5cbi8qKiBUaGUgY29uc3RydWN0J3Mgcm91dGUgbW9kZWwsIGRlcml2ZWQgdGhyb3VnaCB0aGUgc2hhcmVkIE1DUCByb3V0ZSBhbGdlYnJhLiAqL1xuaW50ZXJmYWNlIFJlbW90ZU1jcFJvdXRlTW9kZWwge1xuICAvKiogTUNQIHRyYW5zcG9ydCByZXNvdXJjZSBwYXRoIChgL21jcGAgb3IgYC9tY3Ave2FjdG9yfWApLiAqL1xuICByZWFkb25seSByZXNvdXJjZVBhdGg6IHN0cmluZztcblxuICAvKiogQWxnZWJyYS1kZXJpdmVkIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBtZXRhZGF0YSByb3V0ZS4gKi9cbiAgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHJvdXRlIG1vZGVsIGZyb20gdGhlIHNoYXJlZCBNQ1Agcm91dGUtYWxnZWJyYSBzdXJmYWNlLlxuICpcbiAqIFRoZSBwcm90ZWN0ZWQtcmVzb3VyY2Ugcm91dGUgaXMgbmV2ZXIgaGFuZC13cml0dGVuOiBpdCBpcyB0aGUgYWxnZWJyYSdzXG4gKiByZXNvdXJjZS1wYXRoIOKGkiBwcm90ZWN0ZWQtcmVzb3VyY2UtcGF0aCBkZXJpdmF0aW9uLCBzbyB0aGUgbW91bnRlZCBtZXRhZGF0YVxuICogcm91dGUgYW5kIHRoZSBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVVybGAgdGVtcGxhdGUgY2Fubm90IGRyaWZ0LiBUaGVcbiAqIGB7YWN0b3J9YCBwbGFjZWhvbGRlciBzdXJ2aXZlcyB0aGUgZGVyaXZhdGlvbiBpbnRhY3QuXG4gKi9cbmZ1bmN0aW9uIHJlbW90ZU1jcFJvdXRlTW9kZWwoYWN0b3JQYXRoPzogYm9vbGVhbik6IFJlbW90ZU1jcFJvdXRlTW9kZWwge1xuICBjb25zdCByZXNvdXJjZVBhdGggPSBhY3RvclBhdGhcbiAgICA/IGAke0FwcFRoZW9yeU1jcFBhdGhzLk1DUH0ve2FjdG9yfWBcbiAgICA6IEFwcFRoZW9yeU1jcFBhdGhzLk1DUDtcbiAgcmV0dXJuIHtcbiAgICByZXNvdXJjZVBhdGgsXG4gICAgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZyb21NY3BQYXRoKHJlc291cmNlUGF0aCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNvbXB1dGVFbmRwb2ludE9yaWdpbihcbiAgcm91dGVyOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyLFxuICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMsXG4pOiBzdHJpbmcge1xuICBpZiAoIWRvbWFpbikge1xuICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yocm91dGVyKTtcbiAgICBjb25zdCBzdGFnZSA9IFN0cmluZyhzdGFnZU5hbWUgPz8gXCJcIikudHJpbSgpIHx8IFwicHJvZFwiO1xuICAgIHJldHVybiBgaHR0cHM6Ly8ke3JvdXRlci5hcGkucmVzdEFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9LyR7c3RhZ2V9YDtcbiAgfVxuXG4gIGNvbnN0IGJhc2VQYXRoID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoZG9tYWluLmJhc2VQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICBjb25zdCBwcmVmaXggPSBiYXNlUGF0aCA/IGAvJHtiYXNlUGF0aH1gIDogXCJcIjtcbiAgcmV0dXJuIGBodHRwczovLyR7ZG9tYWluLmRvbWFpbk5hbWV9JHtwcmVmaXh9YDtcbn1cbiJdfQ==