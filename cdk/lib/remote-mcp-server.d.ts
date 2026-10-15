import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { AppTheoryRestApiRouter, type AppTheoryRestApiRouterCorsOptions, type AppTheoryRestApiRouterDomainOptions, type AppTheoryRestApiRouterStageOptions } from "./rest-api-router";
/**
 * Props for the AppTheoryRemoteMcpServer construct.
 *
 * This construct is intended for Claude-first Remote MCP deployments:
 * - API Gateway REST API v1 (required for response streaming)
 * - Streamable HTTP mount at `/mcp` (POST/GET/DELETE)
 */
export interface AppTheoryRemoteMcpServerProps {
    /**
     * The Lambda function that handles MCP Streamable HTTP requests.
     */
    readonly handler: lambda.IFunction;
    /**
     * Optional API name.
     * @default undefined
     */
    readonly apiName?: string;
    /**
     * Optional API description.
     * @default undefined
     */
    readonly description?: string;
    /**
     * Stage configuration.
     * @default undefined (router defaults applied)
     */
    readonly stage?: AppTheoryRestApiRouterStageOptions;
    /**
     * CORS configuration for the REST API.
     *
     * Note: For browser clients, your Lambda handler still needs to emit
     * the appropriate `Access-Control-Allow-Origin` headers.
     *
     * @default undefined (no CORS preflight)
     */
    readonly cors?: boolean | AppTheoryRestApiRouterCorsOptions;
    /**
     * Optional custom domain configuration.
     * @default undefined
     */
    readonly domain?: AppTheoryRestApiRouterDomainOptions;
    /**
     * Whether API Gateway console test invocations should be granted Lambda invoke permissions.
     *
     * When false, the construct suppresses the extra `test-invoke-stage` Lambda permissions
     * that CDK adds for each REST API method. This reduces Lambda resource policy size while
     * preserving deployed-stage invoke permissions.
     *
     * @default true
     */
    readonly allowTestInvoke?: boolean;
    /**
     * Whether Lambda invoke permissions should be scoped to individual REST API methods.
     *
     * When false, the construct grants one API-scoped invoke permission per Lambda instead of
     * one permission per method/path pair. This is the scalable choice for large Remote MCP
     * route bundles that share one handler.
     *
     * @default true
     */
    readonly scopePermissionToMethod?: boolean;
    /**
     * Enable per-actor MCP endpoint bundles.
     *
     * When enabled, the construct mounts the transport at `/mcp/{actor}` and
     * co-registers the RFC 9728 discovery route at
     * `/.well-known/oauth-protected-resource/mcp/{actor}`.
     *
     * The public `endpoint` and `protectedResourceMetadataUrl` then become route
     * templates ending in `/mcp/{actor}` and
     * `/.well-known/oauth-protected-resource/mcp/{actor}` respectively. Both are
     * derived from the same route model through the shared MCP route algebra.
     *
     * @default false
     */
    readonly actorPath?: boolean;
    /**
     * Register `GET /.well-known/mcp.json` and route it to the handler.
     *
     * This lets the construct own the final MCP discovery route alongside the
     * transport and protected-resource metadata routes. The handler remains
     * responsible for serving the discovery document content.
     *
     * @default false
     */
    readonly enableWellKnownMcpDiscovery?: boolean;
    /**
     * Create a DynamoDB table for MCP session storage.
     * @default false
     */
    readonly enableSessionTable?: boolean;
    /**
     * Session DynamoDB table name (only used when enableSessionTable is true).
     * @default undefined (auto-generated)
     */
    readonly sessionTableName?: string;
    /**
     * Session TTL in minutes (exposed to the handler as MCP_SESSION_TTL_MINUTES).
     * @default 60
     */
    readonly sessionTtlMinutes?: number;
    /**
     * Create a DynamoDB table for stream/event log storage.
     *
     * This is intended for durable resumable SSE implementations where stream
     * events must survive Lambda container recycling.
     *
     * @default false
     */
    readonly enableStreamTable?: boolean;
    /**
     * Stream DynamoDB table name (only used when enableStreamTable is true).
     * @default undefined (auto-generated)
     */
    readonly streamTableName?: string;
    /**
     * Stream/event TTL in minutes (exposed to the handler as MCP_STREAM_TTL_MINUTES).
     * @default 60
     */
    readonly streamTtlMinutes?: number;
    /**
     * Create a DynamoDB table for MCP task runtime state.
     *
     * Task state is session-scoped and durable so task-augmented tool execution
     * can survive Lambda container recycling while preserving AppTheory's
     * fail-closed session boundary.
     *
     * @default false
     */
    readonly enableTaskTable?: boolean;
    /**
     * Task DynamoDB table name (only used when enableTaskTable is true).
     * @default undefined (auto-generated)
     */
    readonly taskTableName?: string;
    /**
     * Task TTL in minutes (exposed to the handler as MCP_TASK_TTL_MINUTES).
     * @default 10
     */
    readonly taskTtlMinutes?: number;
    /**
     * Inline byte threshold for MCP stream events before AppTheory spills the
     * logical event payload to the managed S3 spill bucket.
     *
     * This is a storage threshold only. MCP clients still receive one logical
     * JSON-RPC response event and replay continues to use Last-Event-ID. The
     * value must not exceed AppTheory's DynamoDB-safe inline ceiling of 358400
     * bytes.
     *
     * @default 32768
     */
    readonly streamSpillInlineMaxBytes?: number;
    /**
     * Hard maximum byte size for a single logical MCP stream event.
     *
     * Events over this size fail closed with a stable stream delivery error
     * rather than timing out after a failed persistence append.
     *
     * @default 10485760
     */
    readonly streamMaxEventBytes?: number;
}
/**
 * A Claude-first Remote MCP server construct that provisions:
 * - API Gateway REST API v1
 * - Streaming-enabled Lambda proxy integrations for `/mcp` (POST/GET) using
 *   Lambda response streaming (`/response-streaming-invocations`)
 * - Optional DynamoDB tables for sessions, streams, and task runtime state
 *
 * This construct is designed for MCP Streamable HTTP (2025-06-18).
 */
export declare class AppTheoryRemoteMcpServer extends Construct {
    /**
     * The underlying REST API router.
     */
    readonly router: AppTheoryRestApiRouter;
    /**
     * The MCP endpoint URL or template (`.../mcp` or `.../mcp/{actor}`).
     */
    readonly endpoint: string;
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
    readonly protectedResourceMetadataUrl: string;
    /**
     * The DynamoDB session table (if enabled).
     */
    readonly sessionTable?: dynamodb.ITable;
    /**
     * The DynamoDB stream/event log table (if enabled).
     */
    readonly streamTable?: dynamodb.ITable;
    /**
     * The DynamoDB task runtime table (if enabled).
     */
    readonly taskTable?: dynamodb.ITable;
    /**
     * The S3 spill bucket for large stream event payloads (if stream storage is enabled).
     */
    readonly streamSpillBucket?: s3.IBucket;
    constructor(scope: Construct, id: string, props: AppTheoryRemoteMcpServerProps);
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise no-op for imported functions.
     */
    private addEnvironment;
    private validateStreamSpillThresholds;
}
