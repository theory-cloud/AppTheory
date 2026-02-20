import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

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
 * An MCP (Model Context Protocol) server construct that provisions an HTTP API Gateway v2
 * with a Lambda integration on POST /mcp, optional DynamoDB session table, and optional
 * custom domain with Route53.
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
   * The MCP endpoint URL (POST /mcp).
   */
  public readonly endpoint: string;

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

    // Add POST /mcp route with Lambda integration
    this.api.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    // Optional session table
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

    // Optional custom domain
    if (props.domain) {
      if (!stage) {
        throw new Error("AppTheoryMcpServer: no stage available for domain mapping");
      }
      this.setupCustomDomain(props.domain, stage);
      this.endpoint = `${stripTrailingSlash(`https://${props.domain.domainName}`)}/mcp`;
    } else {
      // Compute execute-api endpoint URL (include stage path unless using $default).
      const baseUrl = (stageName === "$default")
        ? this.api.apiEndpoint
        : `${this.api.apiEndpoint}/${stageName}`;
      this.endpoint = `${stripTrailingSlash(baseUrl)}/mcp`;
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
