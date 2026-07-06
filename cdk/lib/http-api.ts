import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { AppTheoryApiDomain } from "./api-domain";
import type { AppTheoryRegionalWafOptions } from "./regional-waf";

export interface AppTheoryHttpApiCorsOptions {
  /**
   * Allowed origins.
   * @default ["*"]
   */
  readonly allowOrigins?: string[];

  /**
   * Allowed HTTP methods.
   * @default ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
   */
  readonly allowMethods?: string[];

  /**
   * Allowed headers.
   * @default ["content-type", "authorization", "x-request-id", "x-tenant-id"]
   */
  readonly allowHeaders?: string[];

  /**
   * Exposed response headers.
   * @default ["x-request-id"]
   */
  readonly exposeHeaders?: string[];

  /**
   * Whether browsers may send credentials.
   * @default false
   */
  readonly allowCredentials?: boolean;

  /**
   * Browser preflight cache duration.
   * @default Duration.minutes(10)
   */
  readonly maxAge?: Duration;
}

export interface AppTheoryHttpApiDomainOptions {
  /**
   * Custom domain name, for example `api.example.com`.
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
   * Route53 hosted zone for optional CNAME record creation.
   * @default undefined
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * API mapping key under the custom domain.
   * @default undefined
   */
  readonly apiMappingKey?: string;

  /**
   * Stage to map. Defaults to this construct's stage.
   * @default this.stage
   */
  readonly stage?: apigwv2.IStage;

  /**
   * Whether to create a CNAME when hostedZone is provided.
   * @default true when hostedZone is provided
   */
  readonly createCname?: boolean;

  /**
   * CNAME record TTL.
   * @default Duration.seconds(300)
   */
  readonly recordTtl?: Duration;

  /**
   * Mutual TLS configuration.
   * @default undefined
   */
  readonly mutualTlsAuthentication?: apigwv2.MTLSConfig;

  /**
   * TLS security policy.
   * @default API Gateway default
   */
  readonly securityPolicy?: apigwv2.SecurityPolicy;
}

export interface AppTheoryHttpApiStageOptions {
  /**
   * Stage name.
   * @default "$default"
   */
  readonly stageName?: string;

  /**
   * Enable CloudWatch access logging or provide a log group.
   * @default false
   */
  readonly accessLogging?: boolean | logs.ILogGroup;

  /**
   * Retention period for an auto-created access log group.
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly accessLogRetention?: logs.RetentionDays;

  /**
   * Throttling rate limit.
   * @default undefined
   */
  readonly throttlingRateLimit?: number;

  /**
   * Throttling burst limit.
   * @default undefined
   */
  readonly throttlingBurstLimit?: number;
}

/**
 * @deprecated API Gateway v2 HTTP API stages are not supported WAFv2 regional
 * association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
 * AppTheoryRegionalWafOptions for WAF-protected REST API stages.
 */
export interface AppTheoryHttpApiWafOptions extends AppTheoryRegionalWafOptions {}

export interface AppTheoryHttpApiProps {
  readonly handler: lambda.IFunction;
  readonly apiName?: string;
  /**
   * CORS configuration. Set to true for AppTheory defaults.
   * @default undefined
   */
  readonly cors?: boolean | AppTheoryHttpApiCorsOptions;

  /**
   * Custom domain configuration.
   * @default undefined
   */
  readonly domain?: AppTheoryHttpApiDomainOptions;

  /**
   * Stage configuration.
   * @default undefined
   */
  readonly stage?: AppTheoryHttpApiStageOptions;

  /**
   * Regional WAF attachment is intentionally unavailable for API Gateway v2
   * HTTP APIs. Supplying this prop fails closed during synthesis instead of
   * producing an unsupported `/apis/.../stages/...` WebACL association.
   *
   * Use AppTheoryRestApi or AppTheoryRestApiRouter when a WAF-protected API
   * Gateway stage is required.
   * @default undefined
   * @deprecated HTTP API WAF association is unsupported by AWS WAFv2.
   */
  readonly waf?: boolean | AppTheoryHttpApiWafOptions;
}

