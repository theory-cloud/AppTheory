import { Duration } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
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
     * Whether to create an AAAA alias record in addition to the A alias record.
     * Only applies when `hostedZone` is provided.
     * @default false
     */
    readonly createAAAARecord?: boolean;

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
    readonly requestTemplates?: { [key: string]: string };

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
export class AppTheoryRestApiRouter extends Construct {
    /**
     * The underlying API Gateway REST API.
     */
    public readonly api: apigw.RestApi;

    /**
     * The deployment stage.
     */
    public readonly stage: apigw.Stage;

    /**
     * The custom domain name (if configured).
     */
    public readonly domainName?: apigw.DomainName;

    /**
     * The base path mapping (if domain is configured).
     */
    public readonly basePathMapping?: apigw.BasePathMapping;

    /**
     * The Route53 A record (if domain and hostedZone are configured).
     */
    public readonly aRecord?: route53.ARecord;

    /**
     * The Route53 AAAA record (if domain, hostedZone, and createAAAARecord are configured).
     */
    public readonly aaaaRecord?: route53.AaaaRecord;

    /**
     * The access log group (if access logging is enabled).
     */
    public readonly accessLogGroup?: logs.ILogGroup;

    private readonly corsOptions?: AppTheoryRestApiRouterCorsOptions;
    private readonly corsEnabled: boolean;

    constructor(scope: Construct, id: string, props: AppTheoryRestApiRouterProps = {}) {
        super(scope, id);

        // Normalize CORS config
        if (props.cors === true) {
            this.corsEnabled = true;
            this.corsOptions = {};
        } else if (props.cors && typeof props.cors === "object") {
            this.corsEnabled = true;
            this.corsOptions = props.cors;
        } else {
            this.corsEnabled = false;
        }

        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "prod";

        // Create the REST API
        this.api = new apigw.RestApi(this, "Api", {
            restApiName: props.apiName,
            description: props.description,
            deploy: props.deploy ?? true,
            retainDeployments: props.retainDeployments,
            endpointTypes: props.endpointTypes ?? [apigw.EndpointType.REGIONAL],
            binaryMediaTypes: props.binaryMediaTypes,
            minimumCompressionSize: props.minimumCompressionSize?.valueOf(),
            apiKeySourceType: props.apiKeySourceType,
            deployOptions: this.buildDeployOptions(stageOpts, stageName),
        });

        this.stage = this.api.deploymentStage;

        // Set up custom domain if provided
        if (props.domain) {
            this.setupCustomDomain(props.domain);
        }
    }

    /**
     * Add a Lambda integration for the specified path and HTTP methods.
     *
     * @param path - The resource path (e.g., "/sse", "/api/graphql", "/{proxy+}")
     * @param methods - Array of HTTP methods (e.g., ["GET", "POST"] or ["ANY"])
     * @param handler - The Lambda function to integrate
     * @param options - Integration options including streaming configuration
     */
    addLambdaIntegration(
        path: string,
        methods: string[],
        handler: lambda.IFunction,
        options: AppTheoryRestApiRouterIntegrationOptions = {},
    ): void {
        const resource = this.resourceForPath(path);

        for (const m of methods) {
            const method = String(m ?? "").trim().toUpperCase();
            if (!method) continue;

            // Create the integration
            const integration = this.createLambdaIntegration(handler, options);

            // Add the method
            const createdMethod = resource.addMethod(method, integration, {
                methodResponses: this.corsEnabled ? this.buildMethodResponses() : undefined,
            });

            // For streaming routes, apply L1 overrides to ensure full compatibility
            if (options.streaming) {
                this.applyStreamingOverrides(createdMethod, handler, options);
            }
        }

        // Add OPTIONS method for CORS if enabled and not already present
        if (this.corsEnabled && !resource.node.tryFindChild("OPTIONS")) {
            this.addCorsPreflightMethod(resource);
        }
    }

    /**
     * Get or create a resource for the given path.
     */
    private resourceForPath(inputPath: string): apigw.IResource {
        let current: apigw.IResource = this.api.root;
        const trimmed = String(inputPath ?? "")
            .trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
        if (!trimmed) return current;

        for (const segment of trimmed.split("/")) {
            const part = String(segment ?? "").trim();
            if (!part) continue;
            current = current.getResource(part) ?? current.addResource(part);
        }
        return current;
    }

