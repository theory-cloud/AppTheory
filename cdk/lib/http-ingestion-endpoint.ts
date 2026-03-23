import { Duration } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface AppTheoryHttpIngestionEndpointDomainOptions {
  /**
   * The custom domain name (for example `ingest.example.com`).
   */
  readonly domainName: string;

  /**
   * ACM certificate for the domain.
   * Provide either `certificate` or `certificateArn`.
   */
  readonly certificate?: acm.ICertificate;

  /**
   * ACM certificate ARN.
   * Provide either `certificate` or `certificateArn`.
   */
  readonly certificateArn?: string;

  /**
   * Route53 hosted zone for automatic DNS record creation.
   * If provided, a CNAME record will be created pointing to the API Gateway domain.
   * @default undefined
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Optional API mapping key under the custom domain.
   * @default undefined
   */
  readonly basePath?: string;
}

export interface AppTheoryHttpIngestionEndpointStageOptions {
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
   * @default undefined
   */
  readonly throttlingRateLimit?: number;

  /**
   * Throttling burst limit for the stage.
   * @default undefined
   */
  readonly throttlingBurstLimit?: number;
}

export interface AppTheoryHttpIngestionEndpointProps {
  /**
   * Lambda function that handles the ingestion request.
   */
  readonly handler: lambda.IFunction;

  /**
   * Lambda request authorizer used for secret-key validation.
   */
  readonly authorizer: lambda.IFunction;

  /**
   * Optional API name.
   * @default undefined
   */
  readonly apiName?: string;

  /**
   * HTTPS path exposed by the endpoint.
   * @default "/ingest"
   */
  readonly endpointPath?: string;

  /**
   * Header used as the identity source for secret-key authorization.
   * This defaults to `Authorization` to mirror the backoffice-api-authorizer pattern.
   * @default "Authorization"
   */
  readonly authorizerHeaderName?: string;

  /**
   * Friendly authorizer name.
   * @default undefined
   */
  readonly authorizerName?: string;

  /**
   * Lambda authorizer result cache TTL.
   * Defaults to disabled to match the upstream backoffice-api-authorizer behavior.
   * @default Duration.seconds(0)
   */
  readonly authorizerCacheTtl?: Duration;

  /**
   * Optional custom domain configuration.
   * @default undefined
   */
  readonly domain?: AppTheoryHttpIngestionEndpointDomainOptions;

  /**
   * Optional stage configuration.
   * @default undefined
   */
  readonly stage?: AppTheoryHttpIngestionEndpointStageOptions;
}

/**
 * Authenticated HTTPS ingestion endpoint backed by Lambda.
 *
 * This construct is intended for server-to-server submission paths where callers
 * authenticate with a shared secret key via a Lambda request authorizer.
 */
export class AppTheoryHttpIngestionEndpoint extends Construct {
  public readonly api: apigwv2.HttpApi;
  public readonly routeAuthorizer: apigwv2Authorizers.HttpLambdaAuthorizer;
  public readonly endpoint: string;
  public readonly stage: apigwv2.IStage;
  public readonly accessLogGroup?: logs.ILogGroup;
  public readonly domainName?: apigwv2.DomainName;
  public readonly apiMapping?: apigwv2.ApiMapping;
  public readonly cnameRecord?: route53.CnameRecord;

  constructor(scope: Construct, id: string, props: AppTheoryHttpIngestionEndpointProps) {
    super(scope, id);

    const endpointPath = normalizeEndpointPath(props.endpointPath ?? "/ingest");
    const authorizerHeaderName = normalizeHeaderName(props.authorizerHeaderName ?? "Authorization");
    const stageOpts = props.stage ?? {};
    const stageName = stageOpts.stageName ?? "$default";

    const needsExplicitStage = stageName !== "$default"
      || stageOpts.accessLogging
      || stageOpts.throttlingRateLimit !== undefined
      || stageOpts.throttlingBurstLimit !== undefined;

    this.api = new apigwv2.HttpApi(this, "Api", {
      apiName: props.apiName,
      createDefaultStage: !needsExplicitStage,
    });

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

    if (!stage) {
      throw new Error("AppTheoryHttpIngestionEndpoint: failed to create API stage");
    }
    this.stage = stage;

    this.routeAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer("Authorizer", props.authorizer, {
      authorizerName: props.authorizerName,
      identitySource: [`$request.header.${authorizerHeaderName}`],
      resultsCacheTtl: props.authorizerCacheTtl ?? Duration.seconds(0),
      responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
    });

    this.api.addRoutes({
      path: endpointPath,
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("IngestionHandler", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
      authorizer: this.routeAuthorizer,
    });

    if (props.domain) {
      this.setupCustomDomain(props.domain);
      this.endpoint = joinUrlParts(
        `https://${props.domain.domainName}`,
        props.domain.basePath,
        endpointPath,
      );
    } else {
      const baseUrl = stageName === "$default"
        ? this.api.apiEndpoint
        : `${this.api.apiEndpoint}/${stageName}`;
      this.endpoint = joinUrlParts(baseUrl, endpointPath);
    }
  }

  private setupCustomDomain(domainOpts: AppTheoryHttpIngestionEndpointDomainOptions): void {
    const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn) as acm.ICertificate
      : undefined);

    if (!certificate) {
      throw new Error("AppTheoryHttpIngestionEndpoint: domain requires either certificate or certificateArn");
    }

    const domainName = new apigwv2.DomainName(this, "DomainName", {
      domainName: domainOpts.domainName,
      certificate,
    });
    (this as { domainName?: apigwv2.DomainName }).domainName = domainName;

    const apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
      api: this.api,
      domainName,
      stage: this.stage,
      apiMappingKey: normalizeBasePath(domainOpts.basePath),
    });
    (this as { apiMapping?: apigwv2.ApiMapping }).apiMapping = apiMapping;

    if (domainOpts.hostedZone) {
      const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
      const record = new route53.CnameRecord(this, "CnameRecord", {
        zone: domainOpts.hostedZone,
        recordName,
        domainName: domainName.regionalDomainName,
      });
      (this as { cnameRecord?: route53.CnameRecord }).cnameRecord = record;
    }
  }
}

function normalizeEndpointPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) {
    throw new Error("AppTheoryHttpIngestionEndpoint: endpointPath is required");
  }
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`.replace(/\/{2,}/g, "/");
}

function normalizeHeaderName(headerName: string): string {
  const trimmed = String(headerName ?? "").trim();
  if (!trimmed) {
    throw new Error("AppTheoryHttpIngestionEndpoint: authorizerHeaderName is required");
  }
  return trimmed;
}

function normalizeBasePath(basePath?: string): string | undefined {
  const trimmed = String(basePath ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed || undefined;
}

function joinUrlParts(baseUrl: string, ...parts: Array<string | undefined>): string {
  let out = String(baseUrl ?? "").replace(/\/+$/, "");
  for (const part of parts) {
    const normalized = String(part ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalized) continue;
    out = `${out}/${normalized}`;
  }
  return out;
}

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
