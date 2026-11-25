"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryRestApiRouter = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const route53targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const constructs_1 = require("constructs");
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const rest_api_waf_1 = require("./private/rest-api-waf");
const secure_defaults_1 = require("./private/secure-defaults");
const standard_logging_1 = require("./private/standard-logging");
const rest_api_streaming_1 = require("./private/rest-api-streaming");
const string_utils_1 = require("./private/string-utils");
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
class AppTheoryRestApiRouter extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "7.5.0" };
    /**
     * The underlying API Gateway REST API.
     */
    api;
    /**
     * The deployment stage.
     */
    stage;
    /**
     * The custom domain name (if configured).
     */
    domainName;
    /**
     * The base path mapping (if domain is configured).
     */
    basePathMapping;
    /**
     * AppTheory-managed regional WAF WebACL when enabled without webAclArn.
     */
    webAcl;
    /**
     * Regional WAF association for the REST API deployment stage.
     */
    wafAssociation;
    /**
     * The Route53 A record (if domain and hostedZone are configured).
     */
    aRecord;
    /**
     * The Route53 AAAA record (if domain, hostedZone, and createAAAARecord are configured).
     */
    aaaaRecord;
    /**
     * The access log group (if access logging is enabled).
     */
    accessLogGroup;
    corsOptions;
    corsEnabled;
    allowTestInvoke;
    scopePermissionToMethod;
    authorizer;
    authorizationType;
    namingContext;
    logicalName;
    constructor(scope, id, props = {}) {
        super(scope, id);
        // Normalize CORS config
        if (props.cors === true) {
            this.corsEnabled = true;
            this.corsOptions = {};
        }
        else if (props.cors && typeof props.cors === "object") {
            this.corsEnabled = true;
            this.corsOptions = props.cors;
        }
        else {
            this.corsEnabled = false;
        }
        this.allowTestInvoke = props.allowTestInvoke ?? true;
        this.scopePermissionToMethod = props.scopePermissionToMethod ?? true;
        this.authorizer = props.authorizer;
        this.authorizationType = props.authorizationType;
        this.namingContext = props.namingContext;
        this.logicalName = props.logicalName ?? (props.namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(props.namingContext, "AppTheoryRestApiRouter", "apiName", "api_rest", this.logicalName, props.apiName !== undefined);
        const derivedApiName = this.namingContext && this.logicalName
            ? this.namingContext.physicalName("api_rest", this.logicalName)
            : undefined;
        const configuredStageOpts = props.stage ?? {};
        const stageOpts = this.effectiveStageOptions(configuredStageOpts);
        const stageName = stageOpts.stageName ?? "prod";
        const compressionProps = props.minimumCompressionSize === undefined
            ? {}
            : { minCompressionSize: aws_cdk_lib_1.Size.bytes(props.minimumCompressionSize) };
        // Create the REST API
        this.api = new apigw.RestApi(this, "Api", {
            restApiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : props.apiName,
            description: props.description,
            deploy: props.deploy ?? true,
            retainDeployments: props.retainDeployments,
            endpointTypes: props.endpointTypes ?? [apigw.EndpointType.REGIONAL],
            binaryMediaTypes: props.binaryMediaTypes,
            ...compressionProps,
            apiKeySourceType: props.apiKeySourceType,
            deployOptions: this.buildDeployOptions(stageOpts, stageName),
        });
        if (this.namingContext && this.logicalName) {
            // Contract section 11.4: declare the resource carrying the composed name.
            this.namingContext.declareName("api_rest", this.logicalName, this.api);
        }
        this.stage = this.api.deploymentStage;
        // Set up custom domain if provided
        if (props.domain) {
            this.setupCustomDomain(props.domain);
        }
        if (props.waf) {
            const waf = (0, rest_api_waf_1.configureRestApiRegionalWaf)(this, this.api, this.stage, props.waf, props.apiName ?? "AppTheoryRestApiRouter");
            this.webAcl = waf.webAcl;
            this.wafAssociation = waf.wafAssociation;
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
    addLambdaIntegration(path, methods, handler, options = {}) {
        const resource = this.resourceForPath(path);
        for (const m of methods) {
            const method = String(m ?? "").trim().toUpperCase();
            if (!method)
                continue;
            // Create the integration
            const integration = this.createLambdaIntegration(handler, options);
            // Add the method
            const authorizationOptions = this.authorizer === undefined && this.authorizationType === undefined
                ? {}
                : {
                    ...(this.authorizer === undefined ? {} : { authorizer: this.authorizer }),
                    ...(this.authorizationType === undefined
                        ? {}
                        : { authorizationType: this.authorizationType }),
                };
            const createdMethod = resource.addMethod(method, integration, {
                methodResponses: this.corsEnabled ? this.buildMethodResponses() : undefined,
                ...authorizationOptions,
            });
            // For streaming routes, apply L1 overrides to ensure full compatibility
            if (options.streaming) {
                this.applyStreamingOverrides(createdMethod, handler, options);
                (0, rest_api_streaming_1.markRestApiStageRouteAsStreaming)(this.stage, method, path);
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
    resourceForPath(inputPath) {
        let current = this.api.root;
        const trimmed = (0, string_utils_1.trimRepeatedChar)(String(inputPath ?? "").trim(), "/");
        if (!trimmed)
            return current;
        for (const segment of trimmed.split("/")) {
            const part = String(segment ?? "").trim();
            if (!part)
                continue;
            current = current.getResource(part) ?? current.addResource(part);
        }
        return current;
    }
    /**
     * Create a Lambda integration with the appropriate configuration.
     */
    createLambdaIntegration(handler, options) {
        const streaming = options.streaming ?? false;
        // For streaming, we use STREAM responseTransferMode
        // Note: The URI suffix and timeout will be fixed via L1 overrides
        return new apigw.LambdaIntegration(handler, {
            proxy: true,
            allowTestInvoke: this.allowTestInvoke,
            scopePermissionToMethod: this.scopePermissionToMethod,
            responseTransferMode: streaming ? apigw.ResponseTransferMode.STREAM : apigw.ResponseTransferMode.BUFFERED,
            timeout: options.timeout ?? (streaming ? aws_cdk_lib_1.Duration.minutes(15) : undefined),
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
    applyStreamingOverrides(method, handler, options) {
        const cfnMethod = method.node.defaultChild;
        if (!cfnMethod)
            return;
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
    effectiveStageOptions(stage) {
        if (this.namingContext?.standardLogging === true && stage.accessLogging === undefined) {
            return { ...stage, accessLogging: true };
        }
        return stage;
    }
    buildDeployOptions(stageOpts, stageName) {
        // Handle access logging
        let accessLogDestination;
        let accessLogFormat = stageOpts.accessLogFormat;
        const standard = this.namingContext?.standardLogging === true;
        if (standard && !this.logicalName && stageOpts.accessLogging) {
            throw new Error("AppTheoryRestApiRouter standard logging requires a logical name");
        }
        if (stageOpts.accessLogging === true) {
            // The construct-created access-log group is a logging resource: under
            // the standard profile it takes the contract log-source name, and
            // under the legacy profile it keeps today's CloudFormation-generated
            // name and consumes no naming entry (r3, ADV-1312-1).
            const logGroup = new logs.LogGroup(this, "AccessLogs", standard && this.namingContext && this.logicalName
                ? {
                    logGroupName: this.namingContext.logGroupName(`logs/access/api/${this.logicalName}`),
                    retention: (0, standard_logging_1.retentionFor)(this.namingContext.retentionDays),
                }
                : {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
            if (standard && this.namingContext && this.logicalName) {
                // Contract section 11.4: declare the resource carrying the log-source name.
                this.namingContext.declareName("log_group", `logs/access/api/${this.logicalName}`, logGroup);
            }
            this.accessLogGroup = logGroup;
            accessLogDestination = new apigw.LogGroupLogDestination(logGroup);
            accessLogFormat = accessLogFormat ?? (standard ? (0, standard_logging_1.restApiAccessLogFormat)() : apigw.AccessLogFormat.clf());
        }
        else if (stageOpts.accessLogging && typeof stageOpts.accessLogging === "object") {
            // Use provided log group
            this.accessLogGroup = stageOpts.accessLogging;
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
    setupCustomDomain(domainOpts) {
        // Get or create the certificate reference
        const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryRestApiRouter: domain requires either certificate or certificateArn");
        }
        // Create the domain name
        const endpointType = domainOpts.endpointType ?? apigw.EndpointType.REGIONAL;
        // Security Hub APIGateway.11 accepts only the 2025 enhanced policies, and
        // API Gateway rejects a regional policy on an edge domain (and vice
        // versa). Without a naming context the pre-contract TLS_1_2 default stays.
        const securityPolicy = domainOpts.securityPolicy
            ?? ((0, secure_defaults_1.secureDefaults)(this.namingContext)
                ? (endpointType === apigw.EndpointType.EDGE
                    ? secure_defaults_1.RECOMMENDED_EDGE_REST_API_SECURITY_POLICY
                    : secure_defaults_1.RECOMMENDED_REST_API_SECURITY_POLICY)
                : apigw.SecurityPolicy.TLS_1_2);
        const endpointAccessMode = domainOpts.endpointAccessMode
            ?? ((0, secure_defaults_1.isEnhancedRestSecurityPolicy)(securityPolicy) ? apigw.EndpointAccessMode.STRICT : undefined);
        const dmn = new apigw.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
            endpointType,
            securityPolicy,
            ...(endpointAccessMode !== undefined ? { endpointAccessMode } : {}),
        });
        this.domainName = dmn;
        // Create the base path mapping
        const mapping = new apigw.BasePathMapping(this, "BasePathMapping", {
            domainName: dmn,
            restApi: this.api,
            basePath: domainOpts.basePath,
            stage: this.stage,
        });
        this.basePathMapping = mapping;
        // Create Route53 record if hosted zone is provided
        if (domainOpts.hostedZone) {
            const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
            const record = new route53.ARecord(this, "AliasRecord", {
                zone: domainOpts.hostedZone,
                recordName,
                target: route53.RecordTarget.fromAlias(new route53targets.ApiGatewayDomain(dmn)),
            });
            this.aRecord = record;
            if (domainOpts.createAAAARecord === true) {
                const aaaaRecord = new route53.AaaaRecord(this, "AliasRecordAAAA", {
                    zone: domainOpts.hostedZone,
                    recordName,
                    target: route53.RecordTarget.fromAlias(new route53targets.ApiGatewayDomain(dmn)),
                });
                this.aaaaRecord = aaaaRecord;
            }
        }
    }
    /**
     * Build method responses for CORS-enabled endpoints.
     */
    buildMethodResponses() {
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
    addCorsPreflightMethod(resource) {
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
        const maxAge = opts.maxAge ?? aws_cdk_lib_1.Duration.seconds(600);
        const allowOrigin = allowOrigins.join(",");
        const allowMethodsStr = allowMethods.join(",");
        const allowHeadersStr = allowHeaders.join(",");
        resource.addMethod("OPTIONS", new apigw.MockIntegration({
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
        }), {
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
        });
    }
}
exports.AppTheoryRestApiRouter = AppTheoryRestApiRouter;
/**
 * Convert a domain name to a Route53 record name relative to the zone.
 */
function toRoute53RecordName(domainName, zone) {
    const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
    const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
    if (!zoneName)
        return fqdn;
    if (fqdn === zoneName)
        return "";
    const suffix = `.${zoneName}`;
    if (fqdn.endsWith(suffix)) {
        return fqdn.slice(0, -suffix.length);
    }
    return fqdn;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSx5REFBcUU7QUFDckUsK0RBS21DO0FBQ25DLGlFQUFrRjtBQUNsRixxRUFBZ0Y7QUFDaEYseURBQTBEO0FBcVYxRDs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ2pEOztPQUVHO0lBQ2EsR0FBRyxDQUFnQjtJQUVuQzs7T0FFRztJQUNhLEtBQUssQ0FBYztJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBb0I7SUFFOUM7O09BRUc7SUFDYSxlQUFlLENBQXlCO0lBRXhEOztPQUVHO0lBQ2EsTUFBTSxDQUFtQjtJQUV6Qzs7T0FFRztJQUNhLGNBQWMsQ0FBOEI7SUFFNUQ7O09BRUc7SUFDYSxPQUFPLENBQW1CO0lBRTFDOztPQUVHO0lBQ2EsVUFBVSxDQUFzQjtJQUVoRDs7T0FFRztJQUNhLGNBQWMsQ0FBa0I7SUFFL0IsV0FBVyxDQUFxQztJQUNoRCxXQUFXLENBQVU7SUFDckIsZUFBZSxDQUFVO0lBQ3pCLHVCQUF1QixDQUFVO0lBQ2pDLFVBQVUsQ0FBcUI7SUFDL0IsaUJBQWlCLENBQTJCO0lBQzVDLGFBQWEsQ0FBMEI7SUFDdkMsV0FBVyxDQUFVO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLHdCQUF3QjtRQUN4QixJQUFJLEtBQUssQ0FBQyxJQUFJ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d0JBQzFELHlEQUF5RCxFQUFFLElBQUk7d0JBQy9ELCtDQUErQyxFQUFFLElBQUk7cUJBQ3hEO2lCQUNKO2FBQ0o7U0FDSixDQUNKLENBQUM7SUFDTixDQUFDOztBQXJjTCx3REFzY0M7QUFFRDs7R0FFRztBQUNILFNBQVMsbUJBQW1CLENBQUMsVUFBa0IsRUFBRSxJQUF5QjtJQUN0RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDaEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgU2l6ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7XG4gICAgUkVDT01NRU5ERURfRURHRV9SRVNUX0FQSV9TRUNVUklUWV9QT0xJQ1ksXG4gICAgUkVDT01NRU5ERURfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZLFxuICAgIGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3ksXG4gICAgc2VjdXJlRGVmYXVsdHMsXG59IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyByZXN0QXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB7IG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS1zdHJlYW1pbmdcIjtcbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbi8qKlxuICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgICAqIEBkZWZhdWx0IFsnKiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICAgKiBAZGVmYXVsdCBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUycsICdQQVRDSCcsICdIRUFEJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICAgKiBAZGVmYXVsdCBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJywgJ1gtQW16LURhdGUnLCAnWC1BcGktS2V5JywgJ1gtQW16LVNlY3VyaXR5LVRva2VuJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYWxsb3cgY3JlZGVudGlhbHMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE1heCBhZ2UgZm9yIHByZWZsaWdodCBjYWNoZSBpbiBzZWNvbmRzLlxuICAgICAqIEBkZWZhdWx0IDYwMFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIFN0YWdlLWxldmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogU3RhZ2UgbmFtZS5cbiAgICAgKiBAZGVmYXVsdCAncHJvZCdcbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgICAqIElmIHRydWUsIGEgbG9nIGdyb3VwIHdpbGwgYmUgY3JlYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgICAqIFByb3ZpZGUgYSBMb2dHcm91cCBmb3IgY3VzdG9tIGxvZ2dpbmcgY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUgKGJvb2xlYW4pLlxuICAgICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgICAvKipcbiAgICAgKiBBY2Nlc3MgbG9nIGZvcm1hdC5cbiAgICAgKiBAZGVmYXVsdCBBY2Nlc3NMb2dGb3JtYXQuY2xmKCkgKENvbW1vbiBMb2cgRm9ybWF0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXRhaWxlZCBDbG91ZFdhdGNoIG1ldHJpY3MgYXQgbWV0aG9kL3Jlc291cmNlIGxldmVsLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGV0YWlsZWRNZXRyaWNzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChlLmcuLCBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgKG11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBlZGdlIGVuZHBvaW50cywgc2FtZSByZWdpb24gZm9yIHJlZ2lvbmFsKS5cbiAgICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIElmIHByb3ZpZGVkLCBhbiBBIHJlY29yZCAoYWxpYXMpIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGBob3N0ZWRab25lYCBpcyBwcm92aWRlZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIGZvciB0aGUgQVBJIHVuZGVyIHRoaXMgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobWFwcyB0byB0aGUgcm9vdClcbiAgICAgKi9cbiAgICByZWFkb25seSBiYXNlUGF0aD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGUgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgUkVHSU9OQUxcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGU/OiBhcGlndy5FbmRwb2ludFR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBTZWN1cml0eSBwb2xpY3kgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBXaXRoIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YlxuICAgICAqIEFQSUdhdGV3YXkuMTEgYWNjZXB0cyBmb3IgdGhlIGVuZHBvaW50IHR5cGUgKHJlZ2lvbmFsOlxuICAgICAqIGBUTFMxM18xXzJfUEZTX1BRXzIwMjVfMDlgLCBlZGdlOiBgVExTMTJfUEZTXzIwMjVfRURHRWApLiBXaXRob3V0IGFcbiAgICAgKiBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyBgVExTXzFfMmAuXG4gICAgICpcbiAgICAgKiBUaGUgMjAyNSBwb2xpY2llcyBhcmUgYWxzbyBhIGNpcGhlci1wb2xpY3kgY2hhbmdlIGZvciBjbGllbnRzLCB0aGUgc2FtZVxuICAgICAqIGNhdmVhdCBhcyB0aGUgQ2xvdWRGcm9udC4xNSBgVExTdjEuMl8yMDI1YCBwb2xpY3k6IGEgY2xpZW50IHRoYXQgb25seVxuICAgICAqIG5lZ290aWF0ZXMgYW4gb2xkZXIgVExTIDEuMiBjaXBoZXIgc3VpdGUgaXMgZXhjbHVkZWQuIEFuIGVuaGFuY2VkIHBvbGljeVxuICAgICAqIHJlcXVpcmVzIGFuIGVuZHBvaW50IGFjY2VzcyBtb2RlIGFsb25nc2lkZSBpdDogQXBwVGhlb3J5IGRlcml2ZXMgYFNUUklDVGBcbiAgICAgKiAodGhlIHJlY29tbWVuZGVkIG1vZGUpLCBhbmQgYEJBU0lDYCByZW1haW5zIGF2YWlsYWJsZSB0aHJvdWdoXG4gICAgICogYGRvbWFpbi5lbmRwb2ludEFjY2Vzc01vZGVgLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgVExTXzFfMiwgb3IgdGhlIEFQSUdhdGV3YXkuMTEgcG9saWN5IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3cuU2VjdXJpdHlQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCBhY2Nlc3MgbW9kZSBmb3IgYW4gZW5oYW5jZWQgKGBTZWN1cml0eVBvbGljeV8qYCkgc2VjdXJpdHkgcG9saWN5LlxuICAgICAqXG4gICAgICogQVBJIEdhdGV3YXkgcmVxdWlyZXMgdGhpcyBmb3IgYW4gZW5oYW5jZWQgcG9saWN5IGFuZCByZWplY3RzIGl0IGZvciBhXG4gICAgICogbGVnYWN5IG9uZS4gV2hlbiB1bnNldCwgYW4gZW5oYW5jZWQgZWZmZWN0aXZlIHBvbGljeSB0YWtlcyBgU1RSSUNUYCBhbmQgYVxuICAgICAqIGxlZ2FjeSBwb2xpY3kgdGFrZXMgbm8gbW9kZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IFNUUklDVCBmb3IgYW4gZW5oYW5jZWQgZWZmZWN0aXZlIHBvbGljeSwgb3RoZXJ3aXNlIHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50QWNjZXNzTW9kZT86IGFwaWd3LkVuZHBvaW50QWNjZXNzTW9kZTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgICAqIGxvZyBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzXG4gICAgICogSlNPTiBmaWVsZCBzZXQuIFBhc3MgYHN0YWdlLmFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgICAqXG4gICAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRGVzY3JpcHRpb24gb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBzZW5zaWJsZSBkZWZhdWx0cyxcbiAgICAgKiBvciBwcm92aWRlIGN1c3RvbSBvcHRpb25zLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gQ09SUylcbiAgICAgKi9cbiAgICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGN1c3RvbSBkb21haW4pXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuIFNldCB0byB0cnVlXG4gICAgICogZm9yIGFuIEFwcFRoZW9yeS1tYW5hZ2VkIFdlYkFDTCwgb3IgcHJvdmlkZSBvcHRpb25zIHRvIHJldXNlIGFuIGV4aXN0aW5nXG4gICAgICogcmVnaW9uYWwgV2ViQUNMLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlcyBmb3IgdGhlIFJFU1QgQVBJLlxuICAgICAqIEBkZWZhdWx0IFtSRUdJT05BTF1cbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGVzPzogYXBpZ3cuRW5kcG9pbnRUeXBlW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRoZSBSRVNUIEFQSSB1c2VzIGJpbmFyeSBtZWRpYSB0eXBlcy5cbiAgICAgKiBTcGVjaWZ5IG1lZGlhIHR5cGVzIHRoYXQgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgYmluYXJ5LlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJpbmFyeU1lZGlhVHlwZXM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gY29tcHJlc3Npb24gc2l6ZSBpbiBieXRlcy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGNvbXByZXNzaW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Db21wcmVzc2lvblNpemU/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGVwbG95IG9uIGNvbnN0cnVjdCBjcmVhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVwbG95PzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFJldGFpbiBkZXBsb3ltZW50IGhpc3Rvcnkgd2hlbiBkZXBsb3ltZW50cyBjaGFuZ2UuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSByZXRhaW5EZXBsb3ltZW50cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBBUEkga2V5IHNvdXJjZSB0eXBlLlxuICAgICAqIEBkZWZhdWx0IEhFQURFUlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUtleVNvdXJjZVR5cGU/OiBhcGlndy5BcGlLZXlTb3VyY2VUeXBlO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBBUEkgR2F0ZXdheSBjb25zb2xlIHRlc3QgaW52b2NhdGlvbnMgc2hvdWxkIGJlIGdyYW50ZWQgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3Qgc3VwcHJlc3NlcyB0aGUgZXh0cmEgYHRlc3QtaW52b2tlLXN0YWdlYCBMYW1iZGEgcGVybWlzc2lvbnNcbiAgICAgKiB0aGF0IENESyBhZGRzIGZvciBlYWNoIFJFU1QgQVBJIG1ldGhvZC4gVGhpcyByZWR1Y2VzIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZSB3aGlsZVxuICAgICAqIHByZXNlcnZpbmcgZGVwbG95ZWQtc3RhZ2UgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIFJFU1QgQVBJIG1ldGhvZHMuXG4gICAgICpcbiAgICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgbWV0aG9kL3BhdGggcGFpci4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBmcm9udC1jb250cm9sbGVyXG4gICAgICogQVBJcyB0aGF0IHJvdXRlIG1hbnkgUkVTVCBwYXRocyB0byB0aGUgc2FtZSBMYW1iZGEuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgQVBJIEdhdGV3YXkgYXV0aG9yaXplciBhcHBsaWVkIHRvIGV2ZXJ5IExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2QuXG4gICAgICpcbiAgICAgKiBXaGVuIG9taXR0ZWQsIG1ldGhvZHMga2VlcCBBUEkgR2F0ZXdheSdzIG9wZW4gZGVmYXVsdCAoYEF1dGhvcml6YXRpb25UeXBlLk5PTkVgKS5cbiAgICAgKiBDT1JTIHByZWZsaWdodCBgT1BUSU9OU2AgbWV0aG9kcyBzdGF5IHVuYXV0aGVudGljYXRlZCByZWdhcmRsZXNzIG9mIHRoaXMgc2V0dGluZy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gYXV0aG9yaXplcilcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemF0aW9uIHR5cGUgZm9yIHRoZSBMYW1iZGEgaW50ZWdyYXRpb24gbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFVzdWFsbHkgb21pdHRlZDogd2hlbiBgYXV0aG9yaXplcmAgaXMgc2V0LCBBUEkgR2F0ZXdheSBkZXJpdmVzIHRoZSB0eXBlIGZyb20gdGhlXG4gICAgICogYXV0aG9yaXplciBpdHNlbGYuIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gb3ZlcnJpZGUgdGhhdCBpbmZlcmVuY2UuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlcml2ZWQgZnJvbSBgYXV0aG9yaXplcmAsIG9yIGBOT05FYCB3aGVuIG5vIGF1dGhvcml6ZXIgaXMgc2V0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6YXRpb25UeXBlPzogYXBpZ3cuQXV0aG9yaXphdGlvblR5cGU7XG59XG5cbi8qKlxuICogQSBSRVNUIEFQSSB2MSByb3V0ZXIgdGhhdCBzdXBwb3J0cyBtdWx0aS1MYW1iZGEgcm91dGluZyB3aXRoIGZ1bGwgc3RyZWFtaW5nIHBhcml0eS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBhZGRyZXNzZXMgdGhlIGdhcHMgaW4gQXBwVGhlb3J5UmVzdEFwaSBieSBhbGxvd2luZzpcbiAqIC0gTXVsdGlwbGUgTGFtYmRhIGZ1bmN0aW9ucyBhdHRhY2hlZCB0byBkaWZmZXJlbnQgcm91dGVzXG4gKiAtIENvbXBsZXRlIHJlc3BvbnNlIHN0cmVhbWluZyBpbnRlZ3JhdGlvbiAocmVzcG9uc2VUcmFuc2Zlck1vZGUsIFVSSSBzdWZmaXgsIHRpbWVvdXQpXG4gKiAtIFN0YWdlIGNvbnRyb2xzIChhY2Nlc3MgbG9nZ2luZywgbWV0cmljcywgdGhyb3R0bGluZywgQ09SUylcbiAqIC0gQ3VzdG9tIGRvbWFpbiB3aXJpbmcgd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZFxuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCByb3V0ZXIgPSBuZXcgQXBwVGhlb3J5UmVzdEFwaVJvdXRlcih0aGlzLCAnUm91dGVyJywge1xuICogICBhcGlOYW1lOiAnbXktYXBpJyxcbiAqICAgc3RhZ2U6IHsgc3RhZ2VOYW1lOiAncHJvZCcsIGFjY2Vzc0xvZ2dpbmc6IHRydWUsIGRldGFpbGVkTWV0cmljczogdHJ1ZSB9LFxuICogICBjb3JzOiB0cnVlLFxuICogfSk7XG4gKlxuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvc3NlJywgWydHRVQnXSwgc3NlRm4sIHsgc3RyZWFtaW5nOiB0cnVlIH0pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvYXBpL2dyYXBocWwnLCBbJ1BPU1QnXSwgZ3JhcGhxbEZuKTtcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL3twcm94eSt9JywgWydBTlknXSwgYXBpRm4pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIHVuZGVybHlpbmcgQVBJIEdhdGV3YXkgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3cuUmVzdEFwaTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkZXBsb3ltZW50IHN0YWdlLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3cuU3RhZ2U7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWU7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nO1xuXG4gICAgLyoqXG4gICAgICogQXBwVGhlb3J5LW1hbmFnZWQgcmVnaW9uYWwgV0FGIFdlYkFDTCB3aGVuIGVuYWJsZWQgd2l0aG91dCB3ZWJBY2xBcm4uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdlYkFjbD86IHdhZnYyLkNmbldlYkFDTDtcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhc3NvY2lhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEFBQUEgcmVjb3JkIChpZiBkb21haW4sIGhvc3RlZFpvbmUsIGFuZCBjcmVhdGVBQUFBUmVjb3JkIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc09wdGlvbnM/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzRW5hYmxlZDogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZTogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXplcj86IGFwaWd3LklBdXRob3JpemVyO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbiAgICBwcml2YXRlIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuICAgIHByaXZhdGUgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzID0ge30pIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICAvLyBOb3JtYWxpemUgQ09SUyBjb25maWdcbiAgICAgICAgaWYgKHByb3BzLmNvcnMgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmNvcnMgJiYgdHlwZW9mIHByb3BzLmNvcnMgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHByb3BzLmNvcnM7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hbGxvd1Rlc3RJbnZva2UgPSBwcm9wcy5hbGxvd1Rlc3RJbnZva2UgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID8/IHRydWU7XG4gICAgICAgIHRoaXMuYXV0aG9yaXplciA9IHByb3BzLmF1dGhvcml6ZXI7XG4gICAgICAgIHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPSBwcm9wcy5hdXRob3JpemF0aW9uVHlwZTtcbiAgICAgICAgdGhpcy5uYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgICAgdGhpcy5sb2dpY2FsTmFtZSA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChwcm9wcy5uYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgICAgcmVmdXNlRXhwbGljaXROYW1lKHByb3BzLm5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLCBcImFwaU5hbWVcIiwgXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgICAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lXG4gICAgICAgICAgICA/IHRoaXMubmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAgICAgY29uc3QgY29uZmlndXJlZFN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgICAgICBjb25zdCBzdGFnZU9wdHMgPSB0aGlzLmVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhjb25maWd1cmVkU3RhZ2VPcHRzKTtcbiAgICAgICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcInByb2RcIjtcbiAgICAgICAgY29uc3QgY29tcHJlc3Npb25Qcm9wcyA9XG4gICAgICAgICAgICBwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgOiB7IG1pbkNvbXByZXNzaW9uU2l6ZTogU2l6ZS5ieXRlcyhwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplKSB9O1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgUkVTVCBBUElcbiAgICAgICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3cuUmVzdEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgICAgICByZXN0QXBpTmFtZTogZGVyaXZlZEFwaU5hbWUgJiYgIWRlcml2ZWRBcGlOYW1lLmdlbmVyYXRlZCA/IGRlcml2ZWRBcGlOYW1lLm5hbWUgOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgZGVwbG95OiBwcm9wcy5kZXBsb3kgPz8gdHJ1ZSxcbiAgICAgICAgICAgIHJldGFpbkRlcGxveW1lbnRzOiBwcm9wcy5yZXRhaW5EZXBsb3ltZW50cyxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZXM6IHByb3BzLmVuZHBvaW50VHlwZXMgPz8gW2FwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTF0sXG4gICAgICAgICAgICBiaW5hcnlNZWRpYVR5cGVzOiBwcm9wcy5iaW5hcnlNZWRpYVR5cGVzLFxuICAgICAgICAgICAgLi4uY29tcHJlc3Npb25Qcm9wcyxcbiAgICAgICAgICAgIGFwaUtleVNvdXJjZVR5cGU6IHByb3BzLmFwaUtleVNvdXJjZVR5cGUsXG4gICAgICAgICAgICBkZXBsb3lPcHRpb25zOiB0aGlzLmJ1aWxkRGVwbG95T3B0aW9ucyhzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAodGhpcy5uYW1pbmdDb250ZXh0ICYmIHRoaXMubG9naWNhbE5hbWUpIHtcbiAgICAgICAgICAgIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogZGVjbGFyZSB0aGUgcmVzb3VyY2UgY2FycnlpbmcgdGhlIGNvbXBvc2VkIG5hbWUuXG4gICAgICAgICAgICB0aGlzLm5hbWluZ0NvbnRleHQuZGVjbGFyZU5hbWUoXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lLCB0aGlzLmFwaSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnN0YWdlID0gdGhpcy5hcGkuZGVwbG95bWVudFN0YWdlO1xuXG4gICAgICAgIC8vIFNldCB1cCBjdXN0b20gZG9tYWluIGlmIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ocHJvcHMuZG9tYWluKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgICAgICAgIGNvbnN0IHdhZiA9IGNvbmZpZ3VyZVJlc3RBcGlSZWdpb25hbFdhZihcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIHRoaXMuYXBpLFxuICAgICAgICAgICAgICAgIHRoaXMuc3RhZ2UsXG4gICAgICAgICAgICAgICAgcHJvcHMud2FmLFxuICAgICAgICAgICAgICAgIHByb3BzLmFwaU5hbWUgPz8gXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyB3ZWJBY2w/OiB3YWZ2Mi5DZm5XZWJBQ0wgfSkud2ViQWNsID0gd2FmLndlYkFjbDtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgd2FmQXNzb2NpYXRpb24/OiB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbiB9KS53YWZBc3NvY2lhdGlvbiA9IHdhZi53YWZBc3NvY2lhdGlvbjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFkZCBhIExhbWJkYSBpbnRlZ3JhdGlvbiBmb3IgdGhlIHNwZWNpZmllZCBwYXRoIGFuZCBIVFRQIG1ldGhvZHMuXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcGF0aCAtIFRoZSByZXNvdXJjZSBwYXRoIChlLmcuLCBcIi9zc2VcIiwgXCIvYXBpL2dyYXBocWxcIiwgXCIve3Byb3h5K31cIilcbiAgICAgKiBAcGFyYW0gbWV0aG9kcyAtIEFycmF5IG9mIEhUVFAgbWV0aG9kcyAoZS5nLiwgW1wiR0VUXCIsIFwiUE9TVFwiXSBvciBbXCJBTllcIl0pXG4gICAgICogQHBhcmFtIGhhbmRsZXIgLSBUaGUgTGFtYmRhIGZ1bmN0aW9uIHRvIGludGVncmF0ZVxuICAgICAqIEBwYXJhbSBvcHRpb25zIC0gSW50ZWdyYXRpb24gb3B0aW9ucyBpbmNsdWRpbmcgc3RyZWFtaW5nIGNvbmZpZ3VyYXRpb25cbiAgICAgKi9cbiAgICBhZGRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgcGF0aDogc3RyaW5nLFxuICAgICAgICBtZXRob2RzOiBzdHJpbmdbXSxcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyA9IHt9LFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCByZXNvdXJjZSA9IHRoaXMucmVzb3VyY2VGb3JQYXRoKHBhdGgpO1xuXG4gICAgICAgIGZvciAoY29uc3QgbSBvZiBtZXRob2RzKSB7XG4gICAgICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcobSA/PyBcIlwiKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgICAgIGlmICghbWV0aG9kKSBjb250aW51ZTtcblxuICAgICAgICAgICAgLy8gQ3JlYXRlIHRoZSBpbnRlZ3JhdGlvblxuICAgICAgICAgICAgY29uc3QgaW50ZWdyYXRpb24gPSB0aGlzLmNyZWF0ZUxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIG9wdGlvbnMpO1xuXG4gICAgICAgICAgICAvLyBBZGQgdGhlIG1ldGhvZFxuICAgICAgICAgICAgY29uc3QgYXV0aG9yaXphdGlvbk9wdGlvbnMgPVxuICAgICAgICAgICAgICAgIHRoaXMuYXV0aG9yaXplciA9PT0gdW5kZWZpbmVkICYmIHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odGhpcy5hdXRob3JpemVyID09PSB1bmRlZmluZWQgPyB7fSA6IHsgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyIH0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odGhpcy5hdXRob3JpemF0aW9uVHlwZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHsgYXV0aG9yaXphdGlvblR5cGU6IHRoaXMuYXV0aG9yaXphdGlvblR5cGUgfSksXG4gICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRNZXRob2QgPSByZXNvdXJjZS5hZGRNZXRob2QobWV0aG9kLCBpbnRlZ3JhdGlvbiwge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogdGhpcy5jb3JzRW5hYmxlZCA/IHRoaXMuYnVpbGRNZXRob2RSZXNwb25zZXMoKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAuLi5hdXRob3JpemF0aW9uT3B0aW9ucyxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBGb3Igc3RyZWFtaW5nIHJvdXRlcywgYXBwbHkgTDEgb3ZlcnJpZGVzIHRvIGVuc3VyZSBmdWxsIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIGlmIChvcHRpb25zLnN0cmVhbWluZykge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoY3JlYXRlZE1ldGhvZCwgaGFuZGxlciwgb3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcodGhpcy5zdGFnZSwgbWV0aG9kLCBwYXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBPUFRJT05TIG1ldGhvZCBmb3IgQ09SUyBpZiBlbmFibGVkIGFuZCBub3QgYWxyZWFkeSBwcmVzZW50XG4gICAgICAgIGlmICh0aGlzLmNvcnNFbmFibGVkICYmICFyZXNvdXJjZS5ub2RlLnRyeUZpbmRDaGlsZChcIk9QVElPTlNcIikpIHtcbiAgICAgICAgICAgIHRoaXMuYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgb3IgY3JlYXRlIGEgcmVzb3VyY2UgZm9yIHRoZSBnaXZlbiBwYXRoLlxuICAgICAqL1xuICAgIHByaXZhdGUgcmVzb3VyY2VGb3JQYXRoKGlucHV0UGF0aDogc3RyaW5nKTogYXBpZ3cuSVJlc291cmNlIHtcbiAgICAgICAgbGV0IGN1cnJlbnQ6IGFwaWd3LklSZXNvdXJjZSA9IHRoaXMuYXBpLnJvb3Q7XG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhpbnB1dFBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gICAgICAgIGlmICghdHJpbW1lZCkgcmV0dXJuIGN1cnJlbnQ7XG5cbiAgICAgICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHRyaW1tZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJ0ID0gU3RyaW5nKHNlZ21lbnQgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgaWYgKCFwYXJ0KSBjb250aW51ZTtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LmdldFJlc291cmNlKHBhcnQpID8/IGN1cnJlbnQuYWRkUmVzb3VyY2UocGFydCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgTGFtYmRhIGludGVncmF0aW9uIHdpdGggdGhlIGFwcHJvcHJpYXRlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcHJpdmF0ZSBjcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbiB7XG4gICAgICAgIGNvbnN0IHN0cmVhbWluZyA9IG9wdGlvbnMuc3RyZWFtaW5nID8/IGZhbHNlO1xuXG4gICAgICAgIC8vIEZvciBzdHJlYW1pbmcsIHdlIHVzZSBTVFJFQU0gcmVzcG9uc2VUcmFuc2Zlck1vZGVcbiAgICAgICAgLy8gTm90ZTogVGhlIFVSSSBzdWZmaXggYW5kIHRpbWVvdXQgd2lsbCBiZSBmaXhlZCB2aWEgTDEgb3ZlcnJpZGVzXG4gICAgICAgIHJldHVybiBuZXcgYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwge1xuICAgICAgICAgICAgcHJveHk6IHRydWUsXG4gICAgICAgICAgICBhbGxvd1Rlc3RJbnZva2U6IHRoaXMuYWxsb3dUZXN0SW52b2tlLFxuICAgICAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QsXG4gICAgICAgICAgICByZXNwb25zZVRyYW5zZmVyTW9kZTogc3RyZWFtaW5nID8gYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuU1RSRUFNIDogYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuQlVGRkVSRUQsXG4gICAgICAgICAgICB0aW1lb3V0OiBvcHRpb25zLnRpbWVvdXQgPz8gKHN0cmVhbWluZyA/IER1cmF0aW9uLm1pbnV0ZXMoMTUpIDogdW5kZWZpbmVkKSxcbiAgICAgICAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IG9wdGlvbnMucGFzc3Rocm91Z2hCZWhhdmlvcixcbiAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IG9wdGlvbnMucmVxdWVzdFRlbXBsYXRlcyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQXBwbHkgTDEgQ0ZOIG92ZXJyaWRlcyBmb3Igc3RyZWFtaW5nIHJvdXRlcyB0byBlbnN1cmUgZnVsbCBMaWZ0IHBhcml0eS5cbiAgICAgKlxuICAgICAqIFN0cmVhbWluZyByb3V0ZXMgcmVxdWlyZTpcbiAgICAgKiAxLiBJbnRlZ3JhdGlvbi5SZXNwb25zZVRyYW5zZmVyTW9kZSA9IFNUUkVBTSAoYWxyZWFkeSBzZXQgdmlhIEwyKVxuICAgICAqIDIuIEludGVncmF0aW9uLlVyaSBlbmRzIHdpdGggL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAqIDMuIEludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpcyA9IDkwMDAwMCAoMTUgbWludXRlcylcbiAgICAgKi9cbiAgICBwcml2YXRlIGFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKFxuICAgICAgICBtZXRob2Q6IGFwaWd3Lk1ldGhvZCxcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgY2ZuTWV0aG9kID0gbWV0aG9kLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3LkNmbk1ldGhvZDtcbiAgICAgICAgaWYgKCFjZm5NZXRob2QpIHJldHVybjtcblxuICAgICAgICAvLyBCdWlsZCB0aGUgc3RyZWFtaW5nIFVSSVxuICAgICAgICAvLyBTdGFuZGFyZCBmb3JtYXQ6IGFybjp7cGFydGl0aW9ufTphcGlnYXRld2F5OntyZWdpb259OmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL3tmdW5jdGlvbkFybn0vcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICAgIGNvbnN0IHRpbWVvdXRNcyA9IG9wdGlvbnMudGltZW91dD8udG9NaWxsaXNlY29uZHMoKSA/PyA5MDAwMDA7XG5cbiAgICAgICAgLy8gT3ZlcnJpZGUgdGhlIGludGVncmF0aW9uIHByb3BlcnRpZXNcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXNcIiwgdGltZW91dE1zKTtcblxuICAgICAgICAvLyBUaGUgVVJJIG11c3QgdXNlIHRoZSBzdHJlYW1pbmctc3BlY2lmaWMgcGF0aFxuICAgICAgICAvLyBXZSBjb25zdHJ1Y3QgaXQgdXNpbmcgRm46OkpvaW4gdG8gcHJlc2VydmUgQ2xvdWRGb3JtYXRpb24gaW50cmluc2ljc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlVyaVwiLCB7XG4gICAgICAgICAgICBcIkZuOjpKb2luXCI6IFtcbiAgICAgICAgICAgICAgICBcIlwiLFxuICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgXCJhcm46XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UGFydGl0aW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6YXBpZ2F0ZXdheTpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpSZWdpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy9cIixcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlci5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgICAgICAgXCIvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXCIsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIGRlcGxveSBvcHRpb25zIGZvciB0aGUgc3RhZ2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBlZmZlY3RpdmVTdGFnZU9wdGlvbnMoXG4gICAgICAgIHN0YWdlOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zLFxuICAgICk6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMge1xuICAgICAgICBpZiAodGhpcy5uYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4geyAuLi5zdGFnZSwgYWNjZXNzTG9nZ2luZzogdHJ1ZSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBzdGFnZTtcbiAgICB9XG5cbiAgICBwcml2YXRlIGJ1aWxkRGVwbG95T3B0aW9ucyhcbiAgICAgICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zLFxuICAgICAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICApOiBhcGlndy5TdGFnZU9wdGlvbnMge1xuICAgICAgICAvLyBIYW5kbGUgYWNjZXNzIGxvZ2dpbmdcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBhcGlndy5JQWNjZXNzTG9nRGVzdGluYXRpb24gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBhY2Nlc3NMb2dGb3JtYXQgPSBzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0O1xuICAgICAgICBjb25zdCBzdGFuZGFyZCA9IHRoaXMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgICAgICBpZiAoc3RhbmRhcmQgJiYgIXRoaXMubG9naWNhbE5hbWUgJiYgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlclxuICAgICAgICAgICAgLy8gdGhlIHN0YW5kYXJkIHByb2ZpbGUgaXQgdGFrZXMgdGhlIGNvbnRyYWN0IGxvZy1zb3VyY2UgbmFtZSwgYW5kXG4gICAgICAgICAgICAvLyB1bmRlciB0aGUgbGVnYWN5IHByb2ZpbGUgaXQga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWRcbiAgICAgICAgICAgIC8vIG5hbWUgYW5kIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIixcbiAgICAgICAgICAgICAgICBzdGFuZGFyZCAmJiB0aGlzLm5hbWluZ0NvbnRleHQgJiYgdGhpcy5sb2dpY2FsTmFtZVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICBsb2dHcm91cE5hbWU6IHRoaXMubmFtaW5nQ29udGV4dC5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke3RoaXMubG9naWNhbE5hbWV9YCksXG4gICAgICAgICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKHRoaXMubmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKHN0YW5kYXJkICYmIHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lKSB7XG4gICAgICAgICAgICAgICAgLy8gQ29udHJhY3Qgc2VjdGlvbiAxMS40OiBkZWNsYXJlIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbG9nLXNvdXJjZSBuYW1lLlxuICAgICAgICAgICAgICAgIHRoaXMubmFtaW5nQ29udGV4dC5kZWNsYXJlTmFtZShcImxvZ19ncm91cFwiLCBgbG9ncy9hY2Nlc3MvYXBpLyR7dGhpcy5sb2dpY2FsTmFtZX1gLCBsb2dHcm91cCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IChzdGFuZGFyZCA/IHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICAvLyBTZWN1cml0eSBIdWIgQVBJR2F0ZXdheS4xMSBhY2NlcHRzIG9ubHkgdGhlIDIwMjUgZW5oYW5jZWQgcG9saWNpZXMsIGFuZFxuICAgICAgICAvLyBBUEkgR2F0ZXdheSByZWplY3RzIGEgcmVnaW9uYWwgcG9saWN5IG9uIGFuIGVkZ2UgZG9tYWluIChhbmQgdmljZVxuICAgICAgICAvLyB2ZXJzYSkuIFdpdGhvdXQgYSBuYW1pbmcgY29udGV4dCB0aGUgcHJlLWNvbnRyYWN0IFRMU18xXzIgZGVmYXVsdCBzdGF5cy5cbiAgICAgICAgY29uc3Qgc2VjdXJpdHlQb2xpY3kgPSBkb21haW5PcHRzLnNlY3VyaXR5UG9saWN5XG4gICAgICAgICAgICA/PyAoc2VjdXJlRGVmYXVsdHModGhpcy5uYW1pbmdDb250ZXh0KVxuICAgICAgICAgICAgICAgID8gKGVuZHBvaW50VHlwZSA9PT0gYXBpZ3cuRW5kcG9pbnRUeXBlLkVER0VcbiAgICAgICAgICAgICAgICAgICAgPyBSRUNPTU1FTkRFRF9FREdFX1JFU1RfQVBJX1NFQ1VSSVRZX1BPTElDWVxuICAgICAgICAgICAgICAgICAgICA6IFJFQ09NTUVOREVEX1JFU1RfQVBJX1NFQ1VSSVRZX1BPTElDWSlcbiAgICAgICAgICAgICAgICA6IGFwaWd3LlNlY3VyaXR5UG9saWN5LlRMU18xXzIpO1xuICAgICAgICBjb25zdCBlbmRwb2ludEFjY2Vzc01vZGUgPSBkb21haW5PcHRzLmVuZHBvaW50QWNjZXNzTW9kZVxuICAgICAgICAgICAgPz8gKGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3koc2VjdXJpdHlQb2xpY3kpID8gYXBpZ3cuRW5kcG9pbnRBY2Nlc3NNb2RlLlNUUklDVCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGNvbnN0IGRtbiA9IG5ldyBhcGlndy5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZSxcbiAgICAgICAgICAgIHNlY3VyaXR5UG9saWN5LFxuICAgICAgICAgICAgLi4uKGVuZHBvaW50QWNjZXNzTW9kZSAhPT0gdW5kZWZpbmVkID8geyBlbmRwb2ludEFjY2Vzc01vZGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRtbjtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGJhc2UgcGF0aCBtYXBwaW5nXG4gICAgICAgIGNvbnN0IG1hcHBpbmcgPSBuZXcgYXBpZ3cuQmFzZVBhdGhNYXBwaW5nKHRoaXMsIFwiQmFzZVBhdGhNYXBwaW5nXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgICAgICAgIHJlc3RBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgICAgYmFzZVBhdGg6IGRvbWFpbk9wdHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nIH0pLmJhc2VQYXRoTWFwcGluZyA9IG1hcHBpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZCB9KS5hUmVjb3JkID0gcmVjb3JkO1xuXG4gICAgICAgICAgICBpZiAoZG9tYWluT3B0cy5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYWFhYVJlY29yZCA9IG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICh0aGlzIGFzIHsgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZCB9KS5hYWFhUmVjb3JkID0gYWFhYVJlY29yZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIG1ldGhvZCByZXNwb25zZXMgZm9yIENPUlMtZW5hYmxlZCBlbmRwb2ludHMuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZE1ldGhvZFJlc3BvbnNlcygpOiBhcGlndy5NZXRob2RSZXNwb25zZVtdIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIENPUlMgcHJlZmxpZ2h0IChPUFRJT05TKSBtZXRob2QgdG8gYSByZXNvdXJjZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2U6IGFwaWd3LklSZXNvdXJjZSk6IHZvaWQge1xuICAgICAgICBjb25zdCBvcHRzID0gdGhpcy5jb3JzT3B0aW9ucyA/PyB7fTtcbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW5zID0gb3B0cy5hbGxvd09yaWdpbnMgPz8gW1wiKlwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzID0gb3B0cy5hbGxvd01ldGhvZHMgPz8gW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIk9QVElPTlNcIiwgXCJQQVRDSFwiLCBcIkhFQURcIl07XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVycyA9IG9wdHMuYWxsb3dIZWFkZXJzID8/IFtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICBcIkF1dGhvcml6YXRpb25cIixcbiAgICAgICAgICAgIFwiWC1BbXotRGF0ZVwiLFxuICAgICAgICAgICAgXCJYLUFwaS1LZXlcIixcbiAgICAgICAgICAgIFwiWC1BbXotU2VjdXJpdHktVG9rZW5cIixcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYWxsb3dDcmVkZW50aWFscyA9IG9wdHMuYWxsb3dDcmVkZW50aWFscyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgbWF4QWdlID0gb3B0cy5tYXhBZ2UgPz8gRHVyYXRpb24uc2Vjb25kcyg2MDApO1xuXG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2luID0gYWxsb3dPcmlnaW5zLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHNTdHIgPSBhbGxvd01ldGhvZHMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVyc1N0ciA9IGFsbG93SGVhZGVycy5qb2luKFwiLFwiKTtcblxuICAgICAgICByZXNvdXJjZS5hZGRNZXRob2QoXG4gICAgICAgICAgICBcIk9QVElPTlNcIixcbiAgICAgICAgICAgIG5ldyBhcGlndy5Nb2NrSW50ZWdyYXRpb24oe1xuICAgICAgICAgICAgICAgIGludGVncmF0aW9uUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiBgJyR7YWxsb3dIZWFkZXJzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IGAnJHthbGxvd01ldGhvZHNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBgJyR7YWxsb3dPcmlnaW59J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IGAnJHthbGxvd0NyZWRlbnRpYWxzfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IGAnJHttYXhBZ2UudG9TZWNvbmRzKCl9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6ICd7XCJzdGF0dXNDb2RlXCI6IDIwMH0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gICAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgICB9XG4gICAgcmV0dXJuIGZxZG47XG59XG4iXX0=