    /**
     * Create a Lambda integration with the appropriate configuration.
     */
    private createLambdaIntegration(
        handler: lambda.IFunction,
        options: AppTheoryRestApiRouterIntegrationOptions,
    ): apigw.LambdaIntegration {
        const streaming = options.streaming ?? false;

        // For streaming, we use STREAM responseTransferMode
        // Note: The URI suffix and timeout will be fixed via L1 overrides
        return new apigw.LambdaIntegration(handler, {
            proxy: true,
            responseTransferMode: streaming ? apigw.ResponseTransferMode.STREAM : apigw.ResponseTransferMode.BUFFERED,
            timeout: options.timeout ?? (streaming ? Duration.minutes(15) : undefined),
            passthroughBehavior: options.passthroughBehavior,
            requestTemplates: options.requestTemplates,
        });
    }

    /**
     * Apply L1 CFN overrides for streaming routes to ensure full Lift parity.
     *
     * Streaming routes require:
     * 1. Integration.ResponseTransferMode = STREAM (already set via L2)
     * 2. Integration.Uri ends with /response-streaming-invocations
     * 3. Integration.TimeoutInMillis = 900000 (15 minutes)
     */
    private applyStreamingOverrides(
        method: apigw.Method,
        handler: lambda.IFunction,
        options: AppTheoryRestApiRouterIntegrationOptions,
    ): void {
        const cfnMethod = method.node.defaultChild as apigw.CfnMethod;
        if (!cfnMethod) return;

        // Build the streaming URI
        // Standard format: arn:{partition}:apigateway:{region}:lambda:path/2021-11-15/functions/{functionArn}/response-streaming-invocations
        const timeoutMs = options.timeout?.toMilliseconds() ?? 900000;

        // Override the integration properties
        cfnMethod.addPropertyOverride("Integration.TimeoutInMillis", timeoutMs);

        // The URI must use the streaming-specific path
        // We construct it using Fn::Join to preserve CloudFormation intrinsics
        cfnMethod.addPropertyOverride("Integration.Uri", {
            "Fn::Join": [
                "",
                [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    ":apigateway:",
                    { Ref: "AWS::Region" },
                    ":lambda:path/2021-11-15/functions/",
                    handler.functionArn,
                    "/response-streaming-invocations",
                ],
            ],
        });
    }

