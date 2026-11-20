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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "7.4.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSx5REFBcUU7QUFDckUsK0RBS21DO0FBQ25DLGlFQUFrRjtBQUNsRixxRUFBZ0Y7QUFDaEYseURBQTBEO0FBOFUxRDs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ2pEOztPQUVHO0lBQ2EsR0FBRyxDQUFnQjtJQUVuQzs7T0FFRztJQUNhLEtBQUssQ0FBYztJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBb0I7SUFFOUM7O09BRUc7SUFDYSxlQUFlLENBQXlCO0lBRXhEOztPQUVHO0lBQ2EsTUFBTSxDQUFtQjtJQUV6Qzs7T0FFRztJQUNhLGNBQWMsQ0FBOEI7SUFFNUQ7O09BRUc7SUFDYSxPQUFPLENBQW1CO0lBRTFDOztPQUVHO0lBQ2EsVUFBVSxDQUFzQjtJQUVoRDs7T0FFRztJQUNhLGNBQWMsQ0FBa0I7SUFFL0IsV0FBVyxDQUFxQztJQUNoRCxXQUFXLENBQVU7SUFDckIsZUFBZSxDQUFVO0lBQ3pCLHVCQUF1QixDQUFVO0lBQ2pDLFVBQVUsQ0FBcUI7SUFDL0IsaUJBQWlCLENBQTJCO0lBQzVDLGFBQWEsQ0FBMEI7SUFDdkMsV0FBVyxDQUFVO0lBRXRDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLHdCQUF3QjtRQUN4QixJQUFJLEtBQUssQ0FBQyxJQUFJ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QUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgU2l6ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7XG4gICAgUkVDT01NRU5ERURfRURHRV9SRVNUX0FQSV9TRUNVUklUWV9QT0xJQ1ksXG4gICAgUkVDT01NRU5ERURfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZLFxuICAgIGlzRW5oYW5jZWRSZXN0U2VjdXJpdHlQb2xpY3ksXG4gICAgc2VjdXJlRGVmYXVsdHMsXG59IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyByZXN0QXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB7IG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS1zdHJlYW1pbmdcIjtcbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbi8qKlxuICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgICAqIEBkZWZhdWx0IFsnKiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICAgKiBAZGVmYXVsdCBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUycsICdQQVRDSCcsICdIRUFEJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICAgKiBAZGVmYXVsdCBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJywgJ1gtQW16LURhdGUnLCAnWC1BcGktS2V5JywgJ1gtQW16LVNlY3VyaXR5LVRva2VuJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYWxsb3cgY3JlZGVudGlhbHMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE1heCBhZ2UgZm9yIHByZWZsaWdodCBjYWNoZSBpbiBzZWNvbmRzLlxuICAgICAqIEBkZWZhdWx0IDYwMFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIFN0YWdlLWxldmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogU3RhZ2UgbmFtZS5cbiAgICAgKiBAZGVmYXVsdCAncHJvZCdcbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgICAqIElmIHRydWUsIGEgbG9nIGdyb3VwIHdpbGwgYmUgY3JlYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgICAqIFByb3ZpZGUgYSBMb2dHcm91cCBmb3IgY3VzdG9tIGxvZ2dpbmcgY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUgKGJvb2xlYW4pLlxuICAgICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgICAvKipcbiAgICAgKiBBY2Nlc3MgbG9nIGZvcm1hdC5cbiAgICAgKiBAZGVmYXVsdCBBY2Nlc3NMb2dGb3JtYXQuY2xmKCkgKENvbW1vbiBMb2cgRm9ybWF0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXRhaWxlZCBDbG91ZFdhdGNoIG1ldHJpY3MgYXQgbWV0aG9kL3Jlc291cmNlIGxldmVsLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGV0YWlsZWRNZXRyaWNzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChlLmcuLCBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgKG11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBlZGdlIGVuZHBvaW50cywgc2FtZSByZWdpb24gZm9yIHJlZ2lvbmFsKS5cbiAgICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIElmIHByb3ZpZGVkLCBhbiBBIHJlY29yZCAoYWxpYXMpIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGBob3N0ZWRab25lYCBpcyBwcm92aWRlZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIGZvciB0aGUgQVBJIHVuZGVyIHRoaXMgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobWFwcyB0byB0aGUgcm9vdClcbiAgICAgKi9cbiAgICByZWFkb25seSBiYXNlUGF0aD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGUgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgUkVHSU9OQUxcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGU/OiBhcGlndy5FbmRwb2ludFR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBTZWN1cml0eSBwb2xpY3kgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBXaXRoIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YlxuICAgICAqIEFQSUdhdGV3YXkuMTEgYWNjZXB0cyBmb3IgdGhlIGVuZHBvaW50IHR5cGUgKHJlZ2lvbmFsOlxuICAgICAqIGBUTFMxM18xXzJfUEZTX1BRXzIwMjVfMDlgLCBlZGdlOiBgVExTMTJfUEZTXzIwMjVfRURHRWApLiBXaXRob3V0IGFcbiAgICAgKiBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyBgVExTXzFfMmAuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBUTFNfMV8yLCBvciB0aGUgQVBJR2F0ZXdheS4xMSBwb2xpY3kgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0XG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlndy5TZWN1cml0eVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IGFjY2VzcyBtb2RlIGZvciBhbiBlbmhhbmNlZCAoYFNlY3VyaXR5UG9saWN5XypgKSBzZWN1cml0eSBwb2xpY3kuXG4gICAgICpcbiAgICAgKiBBUEkgR2F0ZXdheSByZXF1aXJlcyB0aGlzIGZvciBhbiBlbmhhbmNlZCBwb2xpY3kgYW5kIHJlamVjdHMgaXQgZm9yIGFcbiAgICAgKiBsZWdhY3kgb25lLiBXaGVuIHVuc2V0LCBhbiBlbmhhbmNlZCBlZmZlY3RpdmUgcG9saWN5IHRha2VzIGBTVFJJQ1RgIGFuZCBhXG4gICAgICogbGVnYWN5IHBvbGljeSB0YWtlcyBubyBtb2RlLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgU1RSSUNUIGZvciBhbiBlbmhhbmNlZCBlZmZlY3RpdmUgcG9saWN5LCBvdGhlcndpc2UgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRBY2Nlc3NNb2RlPzogYXBpZ3cuRW5kcG9pbnRBY2Nlc3NNb2RlO1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGFkZGluZyBhIExhbWJkYSBpbnRlZ3JhdGlvbiB0byBhIHJvdXRlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIEVuYWJsZSByZXNwb25zZSBzdHJlYW1pbmcgZm9yIHRoaXMgcm91dGUuXG4gICAgICogV2hlbiBlbmFibGVkOlxuICAgICAqIC0gUmVzcG9uc2VUcmFuc2Zlck1vZGUgaXMgc2V0IHRvIFNUUkVBTVxuICAgICAqIC0gVGhlIExhbWJkYSBpbnZvY2F0aW9uIFVSSSB1c2VzIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAtIFRpbWVvdXQgaXMgc2V0IHRvIDE1IG1pbnV0ZXMgKDkwMDAwMG1zKVxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RyZWFtaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBpbnRlZ3JhdGlvbiB0aW1lb3V0LlxuICAgICAqIEZvciBzdHJlYW1pbmcgcm91dGVzLCBkZWZhdWx0cyB0byAxNSBtaW51dGVzLlxuICAgICAqIEZvciBub24tc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMjkgc2Vjb25kcy5cbiAgICAgKi9cbiAgICByZWFkb25seSB0aW1lb3V0PzogRHVyYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBSZXF1ZXN0IHRlbXBsYXRlcyBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAodXNlIExhbWJkYSBwcm94eSBpbnRlZ3JhdGlvbilcbiAgICAgKi9cbiAgICByZWFkb25seSByZXF1ZXN0VGVtcGxhdGVzPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAgIC8qKlxuICAgICAqIFBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciB0aGUgaW50ZWdyYXRpb24uXG4gICAgICogQGRlZmF1bHQgV0hFTl9OT19NQVRDSFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhc3N0aHJvdWdoQmVoYXZpb3I/OiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzIHtcbiAgICAvKipcbiAgICAgKiBOYW1lIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAgICpcbiAgICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhXG4gICAgICogbG9nIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3NcbiAgICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAgICpcbiAgICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEZXNjcmlwdGlvbiBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIHNlbnNpYmxlIGRlZmF1bHRzLFxuICAgICAqIG9yIHByb3ZpZGUgY3VzdG9tIG9wdGlvbnMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBDT1JTKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS4gU2V0IHRvIHRydWVcbiAgICAgKiBmb3IgYW4gQXBwVGhlb3J5LW1hbmFnZWQgV2ViQUNMLCBvciBwcm92aWRlIG9wdGlvbnMgdG8gcmV1c2UgYW4gZXhpc3RpbmdcbiAgICAgKiByZWdpb25hbCBXZWJBQ0wuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGVzIGZvciB0aGUgUkVTVCBBUEkuXG4gICAgICogQGRlZmF1bHQgW1JFR0lPTkFMXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZXM/OiBhcGlndy5FbmRwb2ludFR5cGVbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdGhlIFJFU1QgQVBJIHVzZXMgYmluYXJ5IG1lZGlhIHR5cGVzLlxuICAgICAqIFNwZWNpZnkgbWVkaWEgdHlwZXMgdGhhdCBzaG91bGQgYmUgdHJlYXRlZCBhcyBiaW5hcnkuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmluYXJ5TWVkaWFUeXBlcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBjb21wcmVzc2lvbiBzaXplIGluIGJ5dGVzLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY29tcHJlc3Npb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bUNvbXByZXNzaW9uU2l6ZT86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXBsb3kgb24gY29uc3RydWN0IGNyZWF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXBsb3k/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogUmV0YWluIGRlcGxveW1lbnQgaGlzdG9yeSB3aGVuIGRlcGxveW1lbnRzIGNoYW5nZS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJldGFpbkRlcGxveW1lbnRzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEFQSSBrZXkgc291cmNlIHR5cGUuXG4gICAgICogQGRlZmF1bHQgSEVBREVSXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpS2V5U291cmNlVHlwZT86IGFwaWd3LkFwaUtleVNvdXJjZVR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIEFQSSBHYXRld2F5IGNvbnNvbGUgdGVzdCBpbnZvY2F0aW9ucyBzaG91bGQgYmUgZ3JhbnRlZCBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBzdXBwcmVzc2VzIHRoZSBleHRyYSBgdGVzdC1pbnZva2Utc3RhZ2VgIExhbWJkYSBwZXJtaXNzaW9uc1xuICAgICAqIHRoYXQgQ0RLIGFkZHMgZm9yIGVhY2ggUkVTVCBBUEkgbWV0aG9kLiBUaGlzIHJlZHVjZXMgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIHdoaWxlXG4gICAgICogcHJlc2VydmluZyBkZXBsb3llZC1zdGFnZSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgUkVTVCBBUEkgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgICAqIG9uZSBwZXJtaXNzaW9uIHBlciBtZXRob2QvcGF0aCBwYWlyLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIGZyb250LWNvbnRyb2xsZXJcbiAgICAgKiBBUElzIHRoYXQgcm91dGUgbWFueSBSRVNUIHBhdGhzIHRvIHRoZSBzYW1lIExhbWJkYS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemVyIGFwcGxpZWQgdG8gZXZlcnkgTGFtYmRhIGludGVncmF0aW9uIG1ldGhvZC5cbiAgICAgKlxuICAgICAqIFdoZW4gb21pdHRlZCwgbWV0aG9kcyBrZWVwIEFQSSBHYXRld2F5J3Mgb3BlbiBkZWZhdWx0IChgQXV0aG9yaXphdGlvblR5cGUuTk9ORWApLlxuICAgICAqIENPUlMgcHJlZmxpZ2h0IGBPUFRJT05TYCBtZXRob2RzIHN0YXkgdW5hdXRoZW50aWNhdGVkIHJlZ2FyZGxlc3Mgb2YgdGhpcyBzZXR0aW5nLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBhdXRob3JpemVyKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlndy5JQXV0aG9yaXplcjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIEFQSSBHYXRld2F5IGF1dGhvcml6YXRpb24gdHlwZSBmb3IgdGhlIExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2RzLlxuICAgICAqXG4gICAgICogVXN1YWxseSBvbWl0dGVkOiB3aGVuIGBhdXRob3JpemVyYCBpcyBzZXQsIEFQSSBHYXRld2F5IGRlcml2ZXMgdGhlIHR5cGUgZnJvbSB0aGVcbiAgICAgKiBhdXRob3JpemVyIGl0c2VsZi4gU2V0IHRoaXMgZXhwbGljaXRseSB0byBvdmVycmlkZSB0aGF0IGluZmVyZW5jZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVyaXZlZCBmcm9tIGBhdXRob3JpemVyYCwgb3IgYE5PTkVgIHdoZW4gbm8gYXV0aG9yaXplciBpcyBzZXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBcHBUaGVvcnktbWFuYWdlZCByZWdpb25hbCBXQUYgV2ViQUNMIHdoZW4gZW5hYmxlZCB3aXRob3V0IHdlYkFjbEFybi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMO1xuXG4gICAgLyoqXG4gICAgICogUmVnaW9uYWwgV0FGIGFzc29jaWF0aW9uIGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2FmQXNzb2NpYXRpb24/OiB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEEgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQUFBQSByZWNvcmQgKGlmIGRvbWFpbiwgaG9zdGVkWm9uZSwgYW5kIGNyZWF0ZUFBQUFSZWNvcmQgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzT3B0aW9ucz86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNFbmFibGVkOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IGJvb2xlYW47XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemF0aW9uVHlwZT86IGFwaWd3LkF1dGhvcml6YXRpb25UeXBlO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG4gICAgcHJpdmF0ZSByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMgPSB7fSkge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIC8vIE5vcm1hbGl6ZSBDT1JTIGNvbmZpZ1xuICAgICAgICBpZiAocHJvcHMuY29ycyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0ge307XG4gICAgICAgIH0gZWxzZSBpZiAocHJvcHMuY29ycyAmJiB0eXBlb2YgcHJvcHMuY29ycyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0gcHJvcHMuY29ycztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmFsbG93VGVzdEludm9rZSA9IHByb3BzLmFsbG93VGVzdEludm9rZSA/PyB0cnVlO1xuICAgICAgICB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID0gcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdXRob3JpemVyID0gcHJvcHMuYXV0aG9yaXplcjtcbiAgICAgICAgdGhpcy5hdXRob3JpemF0aW9uVHlwZSA9IHByb3BzLmF1dGhvcml6YXRpb25UeXBlO1xuICAgICAgICB0aGlzLm5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICB0aGlzLmxvZ2ljYWxOYW1lID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKHByb3BzLm5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICByZWZ1c2VFeHBsaWNpdE5hbWUocHJvcHMubmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyXCIsIFwiYXBpTmFtZVwiLCBcImFwaV9yZXN0XCIsIHRoaXMubG9naWNhbE5hbWUsIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gdGhpcy5uYW1pbmdDb250ZXh0ICYmIHRoaXMubG9naWNhbE5hbWVcbiAgICAgICAgICAgID8gdGhpcy5uYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV9yZXN0XCIsIHRoaXMubG9naWNhbE5hbWUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgICBjb25zdCBjb25maWd1cmVkU3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgICAgIGNvbnN0IHN0YWdlT3B0cyA9IHRoaXMuZWZmZWN0aXZlU3RhZ2VPcHRpb25zKGNvbmZpZ3VyZWRTdGFnZU9wdHMpO1xuICAgICAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwicHJvZFwiO1xuICAgICAgICBjb25zdCBjb21wcmVzc2lvblByb3BzID1cbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICA6IHsgbWluQ29tcHJlc3Npb25TaXplOiBTaXplLmJ5dGVzKHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUpIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBSRVNUIEFQSVxuICAgICAgICB0aGlzLmFwaSA9IG5ldyBhcGlndy5SZXN0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgICAgIHJlc3RBcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBkZXBsb3k6IHByb3BzLmRlcGxveSA/PyB0cnVlLFxuICAgICAgICAgICAgcmV0YWluRGVwbG95bWVudHM6IHByb3BzLnJldGFpbkRlcGxveW1lbnRzLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlczogcHJvcHMuZW5kcG9pbnRUeXBlcyA/PyBbYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMXSxcbiAgICAgICAgICAgIGJpbmFyeU1lZGlhVHlwZXM6IHByb3BzLmJpbmFyeU1lZGlhVHlwZXMsXG4gICAgICAgICAgICAuLi5jb21wcmVzc2lvblByb3BzLFxuICAgICAgICAgICAgYXBpS2V5U291cmNlVHlwZTogcHJvcHMuYXBpS2V5U291cmNlVHlwZSxcbiAgICAgICAgICAgIGRlcGxveU9wdGlvbnM6IHRoaXMuYnVpbGREZXBsb3lPcHRpb25zKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5zdGFnZSA9IHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZTtcblxuICAgICAgICAvLyBTZXQgdXAgY3VzdG9tIGRvbWFpbiBpZiBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICAgICAgICBjb25zdCB3YWYgPSBjb25maWd1cmVSZXN0QXBpUmVnaW9uYWxXYWYoXG4gICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICB0aGlzLmFwaSxcbiAgICAgICAgICAgICAgICB0aGlzLnN0YWdlLFxuICAgICAgICAgICAgICAgIHByb3BzLndhZixcbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlOYW1lID8/IFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMIH0pLndlYkFjbCA9IHdhZi53ZWJBY2w7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24gfSkud2FmQXNzb2NpYXRpb24gPSB3YWYud2FmQXNzb2NpYXRpb247XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYSBMYW1iZGEgaW50ZWdyYXRpb24gZm9yIHRoZSBzcGVjaWZpZWQgcGF0aCBhbmQgSFRUUCBtZXRob2RzLlxuICAgICAqXG4gICAgICogQHBhcmFtIHBhdGggLSBUaGUgcmVzb3VyY2UgcGF0aCAoZS5nLiwgXCIvc3NlXCIsIFwiL2FwaS9ncmFwaHFsXCIsIFwiL3twcm94eSt9XCIpXG4gICAgICogQHBhcmFtIG1ldGhvZHMgLSBBcnJheSBvZiBIVFRQIG1ldGhvZHMgKGUuZy4sIFtcIkdFVFwiLCBcIlBPU1RcIl0gb3IgW1wiQU5ZXCJdKVxuICAgICAqIEBwYXJhbSBoYW5kbGVyIC0gVGhlIExhbWJkYSBmdW5jdGlvbiB0byBpbnRlZ3JhdGVcbiAgICAgKiBAcGFyYW0gb3B0aW9ucyAtIEludGVncmF0aW9uIG9wdGlvbnMgaW5jbHVkaW5nIHN0cmVhbWluZyBjb25maWd1cmF0aW9uXG4gICAgICovXG4gICAgYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHBhdGg6IHN0cmluZyxcbiAgICAgICAgbWV0aG9kczogc3RyaW5nW10sXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlRm9yUGF0aChwYXRoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbWV0aG9kcykge1xuICAgICAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKG0gPz8gXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAoIW1ldGhvZCkgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0aGUgaW50ZWdyYXRpb25cbiAgICAgICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gdGhpcy5jcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCBvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gQWRkIHRoZSBtZXRob2RcbiAgICAgICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25PcHRpb25zID1cbiAgICAgICAgICAgICAgICB0aGlzLmF1dGhvcml6ZXIgPT09IHVuZGVmaW5lZCAmJiB0aGlzLmF1dGhvcml6YXRpb25UeXBlID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXplciA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplciB9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB7IGF1dGhvcml6YXRpb25UeXBlOiB0aGlzLmF1dGhvcml6YXRpb25UeXBlIH0pLFxuICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkTWV0aG9kID0gcmVzb3VyY2UuYWRkTWV0aG9kKG1ldGhvZCwgaW50ZWdyYXRpb24sIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IHRoaXMuY29yc0VuYWJsZWQgPyB0aGlzLmJ1aWxkTWV0aG9kUmVzcG9uc2VzKCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgLi4uYXV0aG9yaXphdGlvbk9wdGlvbnMsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRm9yIHN0cmVhbWluZyByb3V0ZXMsIGFwcGx5IEwxIG92ZXJyaWRlcyB0byBlbnN1cmUgZnVsbCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5zdHJlYW1pbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKGNyZWF0ZWRNZXRob2QsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nKHRoaXMuc3RhZ2UsIG1ldGhvZCwgcGF0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgT1BUSU9OUyBtZXRob2QgZm9yIENPUlMgaWYgZW5hYmxlZCBhbmQgbm90IGFscmVhZHkgcHJlc2VudFxuICAgICAgICBpZiAodGhpcy5jb3JzRW5hYmxlZCAmJiAhcmVzb3VyY2Uubm9kZS50cnlGaW5kQ2hpbGQoXCJPUFRJT05TXCIpKSB7XG4gICAgICAgICAgICB0aGlzLmFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2UpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG9yIGNyZWF0ZSBhIHJlc291cmNlIGZvciB0aGUgZ2l2ZW4gcGF0aC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHJlc291cmNlRm9yUGF0aChpbnB1dFBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gICAgICAgIGxldCBjdXJyZW50OiBhcGlndy5JUmVzb3VyY2UgPSB0aGlzLmFwaS5yb290O1xuICAgICAgICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoaW5wdXRQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBjdXJyZW50O1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFydCA9IFN0cmluZyhzZWdtZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghcGFydCkgY29udGludWU7XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShwYXJ0KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHBhcnQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIExhbWJkYSBpbnRlZ3JhdGlvbiB3aXRoIHRoZSBhcHByb3ByaWF0ZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHByaXZhdGUgY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24ge1xuICAgICAgICBjb25zdCBzdHJlYW1pbmcgPSBvcHRpb25zLnN0cmVhbWluZyA/PyBmYWxzZTtcblxuICAgICAgICAvLyBGb3Igc3RyZWFtaW5nLCB3ZSB1c2UgU1RSRUFNIHJlc3BvbnNlVHJhbnNmZXJNb2RlXG4gICAgICAgIC8vIE5vdGU6IFRoZSBVUkkgc3VmZml4IGFuZCB0aW1lb3V0IHdpbGwgYmUgZml4ZWQgdmlhIEwxIG92ZXJyaWRlc1xuICAgICAgICByZXR1cm4gbmV3IGFwaWd3LkxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIHtcbiAgICAgICAgICAgIHByb3h5OiB0cnVlLFxuICAgICAgICAgICAgYWxsb3dUZXN0SW52b2tlOiB0aGlzLmFsbG93VGVzdEludm9rZSxcbiAgICAgICAgICAgIHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kLFxuICAgICAgICAgICAgcmVzcG9uc2VUcmFuc2Zlck1vZGU6IHN0cmVhbWluZyA/IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLlNUUkVBTSA6IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLkJVRkZFUkVELFxuICAgICAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0ID8/IChzdHJlYW1pbmcgPyBEdXJhdGlvbi5taW51dGVzKDE1KSA6IHVuZGVmaW5lZCksXG4gICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBvcHRpb25zLnBhc3N0aHJvdWdoQmVoYXZpb3IsXG4gICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiBvcHRpb25zLnJlcXVlc3RUZW1wbGF0ZXMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFwcGx5IEwxIENGTiBvdmVycmlkZXMgZm9yIHN0cmVhbWluZyByb3V0ZXMgdG8gZW5zdXJlIGZ1bGwgTGlmdCBwYXJpdHkuXG4gICAgICpcbiAgICAgKiBTdHJlYW1pbmcgcm91dGVzIHJlcXVpcmU6XG4gICAgICogMS4gSW50ZWdyYXRpb24uUmVzcG9uc2VUcmFuc2Zlck1vZGUgPSBTVFJFQU0gKGFscmVhZHkgc2V0IHZpYSBMMilcbiAgICAgKiAyLiBJbnRlZ3JhdGlvbi5VcmkgZW5kcyB3aXRoIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAzLiBJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXMgPSA5MDAwMDAgKDE1IG1pbnV0ZXMpXG4gICAgICovXG4gICAgcHJpdmF0ZSBhcHBseVN0cmVhbWluZ092ZXJyaWRlcyhcbiAgICAgICAgbWV0aG9kOiBhcGlndy5NZXRob2QsXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNmbk1ldGhvZCA9IG1ldGhvZC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlndy5DZm5NZXRob2Q7XG4gICAgICAgIGlmICghY2ZuTWV0aG9kKSByZXR1cm47XG5cbiAgICAgICAgLy8gQnVpbGQgdGhlIHN0cmVhbWluZyBVUklcbiAgICAgICAgLy8gU3RhbmRhcmQgZm9ybWF0OiBhcm46e3BhcnRpdGlvbn06YXBpZ2F0ZXdheTp7cmVnaW9ufTpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy97ZnVuY3Rpb25Bcm59L3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAgICBjb25zdCB0aW1lb3V0TXMgPSBvcHRpb25zLnRpbWVvdXQ/LnRvTWlsbGlzZWNvbmRzKCkgPz8gOTAwMDAwO1xuXG4gICAgICAgIC8vIE92ZXJyaWRlIHRoZSBpbnRlZ3JhdGlvbiBwcm9wZXJ0aWVzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzXCIsIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgLy8gVGhlIFVSSSBtdXN0IHVzZSB0aGUgc3RyZWFtaW5nLXNwZWNpZmljIHBhdGhcbiAgICAgICAgLy8gV2UgY29uc3RydWN0IGl0IHVzaW5nIEZuOjpKb2luIHRvIHByZXNlcnZlIENsb3VkRm9ybWF0aW9uIGludHJpbnNpY3NcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5VcmlcIiwge1xuICAgICAgICAgICAgXCJGbjo6Sm9pblwiOiBbXG4gICAgICAgICAgICAgICAgXCJcIixcbiAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIFwiYXJuOlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlBhcnRpdGlvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmFwaWdhdGV3YXk6XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UmVnaW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMvXCIsXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIuZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgICAgICAgIFwiL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBdLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBkZXBsb3kgb3B0aW9ucyBmb3IgdGhlIHN0YWdlLlxuICAgICAqL1xuICAgIHByaXZhdGUgZWZmZWN0aXZlU3RhZ2VPcHRpb25zKFxuICAgICAgICBzdGFnZTogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICApOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgaWYgKHRoaXMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHN0YWdlLmFjY2Vzc0xvZ2dpbmcgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gc3RhZ2U7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBidWlsZERlcGxveU9wdGlvbnMoXG4gICAgICAgIHN0YWdlT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgKTogYXBpZ3cuU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgLy8gSGFuZGxlIGFjY2VzcyBsb2dnaW5nXG4gICAgICAgIGxldCBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogYXBpZ3cuSUFjY2Vzc0xvZ0Rlc3RpbmF0aW9uIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgYWNjZXNzTG9nRm9ybWF0ID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdDtcbiAgICAgICAgY29uc3Qgc3RhbmRhcmQgPSB0aGlzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICAgICAgaWYgKHN0YW5kYXJkICYmICF0aGlzLmxvZ2ljYWxOYW1lICYmIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIFRoZSBjb25zdHJ1Y3QtY3JlYXRlZCBhY2Nlc3MtbG9nIGdyb3VwIGlzIGEgbG9nZ2luZyByZXNvdXJjZTogdW5kZXJcbiAgICAgICAgICAgIC8vIHRoZSBzdGFuZGFyZCBwcm9maWxlIGl0IHRha2VzIHRoZSBjb250cmFjdCBsb2ctc291cmNlIG5hbWUsIGFuZFxuICAgICAgICAgICAgLy8gdW5kZXIgdGhlIGxlZ2FjeSBwcm9maWxlIGl0IGtlZXBzIHRvZGF5J3MgQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkXG4gICAgICAgICAgICAvLyBuYW1lIGFuZCBjb25zdW1lcyBubyBuYW1pbmcgZW50cnkgKHIzLCBBRFYtMTMxMi0xKS5cbiAgICAgICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsXG4gICAgICAgICAgICAgICAgc3RhbmRhcmQgJiYgdGhpcy5uYW1pbmdDb250ZXh0ICYmIHRoaXMubG9naWNhbE5hbWVcbiAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiB0aGlzLm5hbWluZ0NvbnRleHQubG9nR3JvdXBOYW1lKGBsb2dzL2FjY2Vzcy9hcGkvJHt0aGlzLmxvZ2ljYWxOYW1lfWApLFxuICAgICAgICAgICAgICAgICAgICByZXRlbnRpb246IHJldGVudGlvbkZvcih0aGlzLm5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gKHN0YW5kYXJkID8gcmVzdEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpIDogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpKTtcbiAgICAgICAgfSBlbHNlIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyAmJiB0eXBlb2Ygc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIC8vIFVzZSBwcm92aWRlZCBsb2cgZ3JvdXBcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uLFxuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0LFxuICAgICAgICAgICAgbWV0cmljc0VuYWJsZWQ6IHN0YWdlT3B0cy5kZXRhaWxlZE1ldHJpY3MsXG4gICAgICAgICAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU2V0IHVwIGN1c3RvbSBkb21haW4gd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKGRvbWFpbk9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgICAgIC8vIEdldCBvciBjcmVhdGUgdGhlIGNlcnRpZmljYXRlIHJlZmVyZW5jZVxuICAgICAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgICAgICAgID8gKGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZSlcbiAgICAgICAgICAgIDogdW5kZWZpbmVkKTtcblxuICAgICAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyOiBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkb21haW4gbmFtZVxuICAgICAgICBjb25zdCBlbmRwb2ludFR5cGUgPSBkb21haW5PcHRzLmVuZHBvaW50VHlwZSA/PyBhcGlndy5FbmRwb2ludFR5cGUuUkVHSU9OQUw7XG4gICAgICAgIC8vIFNlY3VyaXR5IEh1YiBBUElHYXRld2F5LjExIGFjY2VwdHMgb25seSB0aGUgMjAyNSBlbmhhbmNlZCBwb2xpY2llcywgYW5kXG4gICAgICAgIC8vIEFQSSBHYXRld2F5IHJlamVjdHMgYSByZWdpb25hbCBwb2xpY3kgb24gYW4gZWRnZSBkb21haW4gKGFuZCB2aWNlXG4gICAgICAgIC8vIHZlcnNhKS4gV2l0aG91dCBhIG5hbWluZyBjb250ZXh0IHRoZSBwcmUtY29udHJhY3QgVExTXzFfMiBkZWZhdWx0IHN0YXlzLlxuICAgICAgICBjb25zdCBzZWN1cml0eVBvbGljeSA9IGRvbWFpbk9wdHMuc2VjdXJpdHlQb2xpY3lcbiAgICAgICAgICAgID8/IChzZWN1cmVEZWZhdWx0cyh0aGlzLm5hbWluZ0NvbnRleHQpXG4gICAgICAgICAgICAgICAgPyAoZW5kcG9pbnRUeXBlID09PSBhcGlndy5FbmRwb2ludFR5cGUuRURHRVxuICAgICAgICAgICAgICAgICAgICA/IFJFQ09NTUVOREVEX0VER0VfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZXG4gICAgICAgICAgICAgICAgICAgIDogUkVDT01NRU5ERURfUkVTVF9BUElfU0VDVVJJVFlfUE9MSUNZKVxuICAgICAgICAgICAgICAgIDogYXBpZ3cuU2VjdXJpdHlQb2xpY3kuVExTXzFfMik7XG4gICAgICAgIGNvbnN0IGVuZHBvaW50QWNjZXNzTW9kZSA9IGRvbWFpbk9wdHMuZW5kcG9pbnRBY2Nlc3NNb2RlXG4gICAgICAgICAgICA/PyAoaXNFbmhhbmNlZFJlc3RTZWN1cml0eVBvbGljeShzZWN1cml0eVBvbGljeSkgPyBhcGlndy5FbmRwb2ludEFjY2Vzc01vZGUuU1RSSUNUIDogdW5kZWZpbmVkKTtcbiAgICAgICAgY29uc3QgZG1uID0gbmV3IGFwaWd3LkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk9wdHMuZG9tYWluTmFtZSxcbiAgICAgICAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlLFxuICAgICAgICAgICAgc2VjdXJpdHlQb2xpY3ksXG4gICAgICAgICAgICAuLi4oZW5kcG9pbnRBY2Nlc3NNb2RlICE9PSB1bmRlZmluZWQgPyB7IGVuZHBvaW50QWNjZXNzTW9kZSB9IDoge30pLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBwYXRoIG1hcHBpbmdcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlndy5CYXNlUGF0aE1hcHBpbmcodGhpcywgXCJCYXNlUGF0aE1hcHBpbmdcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgICAgICAgcmVzdEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgICBiYXNlUGF0aDogZG9tYWluT3B0cy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmcgfSkuYmFzZVBhdGhNYXBwaW5nID0gbWFwcGluZztcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkIH0pLmFSZWNvcmQgPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmIChkb21haW5PcHRzLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhYWFhUmVjb3JkID0gbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgKHRoaXMgYXMgeyBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkIH0pLmFhYWFSZWNvcmQgPSBhYWFhUmVjb3JkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgbWV0aG9kIHJlc3BvbnNlcyBmb3IgQ09SUy1lbmFibGVkIGVuZHBvaW50cy5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkTWV0aG9kUmVzcG9uc2VzKCk6IGFwaWd3Lk1ldGhvZFJlc3BvbnNlW10ge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgQ09SUyBwcmVmbGlnaHQgKE9QVElPTlMpIG1ldGhvZCB0byBhIHJlc291cmNlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZTogYXBpZ3cuSVJlc291cmNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSB0aGlzLmNvcnNPcHRpb25zID8/IHt9O1xuICAgICAgICBjb25zdCBhbGxvd09yaWdpbnMgPSBvcHRzLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHMgPSBvcHRzLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiT1BUSU9OU1wiLCBcIlBBVENIXCIsIFwiSEVBRFwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzID0gb3B0cy5hbGxvd0hlYWRlcnMgPz8gW1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICAgIFwiQXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgICAgXCJYLUFtei1EYXRlXCIsXG4gICAgICAgICAgICBcIlgtQXBpLUtleVwiLFxuICAgICAgICAgICAgXCJYLUFtei1TZWN1cml0eS1Ub2tlblwiLFxuICAgICAgICBdO1xuICAgICAgICBjb25zdCBhbGxvd0NyZWRlbnRpYWxzID0gb3B0cy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBtYXhBZ2UgPSBvcHRzLm1heEFnZSA/PyBEdXJhdGlvbi5zZWNvbmRzKDYwMCk7XG5cbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW4gPSBhbGxvd09yaWdpbnMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kc1N0ciA9IGFsbG93TWV0aG9kcy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzU3RyID0gYWxsb3dIZWFkZXJzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIFwiT1BUSU9OU1wiLFxuICAgICAgICAgICAgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IGAnJHthbGxvd0hlYWRlcnNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogYCcke2FsbG93TWV0aG9kc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IGAnJHthbGxvd09yaWdpbn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogYCcke2FsbG93Q3JlZGVudGlhbHN9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogYCcke21heEFnZS50b1NlY29uZHMoKX0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogJ3tcInN0YXR1c0NvZGVcIjogMjAwfScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICAgIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICAgIH1cbiAgICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==