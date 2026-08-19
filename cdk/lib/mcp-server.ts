import { RemovalPolicy, Token } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { AppTheoryMcpPaths } from "./mcp-paths";

/**
 * Custom domain configuration for the MCP server.
 */
export interface AppTheoryMcpServerDomainOptions {
  /**
   * The custom domain name (e.g., "mcp.example.com").
   */
  readonly domainName: string;

  /**
   * ACM certificate for the domain.
   * Provide either certificate or certificateArn.
   */
  readonly certificate?: acm.ICertificate;

  /**
   * ACM certificate ARN.
   * Provide either certificate or certificateArn.
   */
  readonly certificateArn?: string;

  /**
   * Route53 hosted zone for automatic DNS record creation.
   * If provided, a CNAME record will be created pointing to the API Gateway domain.
   * @default undefined (no DNS record created)
   */
  readonly hostedZone?: route53.IHostedZone;
}

/**
 * Stage configuration for the MCP server API Gateway.
 */
export interface AppTheoryMcpServerStageOptions {
  /**
   * Stage name.
   * @default "$default"
   */
  readonly stageName?: string;

  /**
   * Enable CloudWatch access logging for the stage.
   * @default false
   */
  readonly accessLogging?: boolean;

  /**
   * Retention period for auto-created access log group.
   * Only applies when accessLogging is true.
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly accessLogRetention?: logs.RetentionDays;

  /**
   * Throttling rate limit (requests per second) for the stage.
   * @default undefined (no throttling)
   */
  readonly throttlingRateLimit?: number;

  /**
   * Throttling burst limit for the stage.
   * @default undefined (no throttling)
   */
  readonly throttlingBurstLimit?: number;
}

/**
 * Props for the AppTheoryMcpServer construct.
 */
export interface AppTheoryMcpServerProps {
  /**
   * The Lambda function handling MCP requests.
   */
  readonly handler: lambda.IFunction;

  /**
   * Literal route path for the MCP endpoint.
   *
   * This is a synthesis-time path, never an origin or full resource URL.
   * @default AppTheoryMcpPaths.MCP
   */
  readonly mcpPath?: string;

  /**
   * OAuth authorization server issuer passed to the Lambda runtime config.
   *
   * AppTheory does not parse this value or use it to synthesize resource URLs.
   * Supply `jwksUri` with this prop to enable the runtime-served RFC 9728
   * discovery routes.
   * @default undefined (legacy POST-only MCP route)
   */
  readonly authorizationServerIssuer?: string;

  /**
   * OAuth JSON Web Key Set URL passed to the Lambda runtime config.
   *
   * Supply `authorizationServerIssuer` with this prop. CDK tokens are accepted
   * because the value is forwarded, not parsed during synthesis.
   * @default undefined (legacy POST-only MCP route)
   */
  readonly jwksUri?: string;

  /**
   * Optional API name.
   * @default undefined
   */
  readonly apiName?: string;

  /**
   * Create a DynamoDB table for session state storage.
   * @default false
   */
  readonly enableSessionTable?: boolean;

  /**
   * Name for the session DynamoDB table.
   * Only used when enableSessionTable is true.
   * @default undefined (auto-generated)
   */
  readonly sessionTableName?: string;

  /**
   * TTL in minutes for session records.
   * Only used when enableSessionTable is true.
   * @default 60
   */
  readonly sessionTtlMinutes?: number;

  /**
   * Custom domain configuration.
   * @default undefined (no custom domain)
   */
  readonly domain?: AppTheoryMcpServerDomainOptions;

  /**
   * Stage configuration.
   * @default undefined (defaults applied)
   */
  readonly stage?: AppTheoryMcpServerStageOptions;
}

/**
 * Umbrella deployment contract for a namespace MCP server.
 *
 * The construct provisions an HTTP API Gateway v2 with a Lambda integration
 * on the conventional POST /mcp path, optional runtime-served RFC 9728
 * discovery routes, optional DynamoDB session state, and an optional custom
 * domain. Resource origins are intentionally absent from the prop surface:
 * the Go runtime derives the protected resource host from each request.
 *
 * @example
 * const server = new AppTheoryMcpServer(this, 'McpServer', {
 *   handler: mcpFn,
 *   enableSessionTable: true,
 *   sessionTtlMinutes: 120,
 * });
 */
export class AppTheoryMcpServer extends Construct {
  /**
   * The underlying HTTP API Gateway v2.
   */
  public readonly api: apigwv2.HttpApi;