    /**
     * Build deploy options for the stage.
     */
    private buildDeployOptions(
        stageOpts: AppTheoryRestApiRouterStageOptions,
        stageName: string,
    ): apigw.StageOptions {
        // Handle access logging
        let accessLogDestination: apigw.IAccessLogDestination | undefined;
        let accessLogFormat = stageOpts.accessLogFormat;

        if (stageOpts.accessLogging === true) {
            // Create an auto-managed log group
            const logGroup = new logs.LogGroup(this, "AccessLogs", {
                retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
            });
            (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = logGroup;
            accessLogDestination = new apigw.LogGroupLogDestination(logGroup);
            accessLogFormat = accessLogFormat ?? apigw.AccessLogFormat.clf();
        } else if (stageOpts.accessLogging && typeof stageOpts.accessLogging === "object") {
            // Use provided log group
            (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = stageOpts.accessLogging;
            accessLogDestination = new apigw.LogGroupLogDestination(stageOpts.accessLogging);
            accessLogFormat = accessLogFormat ?? apigw.AccessLogFormat.clf();
        }

        return {
            stageName,
            accessLogDestination,
            accessLogFormat,
            metricsEnabled: stageOpts.detailedMetrics,
            throttlingRateLimit: stageOpts.throttlingRateLimit,
            throttlingBurstLimit: stageOpts.throttlingBurstLimit,
        };
    }

    /**
     * Set up custom domain with optional Route53 record.
     */
    private setupCustomDomain(domainOpts: AppTheoryRestApiRouterDomainOptions): void {
        // Get or create the certificate reference
        const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
            ? (acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn) as acm.ICertificate)
            : undefined);

        if (!certificate) {
            throw new Error("AppTheoryRestApiRouter: domain requires either certificate or certificateArn");
        }

        // Create the domain name
        const endpointType = domainOpts.endpointType ?? apigw.EndpointType.REGIONAL;
        const dmn = new apigw.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
            endpointType,
            securityPolicy: domainOpts.securityPolicy ?? apigw.SecurityPolicy.TLS_1_2,
        });
        (this as { domainName?: apigw.DomainName }).domainName = dmn;

        // Create the base path mapping
        const mapping = new apigw.BasePathMapping(this, "BasePathMapping", {
            domainName: dmn,
            restApi: this.api,
            basePath: domainOpts.basePath,
            stage: this.stage,
        });
        (this as { basePathMapping?: apigw.BasePathMapping }).basePathMapping = mapping;

        // Create Route53 record if hosted zone is provided
        if (domainOpts.hostedZone) {
            const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
            const record = new route53.ARecord(this, "AliasRecord", {
                zone: domainOpts.hostedZone,
                recordName,
                target: route53.RecordTarget.fromAlias(new route53targets.ApiGatewayDomain(dmn)),
            });
            (this as { aRecord?: route53.ARecord }).aRecord = record;

            if (domainOpts.createAAAARecord === true) {
                const aaaaRecord = new route53.AaaaRecord(this, "AliasRecordAAAA", {
                    zone: domainOpts.hostedZone,
                    recordName,
                    target: route53.RecordTarget.fromAlias(new route53targets.ApiGatewayDomain(dmn)),
                });
                (this as { aaaaRecord?: route53.AaaaRecord }).aaaaRecord = aaaaRecord;
            }
        }
    }

    /**
     * Build method responses for CORS-enabled endpoints.
     */
    private buildMethodResponses(): apigw.MethodResponse[] {
        return [
            {
                statusCode: "200",
                responseParameters: {
                    "method.response.header.Access-Control-Allow-Origin": true,
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Methods": true,
                },
            },
        ];
    }

    /**
     * Add CORS preflight (OPTIONS) method to a resource.
     */
    private addCorsPreflightMethod(resource: apigw.IResource): void {
        const opts = this.corsOptions ?? {};
        const allowOrigins = opts.allowOrigins ?? ["*"];
        const allowMethods = opts.allowMethods ?? ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"];
        const allowHeaders = opts.allowHeaders ?? [
            "Content-Type",
            "Authorization",
            "X-Amz-Date",
            "X-Api-Key",
            "X-Amz-Security-Token",
        ];
        const allowCredentials = opts.allowCredentials ?? false;
        const maxAge = opts.maxAge ?? Duration.seconds(600);

        const allowOrigin = allowOrigins.join(",");
        const allowMethodsStr = allowMethods.join(",");
        const allowHeadersStr = allowHeaders.join(",");

        resource.addMethod(
            "OPTIONS",
            new apigw.MockIntegration({
                integrationResponses: [
                    {
                        statusCode: "200",
                        responseParameters: {
                            "method.response.header.Access-Control-Allow-Headers": `'${allowHeadersStr}'`,
                            "method.response.header.Access-Control-Allow-Methods": `'${allowMethodsStr}'`,
                            "method.response.header.Access-Control-Allow-Origin": `'${allowOrigin}'`,
                            "method.response.header.Access-Control-Allow-Credentials": `'${allowCredentials}'`,
                            "method.response.header.Access-Control-Max-Age": `'${maxAge.toSeconds()}'`,
                        },
                    },
                ],
                passthroughBehavior: apigw.PassthroughBehavior.WHEN_NO_MATCH,
                requestTemplates: {
                    "application/json": '{"statusCode": 200}',
                },
            }),
            {
                methodResponses: [
                    {
                        statusCode: "200",
                        responseParameters: {
                            "method.response.header.Access-Control-Allow-Headers": true,
                            "method.response.header.Access-Control-Allow-Methods": true,
                            "method.response.header.Access-Control-Allow-Origin": true,
                            "method.response.header.Access-Control-Allow-Credentials": true,
                            "method.response.header.Access-Control-Max-Age": true,
                        },
                    },
                ],
            },
        );
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
