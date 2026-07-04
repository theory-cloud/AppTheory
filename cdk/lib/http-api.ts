import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as route53 from "aws-cdk-lib/aws-route53";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import { AppTheoryApiDomain } from "./api-domain";

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

export interface AppTheoryHttpApiWafOptions {
  /**
   * Existing regional WAFv2 WebACL ARN to associate with the HTTP API stage.
   *
   * When omitted, AppTheory creates a regional WebACL with AWS managed baseline rules.
   * @default undefined
   */
  readonly webAclArn?: string;

  /**
   * WebACL name when AppTheory creates one.
   * @default derived from apiName
   */
  readonly name?: string;

  /**
   * CloudWatch metric name for the WebACL.
   * @default derived from apiName
   */
  readonly metricName?: string;

  /**
   * Optional request rate limit rule threshold per five-minute window.
   * @default undefined
   */
  readonly rateLimit?: number;
}

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
   * Regional WAF attachment. Set to true for an AppTheory-managed WebACL.
   * @default undefined
   */
  readonly waf?: boolean | AppTheoryHttpApiWafOptions;
}

export class AppTheoryHttpApi extends Construct {
  public readonly api: apigwv2.HttpApi;
  public readonly stage: apigwv2.IStage;
  public readonly accessLogGroup?: logs.ILogGroup;
  public readonly domain?: AppTheoryApiDomain;
  public readonly webAcl?: wafv2.CfnWebACL;
  public readonly wafAssociation?: wafv2.CfnWebACLAssociation;

  constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps) {
    super(scope, id);

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

    if (props.waf) {
      this.configureWaf(props.waf === true ? {} : props.waf);
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

  private configureWaf(options: AppTheoryHttpApiWafOptions): void {
    const webAclArn = options.webAclArn ?? this.createWebAcl(options).attrArn;
    const association = new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: httpApiStageArn(this.api, this.stage),
      webAclArn,
    });
    (this as { wafAssociation?: wafv2.CfnWebACLAssociation }).wafAssociation = association;
  }

  private createWebAcl(options: AppTheoryHttpApiWafOptions): wafv2.CfnWebACL {
    const baseName = sanitizeMetricName(options.metricName ?? options.name ?? this.api.httpApiName ?? "AppTheoryHttpApi");
    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      {
        name: "AWSManagedRulesCommonRuleSet",
        priority: 0,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: "AWS",
            name: "AWSManagedRulesCommonRuleSet",
          },
        },
        visibilityConfig: wafVisibility(`${baseName}Common`),
      },
    ];

    if (options.rateLimit !== undefined) {
      rules.push({
        name: "RateLimit",
        priority: 1,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: Math.trunc(options.rateLimit),
            aggregateKeyType: "IP",
          },
        },
        visibilityConfig: wafVisibility(`${baseName}RateLimit`),
      });
    }

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: options.name,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: wafVisibility(baseName),
      rules,
    });
    (this as { webAcl?: wafv2.CfnWebACL }).webAcl = webAcl;
    return webAcl;
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

function httpApiStageArn(api: apigwv2.HttpApi, stage: apigwv2.IStage): string {
  return Stack.of(api).formatArn({
    service: "apigateway",
    account: "",
    resource: "/apis",
    resourceName: `${api.apiId}/stages/${stage.stageName}`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

function wafVisibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName: sanitizeMetricName(metricName),
    sampledRequestsEnabled: true,
  };
}

function sanitizeMetricName(input: string): string {
  const sanitized = String(input ?? "AppTheoryHttpApi").replace(/[^A-Za-z0-9_-]/g, "");
  return sanitized || "AppTheoryHttpApi";
}
