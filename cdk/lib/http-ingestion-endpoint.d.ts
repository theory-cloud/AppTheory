import { Duration } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
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
export declare class AppTheoryHttpIngestionEndpoint extends Construct {
    readonly api: apigwv2.HttpApi;
    readonly routeAuthorizer: apigwv2Authorizers.HttpLambdaAuthorizer;
    readonly endpoint: string;
    readonly stage: apigwv2.IStage;
    readonly accessLogGroup?: logs.ILogGroup;
    readonly domainName?: apigwv2.DomainName;
    readonly apiMapping?: apigwv2.ApiMapping;
    readonly cnameRecord?: route53.CnameRecord;
    constructor(scope: Construct, id: string, props: AppTheoryHttpIngestionEndpointProps);
    private setupCustomDomain;
}
