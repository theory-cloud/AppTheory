import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
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
}
/**
 * A Claude-first Remote MCP server construct that provisions:
 * - API Gateway REST API v1
 * - Streaming-enabled Lambda proxy integrations for `/mcp` (POST/GET) using
 *   Lambda response streaming (`/response-streaming-invocations`)
 * - Optional DynamoDB tables for sessions and stream/event log state
 *
 * This construct is designed for MCP Streamable HTTP (2025-06-18).
 */
export declare class AppTheoryRemoteMcpServer extends Construct {
    /**
     * The underlying REST API router.
     */
    readonly router: AppTheoryRestApiRouter;
    /**
     * The MCP endpoint URL (`.../mcp`).
     */
    readonly endpoint: string;
    /**
     * The DynamoDB session table (if enabled).
     */
    readonly sessionTable?: dynamodb.ITable;
    /**
     * The DynamoDB stream/event log table (if enabled).
     */
    readonly streamTable?: dynamodb.ITable;
    constructor(scope: Construct, id: string, props: AppTheoryRemoteMcpServerProps);
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise no-op for imported functions.
     */
    private addEnvironment;
}
