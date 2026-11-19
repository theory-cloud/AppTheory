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
        const dmn = new apigw.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
            endpointType,
            securityPolicy: domainOpts.securityPolicy ?? apigw.SecurityPolicy.TLS_1_2,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSx5REFBcUU7QUFDckUsaUVBQWtGO0FBQ2xGLHFFQUFnRjtBQUNoRix5REFBMEQ7QUE2VDFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDakQ7O09BRUc7SUFDYSxHQUFHLENBQWdCO0lBRW5DOztPQUVHO0lBQ2EsS0FBSyxDQUFjO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFvQjtJQUU5Qzs7T0FFRztJQUNhLGVBQWUsQ0FBeUI7SUFFeEQ7O09BRUc7SUFDYSxNQUFNLENBQW1CO0lBRXpDOztPQUVHO0lBQ2EsY0FBYyxDQUE4QjtJQUU1RDs7T0FFRztJQUNhLE9BQU8sQ0FBbUI7SUFFMUM7O09BRUc7SUFDYSxVQUFVLENBQXNCO0lBRWhEOztPQUVHO0lBQ2EsY0FBYyxDQUFrQjtJQUUvQixXQUFXLENBQXFDO0lBQ2hELFdBQVcsQ0FBVTtJQUNyQixlQUFlLENBQVU7SUFDekIsdUJBQXVCLENBQVU7SUFDakMsVUFBVSxDQUFxQjtJQUMvQixpQkFBaUIsQ0FBMkI7SUFDNUMsYUFBYSxDQUEwQjtJQUN2QyxXQUFXLENBQVU7SUFFdEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVB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RCxFQUFFLElBQUk7d0JBQzNELHFEQUFxRCxFQUFFLElBQUk7d0JBQzNELG9EQUFvRCxFQUFFLElBQUk7d0JBQzFELHlEQUF5RCxFQUFFLElBQUk7d0JBQy9ELCtDQUErQyxFQUFFLElBQUk7cUJBQ3hEO2lCQUNKO2FBQ0o7U0FDSixDQUNKLENBQUM7SUFDTixDQUFDOztBQWpiTCx3REFrYkM7QUFFRDs7R0FFRztBQUNILFNBQVMsbUJBQW1CLENBQUMsVUFBa0IsRUFBRSxJQUF5QjtJQUN0RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDaEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgU2l6ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7IHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQsIHJldGVudGlvbkZvciB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHsgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtYXBpLXN0cmVhbWluZ1wiO1xuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcblxuLyoqXG4gKiBDT1JTIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAgICogQGRlZmF1bHQgWycqJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgICAqIEBkZWZhdWx0IFsnR0VUJywgJ1BPU1QnLCAnUFVUJywgJ0RFTEVURScsICdPUFRJT05TJywgJ1BBVENIJywgJ0hFQUQnXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgICAqIEBkZWZhdWx0IFsnQ29udGVudC1UeXBlJywgJ0F1dGhvcml6YXRpb24nLCAnWC1BbXotRGF0ZScsICdYLUFwaS1LZXknLCAnWC1BbXotU2VjdXJpdHktVG9rZW4nXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhbGxvdyBjcmVkZW50aWFscy5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogTWF4IGFnZSBmb3IgcHJlZmxpZ2h0IGNhY2hlIGluIHNlY29uZHMuXG4gICAgICogQGRlZmF1bHQgNjAwXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogU3RhZ2UtbGV2ZWwgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBTdGFnZSBuYW1lLlxuICAgICAqIEBkZWZhdWx0ICdwcm9kJ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIGZvciB0aGUgc3RhZ2UuXG4gICAgICogSWYgdHJ1ZSwgYSBsb2cgZ3JvdXAgd2lsbCBiZSBjcmVhdGVkIGF1dG9tYXRpY2FsbHkuXG4gICAgICogUHJvdmlkZSBhIExvZ0dyb3VwIGZvciBjdXN0b20gbG9nZ2luZyBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGFjY2Vzc0xvZ2dpbmcgaXMgdHJ1ZSAoYm9vbGVhbikuXG4gICAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAgIC8qKlxuICAgICAqIEFjY2VzcyBsb2cgZm9ybWF0LlxuICAgICAqIEBkZWZhdWx0IEFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSAoQ29tbW9uIExvZyBGb3JtYXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRldGFpbGVkIENsb3VkV2F0Y2ggbWV0cmljcyBhdCBtZXRob2QvcmVzb3VyY2UgbGV2ZWwuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXRhaWxlZE1ldHJpY3M/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwiYXBpLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSAobXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIGVkZ2UgZW5kcG9pbnRzLCBzYW1lIHJlZ2lvbiBmb3IgcmVnaW9uYWwpLlxuICAgICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYXV0b21hdGljIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogSWYgcHJvdmlkZWQsIGFuIEEgcmVjb3JkIChhbGlhcykgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBETlMgcmVjb3JkIGNyZWF0ZWQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYGhvc3RlZFpvbmVgIGlzIHByb3ZpZGVkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgZm9yIHRoZSBBUEkgdW5kZXIgdGhpcyBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChtYXBzIHRvIHRoZSByb290KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBSRUdJT05BTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZT86IGFwaWd3LkVuZHBvaW50VHlwZTtcblxuICAgIC8qKlxuICAgICAqIFNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBUTFNfMV8yXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlndy5TZWN1cml0eVBvbGljeTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgICAqIGxvZyBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzXG4gICAgICogSlNPTiBmaWVsZCBzZXQuIFBhc3MgYHN0YWdlLmFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgICAqXG4gICAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRGVzY3JpcHRpb24gb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBzZW5zaWJsZSBkZWZhdWx0cyxcbiAgICAgKiBvciBwcm92aWRlIGN1c3RvbSBvcHRpb25zLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gQ09SUylcbiAgICAgKi9cbiAgICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGN1c3RvbSBkb21haW4pXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuIFNldCB0byB0cnVlXG4gICAgICogZm9yIGFuIEFwcFRoZW9yeS1tYW5hZ2VkIFdlYkFDTCwgb3IgcHJvdmlkZSBvcHRpb25zIHRvIHJldXNlIGFuIGV4aXN0aW5nXG4gICAgICogcmVnaW9uYWwgV2ViQUNMLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlcyBmb3IgdGhlIFJFU1QgQVBJLlxuICAgICAqIEBkZWZhdWx0IFtSRUdJT05BTF1cbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGVzPzogYXBpZ3cuRW5kcG9pbnRUeXBlW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRoZSBSRVNUIEFQSSB1c2VzIGJpbmFyeSBtZWRpYSB0eXBlcy5cbiAgICAgKiBTcGVjaWZ5IG1lZGlhIHR5cGVzIHRoYXQgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgYmluYXJ5LlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJpbmFyeU1lZGlhVHlwZXM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gY29tcHJlc3Npb24gc2l6ZSBpbiBieXRlcy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGNvbXByZXNzaW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Db21wcmVzc2lvblNpemU/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGVwbG95IG9uIGNvbnN0cnVjdCBjcmVhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVwbG95PzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFJldGFpbiBkZXBsb3ltZW50IGhpc3Rvcnkgd2hlbiBkZXBsb3ltZW50cyBjaGFuZ2UuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSByZXRhaW5EZXBsb3ltZW50cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBBUEkga2V5IHNvdXJjZSB0eXBlLlxuICAgICAqIEBkZWZhdWx0IEhFQURFUlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUtleVNvdXJjZVR5cGU/OiBhcGlndy5BcGlLZXlTb3VyY2VUeXBlO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBBUEkgR2F0ZXdheSBjb25zb2xlIHRlc3QgaW52b2NhdGlvbnMgc2hvdWxkIGJlIGdyYW50ZWQgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3Qgc3VwcHJlc3NlcyB0aGUgZXh0cmEgYHRlc3QtaW52b2tlLXN0YWdlYCBMYW1iZGEgcGVybWlzc2lvbnNcbiAgICAgKiB0aGF0IENESyBhZGRzIGZvciBlYWNoIFJFU1QgQVBJIG1ldGhvZC4gVGhpcyByZWR1Y2VzIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZSB3aGlsZVxuICAgICAqIHByZXNlcnZpbmcgZGVwbG95ZWQtc3RhZ2UgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIFJFU1QgQVBJIG1ldGhvZHMuXG4gICAgICpcbiAgICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgbWV0aG9kL3BhdGggcGFpci4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBmcm9udC1jb250cm9sbGVyXG4gICAgICogQVBJcyB0aGF0IHJvdXRlIG1hbnkgUkVTVCBwYXRocyB0byB0aGUgc2FtZSBMYW1iZGEuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgQVBJIEdhdGV3YXkgYXV0aG9yaXplciBhcHBsaWVkIHRvIGV2ZXJ5IExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2QuXG4gICAgICpcbiAgICAgKiBXaGVuIG9taXR0ZWQsIG1ldGhvZHMga2VlcCBBUEkgR2F0ZXdheSdzIG9wZW4gZGVmYXVsdCAoYEF1dGhvcml6YXRpb25UeXBlLk5PTkVgKS5cbiAgICAgKiBDT1JTIHByZWZsaWdodCBgT1BUSU9OU2AgbWV0aG9kcyBzdGF5IHVuYXV0aGVudGljYXRlZCByZWdhcmRsZXNzIG9mIHRoaXMgc2V0dGluZy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gYXV0aG9yaXplcilcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemF0aW9uIHR5cGUgZm9yIHRoZSBMYW1iZGEgaW50ZWdyYXRpb24gbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFVzdWFsbHkgb21pdHRlZDogd2hlbiBgYXV0aG9yaXplcmAgaXMgc2V0LCBBUEkgR2F0ZXdheSBkZXJpdmVzIHRoZSB0eXBlIGZyb20gdGhlXG4gICAgICogYXV0aG9yaXplciBpdHNlbGYuIFNldCB0aGlzIGV4cGxpY2l0bHkgdG8gb3ZlcnJpZGUgdGhhdCBpbmZlcmVuY2UuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlcml2ZWQgZnJvbSBgYXV0aG9yaXplcmAsIG9yIGBOT05FYCB3aGVuIG5vIGF1dGhvcml6ZXIgaXMgc2V0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6YXRpb25UeXBlPzogYXBpZ3cuQXV0aG9yaXphdGlvblR5cGU7XG59XG5cbi8qKlxuICogQSBSRVNUIEFQSSB2MSByb3V0ZXIgdGhhdCBzdXBwb3J0cyBtdWx0aS1MYW1iZGEgcm91dGluZyB3aXRoIGZ1bGwgc3RyZWFtaW5nIHBhcml0eS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBhZGRyZXNzZXMgdGhlIGdhcHMgaW4gQXBwVGhlb3J5UmVzdEFwaSBieSBhbGxvd2luZzpcbiAqIC0gTXVsdGlwbGUgTGFtYmRhIGZ1bmN0aW9ucyBhdHRhY2hlZCB0byBkaWZmZXJlbnQgcm91dGVzXG4gKiAtIENvbXBsZXRlIHJlc3BvbnNlIHN0cmVhbWluZyBpbnRlZ3JhdGlvbiAocmVzcG9uc2VUcmFuc2Zlck1vZGUsIFVSSSBzdWZmaXgsIHRpbWVvdXQpXG4gKiAtIFN0YWdlIGNvbnRyb2xzIChhY2Nlc3MgbG9nZ2luZywgbWV0cmljcywgdGhyb3R0bGluZywgQ09SUylcbiAqIC0gQ3VzdG9tIGRvbWFpbiB3aXJpbmcgd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZFxuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCByb3V0ZXIgPSBuZXcgQXBwVGhlb3J5UmVzdEFwaVJvdXRlcih0aGlzLCAnUm91dGVyJywge1xuICogICBhcGlOYW1lOiAnbXktYXBpJyxcbiAqICAgc3RhZ2U6IHsgc3RhZ2VOYW1lOiAncHJvZCcsIGFjY2Vzc0xvZ2dpbmc6IHRydWUsIGRldGFpbGVkTWV0cmljczogdHJ1ZSB9LFxuICogICBjb3JzOiB0cnVlLFxuICogfSk7XG4gKlxuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvc3NlJywgWydHRVQnXSwgc3NlRm4sIHsgc3RyZWFtaW5nOiB0cnVlIH0pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvYXBpL2dyYXBocWwnLCBbJ1BPU1QnXSwgZ3JhcGhxbEZuKTtcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL3twcm94eSt9JywgWydBTlknXSwgYXBpRm4pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIHVuZGVybHlpbmcgQVBJIEdhdGV3YXkgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3cuUmVzdEFwaTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkZXBsb3ltZW50IHN0YWdlLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3cuU3RhZ2U7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWU7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nO1xuXG4gICAgLyoqXG4gICAgICogQXBwVGhlb3J5LW1hbmFnZWQgcmVnaW9uYWwgV0FGIFdlYkFDTCB3aGVuIGVuYWJsZWQgd2l0aG91dCB3ZWJBY2xBcm4uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdlYkFjbD86IHdhZnYyLkNmbldlYkFDTDtcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhc3NvY2lhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEFBQUEgcmVjb3JkIChpZiBkb21haW4sIGhvc3RlZFpvbmUsIGFuZCBjcmVhdGVBQUFBUmVjb3JkIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc09wdGlvbnM/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzRW5hYmxlZDogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZTogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXplcj86IGFwaWd3LklBdXRob3JpemVyO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbiAgICBwcml2YXRlIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuICAgIHByaXZhdGUgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzID0ge30pIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICAvLyBOb3JtYWxpemUgQ09SUyBjb25maWdcbiAgICAgICAgaWYgKHByb3BzLmNvcnMgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmNvcnMgJiYgdHlwZW9mIHByb3BzLmNvcnMgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHByb3BzLmNvcnM7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hbGxvd1Rlc3RJbnZva2UgPSBwcm9wcy5hbGxvd1Rlc3RJbnZva2UgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID8/IHRydWU7XG4gICAgICAgIHRoaXMuYXV0aG9yaXplciA9IHByb3BzLmF1dGhvcml6ZXI7XG4gICAgICAgIHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPSBwcm9wcy5hdXRob3JpemF0aW9uVHlwZTtcbiAgICAgICAgdGhpcy5uYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgICAgdGhpcy5sb2dpY2FsTmFtZSA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChwcm9wcy5uYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgICAgcmVmdXNlRXhwbGljaXROYW1lKHByb3BzLm5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLCBcImFwaU5hbWVcIiwgXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgICAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lXG4gICAgICAgICAgICA/IHRoaXMubmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfcmVzdFwiLCB0aGlzLmxvZ2ljYWxOYW1lKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAgICAgY29uc3QgY29uZmlndXJlZFN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgICAgICBjb25zdCBzdGFnZU9wdHMgPSB0aGlzLmVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhjb25maWd1cmVkU3RhZ2VPcHRzKTtcbiAgICAgICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcInByb2RcIjtcbiAgICAgICAgY29uc3QgY29tcHJlc3Npb25Qcm9wcyA9XG4gICAgICAgICAgICBwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICA/IHt9XG4gICAgICAgICAgICAgICAgOiB7IG1pbkNvbXByZXNzaW9uU2l6ZTogU2l6ZS5ieXRlcyhwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplKSB9O1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgUkVTVCBBUElcbiAgICAgICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3cuUmVzdEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgICAgICByZXN0QXBpTmFtZTogZGVyaXZlZEFwaU5hbWUgJiYgIWRlcml2ZWRBcGlOYW1lLmdlbmVyYXRlZCA/IGRlcml2ZWRBcGlOYW1lLm5hbWUgOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgZGVwbG95OiBwcm9wcy5kZXBsb3kgPz8gdHJ1ZSxcbiAgICAgICAgICAgIHJldGFpbkRlcGxveW1lbnRzOiBwcm9wcy5yZXRhaW5EZXBsb3ltZW50cyxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZXM6IHByb3BzLmVuZHBvaW50VHlwZXMgPz8gW2FwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTF0sXG4gICAgICAgICAgICBiaW5hcnlNZWRpYVR5cGVzOiBwcm9wcy5iaW5hcnlNZWRpYVR5cGVzLFxuICAgICAgICAgICAgLi4uY29tcHJlc3Npb25Qcm9wcyxcbiAgICAgICAgICAgIGFwaUtleVNvdXJjZVR5cGU6IHByb3BzLmFwaUtleVNvdXJjZVR5cGUsXG4gICAgICAgICAgICBkZXBsb3lPcHRpb25zOiB0aGlzLmJ1aWxkRGVwbG95T3B0aW9ucyhzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuc3RhZ2UgPSB0aGlzLmFwaS5kZXBsb3ltZW50U3RhZ2U7XG5cbiAgICAgICAgLy8gU2V0IHVwIGN1c3RvbSBkb21haW4gaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHByb3BzLndhZikge1xuICAgICAgICAgICAgY29uc3Qgd2FmID0gY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmKFxuICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgdGhpcy5hcGksXG4gICAgICAgICAgICAgICAgdGhpcy5zdGFnZSxcbiAgICAgICAgICAgICAgICBwcm9wcy53YWYsXG4gICAgICAgICAgICAgICAgcHJvcHMuYXBpTmFtZSA/PyBcIkFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdlYkFjbD86IHdhZnYyLkNmbldlYkFDTCB9KS53ZWJBY2wgPSB3YWYud2ViQWNsO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyB3YWZBc3NvY2lhdGlvbj86IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uIH0pLndhZkFzc29jaWF0aW9uID0gd2FmLndhZkFzc29jaWF0aW9uO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgTGFtYmRhIGludGVncmF0aW9uIGZvciB0aGUgc3BlY2lmaWVkIHBhdGggYW5kIEhUVFAgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXRoIC0gVGhlIHJlc291cmNlIHBhdGggKGUuZy4sIFwiL3NzZVwiLCBcIi9hcGkvZ3JhcGhxbFwiLCBcIi97cHJveHkrfVwiKVxuICAgICAqIEBwYXJhbSBtZXRob2RzIC0gQXJyYXkgb2YgSFRUUCBtZXRob2RzIChlLmcuLCBbXCJHRVRcIiwgXCJQT1NUXCJdIG9yIFtcIkFOWVwiXSlcbiAgICAgKiBAcGFyYW0gaGFuZGxlciAtIFRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gaW50ZWdyYXRlXG4gICAgICogQHBhcmFtIG9wdGlvbnMgLSBJbnRlZ3JhdGlvbiBvcHRpb25zIGluY2x1ZGluZyBzdHJlYW1pbmcgY29uZmlndXJhdGlvblxuICAgICAqL1xuICAgIGFkZExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBwYXRoOiBzdHJpbmcsXG4gICAgICAgIG1ldGhvZHM6IHN0cmluZ1tdLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHJlc291cmNlID0gdGhpcy5yZXNvdXJjZUZvclBhdGgocGF0aCk7XG5cbiAgICAgICAgZm9yIChjb25zdCBtIG9mIG1ldGhvZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhtID8/IFwiXCIpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgaWYgKCFtZXRob2QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAvLyBDcmVhdGUgdGhlIGludGVncmF0aW9uXG4gICAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IHRoaXMuY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwgb3B0aW9ucyk7XG5cbiAgICAgICAgICAgIC8vIEFkZCB0aGUgbWV0aG9kXG4gICAgICAgICAgICBjb25zdCBhdXRob3JpemF0aW9uT3B0aW9ucyA9XG4gICAgICAgICAgICAgICAgdGhpcy5hdXRob3JpemVyID09PSB1bmRlZmluZWQgJiYgdGhpcy5hdXRob3JpemF0aW9uVHlwZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmF1dGhvcml6ZXIgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIgfSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmF1dGhvcml6YXRpb25UeXBlID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogeyBhdXRob3JpemF0aW9uVHlwZTogdGhpcy5hdXRob3JpemF0aW9uVHlwZSB9KSxcbiAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc3QgY3JlYXRlZE1ldGhvZCA9IHJlc291cmNlLmFkZE1ldGhvZChtZXRob2QsIGludGVncmF0aW9uLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiB0aGlzLmNvcnNFbmFibGVkID8gdGhpcy5idWlsZE1ldGhvZFJlc3BvbnNlcygpIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIC4uLmF1dGhvcml6YXRpb25PcHRpb25zLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIEZvciBzdHJlYW1pbmcgcm91dGVzLCBhcHBseSBMMSBvdmVycmlkZXMgdG8gZW5zdXJlIGZ1bGwgY29tcGF0aWJpbGl0eVxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc3RyZWFtaW5nKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBseVN0cmVhbWluZ092ZXJyaWRlcyhjcmVhdGVkTWV0aG9kLCBoYW5kbGVyLCBvcHRpb25zKTtcbiAgICAgICAgICAgICAgICBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyh0aGlzLnN0YWdlLCBtZXRob2QsIHBhdGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIE9QVElPTlMgbWV0aG9kIGZvciBDT1JTIGlmIGVuYWJsZWQgYW5kIG5vdCBhbHJlYWR5IHByZXNlbnRcbiAgICAgICAgaWYgKHRoaXMuY29yc0VuYWJsZWQgJiYgIXJlc291cmNlLm5vZGUudHJ5RmluZENoaWxkKFwiT1BUSU9OU1wiKSkge1xuICAgICAgICAgICAgdGhpcy5hZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBvciBjcmVhdGUgYSByZXNvdXJjZSBmb3IgdGhlIGdpdmVuIHBhdGguXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNvdXJjZUZvclBhdGgoaW5wdXRQYXRoOiBzdHJpbmcpOiBhcGlndy5JUmVzb3VyY2Uge1xuICAgICAgICBsZXQgY3VycmVudDogYXBpZ3cuSVJlc291cmNlID0gdGhpcy5hcGkucm9vdDtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKGlucHV0UGF0aCA/PyBcIlwiKS50cmltKCksIFwiL1wiKTtcbiAgICAgICAgaWYgKCF0cmltbWVkKSByZXR1cm4gY3VycmVudDtcblxuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSBTdHJpbmcoc2VnbWVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIXBhcnQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2UocGFydCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShwYXJ0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBMYW1iZGEgaW50ZWdyYXRpb24gd2l0aCB0aGUgYXBwcm9wcmlhdGUgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICBwcml2YXRlIGNyZWF0ZUxhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IGFwaWd3LkxhbWJkYUludGVncmF0aW9uIHtcbiAgICAgICAgY29uc3Qgc3RyZWFtaW5nID0gb3B0aW9ucy5zdHJlYW1pbmcgPz8gZmFsc2U7XG5cbiAgICAgICAgLy8gRm9yIHN0cmVhbWluZywgd2UgdXNlIFNUUkVBTSByZXNwb25zZVRyYW5zZmVyTW9kZVxuICAgICAgICAvLyBOb3RlOiBUaGUgVVJJIHN1ZmZpeCBhbmQgdGltZW91dCB3aWxsIGJlIGZpeGVkIHZpYSBMMSBvdmVycmlkZXNcbiAgICAgICAgcmV0dXJuIG5ldyBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCB7XG4gICAgICAgICAgICBwcm94eTogdHJ1ZSxcbiAgICAgICAgICAgIGFsbG93VGVzdEludm9rZTogdGhpcy5hbGxvd1Rlc3RJbnZva2UsXG4gICAgICAgICAgICBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCxcbiAgICAgICAgICAgIHJlc3BvbnNlVHJhbnNmZXJNb2RlOiBzdHJlYW1pbmcgPyBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5TVFJFQU0gOiBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5CVUZGRVJFRCxcbiAgICAgICAgICAgIHRpbWVvdXQ6IG9wdGlvbnMudGltZW91dCA/PyAoc3RyZWFtaW5nID8gRHVyYXRpb24ubWludXRlcygxNSkgOiB1bmRlZmluZWQpLFxuICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogb3B0aW9ucy5wYXNzdGhyb3VnaEJlaGF2aW9yLFxuICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczogb3B0aW9ucy5yZXF1ZXN0VGVtcGxhdGVzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBcHBseSBMMSBDRk4gb3ZlcnJpZGVzIGZvciBzdHJlYW1pbmcgcm91dGVzIHRvIGVuc3VyZSBmdWxsIExpZnQgcGFyaXR5LlxuICAgICAqXG4gICAgICogU3RyZWFtaW5nIHJvdXRlcyByZXF1aXJlOlxuICAgICAqIDEuIEludGVncmF0aW9uLlJlc3BvbnNlVHJhbnNmZXJNb2RlID0gU1RSRUFNIChhbHJlYWR5IHNldCB2aWEgTDIpXG4gICAgICogMi4gSW50ZWdyYXRpb24uVXJpIGVuZHMgd2l0aCAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogMy4gSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzID0gOTAwMDAwICgxNSBtaW51dGVzKVxuICAgICAqL1xuICAgIHByaXZhdGUgYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoXG4gICAgICAgIG1ldGhvZDogYXBpZ3cuTWV0aG9kLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCBjZm5NZXRob2QgPSBtZXRob2Qubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3cuQ2ZuTWV0aG9kO1xuICAgICAgICBpZiAoIWNmbk1ldGhvZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBzdHJlYW1pbmcgVVJJXG4gICAgICAgIC8vIFN0YW5kYXJkIGZvcm1hdDogYXJuOntwYXJ0aXRpb259OmFwaWdhdGV3YXk6e3JlZ2lvbn06bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMve2Z1bmN0aW9uQXJufS9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgICAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0Py50b01pbGxpc2Vjb25kcygpID8/IDkwMDAwMDtcblxuICAgICAgICAvLyBPdmVycmlkZSB0aGUgaW50ZWdyYXRpb24gcHJvcGVydGllc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpc1wiLCB0aW1lb3V0TXMpO1xuXG4gICAgICAgIC8vIFRoZSBVUkkgbXVzdCB1c2UgdGhlIHN0cmVhbWluZy1zcGVjaWZpYyBwYXRoXG4gICAgICAgIC8vIFdlIGNvbnN0cnVjdCBpdCB1c2luZyBGbjo6Sm9pbiB0byBwcmVzZXJ2ZSBDbG91ZEZvcm1hdGlvbiBpbnRyaW5zaWNzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVXJpXCIsIHtcbiAgICAgICAgICAgIFwiRm46OkpvaW5cIjogW1xuICAgICAgICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICBcImFybjpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpQYXJ0aXRpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjphcGlnYXRld2F5OlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlJlZ2lvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL1wiLFxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICAgICAgICBcIi9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgZGVwbG95IG9wdGlvbnMgZm9yIHRoZSBzdGFnZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhcbiAgICAgICAgc3RhZ2U6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgKTogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgICAgIGlmICh0aGlzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBzdGFnZS5hY2Nlc3NMb2dnaW5nID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnN0YWdlLCBhY2Nlc3NMb2dnaW5nOiB0cnVlIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHN0YWdlO1xuICAgIH1cblxuICAgIHByaXZhdGUgYnVpbGREZXBsb3lPcHRpb25zKFxuICAgICAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICAgICk6IGFwaWd3LlN0YWdlT3B0aW9ucyB7XG4gICAgICAgIC8vIEhhbmRsZSBhY2Nlc3MgbG9nZ2luZ1xuICAgICAgICBsZXQgYWNjZXNzTG9nRGVzdGluYXRpb246IGFwaWd3LklBY2Nlc3NMb2dEZXN0aW5hdGlvbiB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Zvcm1hdCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQ7XG4gICAgICAgIGNvbnN0IHN0YW5kYXJkID0gdGhpcy5uYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgICAgIGlmIChzdGFuZGFyZCAmJiAhdGhpcy5sb2dpY2FsTmFtZSAmJiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICAgICAgICAvLyBUaGUgY29uc3RydWN0LWNyZWF0ZWQgYWNjZXNzLWxvZyBncm91cCBpcyBhIGxvZ2dpbmcgcmVzb3VyY2U6IHVuZGVyXG4gICAgICAgICAgICAvLyB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpdCB0YWtlcyB0aGUgY29udHJhY3QgbG9nLXNvdXJjZSBuYW1lLCBhbmRcbiAgICAgICAgICAgIC8vIHVuZGVyIHRoZSBsZWdhY3kgcHJvZmlsZSBpdCBrZWVwcyB0b2RheSdzIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZFxuICAgICAgICAgICAgLy8gbmFtZSBhbmQgY29uc3VtZXMgbm8gbmFtaW5nIGVudHJ5IChyMywgQURWLTEzMTItMSkuXG4gICAgICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLFxuICAgICAgICAgICAgICAgIHN0YW5kYXJkICYmIHRoaXMubmFtaW5nQ29udGV4dCAmJiB0aGlzLmxvZ2ljYWxOYW1lXG4gICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogdGhpcy5uYW1pbmdDb250ZXh0LmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7dGhpcy5sb2dpY2FsTmFtZX1gKSxcbiAgICAgICAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IodGhpcy5uYW1pbmdDb250ZXh0LnJldGVudGlvbkRheXMpLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IChzdGFuZGFyZCA/IHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICBjb25zdCBkbW4gPSBuZXcgYXBpZ3cuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICAgICAgICBlbmRwb2ludFR5cGUsXG4gICAgICAgICAgICBzZWN1cml0eVBvbGljeTogZG9tYWluT3B0cy5zZWN1cml0eVBvbGljeSA/PyBhcGlndy5TZWN1cml0eVBvbGljeS5UTFNfMV8yLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBwYXRoIG1hcHBpbmdcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlndy5CYXNlUGF0aE1hcHBpbmcodGhpcywgXCJCYXNlUGF0aE1hcHBpbmdcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgICAgICAgcmVzdEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgICBiYXNlUGF0aDogZG9tYWluT3B0cy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmcgfSkuYmFzZVBhdGhNYXBwaW5nID0gbWFwcGluZztcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkIH0pLmFSZWNvcmQgPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmIChkb21haW5PcHRzLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhYWFhUmVjb3JkID0gbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgKHRoaXMgYXMgeyBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkIH0pLmFhYWFSZWNvcmQgPSBhYWFhUmVjb3JkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgbWV0aG9kIHJlc3BvbnNlcyBmb3IgQ09SUy1lbmFibGVkIGVuZHBvaW50cy5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkTWV0aG9kUmVzcG9uc2VzKCk6IGFwaWd3Lk1ldGhvZFJlc3BvbnNlW10ge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgQ09SUyBwcmVmbGlnaHQgKE9QVElPTlMpIG1ldGhvZCB0byBhIHJlc291cmNlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZTogYXBpZ3cuSVJlc291cmNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSB0aGlzLmNvcnNPcHRpb25zID8/IHt9O1xuICAgICAgICBjb25zdCBhbGxvd09yaWdpbnMgPSBvcHRzLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHMgPSBvcHRzLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiT1BUSU9OU1wiLCBcIlBBVENIXCIsIFwiSEVBRFwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzID0gb3B0cy5hbGxvd0hlYWRlcnMgPz8gW1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICAgIFwiQXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgICAgXCJYLUFtei1EYXRlXCIsXG4gICAgICAgICAgICBcIlgtQXBpLUtleVwiLFxuICAgICAgICAgICAgXCJYLUFtei1TZWN1cml0eS1Ub2tlblwiLFxuICAgICAgICBdO1xuICAgICAgICBjb25zdCBhbGxvd0NyZWRlbnRpYWxzID0gb3B0cy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBtYXhBZ2UgPSBvcHRzLm1heEFnZSA/PyBEdXJhdGlvbi5zZWNvbmRzKDYwMCk7XG5cbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW4gPSBhbGxvd09yaWdpbnMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kc1N0ciA9IGFsbG93TWV0aG9kcy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzU3RyID0gYWxsb3dIZWFkZXJzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIFwiT1BUSU9OU1wiLFxuICAgICAgICAgICAgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IGAnJHthbGxvd0hlYWRlcnNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogYCcke2FsbG93TWV0aG9kc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IGAnJHthbGxvd09yaWdpbn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogYCcke2FsbG93Q3JlZGVudGlhbHN9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogYCcke21heEFnZS50b1NlY29uZHMoKX0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogJ3tcInN0YXR1c0NvZGVcIjogMjAwfScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICAgIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICAgIH1cbiAgICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==