  /**
   * The DynamoDB session table (if enableSessionTable is true).
   */
  public readonly sessionTable?: dynamodb.ITable;

  /**
   * The MCP endpoint URL.
   */
  public readonly endpoint: string;

  /**
   * Literal MCP endpoint route path.
   */
  public readonly mcpPath: string;

  /**
   * Path-scoped RFC 9728 discovery route for this MCP endpoint.
   */
  public readonly protectedResourceMetadataPath: string;

  /**
   * The custom domain name resource (if domain is configured).
   */
  public readonly domainName?: apigwv2.DomainName;

  /**
   * The API mapping for the custom domain (if domain is configured).
   */
  public readonly apiMapping?: apigwv2.ApiMapping;

  /**
   * The Route53 CNAME record (if domain and hostedZone are configured).
   */
  public readonly cnameRecord?: route53.CnameRecord;

  /**
   * The access log group (if access logging is enabled).
   */
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps) {
    super(scope, id);

    this.mcpPath = normalizeRoutePath(props.mcpPath ?? AppTheoryMcpPaths.MCP, "mcpPath");
    this.protectedResourceMetadataPath = `${AppTheoryMcpPaths.OAUTH_PROTECTED_RESOURCE}${this.mcpPath}`;
    const authConfig = normalizeAuthConfig(props);
    const stageOpts = props.stage ?? {};
    const stageName = stageOpts.stageName ?? "$default";

    const needsExplicitStage = stageName !== "$default"
      || stageOpts.accessLogging
      || stageOpts.throttlingRateLimit !== undefined
      || stageOpts.throttlingBurstLimit !== undefined;

    // Create HTTP API with default stage
    this.api = new apigwv2.HttpApi(this, "Api", {
      apiName: props.apiName,
      createDefaultStage: !needsExplicitStage,
    });

    // If custom stage options, create the stage explicitly
    let stage: apigwv2.IStage | undefined;
    if (needsExplicitStage) {
      stage = new apigwv2.HttpStage(this, "Stage", {
        httpApi: this.api,
        stageName,
        autoDeploy: true,
        throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
          ? {
            rateLimit: stageOpts.throttlingRateLimit,
            burstLimit: stageOpts.throttlingBurstLimit,
          }
          : undefined,
      });

      // Set up access logging if enabled
      if (stageOpts.accessLogging) {
        const logGroup = new logs.LogGroup(this, "AccessLogs", {
          retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
        });
        (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = logGroup;

        const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
        cfnStage.accessLogSettings = {
          destinationArn: logGroup.logGroupArn,
          format: JSON.stringify({
            requestId: "$context.requestId",
            ip: "$context.identity.sourceIp",
            requestTime: "$context.requestTime",
            httpMethod: "$context.httpMethod",
            routeKey: "$context.routeKey",
            status: "$context.status",
            protocol: "$context.protocol",
            responseLength: "$context.responseLength",
            integrationLatency: "$context.integrationLatency",
          }),
        };
      }
    } else {
      stage = this.api.defaultStage;
    }

    const handlerIntegration = new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });

    // Route MCP protocol traffic to the application runtime.
    this.api.addRoutes({
      path: this.mcpPath,
      methods: [apigwv2.HttpMethod.POST],
      integration: handlerIntegration,
    });

    if (authConfig) {
      // Discovery stays unauthenticated at API Gateway. The matching Go helper
      // registers these routes with SecureApp Public posture while registering
      // the MCP route as Authenticated.
      this.api.addRoutes({
        path: AppTheoryMcpPaths.OAUTH_PROTECTED_RESOURCE,
        methods: [apigwv2.HttpMethod.GET],
        integration: handlerIntegration,
      });
      this.api.addRoutes({
        path: this.protectedResourceMetadataPath,
        methods: [apigwv2.HttpMethod.GET],
        integration: handlerIntegration,
      });

      this.addEnvironment(props.handler, "APPTHEORY_MCP_PATH", this.mcpPath);
      this.addEnvironment(
        props.handler,
        "APPTHEORY_MCP_PROTECTED_RESOURCE_PATH",
        this.protectedResourceMetadataPath,
      );
      this.addEnvironment(
        props.handler,
        "APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER",
        authConfig.authorizationServerIssuer,
      );
      this.addEnvironment(props.handler, "APPTHEORY_MCP_JWKS_URI", authConfig.jwksUri);
    }

    // Optional session table
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

    // Optional custom domain
    if (props.domain) {
      if (!stage) {
        throw new Error("AppTheoryMcpServer: no stage available for domain mapping");
      }
      this.setupCustomDomain(props.domain, stage);
      this.endpoint = `${stripTrailingSlash(`https://${props.domain.domainName}`)}${this.mcpPath}`;
    } else {
      // Compute execute-api endpoint URL (include stage path unless using $default).
      const baseUrl = (stageName === "$default")
        ? this.api.apiEndpoint
        : `${this.api.apiEndpoint}/${stageName}`;
      this.endpoint = `${stripTrailingSlash(baseUrl)}${this.mcpPath}`;
    }

    // Inject environment variables into the Lambda handler
    this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
  }

  /**
   * Add an environment variable to the Lambda function.
   * Uses addEnvironment if available (Function), otherwise uses L1 override.
   */
  private addEnvironment(handler: lambda.IFunction, key: string, value: string): void {
    if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
      handler.addEnvironment(key, value);
    }
  }

  /**
   * Set up custom domain with optional Route53 record.
   */
  private setupCustomDomain(domainOpts: AppTheoryMcpServerDomainOptions, stage: apigwv2.IStage): void {
    const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn) as acm.ICertificate
      : undefined);

    if (!certificate) {
      throw new Error("AppTheoryMcpServer: domain requires either certificate or certificateArn");
    }

    const dmn = new apigwv2.DomainName(this, "DomainName", {
      domainName: domainOpts.domainName,
      certificate,
    });
    (this as { domainName?: apigwv2.DomainName }).domainName = dmn;

    const mapping = new apigwv2.ApiMapping(this, "ApiMapping", {
      api: this.api,
      domainName: dmn,
      stage,
    });
    (this as { apiMapping?: apigwv2.ApiMapping }).apiMapping = mapping;

    if (domainOpts.hostedZone) {
      const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
      const record = new route53.CnameRecord(this, "CnameRecord", {
        zone: domainOpts.hostedZone,
        recordName,
        domainName: dmn.regionalDomainName,
      });
      (this as { cnameRecord?: route53.CnameRecord }).cnameRecord = record;
    }
  }
}

