import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
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
export declare class AppTheoryHttpApi extends Construct {
    readonly api: apigwv2.HttpApi;
    readonly stage: apigwv2.IStage;
    readonly accessLogGroup?: logs.ILogGroup;
    readonly domain?: AppTheoryApiDomain;
    readonly webAcl?: wafv2.CfnWebACL;
    readonly wafAssociation?: wafv2.CfnWebACLAssociation;
    constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps);
    private configureAccessLogging;
    private configureDomain;
    private configureWaf;
    private createWebAcl;
}
