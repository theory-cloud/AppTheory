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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSx5REFBcUU7QUFDckUsK0RBS21DO0FBQ25DLGlFQUFrRjtBQUNsRixxRUFBZ0Y7QUFDaEYseURBQTBEO0FBcVYxRDs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ2pEOztPQUVHO0lBQ2EsR0FBRyxDQUFnQjtJQUVuQzs7T0FFRztJQUNhLEtBQUssQ0FBYztJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBb0I7SUFFOUM7O09BRUc7SUFDYSxlQUFlLENBQXlCO0lBRXhEOztPQUVHO0lBQ2EsTUFBTSxDQUFtQjtJQUV6Qzs7T0FFRztJQUNhLGNBQWMsQ0FBOEI7SUFFNUQ7O09BRUc7SUFDYSxPQUFPLENBQW1CO0lBRTFDOztPQUVHO0lBQ2EsVUFBVSxDQUFzQjtJQUVoRDs7T0FFRztJQUNhLGNBQWMsQ0FBa0I7SUFFL0IsV0FBVyxDQUFxQztJQUNoRCxXQUFXLENBQVU7SUFDckIsZUFBZSxDQUFVO0lBQ3pCLHVCQUF1QixDQUFVO0lBQ2pDLFVBQVUsQ0FBcUI7SUFDL0IsaUJBQWlCLENBQTJCO0lBQzVDLGFBQWEsQ0FBMEI7SUFDdkMsV0FBVyxDQUFVO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLHdCQUF3QjtRQUN4QixJQUFJLEtBQUssQ0FBQyxJQUFJ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QUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgU2l6ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7XG4gICAgUkVDT01NRU5ERURfRURHRV9SRVNUX0FQSV9TRUNVUklUWV9QT0xJQ1ksXG4gICAgUkVDT01NRU5ERURfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZLFxuICAgIGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3ksXG4gICAgc2VjdXJlRGVmYXVsdHMsXG59IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyByZXN0QXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB7IG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS1zdHJlYW1pbmdcIjtcbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbi8qKlxuICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgICAqIEBkZWZhdWx0IFsnKiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICAgKiBAZGVmYXVsdCBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUycsICdQQVRDSCcsICdIRUFEJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICAgKiBAZGVmYXVsdCBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJywgJ1gtQW16LURhdGUnLCAnWC1BcGktS2V5JywgJ1gtQW16LVNlY3VyaXR5LVRva2VuJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYWxsb3cgY3JlZGVudGlhbHMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE1heCBhZ2UgZm9yIHByZWZsaWdodCBjYWNoZSBpbiBzZWNvbmRzLlxuICAgICAqIEBkZWZhdWx0IDYwMFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIFN0YWdlLWxldmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogU3RhZ2UgbmFtZS5cbiAgICAgKiBAZGVmYXVsdCAncHJvZCdcbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgICAqIElmIHRydWUsIGEgbG9nIGdyb3VwIHdpbGwgYmUgY3JlYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgICAqIFByb3ZpZGUgYSBMb2dHcm91cCBmb3IgY3VzdG9tIGxvZ2dpbmcgY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUgKGJvb2xlYW4pLlxuICAgICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgICAvKipcbiAgICAgKiBBY2Nlc3MgbG9nIGZvcm1hdC5cbiAgICAgKiBAZGVmYXVsdCBBY2Nlc3NMb2dGb3JtYXQuY2xmKCkgKENvbW1vbiBMb2cgRm9ybWF0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXRhaWxlZCBDbG91ZFdhdGNoIG1ldHJpY3MgYXQgbWV0aG9kL3Jlc291cmNlIGxldmVsLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGV0YWlsZWRNZXRyaWNzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChlLmcuLCBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgKG11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBlZGdlIGVuZHBvaW50cywgc2FtZSByZWdpb24gZm9yIHJlZ2lvbmFsKS5cbiAgICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIElmIHByb3ZpZGVkLCBhbiBBIHJlY29yZCAoYWxpYXMpIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGBob3N0ZWRab25lYCBpcyBwcm92aWRlZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIGZvciB0aGUgQVBJIHVuZGVyIHRoaXMgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobWFwcyB0byB0aGUgcm9vdClcbiAgICAgKi9cbiAgICByZWFkb25seSBiYXNlUGF0aD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGUgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgUkVHSU9OQUxcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGU/OiBhcGlndy5FbmRwb2ludFR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBTZWN1cml0eSBwb2xpY3kgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBXaXRoIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YlxuICAgICAqIEFQSUdhdGV3YXkuMTEgYWNjZXB0cyBmb3IgdGhlIGVuZHBvaW50IHR5cGUgKHJlZ2lvbmFsOlxuICAgICAqIGBUTFMxM18xXzJfUEZTX1BRXzIwMjVfMDlgLCBlZGdlOiBgVExTMTJfUEZTXzIwMjVfRURHRWApLiBXaXRob3V0IGFcbiAgICAgKiBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyBgVExTXzFfMmAuXG4gICAgICpcbiAgICAgKiBUaGUgMjAyNSBwb2xpY2llcyBhcmUgYWxzbyBhIGNpcGhlci1wb2xpY3kgY2hhbmdlIGZvciBjbGllbnRzLCB0aGUgc2FtZVxuICAgICAqIGNhdmVhdCBhcyB0aGUgQ2xvdWRGcm9udC4xNSBgVExTdjEuMl8yMDI1YCBwb2xpY3k6IGEgY2xpZW50IHRoYXQgb25seVxuICAgICAqIG5lZ290aWF0ZXMgYW4gb2xkZXIgVExTIDEuMiBjaXBoZXIgc3VpdGUgaXMgZXhjbHVkZWQuIEFuIGVuaGFuY2VkIHBvbGljeVxuICAgICAqIHJlcXVpcmVzIGFuIGVuZHBvaW50IGFjY2VzcyBtb2RlIGFsb25nc2lkZSBpdDogQXBwVGhlb3J5IGRlcml2ZXMgYFNUUklDVGBcbiAgICAgKiAodGhlIHJlY29tbWVuZGVkIG1vZGUpLCBhbmQgYEJBU0lDYCByZW1haW5zIGF2YWlsYWJsZSB0aHJvdWdoXG4gICAgICogYGRvbWFpbi5lbmRwb2ludEFjY2Vzc01vZGVgLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgVExTXzFfMiwgb3IgdGhlIEFQSUdhdGV3YXkuMTEgcG9saWN5IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3cuU2VjdXJpdHlQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCBhY2Nlc3MgbW9kZSBmb3IgYW4gZW5oYW5jZWQgKGBTZWN1cml0eVBvbGljeV8qYCkgc2VjdXJpdHkgcG9saWN5LlxuICAgICAqXG4gICAgICogQVBJIEdhdGV3YXkgcmVxdWlyZXMgdGhpcyBmb3IgYW4gZW5oYW5jZWQgcG9saWN5IGFuZCByZWplY3RzIGl0IGZvciBhXG4gICAgICogbGVnYWN5IG9uZS4gV2hlbiB1bnNldCwgYW4gZW5oYW5jZWQgZWZmZWN0aXZlIHBvbGljeSB0YWtlcyBgU1RSSUNUYCBhbmQgYVxuICAgICAqIGxlZ2FjeSBwb2xpY3kgdGFrZXMgbm8gbW9kZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IFNUUklDVCBmb3IgYW4gZW5oYW5jZWQgZWZmZWN0aXZlIHBvbGljeSwgb3RoZXJ3aXNlIHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50QWNjZXNzTW9kZT86IGFwaWd3LkVuZHBvaW50QWNjZXNzTW9kZTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgICAqIGxvZyBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzXG4gICAgICogSlNPTiBmaWVsZCBzZXQuIFBhc3MgYHN0YWdlLmFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgICAqXG4gICAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRGVzY3JpcHRpb24gb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBzZW5zaWJsZSBkZWZhdWx0cyxcbiAgICAgKiBvciBwcm92aWRlIGN1c3RvbSBvcHRpb25zLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gQ09SUylcbiAgICAgKi9cbiAgICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGN1c3RvbSBkb21haW4pXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuIFNldCB0byB0cnVlXG4gICAgICogZm9yIGFuIEFwcFRoZW9yeS1tYW5hZ2VkIFdlYkFDTCwgb3IgcHJvdmlkZSBvcHRpb25zIHRvIHJldXNlIGFuIGV4aXN0aW5nXG4gICAgICogcmVnaW9uYWwgV2ViQUNMLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlcyBmb3IgdGhlIFJFU1QgQVBJLlxuICAgICAqIEBkZWZhdWx0IFtSRUdJT05BTF1cbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGVzPzogYXBpZ3cuRW5kcG9pbnRUeXBlW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRoZSBSRVNUIEFQSSB1c2VzIGJpbmFyeSBtZWRpYSB0eXBlcy5cbiAgICAgKiBTcGVjaWZ5IG1lZGlhIHR5cGVzIHRoYXQgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgYmluYXJ5LlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJpbmFyeU1lZGlhVHlwZXM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gY29tcHJlc3Npb24gc2l6ZSBpbiBieXRlcy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGNvbXByZXNzaW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Db21wcmVzc2lvblNpemU/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGVwbG95IG9uIGNvbnN0cnVjdCBjcmVhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVwbG95PzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFJldGFpbiBkZXBsb3ltZW50IGhpc3Rvcnkgd2hlbiBkZXBsb3ltZW50cyBjaGFuZ2UuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSByZXRhaW5EZXBsb3ltZW50cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBBUEkga2V5IHNvdXJjZSB0eXBlLlxuICAgICAqIEBkZWZhdWx0IEhFQURFUlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUtleVNvdXJjZVR5cGU/OiBhcGlndy5BcGlLZXlTb3VyY2VUeXBlO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBBUEkgR2F0ZXdheSBjb25zb2xlIHRlc3QgaW52b2NhdGlvbnMgc2hvdWxkIGJlIGdyYW50ZWQgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3Qgc3VwcHJlc3NlcyB0aGUgZXh0cmEgYHRlc3QtaW52b2tlLXN0YWdlYCBMYW1iZGEgcGVybWlzc2lvbnNcbiAgICAgKiB0aGF0IENESyBhZGRzIGZvciBlYWNoIFJFU1QgQVBJIG1ldGhvZC4gVGhpcyByZWR1Y2VzIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZSB3aGlsZVxuICAgICAqIHByZXNlcnZpbmcgZGVwbG95ZWQtc3RhZ2UgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIFJFU1QgQVBJIG1ldGhvZHMuXG4gICAgICpcbiAgICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgbWV0aG9kL3BhdGggcGFpci4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBmcm9udC1jb250cm9sbGVyXG4gICAgICogQVBJcyB0aGF0IHJvdXRlIG1hbnkgUkVTVCBwYXRocyB0byB0aGUgc2FtZSBMYW1iZGEuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgQVBJIEdhdGV3YXkgYXV0aG9yaXplciBhcHBsaWVkIHRvIGV2ZXJ5IExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2QuXG4gICAgICpcbiAgICAgKiBXaGVuIG9taXR0ZWQsIG1ldGhvZHMga2VlcCBBUEkgR2F0ZXdheSdzIG9wZW4gZGVmYXVsdCAoYEF1dGhvcml6YXRpb25UeXBlLk5PTkVgKS5cbiAgICAgKiBDT1JTIHByZWZsaWdodCBgT1BUSU9OU2AgbWV0aG9kcyBzdGF5IHVuYXV0aGVudGljYXRlZCByZWdhcmRsZXNzIG9mIHRoaXMgc2V0dGluZy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gYXV0aG9yaXplcilcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemF0aW9uIHR5cGUgZm9yIHRoZSBMYW1iZGEgaW50ZWdyYXRpb24gbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFVzdWFsbHkgb21pdHRlZDogd2hlbiBgYXV0aG9yaXplcmAgaXMgc2V0LCBBUEkgR2F0ZXdheSBkZXJpdmVzIHRoZSB0eXBlIGZyb20gdGhlXG4gICAgICogYXV0aG9yaXplciBpdHNlbGYuIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gb3ZlcnJpZGUgdGhhdCBpbmZlcmVuY2UuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlcml2ZWQgZnJvbSBgYXV0aG9yaXplcmAsIG9yIGBOT05FYCB3aGVuIG5vIGF1dGhvcml6ZXIgaXMgc2V0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6YXRpb25UeXBlPzogYXBpZ3cuQXV0aG9yaXphdGlvblR5cGU7XG59XG5cbi8qKlxuICogQSBSRVNUIEFQSSB2MSByb3V0ZXIgdGhhdCBzdXBwb3J0cyBtdWx0aS1MYW1iZGEgcm91dGluZyB3aXRoIGZ1bGwgc3RyZWFtaW5nIHBhcml0eS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBhZGRyZXNzZXMgdGhlIGdhcHMgaW4gQXBwVGhlb3J5UmVzdEFwaSBieSBhbGxvd2luZzpcbiAqIC0gTXVsdGlwbGUgTGFtYmRhIGZ1bmN0aW9ucyBhdHRhY2hlZCB0byBkaWZmZXJlbnQgcm91dGVzXG4gKiAtIENvbXBsZXRlIHJlc3BvbnNlIHN0cmVhbWluZyBpbnRlZ3JhdGlvbiAocmVzcG9uc2VUcmFuc2Zlck1vZGUsIFVSSSBzdWZmaXgsIHRpbWVvdXQpXG4gKiAtIFN0YWdlIGNvbnRyb2xzIChhY2Nlc3MgbG9nZ2luZywgbWV0cmljcywgdGhyb3R0bGluZywgQ09SUylcbiAqIC0gQ3VzdG9tIGRvbWFpbiB3aXJpbmcgd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZFxuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCByb3V0ZXIgPSBuZXcgQXBwVGhlb3J5UmVzdEFwaVJvdXRlcih0aGlzLCAnUm91dGVyJywge1xuICogICBhcGlOYW1lOiAnbXktYXBpJyxcbiAqICAgc3RhZ2U6IHsgc3RhZ2VOYW1lOiAncHJvZCcsIGFjY2Vzc0xvZ2dpbmc6IHRydWUsIGRldGFpbGVkTWV0cmljczogdHJ1ZSB9LFxuICogICBjb3JzOiB0cnVlLFxuICogfSk7XG4gKlxuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvc3NlJywgWydHRVQnXSwgc3NlRm4sIHsgc3RyZWFtaW5nOiB0cnVlIH0pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvYXBpL2dyYXBocWwnLCBbJ1BPU1QnXSwgZ3JhcGhxbEZuKTtcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL3twcm94eSt9JywgWydBTlknXSwgYXBpRm4pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIHVuZGVybHlpbmcgQVBJIEdhdGV3YXkgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3cuUmVzdEFwaTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkZXBsb3ltZW50IHN0YWdlLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3cuU3RhZ2U7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWU7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nO1xuXG4gICAgLyoqXG4gICAgICogQXBwVGhlb3J5LW1hbmFnZWQgcmVnaW9uYWwgV0FGIFdlYkFDTCB3aGVuIGVuYWJsZWQgd2l0aG91dCB3ZWJBY2xBcm4uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdlYkFjbD86IHdhZnYyLkNmbldlYkFDTDtcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhc3NvY2lhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEFBQUEgcmVjb3JkIChpZiBkb21haW4sIGhvc3RlZFpvbmUsIGFuZCBjcmVhdGVBQUFBUmVjb3JkIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc09wdGlvbnM/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzRW5hYmxlZDogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZTogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXplcj86IGFwaWd3LklBdXRob3JpemVyO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbiAgICBwcml2YXRlIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuICAgIHByaXZhdGUgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzID0ge30pIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICAvLyBOb3JtYWxpemUgQ09SUyBjb25maWdcbiAgICAgICAgaWYgKHByb3BzLmNvcnMgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmNvcnMgJiYgdHlwZW9mIHByb3BzLmNvcnMgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHByb3BzLmNvcnM7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hbGxvd1Rlc3RJbnZva2UgPSBwcm9wcy5hbGxvd1Rlc3RJbnZva2UgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID8/IHRydWU7XG4gICAgICAgIHRoaXMuYXV0aG9yaXplciA9IHByb3BzLmF1dGhvcml6ZXI7XG4gICAgICAgIHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPSBwcm9wcy5hdXRob3JpemF0aW9uVHlwZTtcbiAgICAgICAgdGhpcy5uYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgICAgdGhpcy5sb2dpY2FsTmFtZSA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChwcm9wcy5uYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgICAgcmVmdXNlRXhwbGljaXROYW1lKHByb3BzLm5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLCBcImFwaU5hbWVcIiwgXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgICAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lXG4gICAgICAgICAgICA/IHRoaXMubmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAgICAgY29uc3QgY29uZmlndXJlZFN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgICAgICBjb25zdCBzdGFnZU9wdHMgPSB0aGlzLmVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhjb25maWd1cmVkU3RhZ2VPcHRzKTtcbiAgICAgICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcInByb2RcIjtcbiAgICAgICAgY29uc3QgY29tcHJlc3Npb25Qcm9wcyA9XG4gICAgICAgICAgICBwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgOiB7IG1pbkNvbXByZXNzaW9uU2l6ZTogU2l6ZS5ieXRlcyhwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplKSB9O1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgUkVTVCBBUElcbiAgICAgICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3cuUmVzdEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgICAgICByZXN0QXBpTmFtZTogZGVyaXZlZEFwaU5hbWUgJiYgIWRlcml2ZWRBcGlOYW1lLmdlbmVyYXRlZCA/IGRlcml2ZWRBcGlOYW1lLm5hbWUgOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgZGVwbG95OiBwcm9wcy5kZXBsb3kgPz8gdHJ1ZSxcbiAgICAgICAgICAgIHJldGFpbkRlcGxveW1lbnRzOiBwcm9wcy5yZXRhaW5EZXBsb3ltZW50cyxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZXM6IHByb3BzLmVuZHBvaW50VHlwZXMgPz8gW2FwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTF0sXG4gICAgICAgICAgICBiaW5hcnlNZWRpYVR5cGVzOiBwcm9wcy5iaW5hcnlNZWRpYVR5cGVzLFxuICAgICAgICAgICAgLi4uY29tcHJlc3Npb25Qcm9wcyxcbiAgICAgICAgICAgIGFwaUtleVNvdXJjZVR5cGU6IHByb3BzLmFwaUtleVNvdXJjZVR5cGUsXG4gICAgICAgICAgICBkZXBsb3lPcHRpb25zOiB0aGlzLmJ1aWxkRGVwbG95T3B0aW9ucyhzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuc3RhZ2UgPSB0aGlzLmFwaS5kZXBsb3ltZW50U3RhZ2U7XG5cbiAgICAgICAgLy8gU2V0IHVwIGN1c3RvbSBkb21haW4gaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHByb3BzLndhZikge1xuICAgICAgICAgICAgY29uc3Qgd2FmID0gY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmKFxuICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgdGhpcy5hcGksXG4gICAgICAgICAgICAgICAgdGhpcy5zdGFnZSxcbiAgICAgICAgICAgICAgICBwcm9wcy53YWYsXG4gICAgICAgICAgICAgICAgcHJvcHMuYXBpTmFtZSA/PyBcIkFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdlYkFjbD86IHdhZnYyLkNmbldlYkFDTCB9KS53ZWJBY2wgPSB3YWYud2ViQWNsO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyB3YWZBc3NvY2lhdGlvbj86IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uIH0pLndhZkFzc29jaWF0aW9uID0gd2FmLndhZkFzc29jaWF0aW9uO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgTGFtYmRhIGludGVncmF0aW9uIGZvciB0aGUgc3BlY2lmaWVkIHBhdGggYW5kIEhUVFAgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXRoIC0gVGhlIHJlc291cmNlIHBhdGggKGUuZy4sIFwiL3NzZVwiLCBcIi9hcGkvZ3JhcGhxbFwiLCBcIi97cHJveHkrfVwiKVxuICAgICAqIEBwYXJhbSBtZXRob2RzIC0gQXJyYXkgb2YgSFRUUCBtZXRob2RzIChlLmcuLCBbXCJHRVRcIiwgXCJQT1NUXCJdIG9yIFtcIkFOWVwiXSlcbiAgICAgKiBAcGFyYW0gaGFuZGxlciAtIFRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gaW50ZWdyYXRlXG4gICAgICogQHBhcmFtIG9wdGlvbnMgLSBJbnRlZ3JhdGlvbiBvcHRpb25zIGluY2x1ZGluZyBzdHJlYW1pbmcgY29uZmlndXJhdGlvblxuICAgICAqL1xuICAgIGFkZExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBwYXRoOiBzdHJpbmcsXG4gICAgICAgIG1ldGhvZHM6IHN0cmluZ1tdLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHJlc291cmNlID0gdGhpcy5yZXNvdXJjZUZvclBhdGgocGF0aCk7XG5cbiAgICAgICAgZm9yIChjb25zdCBtIG9mIG1ldGhvZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhtID8/IFwiXCIpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgaWYgKCFtZXRob2QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAvLyBDcmVhdGUgdGhlIGludGVncmF0aW9uXG4gICAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IHRoaXMuY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwgb3B0aW9ucyk7XG5cbiAgICAgICAgICAgIC8vIEFkZCB0aGUgbWV0aG9kXG4gICAgICAgICAgICBjb25zdCBhdXRob3JpemF0aW9uT3B0aW9ucyA9XG4gICAgICAgICAgICAgICAgdGhpcy5hdXRob3JpemVyID09PSB1bmRlZmluZWQgJiYgdGhpcy5hdXRob3JpemF0aW9uVHlwZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmF1dGhvcml6ZXIgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIgfSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmF1dGhvcml6YXRpb25UeXBlID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogeyBhdXRob3JpemF0aW9uVHlwZTogdGhpcy5hdXRob3JpemF0aW9uVHlwZSB9KSxcbiAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc3QgY3JlYXRlZE1ldGhvZCA9IHJlc291cmNlLmFkZE1ldGhvZChtZXRob2QsIGludGVncmF0aW9uLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiB0aGlzLmNvcnNFbmFibGVkID8gdGhpcy5idWlsZE1ldGhvZFJlc3BvbnNlcygpIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIC4uLmF1dGhvcml6YXRpb25PcHRpb25zLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIEZvciBzdHJlYW1pbmcgcm91dGVzLCBhcHBseSBMMSBvdmVycmlkZXMgdG8gZW5zdXJlIGZ1bGwgY29tcGF0aWJpbGl0eVxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc3RyZWFtaW5nKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBseVN0cmVhbWluZ092ZXJyaWRlcyhjcmVhdGVkTWV0aG9kLCBoYW5kbGVyLCBvcHRpb25zKTtcbiAgICAgICAgICAgICAgICBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyh0aGlzLnN0YWdlLCBtZXRob2QsIHBhdGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIE9QVElPTlMgbWV0aG9kIGZvciBDT1JTIGlmIGVuYWJsZWQgYW5kIG5vdCBhbHJlYWR5IHByZXNlbnRcbiAgICAgICAgaWYgKHRoaXMuY29yc0VuYWJsZWQgJiYgIXJlc291cmNlLm5vZGUudHJ5RmluZENoaWxkKFwiT1BUSU9OU1wiKSkge1xuICAgICAgICAgICAgdGhpcy5hZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBvciBjcmVhdGUgYSByZXNvdXJjZSBmb3IgdGhlIGdpdmVuIHBhdGguXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNvdXJjZUZvclBhdGgoaW5wdXRQYXRoOiBzdHJpbmcpOiBhcGlndy5JUmVzb3VyY2Uge1xuICAgICAgICBsZXQgY3VycmVudDogYXBpZ3cuSVJlc291cmNlID0gdGhpcy5hcGkucm9vdDtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKGlucHV0UGF0aCA/PyBcIlwiKS50cmltKCksIFwiL1wiKTtcbiAgICAgICAgaWYgKCF0cmltbWVkKSByZXR1cm4gY3VycmVudDtcblxuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSBTdHJpbmcoc2VnbWVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIXBhcnQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2UocGFydCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShwYXJ0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBMYW1iZGEgaW50ZWdyYXRpb24gd2l0aCB0aGUgYXBwcm9wcmlhdGUgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICBwcml2YXRlIGNyZWF0ZUxhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IGFwaWd3LkxhbWJkYUludGVncmF0aW9uIHtcbiAgICAgICAgY29uc3Qgc3RyZWFtaW5nID0gb3B0aW9ucy5zdHJlYW1pbmcgPz8gZmFsc2U7XG5cbiAgICAgICAgLy8gRm9yIHN0cmVhbWluZywgd2UgdXNlIFNUUkVBTSByZXNwb25zZVRyYW5zZmVyTW9kZVxuICAgICAgICAvLyBOb3RlOiBUaGUgVVJJIHN1ZmZpeCBhbmQgdGltZW91dCB3aWxsIGJlIGZpeGVkIHZpYSBMMSBvdmVycmlkZXNcbiAgICAgICAgcmV0dXJuIG5ldyBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCB7XG4gICAgICAgICAgICBwcm94eTogdHJ1ZSxcbiAgICAgICAgICAgIGFsbG93VGVzdEludm9rZTogdGhpcy5hbGxvd1Rlc3RJbnZva2UsXG4gICAgICAgICAgICBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCxcbiAgICAgICAgICAgIHJlc3BvbnNlVHJhbnNmZXJNb2RlOiBzdHJlYW1pbmcgPyBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5TVFJFQU0gOiBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5CVUZGRVJFRCxcbiAgICAgICAgICAgIHRpbWVvdXQ6IG9wdGlvbnMudGltZW91dCA/PyAoc3RyZWFtaW5nID8gRHVyYXRpb24ubWludXRlcygxNSkgOiB1bmRlZmluZWQpLFxuICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogb3B0aW9ucy5wYXNzdGhyb3VnaEJlaGF2aW9yLFxuICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczogb3B0aW9ucy5yZXF1ZXN0VGVtcGxhdGVzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBcHBseSBMMSBDRk4gb3ZlcnJpZGVzIGZvciBzdHJlYW1pbmcgcm91dGVzIHRvIGVuc3VyZSBmdWxsIExpZnQgcGFyaXR5LlxuICAgICAqXG4gICAgICogU3RyZWFtaW5nIHJvdXRlcyByZXF1aXJlOlxuICAgICAqIDEuIEludGVncmF0aW9uLlJlc3BvbnNlVHJhbnNmZXJNb2RlID0gU1RSRUFNIChhbHJlYWR5IHNldCB2aWEgTDIpXG4gICAgICogMi4gSW50ZWdyYXRpb24uVXJpIGVuZHMgd2l0aCAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogMy4gSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzID0gOTAwMDAwICgxNSBtaW51dGVzKVxuICAgICAqL1xuICAgIHByaXZhdGUgYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoXG4gICAgICAgIG1ldGhvZDogYXBpZ3cuTWV0aG9kLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCBjZm5NZXRob2QgPSBtZXRob2Qubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3cuQ2ZuTWV0aG9kO1xuICAgICAgICBpZiAoIWNmbk1ldGhvZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBzdHJlYW1pbmcgVVJJXG4gICAgICAgIC8vIFN0YW5kYXJkIGZvcm1hdDogYXJuOntwYXJ0aXRpb259OmFwaWdhdGV3YXk6e3JlZ2lvbn06bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMve2Z1bmN0aW9uQXJufS9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgICAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0Py50b01pbGxpc2Vjb25kcygpID8/IDkwMDAwMDtcblxuICAgICAgICAvLyBPdmVycmlkZSB0aGUgaW50ZWdyYXRpb24gcHJvcGVydGllc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpc1wiLCB0aW1lb3V0TXMpO1xuXG4gICAgICAgIC8vIFRoZSBVUkkgbXVzdCB1c2UgdGhlIHN0cmVhbWluZy1zcGVjaWZpYyBwYXRoXG4gICAgICAgIC8vIFdlIGNvbnN0cnVjdCBpdCB1c2luZyBGbjo6Sm9pbiB0byBwcmVzZXJ2ZSBDbG91ZEZvcm1hdGlvbiBpbnRyaW5zaWNzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVXJpXCIsIHtcbiAgICAgICAgICAgIFwiRm46OkpvaW5cIjogW1xuICAgICAgICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICBcImFybjpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpQYXJ0aXRpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjphcGlnYXRld2F5OlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlJlZ2lvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL1wiLFxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICAgICAgICBcIi9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgZGVwbG95IG9wdGlvbnMgZm9yIHRoZSBzdGFnZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhcbiAgICAgICAgc3RhZ2U6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgKTogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgICAgIGlmICh0aGlzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBzdGFnZS5hY2Nlc3NMb2dnaW5nID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnN0YWdlLCBhY2Nlc3NMb2dnaW5nOiB0cnVlIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHN0YWdlO1xuICAgIH1cblxuICAgIHByaXZhdGUgYnVpbGREZXBsb3lPcHRpb25zKFxuICAgICAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICAgICk6IGFwaWd3LlN0YWdlT3B0aW9ucyB7XG4gICAgICAgIC8vIEhhbmRsZSBhY2Nlc3MgbG9nZ2luZ1xuICAgICAgICBsZXQgYWNjZXNzTG9nRGVzdGluYXRpb246IGFwaWd3LklBY2Nlc3NMb2dEZXN0aW5hdGlvbiB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Zvcm1hdCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQ7XG4gICAgICAgIGNvbnN0IHN0YW5kYXJkID0gdGhpcy5uYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgICAgIGlmIChzdGFuZGFyZCAmJiAhdGhpcy5sb2dpY2FsTmFtZSAmJiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICAgICAgICAvLyBUaGUgY29uc3RydWN0LWNyZWF0ZWQgYWNjZXNzLWxvZyBncm91cCBpcyBhIGxvZ2dpbmcgcmVzb3VyY2U6IHVuZGVyXG4gICAgICAgICAgICAvLyB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpdCB0YWtlcyB0aGUgY29udHJhY3QgbG9nLXNvdXJjZSBuYW1lLCBhbmRcbiAgICAgICAgICAgIC8vIHVuZGVyIHRoZSBsZWdhY3kgcHJvZmlsZSBpdCBrZWVwcyB0b2RheSdzIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZFxuICAgICAgICAgICAgLy8gbmFtZSBhbmQgY29uc3VtZXMgbm8gbmFtaW5nIGVudHJ5IChyMywgQURWLTEzMTItMSkuXG4gICAgICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLFxuICAgICAgICAgICAgICAgIHN0YW5kYXJkICYmIHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lXG4gICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogdGhpcy5uYW1pbmdDb250ZXh0LmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7dGhpcy5sb2dpY2FsTmFtZX1gKSxcbiAgICAgICAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IodGhpcy5uYW1pbmdDb250ZXh0LnJldGVudGlvbkRheXMpLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IChzdGFuZGFyZCA/IHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICAvLyBTZWN1cml0eSBIdWIgQVBJR2F0ZXdheS4xMSBhY2NlcHRzIG9ubHkgdGhlIDIwMjUgZW5oYW5jZWQgcG9saWNpZXMsIGFuZFxuICAgICAgICAvLyBBUEkgR2F0ZXdheSByZWplY3RzIGEgcmVnaW9uYWwgcG9saWN5IG9uIGFuIGVkZ2UgZG9tYWluIChhbmQgdmljZVxuICAgICAgICAvLyB2ZXJzYSkuIFdpdGhvdXQgYSBuYW1pbmcgY29udGV4dCB0aGUgcHJlLWNvbnRyYWN0IFRMU18xXzIgZGVmYXVsdCBzdGF5cy5cbiAgICAgICAgY29uc3Qgc2VjdXJpdHlQb2xpY3kgPSBkb21haW5PcHRzLnNlY3VyaXR5UG9saWN5XG4gICAgICAgICAgICA/PyAoc2VjdXJlRGVmYXVsdHModGhpcy5uYW1pbmdDb250ZXh0KVxuICAgICAgICAgICAgICAgID8gKGVuZHBvaW50VHlwZSA9PT0gYXBpZ3cuRW5kcG9pbnRUeXBlLkVER0VcbiAgICAgICAgICAgICAgICAgICAgPyBSRUNPTU1FTkRFRF9FREdFX1JFU1RfQVBJX1NFQ1VSSVRZX1BPTElDWVxuICAgICAgICAgICAgICAgICAgICA6IFJFQ09NTUVOREVEX1JFU1RfQVBJX1NFQ1VSSVRZX1BPTElDWSlcbiAgICAgICAgICAgICAgICA6IGFwaWd3LlNlY3VyaXR5UG9saWN5LlRMU18xXzIpO1xuICAgICAgICBjb25zdCBlbmRwb2ludEFjY2Vzc01vZGUgPSBkb21haW5PcHRzLmVuZHBvaW50QWNjZXNzTW9kZVxuICAgICAgICAgICAgPz8gKGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3koc2VjdXJpdHlQb2xpY3kpID8gYXBpZ3cuRW5kcG9pbnRBY2Nlc3NNb2RlLlNUUklDVCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGNvbnN0IGRtbiA9IG5ldyBhcGlndy5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZSxcbiAgICAgICAgICAgIHNlY3VyaXR5UG9saWN5LFxuICAgICAgICAgICAgLi4uKGVuZHBvaW50QWNjZXNzTW9kZSAhPT0gdW5kZWZpbmVkID8geyBlbmRwb2ludEFjY2Vzc01vZGUgfSA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRtbjtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGJhc2UgcGF0aCBtYXBwaW5nXG4gICAgICAgIGNvbnN0IG1hcHBpbmcgPSBuZXcgYXBpZ3cuQmFzZVBhdGhNYXBwaW5nKHRoaXMsIFwiQmFzZVBhdGhNYXBwaW5nXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgICAgICAgIHJlc3RBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgICAgYmFzZVBhdGg6IGRvbWFpbk9wdHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nIH0pLmJhc2VQYXRoTWFwcGluZyA9IG1hcHBpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZCB9KS5hUmVjb3JkID0gcmVjb3JkO1xuXG4gICAgICAgICAgICBpZiAoZG9tYWluT3B0cy5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYWFhYVJlY29yZCA9IG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICh0aGlzIGFzIHsgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZCB9KS5hYWFhUmVjb3JkID0gYWFhYVJlY29yZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIG1ldGhvZCByZXNwb25zZXMgZm9yIENPUlMtZW5hYmxlZCBlbmRwb2ludHMuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZE1ldGhvZFJlc3BvbnNlcygpOiBhcGlndy5NZXRob2RSZXNwb25zZVtdIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIENPUlMgcHJlZmxpZ2h0IChPUFRJT05TKSBtZXRob2QgdG8gYSByZXNvdXJjZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2U6IGFwaWd3LklSZXNvdXJjZSk6IHZvaWQge1xuICAgICAgICBjb25zdCBvcHRzID0gdGhpcy5jb3JzT3B0aW9ucyA/PyB7fTtcbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW5zID0gb3B0cy5hbGxvd09yaWdpbnMgPz8gW1wiKlwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzID0gb3B0cy5hbGxvd01ldGhvZHMgPz8gW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIk9QVElPTlNcIiwgXCJQQVRDSFwiLCBcIkhFQURcIl07XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVycyA9IG9wdHMuYWxsb3dIZWFkZXJzID8/IFtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICBcIkF1dGhvcml6YXRpb25cIixcbiAgICAgICAgICAgIFwiWC1BbXotRGF0ZVwiLFxuICAgICAgICAgICAgXCJYLUFwaS1LZXlcIixcbiAgICAgICAgICAgIFwiWC1BbXotU2VjdXJpdHktVG9rZW5cIixcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYWxsb3dDcmVkZW50aWFscyA9IG9wdHMuYWxsb3dDcmVkZW50aWFscyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgbWF4QWdlID0gb3B0cy5tYXhBZ2UgPz8gRHVyYXRpb24uc2Vjb25kcyg2MDApO1xuXG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2luID0gYWxsb3dPcmlnaW5zLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHNTdHIgPSBhbGxvd01ldGhvZHMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVyc1N0ciA9IGFsbG93SGVhZGVycy5qb2luKFwiLFwiKTtcblxuICAgICAgICByZXNvdXJjZS5hZGRNZXRob2QoXG4gICAgICAgICAgICBcIk9QVElPTlNcIixcbiAgICAgICAgICAgIG5ldyBhcGlndy5Nb2NrSW50ZWdyYXRpb24oe1xuICAgICAgICAgICAgICAgIGludGVncmF0aW9uUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiBgJyR7YWxsb3dIZWFkZXJzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IGAnJHthbGxvd01ldGhvZHNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBgJyR7YWxsb3dPcmlnaW59J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IGAnJHthbGxvd0NyZWRlbnRpYWxzfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IGAnJHttYXhBZ2UudG9TZWNvbmRzKCl9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6ICd7XCJzdGF0dXNDb2RlXCI6IDIwMH0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gICAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgICB9XG4gICAgcmV0dXJuIGZxZG47XG59XG4iXX0=