/**
 * Convert a domain name to a Route53 record name relative to the zone.
 */
function toRoute53RecordName(domainName: string, zone: route53.IHostedZone): string {
  const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
  const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
  if (!zoneName) return fqdn;
  if (fqdn === zoneName) return "";
  const suffix = `.${zoneName}`;
  if (fqdn.endsWith(suffix)) {
    return fqdn.slice(0, -suffix.length);
  }
  return fqdn;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function normalizeRoutePath(value: string, propName: string): string {
  if (Token.isUnresolved(value)) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be a synthesis-time literal path`);
  }
  const routePath = String(value ?? "");
  // Literal MCP route paths use only RFC 3986 path characters, with percent-encoding required for whitespace and other characters outside that set.
  const literalRoutePathPattern = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+)*$/;
  if (
    !literalRoutePathPattern.test(routePath)
    || routePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be a literal absolute route path`);
  }
  return routePath;
}

function normalizeAuthConfig(
  props: AppTheoryMcpServerProps,
): { authorizationServerIssuer: string; jwksUri: string } | undefined {
  const hasIssuer = props.authorizationServerIssuer !== undefined;
  const hasJwksUri = props.jwksUri !== undefined;
  if (hasIssuer !== hasJwksUri) {
    throw new Error(
      "AppTheoryMcpServer: authorizationServerIssuer and jwksUri must be supplied together",
    );
  }
  if (!hasIssuer || !hasJwksUri) {
    return undefined;
  }

  const authorizationServerIssuer = String(props.authorizationServerIssuer);
  const jwksUri = String(props.jwksUri);
  if (!Token.isUnresolved(authorizationServerIssuer)) {
    const literalIssuer = authorizationServerIssuer.trim();
    let parsedIssuer: URL | undefined;
    try {
      parsedIssuer = new URL(literalIssuer);
    } catch {
      // The shared validation error below is the public synthesis contract.
    }
    if (
      !parsedIssuer
      || parsedIssuer.protocol !== "https:"
      || !parsedIssuer.hostname
      || parsedIssuer.username !== ""
      || parsedIssuer.password !== ""
      || literalIssuer.includes("?")
      || literalIssuer.includes("#")
    ) {
      throw new Error(
        "AppTheoryMcpServer: authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment",
      );
    }
  }
  if (!Token.isUnresolved(jwksUri) && !jwksUri.trim()) {
    throw new Error("AppTheoryMcpServer: jwksUri must not be empty");
  }
  return { authorizationServerIssuer, jwksUri };
}
