import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import {
  AppTheoryRestApiRouter,
  type AppTheoryRestApiRouterCorsOptions,
  type AppTheoryRestApiRouterDomainOptions,
  type AppTheoryRestApiRouterStageOptions,
} from "./rest-api-router";
import { trimRepeatedChar } from "./private/string-utils";

const STREAM_SPILL_INLINE_DEFAULT_BYTES = 32 * 1024;
const STREAM_SPILL_INLINE_SAFE_MAX_BYTES = 350 * 1024;
const STREAM_MAX_EVENT_DEFAULT_BYTES = 10 * 1024 * 1024;

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
   * The public `endpoint` and injected `MCP_ENDPOINT` environment variable
   * become a template string ending in `/mcp/{actor}`.
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
   * The MCP endpoint URL or template (`.../mcp` or `.../mcp/{actor}`).
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

  /**
   * The S3 spill bucket for large stream event payloads (if stream storage is enabled).
   */
  public readonly streamSpillBucket?: s3.IBucket;

  constructor(scope: Construct, id: string, props: AppTheoryRemoteMcpServerProps) {
    super(scope, id);

    this.router = new AppTheoryRestApiRouter(this, "Api", {
      apiName: props.apiName,
      description: props.description,
      stage: props.stage,
      cors: props.cors,
      domain: props.domain,
      allowTestInvoke: props.allowTestInvoke,
      scopePermissionToMethod: props.scopePermissionToMethod,
    });

    const transportPath = props.actorPath ? "/mcp/{actor}" : "/mcp";

    // Streamable HTTP routes (streaming enabled for SSE delivery)
    this.router.addLambdaIntegration(transportPath, ["POST"], props.handler, { streaming: true });
    this.router.addLambdaIntegration(transportPath, ["GET"], props.handler, { streaming: true });
    this.router.addLambdaIntegration(transportPath, ["DELETE"], props.handler);

    if (props.actorPath) {
      this.router.addLambdaIntegration(
        "/.well-known/oauth-protected-resource/mcp/{actor}",
        ["GET"],
        props.handler,
      );
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
        removalPolicy: RemovalPolicy.DESTROY,
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
        removalPolicy: RemovalPolicy.DESTROY,
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
            expiration: Duration.days(streamSpillExpirationDays(props.streamTtlMinutes ?? 60)),
          },
        ],
        removalPolicy: RemovalPolicy.DESTROY,
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
        this.addEnvironment(
          props.handler,
          "MCP_STREAM_SPILL_INLINE_MAX_BYTES",
          String(props.streamSpillInlineMaxBytes ?? STREAM_SPILL_INLINE_DEFAULT_BYTES),
        );
        this.addEnvironment(
          props.handler,
          "MCP_STREAM_MAX_EVENT_BYTES",
          String(props.streamMaxEventBytes ?? STREAM_MAX_EVENT_DEFAULT_BYTES),
        );
      }
    }

    const stageName = props.stage?.stageName ?? "prod";
    this.endpoint = computeMcpEndpoint(this.router, stageName, props.domain, props.actorPath);
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

  private validateStreamSpillThresholds(props: AppTheoryRemoteMcpServerProps): void {
    const inlineMax = props.streamSpillInlineMaxBytes ?? STREAM_SPILL_INLINE_DEFAULT_BYTES;
    const eventMax = props.streamMaxEventBytes ?? STREAM_MAX_EVENT_DEFAULT_BYTES;

    if (!Number.isInteger(inlineMax) || inlineMax <= 0) {
      throw new Error("AppTheoryRemoteMcpServer: streamSpillInlineMaxBytes must be a positive integer");
    }
    if (inlineMax > STREAM_SPILL_INLINE_SAFE_MAX_BYTES) {
      throw new Error(
        `AppTheoryRemoteMcpServer: streamSpillInlineMaxBytes must be less than or equal to ${STREAM_SPILL_INLINE_SAFE_MAX_BYTES}`,
      );
    }
    if (!Number.isInteger(eventMax) || eventMax <= 0) {
      throw new Error("AppTheoryRemoteMcpServer: streamMaxEventBytes must be a positive integer");
    }
    if (eventMax < inlineMax) {
      throw new Error("AppTheoryRemoteMcpServer: streamMaxEventBytes must be greater than or equal to streamSpillInlineMaxBytes");
    }
  }
}

function streamSpillExpirationDays(ttlMinutes: number): number {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(ttlMinutes / (24 * 60)));
}

function computeMcpEndpoint(
  router: AppTheoryRestApiRouter,
  stageName: string,
  domain?: AppTheoryRestApiRouterDomainOptions,
  actorPath?: boolean,
): string {
  const suffix = actorPath ? "/mcp/{actor}" : "/mcp";
  if (!domain) {
    const stack = Stack.of(router);
    const stage = String(stageName ?? "").trim() || "prod";
    return `https://${router.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${stage}${suffix}`;
  }

  const basePath = trimRepeatedChar(String(domain.basePath ?? "").trim(), "/");
  const prefix = basePath ? `/${basePath}` : "";
  return `https://${domain.domainName}${prefix}${suffix}`;
}
