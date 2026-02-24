import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import {
  AppTheoryRestApiRouter,
  type AppTheoryRestApiRouterCorsOptions,
  type AppTheoryRestApiRouterDomainOptions,
  type AppTheoryRestApiRouterStageOptions,
} from "./rest-api-router";

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
export class AppTheoryRemoteMcpServer extends Construct {
  /**
   * The underlying REST API router.
   */
  public readonly router: AppTheoryRestApiRouter;

  /**
   * The MCP endpoint URL (`.../mcp`).
   */
  public readonly endpoint: string;

  /**
   * The DynamoDB session table (if enabled).
   */
  public readonly sessionTable?: dynamodb.ITable;

  /**
   * The DynamoDB stream/event log table (if enabled).
   */
  public readonly streamTable?: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: AppTheoryRemoteMcpServerProps) {
    super(scope, id);

    this.router = new AppTheoryRestApiRouter(this, "Api", {
      apiName: props.apiName,
      description: props.description,
      stage: props.stage,
      cors: props.cors,
      domain: props.domain,
    });

    // Streamable HTTP routes (streaming enabled for SSE delivery)
    this.router.addLambdaIntegration("/mcp", ["POST"], props.handler, { streaming: true });
    this.router.addLambdaIntegration("/mcp", ["GET"], props.handler, { streaming: true });
    this.router.addLambdaIntegration("/mcp", ["DELETE"], props.handler);

    // Optional session table (matches runtime/mcp/session_dynamo.go schema)
    if (props.enableSessionTable) {
      const table = new dynamodb.Table(this, "SessionTable", {
        tableName: props.sessionTableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: "expiresAt",
        removalPolicy: RemovalPolicy.DESTROY,
        pointInTimeRecovery: true,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
      });

      table.grantReadWriteData(props.handler);
      this.sessionTable = table;
    }

    if (this.sessionTable) {
      this.addEnvironment(props.handler, "MCP_SESSION_TABLE", this.sessionTable.tableName);
      this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(props.sessionTtlMinutes ?? 60));
    }

    // Optional stream/event log table (schema is opinionated but intentionally flexible)
    if (props.enableStreamTable) {
      const table = new dynamodb.Table(this, "StreamTable", {
        tableName: props.streamTableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: "expiresAt",
        removalPolicy: RemovalPolicy.DESTROY,
        pointInTimeRecovery: true,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
      });

      table.grantReadWriteData(props.handler);
      this.streamTable = table;
    }

    if (this.streamTable) {
      this.addEnvironment(props.handler, "MCP_STREAM_TABLE", this.streamTable.tableName);
      this.addEnvironment(props.handler, "MCP_STREAM_TTL_MINUTES", String(props.streamTtlMinutes ?? 60));
    }

    const stageName = props.stage?.stageName ?? "prod";
    this.endpoint = computeMcpEndpoint(this.router, stageName, props.domain);
    this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
  }

  /**
   * Add an environment variable to the Lambda function.
   * Uses addEnvironment if available (Function), otherwise no-op for imported functions.
   */
  private addEnvironment(handler: lambda.IFunction, key: string, value: string): void {
    if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
      handler.addEnvironment(key, value);
    }
  }
}

function computeMcpEndpoint(
  router: AppTheoryRestApiRouter,
  stageName: string,
  domain?: AppTheoryRestApiRouterDomainOptions,
): string {
  if (!domain) {
    const stack = Stack.of(router);
    const stage = String(stageName ?? "").trim() || "prod";
    return `https://${router.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${stage}/mcp`;
  }

  const basePath = String(domain.basePath ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = basePath ? `/${basePath}` : "";
  return `https://${domain.domainName}${prefix}/mcp`.replace(/\/{2,}/g, "/").replace(/^https:\//, "https://");
}