export class AppTheoryHttpApi extends Construct {
  public readonly api: apigwv2.HttpApi;
  public readonly stage: apigwv2.IStage;
  public readonly accessLogGroup?: logs.ILogGroup;
  public readonly domain?: AppTheoryApiDomain;

  constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps) {
    super(scope, id);

    if (props.waf) {
      throw new Error(
        "AppTheoryHttpApi does not support WAFv2 regional WebACL associations for API Gateway v2 HTTP APIs; use AppTheoryRestApi or AppTheoryRestApiRouter for WAF-protected REST stages",
      );
    }

    const stageOpts = props.stage ?? {};
    const stageName = stageOpts.stageName ?? "$default";
    const needsExplicitStage = stageName !== "$default"
      || stageOpts.accessLogging
      || stageOpts.throttlingRateLimit !== undefined
      || stageOpts.throttlingBurstLimit !== undefined;

    this.api = new apigwv2.HttpApi(this, "Api", {
      apiName: props.apiName,
      corsPreflight: buildCorsPreflight(props.cors),
      createDefaultStage: !needsExplicitStage,
    });

    const stage = needsExplicitStage
      ? new apigwv2.HttpStage(this, "Stage", {
          httpApi: this.api,
          stageName,
          autoDeploy: true,
          throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
            ? {
                rateLimit: stageOpts.throttlingRateLimit,
                burstLimit: stageOpts.throttlingBurstLimit,
              }
            : undefined,
        })
      : this.api.defaultStage;
    if (!stage) {
      throw new Error("AppTheoryHttpApi: failed to create API stage");
    }
    this.stage = stage;
    this.configureAccessLogging(stageOpts, stage);

    this.api.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("Root", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    this.api.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("Proxy", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    if (props.domain) {
      this.configureDomain(props.domain);
    }
  }

  private configureAccessLogging(stageOpts: AppTheoryHttpApiStageOptions, stage: apigwv2.IStage): void {
    if (!stageOpts.accessLogging) {
      return;
    }

    const logGroup = stageOpts.accessLogging === true
      ? new logs.LogGroup(this, "AccessLogs", {
          retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
        })
      : stageOpts.accessLogging;
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

  private configureDomain(options: AppTheoryHttpApiDomainOptions): void {
    const certificate = options.certificate ?? (options.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "ImportedCertificate", options.certificateArn)
      : undefined);
    if (!certificate) {
      throw new Error("AppTheoryHttpApi domain requires either certificate or certificateArn");
    }

    const domain = new AppTheoryApiDomain(this, "Domain", {
      domainName: options.domainName,
      certificate,
      httpApi: this.api,
      stage: options.stage ?? this.stage,
      hostedZone: options.hostedZone,
      apiMappingKey: options.apiMappingKey,
      createCname: options.createCname,
      recordTtl: options.recordTtl,
      mutualTlsAuthentication: options.mutualTlsAuthentication,
      securityPolicy: options.securityPolicy,
    });
    (this as { domain?: AppTheoryApiDomain }).domain = domain;
  }
}

function buildCorsPreflight(input?: boolean | AppTheoryHttpApiCorsOptions): apigwv2.CorsPreflightOptions | undefined {
  if (!input) {
    return undefined;
  }
  const options = input === true ? {} : input;
  return {
    allowOrigins: options.allowOrigins ?? ["*"],
    allowMethods: (options.allowMethods ?? ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
      .map((method) => String(method).trim().toUpperCase())
      .filter((method) => method) as apigwv2.CorsHttpMethod[],
    allowHeaders: options.allowHeaders ?? ["content-type", "authorization", "x-request-id", "x-tenant-id"],
    exposeHeaders: options.exposeHeaders ?? ["x-request-id"],
    allowCredentials: options.allowCredentials ?? false,
    maxAge: options.maxAge ?? Duration.minutes(10),
  };
}
