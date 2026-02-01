import { Duration } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
/**
 * CORS configuration for the REST API router.
 */
export interface AppTheoryRestApiRouterCorsOptions {
    /**
     * Allowed origins.
     * @default ['*']
     */
    readonly allowOrigins?: string[];
    /**
     * Allowed HTTP methods.
     * @default ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD']
     */
    readonly allowMethods?: string[];
    /**
     * Allowed headers.
     * @default ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token']
     */
    readonly allowHeaders?: string[];
    /**
     * Whether to allow credentials.
     * @default false
     */
    readonly allowCredentials?: boolean;
    /**
     * Max age for preflight cache in seconds.
     * @default 600
     */
    readonly maxAge?: Duration;
}
/**
 * Stage-level configuration for the REST API router.
 */
export interface AppTheoryRestApiRouterStageOptions {
    /**
     * Stage name.
     * @default 'prod'
     */
    readonly stageName?: string;
    /**
     * Enable CloudWatch access logging for the stage.
     * If true, a log group will be created automatically.
     * Provide a LogGroup for custom logging configuration.
     * @default false
     */
    readonly accessLogging?: boolean | logs.ILogGroup;
    /**
     * Retention period for auto-created access log group.
     * Only applies when accessLogging is true (boolean).
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /**
     * Access log format.
     * @default AccessLogFormat.clf() (Common Log Format)
     */
    readonly accessLogFormat?: apigw.AccessLogFormat;
    /**
     * Enable detailed CloudWatch metrics at method/resource level.
     * @default false
     */
    readonly detailedMetrics?: boolean;
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
 * Custom domain configuration for the REST API router.
 */
export interface AppTheoryRestApiRouterDomainOptions {
    /**
     * The custom domain name (e.g., "api.example.com").
     */
    readonly domainName: string;
    /**
     * ACM certificate (must be in us-east-1 for edge endpoints, same region for regional).
     * Provide either certificate or certificateArn.
     */
    readonly certificate?: acm.ICertificate;
    /**
     * ACM certificate ARN. Provide either certificate or certificateArn.
     */
    readonly certificateArn?: string;
    /**
     * Route53 hosted zone for automatic DNS record creation.
     * If provided, an A record (alias) will be created pointing to the API Gateway domain.
     * @default undefined (no DNS record created)
     */
    readonly hostedZone?: route53.IHostedZone;
    /**
     * The base path mapping for the API under this domain.
     * @default undefined (maps to the root)
     */
    readonly basePath?: string;
    /**
     * Endpoint type for the domain.
     * @default REGIONAL
     */
    readonly endpointType?: apigw.EndpointType;
    /**
     * Security policy for the domain.
     * @default TLS_1_2
     */
    readonly securityPolicy?: apigw.SecurityPolicy;
}
/**
 * Options for adding a Lambda integration to a route.
 */
export interface AppTheoryRestApiRouterIntegrationOptions {
    /**
     * Enable response streaming for this route.
     * When enabled:
     * - ResponseTransferMode is set to STREAM
     * - The Lambda invocation URI uses /response-streaming-invocations
     * - Timeout is set to 15 minutes (900000ms)
     * @default false
     */
    readonly streaming?: boolean;
    /**
     * Custom integration timeout.
     * For streaming routes, defaults to 15 minutes.
     * For non-streaming routes, defaults to 29 seconds.
     */
    readonly timeout?: Duration;
    /**
     * Request templates for the integration.
     * @default undefined (use Lambda proxy integration)
     */
    readonly requestTemplates?: {
        [key: string]: string;
    };
    /**
     * Passthrough behavior for the integration.
     * @default WHEN_NO_MATCH
     */
    readonly passthroughBehavior?: apigw.PassthroughBehavior;
}
/**
 * Props for the AppTheoryRestApiRouter construct.
 */
export interface AppTheoryRestApiRouterProps {
    /**
     * Name of the REST API.
     */
    readonly apiName?: string;
    /**
     * Description of the REST API.
     */
    readonly description?: string;
    /**
     * Stage configuration.
     */
    readonly stage?: AppTheoryRestApiRouterStageOptions;
    /**
     * CORS configuration. Set to true for sensible defaults,
     * or provide custom options.
     * @default undefined (no CORS)
     */
    readonly cors?: boolean | AppTheoryRestApiRouterCorsOptions;
    /**
     * Custom domain configuration.
     * @default undefined (no custom domain)
     */
    readonly domain?: AppTheoryRestApiRouterDomainOptions;
    /**
     * Endpoint types for the REST API.
     * @default [REGIONAL]
     */
    readonly endpointTypes?: apigw.EndpointType[];
    /**
     * Whether the REST API uses binary media types.
     * Specify media types that should be treated as binary.
     * @default undefined
     */
    readonly binaryMediaTypes?: string[];
    /**
     * Minimum compression size in bytes.
     * @default undefined (no compression)
     */
    readonly minimumCompressionSize?: number;
    /**
     * Enable deploy on construct creation.
     * @default true
     */
    readonly deploy?: boolean;
    /**
     * Retain deployment history when deployments change.
     * @default false
     */
    readonly retainDeployments?: boolean;
    /**
     * API key source type.
     * @default HEADER
     */
    readonly apiKeySourceType?: apigw.ApiKeySourceType;
}
/**
 * A REST API v1 router that supports multi-Lambda routing with full streaming parity.
 *
 * This construct addresses the gaps in AppTheoryRestApi by allowing:
 * - Multiple Lambda functions attached to different routes
 * - Complete response streaming integration (responseTransferMode, URI suffix, timeout)
 * - Stage controls (access logging, metrics, throttling, CORS)
 * - Custom domain wiring with optional Route53 record
 *
 * @example
 * const router = new AppTheoryRestApiRouter(this, 'Router', {
 *   apiName: 'my-api',
 *   stage: { stageName: 'prod', accessLogging: true, detailedMetrics: true },
 *   cors: true,
 * });
 *
 * router.addLambdaIntegration('/sse', ['GET'], sseFn, { streaming: true });
 * router.addLambdaIntegration('/api/graphql', ['POST'], graphqlFn);
 * router.addLambdaIntegration('/{proxy+}', ['ANY'], apiFn);
 */
export declare class AppTheoryRestApiRouter extends Construct {
    /**
     * The underlying API Gateway REST API.
     */
    readonly api: apigw.RestApi;
    /**
     * The deployment stage.
     */
    readonly stage: apigw.Stage;
    /**
     * The custom domain name (if configured).
     */
    readonly domainName?: apigw.DomainName;
    /**
     * The base path mapping (if domain is configured).
     */
    readonly basePathMapping?: apigw.BasePathMapping;
    /**
     * The Route53 A record (if domain and hostedZone are configured).
     */
    readonly aRecord?: route53.ARecord;
    /**
     * The access log group (if access logging is enabled).
     */
    readonly accessLogGroup?: logs.ILogGroup;
    private readonly corsOptions?;
    private readonly corsEnabled;
    constructor(scope: Construct, id: string, props?: AppTheoryRestApiRouterProps);
    /**
     * Add a Lambda integration for the specified path and HTTP methods.
     *
     * @param path - The resource path (e.g., "/sse", "/api/graphql", "/{proxy+}")
     * @param methods - Array of HTTP methods (e.g., ["GET", "POST"] or ["ANY"])
     * @param handler - The Lambda function to integrate
     * @param options - Integration options including streaming configuration
     */
    addLambdaIntegration(path: string, methods: string[], handler: lambda.IFunction, options?: AppTheoryRestApiRouterIntegrationOptions): void;
    /**
     * Get or create a resource for the given path.
     */
    private resourceForPath;
    /**
     * Create a Lambda integration with the appropriate configuration.
     */
    private createLambdaIntegration;
    /**
     * Apply L1 CFN overrides for streaming routes to ensure full Lift parity.
     *
     * Streaming routes require:
     * 1. Integration.ResponseTransferMode = STREAM (already set via L2)
     * 2. Integration.Uri ends with /response-streaming-invocations
     * 3. Integration.TimeoutInMillis = 900000 (15 minutes)
     */
    private applyStreamingOverrides;
    /**
     * Build deploy options for the stage.
     */
    private buildDeployOptions;
    /**
     * Set up custom domain with optional Route53 record.
     */
    private setupCustomDomain;
    /**
     * Build method responses for CORS-enabled endpoints.
     */
    private buildMethodResponses;
    /**
     * Add CORS preflight (OPTIONS) method to a resource.
     */
    private addCorsPreflightMethod;
}
