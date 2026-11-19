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
            // Create an auto-managed log group
            const contractName = this.namingContext && this.logicalName
                ? (0, standard_logging_1.accessLogGroupName)(this.namingContext, `logs/access/api/${this.logicalName}`)
                : undefined;
            const logGroup = new logs.LogGroup(this, "AccessLogs", standard && this.namingContext && this.logicalName
                ? {
                    logGroupName: contractName,
                    retention: (0, standard_logging_1.retentionFor)(this.namingContext.retentionDays),
                }
                : contractName !== undefined
                    ? {
                        logGroupName: contractName,
                        retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSx5REFBcUU7QUFDckUsaUVBQXNHO0FBQ3RHLHFFQUFnRjtBQUNoRix5REFBMEQ7QUE2VDFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDakQ7O09BRUc7SUFDYSxHQUFHLENBQWdCO0lBRW5DOztPQUVHO0lBQ2EsS0FBSyxDQUFjO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFvQjtJQUU5Qzs7T0FFRztJQUNhLGVBQWUsQ0FBeUI7SUFFeEQ7O09BRUc7SUFDYSxNQUFNLENBQW1CO0lBRXpDOztPQUVHO0lBQ2EsY0FBYyxDQUE4QjtJQUU1RDs7T0FFRztJQUNhLE9BQU8sQ0FBbUI7SUFFMUM7O09BRUc7SUFDYSxVQUFVLENBQXNCO0lBRWhEOztPQUVHO0lBQ2EsY0FBYyxDQUFrQjtJQUUvQixXQUFXLENBQXFDO0lBQ2hELFdBQVcsQ0FBVTtJQUNyQixlQUFlLENBQVU7SUFDekIsdUJBQXVCLENBQVU7SUFDakMsVUFBVSxDQUFxQjtJQUMvQixpQkFBaUIsQ0FBMkI7SUFDNUMsYUFBYSxDQUEwQjtJQUN2QyxXQUFXLENBQVU7SUFFdEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVB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SUFDekMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgU2l6ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7IGFjY2Vzc0xvZ0dyb3VwTmFtZSwgcmVzdEFwaUFjY2Vzc0xvZ0Zvcm1hdCwgcmV0ZW50aW9uRm9yIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgeyBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyB9IGZyb20gXCIuL3ByaXZhdGUvcmVzdC1hcGktc3RyZWFtaW5nXCI7XG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB9IGZyb20gXCIuL3JlZ2lvbmFsLXdhZlwiO1xuXG4vKipcbiAqIENPUlMgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICAgKiBAZGVmYXVsdCBbJyonXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93T3JpZ2lucz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAgICogQGRlZmF1bHQgWydHRVQnLCAnUE9TVCcsICdQVVQnLCAnREVMRVRFJywgJ09QVElPTlMnLCAnUEFUQ0gnLCAnSEVBRCddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIGhlYWRlcnMuXG4gICAgICogQGRlZmF1bHQgWydDb250ZW50LVR5cGUnLCAnQXV0aG9yaXphdGlvbicsICdYLUFtei1EYXRlJywgJ1gtQXBpLUtleScsICdYLUFtei1TZWN1cml0eS1Ub2tlbiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGFsbG93IGNyZWRlbnRpYWxzLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBNYXggYWdlIGZvciBwcmVmbGlnaHQgY2FjaGUgaW4gc2Vjb25kcy5cbiAgICAgKiBAZGVmYXVsdCA2MDBcbiAgICAgKi9cbiAgICByZWFkb25seSBtYXhBZ2U/OiBEdXJhdGlvbjtcbn1cblxuLyoqXG4gKiBTdGFnZS1sZXZlbCBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFN0YWdlIG5hbWUuXG4gICAgICogQGRlZmF1bHQgJ3Byb2QnXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBJZiB0cnVlLCBhIGxvZyBncm91cCB3aWxsIGJlIGNyZWF0ZWQgYXV0b21hdGljYWxseS5cbiAgICAgKiBQcm92aWRlIGEgTG9nR3JvdXAgZm9yIGN1c3RvbSBsb2dnaW5nIGNvbmZpZ3VyYXRpb24uXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgLyoqXG4gICAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgYXV0by1jcmVhdGVkIGFjY2VzcyBsb2cgZ3JvdXAuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlIChib29sZWFuKS5cbiAgICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gICAgLyoqXG4gICAgICogQWNjZXNzIGxvZyBmb3JtYXQuXG4gICAgICogQGRlZmF1bHQgQWNjZXNzTG9nRm9ybWF0LmNsZigpIChDb21tb24gTG9nIEZvcm1hdClcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlndy5BY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGV0YWlsZWQgQ2xvdWRXYXRjaCBtZXRyaWNzIGF0IG1ldGhvZC9yZXNvdXJjZSBsZXZlbC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRldGFpbGVkTWV0cmljcz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQgKHJlcXVlc3RzIHBlciBzZWNvbmQpIGZvciB0aGUgc3RhZ2UuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZS5nLiwgXCJhcGkuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIChtdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgZWRnZSBlbmRwb2ludHMsIHNhbWUgcmVnaW9uIGZvciByZWdpb25hbCkuXG4gICAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhdXRvbWF0aWMgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBJZiBwcm92aWRlZCwgYW4gQSByZWNvcmQgKGFsaWFzKSB3aWxsIGJlIGNyZWF0ZWQgcG9pbnRpbmcgdG8gdGhlIEFQSSBHYXRld2F5IGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIEROUyByZWNvcmQgY3JlYXRlZClcbiAgICAgKi9cbiAgICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEFBQUEgYWxpYXMgcmVjb3JkIGluIGFkZGl0aW9uIHRvIHRoZSBBIGFsaWFzIHJlY29yZC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBgaG9zdGVkWm9uZWAgaXMgcHJvdmlkZWQuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjcmVhdGVBQUFBUmVjb3JkPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyBmb3IgdGhlIEFQSSB1bmRlciB0aGlzIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG1hcHMgdG8gdGhlIHJvb3QpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmFzZVBhdGg/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlIGZvciB0aGUgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IFJFR0lPTkFMXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRUeXBlPzogYXBpZ3cuRW5kcG9pbnRUeXBlO1xuXG4gICAgLyoqXG4gICAgICogU2VjdXJpdHkgcG9saWN5IGZvciB0aGUgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IFRMU18xXzJcbiAgICAgKi9cbiAgICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3LlNlY3VyaXR5UG9saWN5O1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGFkZGluZyBhIExhbWJkYSBpbnRlZ3JhdGlvbiB0byBhIHJvdXRlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIEVuYWJsZSByZXNwb25zZSBzdHJlYW1pbmcgZm9yIHRoaXMgcm91dGUuXG4gICAgICogV2hlbiBlbmFibGVkOlxuICAgICAqIC0gUmVzcG9uc2VUcmFuc2Zlck1vZGUgaXMgc2V0IHRvIFNUUkVBTVxuICAgICAqIC0gVGhlIExhbWJkYSBpbnZvY2F0aW9uIFVSSSB1c2VzIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAtIFRpbWVvdXQgaXMgc2V0IHRvIDE1IG1pbnV0ZXMgKDkwMDAwMG1zKVxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RyZWFtaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBpbnRlZ3JhdGlvbiB0aW1lb3V0LlxuICAgICAqIEZvciBzdHJlYW1pbmcgcm91dGVzLCBkZWZhdWx0cyB0byAxNSBtaW51dGVzLlxuICAgICAqIEZvciBub24tc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMjkgc2Vjb25kcy5cbiAgICAgKi9cbiAgICByZWFkb25seSB0aW1lb3V0PzogRHVyYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBSZXF1ZXN0IHRlbXBsYXRlcyBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAodXNlIExhbWJkYSBwcm94eSBpbnRlZ3JhdGlvbilcbiAgICAgKi9cbiAgICByZWFkb25seSByZXF1ZXN0VGVtcGxhdGVzPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAgIC8qKlxuICAgICAqIFBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciB0aGUgaW50ZWdyYXRpb24uXG4gICAgICogQGRlZmF1bHQgV0hFTl9OT19NQVRDSFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhc3N0aHJvdWdoQmVoYXZpb3I/OiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzIHtcbiAgICAvKipcbiAgICAgKiBOYW1lIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAgICpcbiAgICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhXG4gICAgICogbG9nIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3NcbiAgICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAgICpcbiAgICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEZXNjcmlwdGlvbiBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIHNlbnNpYmxlIGRlZmF1bHRzLFxuICAgICAqIG9yIHByb3ZpZGUgY3VzdG9tIG9wdGlvbnMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBDT1JTKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS4gU2V0IHRvIHRydWVcbiAgICAgKiBmb3IgYW4gQXBwVGhlb3J5LW1hbmFnZWQgV2ViQUNMLCBvciBwcm92aWRlIG9wdGlvbnMgdG8gcmV1c2UgYW4gZXhpc3RpbmdcbiAgICAgKiByZWdpb25hbCBXZWJBQ0wuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGVzIGZvciB0aGUgUkVTVCBBUEkuXG4gICAgICogQGRlZmF1bHQgW1JFR0lPTkFMXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZXM/OiBhcGlndy5FbmRwb2ludFR5cGVbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdGhlIFJFU1QgQVBJIHVzZXMgYmluYXJ5IG1lZGlhIHR5cGVzLlxuICAgICAqIFNwZWNpZnkgbWVkaWEgdHlwZXMgdGhhdCBzaG91bGQgYmUgdHJlYXRlZCBhcyBiaW5hcnkuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmluYXJ5TWVkaWFUeXBlcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBjb21wcmVzc2lvbiBzaXplIGluIGJ5dGVzLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY29tcHJlc3Npb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bUNvbXByZXNzaW9uU2l6ZT86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXBsb3kgb24gY29uc3RydWN0IGNyZWF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXBsb3k/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogUmV0YWluIGRlcGxveW1lbnQgaGlzdG9yeSB3aGVuIGRlcGxveW1lbnRzIGNoYW5nZS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJldGFpbkRlcGxveW1lbnRzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEFQSSBrZXkgc291cmNlIHR5cGUuXG4gICAgICogQGRlZmF1bHQgSEVBREVSXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpS2V5U291cmNlVHlwZT86IGFwaWd3LkFwaUtleVNvdXJjZVR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIEFQSSBHYXRld2F5IGNvbnNvbGUgdGVzdCBpbnZvY2F0aW9ucyBzaG91bGQgYmUgZ3JhbnRlZCBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBzdXBwcmVzc2VzIHRoZSBleHRyYSBgdGVzdC1pbnZva2Utc3RhZ2VgIExhbWJkYSBwZXJtaXNzaW9uc1xuICAgICAqIHRoYXQgQ0RLIGFkZHMgZm9yIGVhY2ggUkVTVCBBUEkgbWV0aG9kLiBUaGlzIHJlZHVjZXMgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIHdoaWxlXG4gICAgICogcHJlc2VydmluZyBkZXBsb3llZC1zdGFnZSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgUkVTVCBBUEkgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgICAqIG9uZSBwZXJtaXNzaW9uIHBlciBtZXRob2QvcGF0aCBwYWlyLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIGZyb250LWNvbnRyb2xsZXJcbiAgICAgKiBBUElzIHRoYXQgcm91dGUgbWFueSBSRVNUIHBhdGhzIHRvIHRoZSBzYW1lIExhbWJkYS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemVyIGFwcGxpZWQgdG8gZXZlcnkgTGFtYmRhIGludGVncmF0aW9uIG1ldGhvZC5cbiAgICAgKlxuICAgICAqIFdoZW4gb21pdHRlZCwgbWV0aG9kcyBrZWVwIEFQSSBHYXRld2F5J3Mgb3BlbiBkZWZhdWx0IChgQXV0aG9yaXphdGlvblR5cGUuTk9ORWApLlxuICAgICAqIENPUlMgcHJlZmxpZ2h0IGBPUFRJT05TYCBtZXRob2RzIHN0YXkgdW5hdXRoZW50aWNhdGVkIHJlZ2FyZGxlc3Mgb2YgdGhpcyBzZXR0aW5nLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBhdXRob3JpemVyKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlndy5JQXV0aG9yaXplcjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIEFQSSBHYXRld2F5IGF1dGhvcml6YXRpb24gdHlwZSBmb3IgdGhlIExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2RzLlxuICAgICAqXG4gICAgICogVXN1YWxseSBvbWl0dGVkOiB3aGVuIGBhdXRob3JpemVyYCBpcyBzZXQsIEFQSSBHYXRld2F5IGRlcml2ZXMgdGhlIHR5cGUgZnJvbSB0aGVcbiAgICAgKiBhdXRob3JpemVyIGl0c2VsZi4gU2V0IHRoaXMgZXhwbGljaXRseSB0byBvdmVycmlkZSB0aGF0IGluZmVyZW5jZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVyaXZlZCBmcm9tIGBhdXRob3JpemVyYCwgb3IgYE5PTkVgIHdoZW4gbm8gYXV0aG9yaXplciBpcyBzZXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBcHBUaGVvcnktbWFuYWdlZCByZWdpb25hbCBXQUYgV2ViQUNMIHdoZW4gZW5hYmxlZCB3aXRob3V0IHdlYkFjbEFybi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMO1xuXG4gICAgLyoqXG4gICAgICogUmVnaW9uYWwgV0FGIGFzc29jaWF0aW9uIGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2FmQXNzb2NpYXRpb24/OiB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEEgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQUFBQSByZWNvcmQgKGlmIGRvbWFpbiwgaG9zdGVkWm9uZSwgYW5kIGNyZWF0ZUFBQUFSZWNvcmQgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzT3B0aW9ucz86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNFbmFibGVkOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IGJvb2xlYW47XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemF0aW9uVHlwZT86IGFwaWd3LkF1dGhvcml6YXRpb25UeXBlO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG4gICAgcHJpdmF0ZSByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMgPSB7fSkge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIC8vIE5vcm1hbGl6ZSBDT1JTIGNvbmZpZ1xuICAgICAgICBpZiAocHJvcHMuY29ycyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0ge307XG4gICAgICAgIH0gZWxzZSBpZiAocHJvcHMuY29ycyAmJiB0eXBlb2YgcHJvcHMuY29ycyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0gcHJvcHMuY29ycztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmFsbG93VGVzdEludm9rZSA9IHByb3BzLmFsbG93VGVzdEludm9rZSA/PyB0cnVlO1xuICAgICAgICB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID0gcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5hdXRob3JpemVyID0gcHJvcHMuYXV0aG9yaXplcjtcbiAgICAgICAgdGhpcy5hdXRob3JpemF0aW9uVHlwZSA9IHByb3BzLmF1dGhvcml6YXRpb25UeXBlO1xuICAgICAgICB0aGlzLm5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICB0aGlzLmxvZ2ljYWxOYW1lID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKHByb3BzLm5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICByZWZ1c2VFeHBsaWNpdE5hbWUocHJvcHMubmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyXCIsIFwiYXBpTmFtZVwiLCBcImFwaV9yZXN0XCIsIHRoaXMubG9naWNhbE5hbWUsIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gdGhpcy5uYW1pbmdDb250ZXh0ICYmIHRoaXMubG9naWNhbE5hbWVcbiAgICAgICAgICAgID8gdGhpcy5uYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV9yZXN0XCIsIHRoaXMubG9naWNhbE5hbWUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcblxuICAgICAgICBjb25zdCBjb25maWd1cmVkU3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgICAgIGNvbnN0IHN0YWdlT3B0cyA9IHRoaXMuZWZmZWN0aXZlU3RhZ2VPcHRpb25zKGNvbmZpZ3VyZWRTdGFnZU9wdHMpO1xuICAgICAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwicHJvZFwiO1xuICAgICAgICBjb25zdCBjb21wcmVzc2lvblByb3BzID1cbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICA6IHsgbWluQ29tcHJlc3Npb25TaXplOiBTaXplLmJ5dGVzKHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUpIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBSRVNUIEFQSVxuICAgICAgICB0aGlzLmFwaSA9IG5ldyBhcGlndy5SZXN0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgICAgIHJlc3RBcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBkZXBsb3k6IHByb3BzLmRlcGxveSA/PyB0cnVlLFxuICAgICAgICAgICAgcmV0YWluRGVwbG95bWVudHM6IHByb3BzLnJldGFpbkRlcGxveW1lbnRzLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlczogcHJvcHMuZW5kcG9pbnRUeXBlcyA/PyBbYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMXSxcbiAgICAgICAgICAgIGJpbmFyeU1lZGlhVHlwZXM6IHByb3BzLmJpbmFyeU1lZGlhVHlwZXMsXG4gICAgICAgICAgICAuLi5jb21wcmVzc2lvblByb3BzLFxuICAgICAgICAgICAgYXBpS2V5U291cmNlVHlwZTogcHJvcHMuYXBpS2V5U291cmNlVHlwZSxcbiAgICAgICAgICAgIGRlcGxveU9wdGlvbnM6IHRoaXMuYnVpbGREZXBsb3lPcHRpb25zKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5zdGFnZSA9IHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZTtcblxuICAgICAgICAvLyBTZXQgdXAgY3VzdG9tIGRvbWFpbiBpZiBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICAgICAgICBjb25zdCB3YWYgPSBjb25maWd1cmVSZXN0QXBpUmVnaW9uYWxXYWYoXG4gICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICB0aGlzLmFwaSxcbiAgICAgICAgICAgICAgICB0aGlzLnN0YWdlLFxuICAgICAgICAgICAgICAgIHByb3BzLndhZixcbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlOYW1lID8/IFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMIH0pLndlYkFjbCA9IHdhZi53ZWJBY2w7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24gfSkud2FmQXNzb2NpYXRpb24gPSB3YWYud2FmQXNzb2NpYXRpb247XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYSBMYW1iZGEgaW50ZWdyYXRpb24gZm9yIHRoZSBzcGVjaWZpZWQgcGF0aCBhbmQgSFRUUCBtZXRob2RzLlxuICAgICAqXG4gICAgICogQHBhcmFtIHBhdGggLSBUaGUgcmVzb3VyY2UgcGF0aCAoZS5nLiwgXCIvc3NlXCIsIFwiL2FwaS9ncmFwaHFsXCIsIFwiL3twcm94eSt9XCIpXG4gICAgICogQHBhcmFtIG1ldGhvZHMgLSBBcnJheSBvZiBIVFRQIG1ldGhvZHMgKGUuZy4sIFtcIkdFVFwiLCBcIlBPU1RcIl0gb3IgW1wiQU5ZXCJdKVxuICAgICAqIEBwYXJhbSBoYW5kbGVyIC0gVGhlIExhbWJkYSBmdW5jdGlvbiB0byBpbnRlZ3JhdGVcbiAgICAgKiBAcGFyYW0gb3B0aW9ucyAtIEludGVncmF0aW9uIG9wdGlvbnMgaW5jbHVkaW5nIHN0cmVhbWluZyBjb25maWd1cmF0aW9uXG4gICAgICovXG4gICAgYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHBhdGg6IHN0cmluZyxcbiAgICAgICAgbWV0aG9kczogc3RyaW5nW10sXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlRm9yUGF0aChwYXRoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbWV0aG9kcykge1xuICAgICAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKG0gPz8gXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAoIW1ldGhvZCkgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0aGUgaW50ZWdyYXRpb25cbiAgICAgICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gdGhpcy5jcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCBvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gQWRkIHRoZSBtZXRob2RcbiAgICAgICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25PcHRpb25zID1cbiAgICAgICAgICAgICAgICB0aGlzLmF1dGhvcml6ZXIgPT09IHVuZGVmaW5lZCAmJiB0aGlzLmF1dGhvcml6YXRpb25UeXBlID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXplciA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplciB9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB7IGF1dGhvcml6YXRpb25UeXBlOiB0aGlzLmF1dGhvcml6YXRpb25UeXBlIH0pLFxuICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkTWV0aG9kID0gcmVzb3VyY2UuYWRkTWV0aG9kKG1ldGhvZCwgaW50ZWdyYXRpb24sIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IHRoaXMuY29yc0VuYWJsZWQgPyB0aGlzLmJ1aWxkTWV0aG9kUmVzcG9uc2VzKCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgLi4uYXV0aG9yaXphdGlvbk9wdGlvbnMsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRm9yIHN0cmVhbWluZyByb3V0ZXMsIGFwcGx5IEwxIG92ZXJyaWRlcyB0byBlbnN1cmUgZnVsbCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5zdHJlYW1pbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKGNyZWF0ZWRNZXRob2QsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nKHRoaXMuc3RhZ2UsIG1ldGhvZCwgcGF0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgT1BUSU9OUyBtZXRob2QgZm9yIENPUlMgaWYgZW5hYmxlZCBhbmQgbm90IGFscmVhZHkgcHJlc2VudFxuICAgICAgICBpZiAodGhpcy5jb3JzRW5hYmxlZCAmJiAhcmVzb3VyY2Uubm9kZS50cnlGaW5kQ2hpbGQoXCJPUFRJT05TXCIpKSB7XG4gICAgICAgICAgICB0aGlzLmFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2UpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG9yIGNyZWF0ZSBhIHJlc291cmNlIGZvciB0aGUgZ2l2ZW4gcGF0aC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHJlc291cmNlRm9yUGF0aChpbnB1dFBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gICAgICAgIGxldCBjdXJyZW50OiBhcGlndy5JUmVzb3VyY2UgPSB0aGlzLmFwaS5yb290O1xuICAgICAgICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoaW5wdXRQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBjdXJyZW50O1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFydCA9IFN0cmluZyhzZWdtZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghcGFydCkgY29udGludWU7XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShwYXJ0KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHBhcnQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIExhbWJkYSBpbnRlZ3JhdGlvbiB3aXRoIHRoZSBhcHByb3ByaWF0ZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHByaXZhdGUgY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24ge1xuICAgICAgICBjb25zdCBzdHJlYW1pbmcgPSBvcHRpb25zLnN0cmVhbWluZyA/PyBmYWxzZTtcblxuICAgICAgICAvLyBGb3Igc3RyZWFtaW5nLCB3ZSB1c2UgU1RSRUFNIHJlc3BvbnNlVHJhbnNmZXJNb2RlXG4gICAgICAgIC8vIE5vdGU6IFRoZSBVUkkgc3VmZml4IGFuZCB0aW1lb3V0IHdpbGwgYmUgZml4ZWQgdmlhIEwxIG92ZXJyaWRlc1xuICAgICAgICByZXR1cm4gbmV3IGFwaWd3LkxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIHtcbiAgICAgICAgICAgIHByb3h5OiB0cnVlLFxuICAgICAgICAgICAgYWxsb3dUZXN0SW52b2tlOiB0aGlzLmFsbG93VGVzdEludm9rZSxcbiAgICAgICAgICAgIHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kLFxuICAgICAgICAgICAgcmVzcG9uc2VUcmFuc2Zlck1vZGU6IHN0cmVhbWluZyA/IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLlNUUkVBTSA6IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLkJVRkZFUkVELFxuICAgICAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0ID8/IChzdHJlYW1pbmcgPyBEdXJhdGlvbi5taW51dGVzKDE1KSA6IHVuZGVmaW5lZCksXG4gICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBvcHRpb25zLnBhc3N0aHJvdWdoQmVoYXZpb3IsXG4gICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiBvcHRpb25zLnJlcXVlc3RUZW1wbGF0ZXMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFwcGx5IEwxIENGTiBvdmVycmlkZXMgZm9yIHN0cmVhbWluZyByb3V0ZXMgdG8gZW5zdXJlIGZ1bGwgTGlmdCBwYXJpdHkuXG4gICAgICpcbiAgICAgKiBTdHJlYW1pbmcgcm91dGVzIHJlcXVpcmU6XG4gICAgICogMS4gSW50ZWdyYXRpb24uUmVzcG9uc2VUcmFuc2Zlck1vZGUgPSBTVFJFQU0gKGFscmVhZHkgc2V0IHZpYSBMMilcbiAgICAgKiAyLiBJbnRlZ3JhdGlvbi5VcmkgZW5kcyB3aXRoIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAzLiBJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXMgPSA5MDAwMDAgKDE1IG1pbnV0ZXMpXG4gICAgICovXG4gICAgcHJpdmF0ZSBhcHBseVN0cmVhbWluZ092ZXJyaWRlcyhcbiAgICAgICAgbWV0aG9kOiBhcGlndy5NZXRob2QsXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNmbk1ldGhvZCA9IG1ldGhvZC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlndy5DZm5NZXRob2Q7XG4gICAgICAgIGlmICghY2ZuTWV0aG9kKSByZXR1cm47XG5cbiAgICAgICAgLy8gQnVpbGQgdGhlIHN0cmVhbWluZyBVUklcbiAgICAgICAgLy8gU3RhbmRhcmQgZm9ybWF0OiBhcm46e3BhcnRpdGlvbn06YXBpZ2F0ZXdheTp7cmVnaW9ufTpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy97ZnVuY3Rpb25Bcm59L3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAgICBjb25zdCB0aW1lb3V0TXMgPSBvcHRpb25zLnRpbWVvdXQ/LnRvTWlsbGlzZWNvbmRzKCkgPz8gOTAwMDAwO1xuXG4gICAgICAgIC8vIE92ZXJyaWRlIHRoZSBpbnRlZ3JhdGlvbiBwcm9wZXJ0aWVzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzXCIsIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgLy8gVGhlIFVSSSBtdXN0IHVzZSB0aGUgc3RyZWFtaW5nLXNwZWNpZmljIHBhdGhcbiAgICAgICAgLy8gV2UgY29uc3RydWN0IGl0IHVzaW5nIEZuOjpKb2luIHRvIHByZXNlcnZlIENsb3VkRm9ybWF0aW9uIGludHJpbnNpY3NcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5VcmlcIiwge1xuICAgICAgICAgICAgXCJGbjo6Sm9pblwiOiBbXG4gICAgICAgICAgICAgICAgXCJcIixcbiAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIFwiYXJuOlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlBhcnRpdGlvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmFwaWdhdGV3YXk6XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UmVnaW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMvXCIsXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIuZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgICAgICAgIFwiL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBdLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBkZXBsb3kgb3B0aW9ucyBmb3IgdGhlIHN0YWdlLlxuICAgICAqL1xuICAgIHByaXZhdGUgZWZmZWN0aXZlU3RhZ2VPcHRpb25zKFxuICAgICAgICBzdGFnZTogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICApOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgaWYgKHRoaXMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHN0YWdlLmFjY2Vzc0xvZ2dpbmcgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gc3RhZ2U7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBidWlsZERlcGxveU9wdGlvbnMoXG4gICAgICAgIHN0YWdlT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgKTogYXBpZ3cuU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgLy8gSGFuZGxlIGFjY2VzcyBsb2dnaW5nXG4gICAgICAgIGxldCBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogYXBpZ3cuSUFjY2Vzc0xvZ0Rlc3RpbmF0aW9uIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgYWNjZXNzTG9nRm9ybWF0ID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdDtcbiAgICAgICAgY29uc3Qgc3RhbmRhcmQgPSB0aGlzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICAgICAgaWYgKHN0YW5kYXJkICYmICF0aGlzLmxvZ2ljYWxOYW1lICYmIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIENyZWF0ZSBhbiBhdXRvLW1hbmFnZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICBjb25zdCBjb250cmFjdE5hbWUgPSB0aGlzLm5hbWluZ0NvbnRleHQgJiYgdGhpcy5sb2dpY2FsTmFtZVxuICAgICAgICAgICAgICAgID8gYWNjZXNzTG9nR3JvdXBOYW1lKHRoaXMubmFtaW5nQ29udGV4dCwgYGxvZ3MvYWNjZXNzL2FwaS8ke3RoaXMubG9naWNhbE5hbWV9YClcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsXG4gICAgICAgICAgICAgICAgc3RhbmRhcmQgJiYgdGhpcy5uYW1pbmdDb250ZXh0ICYmIHRoaXMubG9naWNhbE5hbWVcbiAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBjb250cmFjdE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKHRoaXMubmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiBjb250cmFjdE5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogY29udHJhY3ROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IChzdGFuZGFyZCA/IHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICBjb25zdCBkbW4gPSBuZXcgYXBpZ3cuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICAgICAgICBlbmRwb2ludFR5cGUsXG4gICAgICAgICAgICBzZWN1cml0eVBvbGljeTogZG9tYWluT3B0cy5zZWN1cml0eVBvbGljeSA/PyBhcGlndy5TZWN1cml0eVBvbGljeS5UTFNfMV8yLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBwYXRoIG1hcHBpbmdcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlndy5CYXNlUGF0aE1hcHBpbmcodGhpcywgXCJCYXNlUGF0aE1hcHBpbmdcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgICAgICAgcmVzdEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgICBiYXNlUGF0aDogZG9tYWluT3B0cy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmcgfSkuYmFzZVBhdGhNYXBwaW5nID0gbWFwcGluZztcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkIH0pLmFSZWNvcmQgPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmIChkb21haW5PcHRzLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhYWFhUmVjb3JkID0gbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgKHRoaXMgYXMgeyBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkIH0pLmFhYWFSZWNvcmQgPSBhYWFhUmVjb3JkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgbWV0aG9kIHJlc3BvbnNlcyBmb3IgQ09SUy1lbmFibGVkIGVuZHBvaW50cy5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkTWV0aG9kUmVzcG9uc2VzKCk6IGFwaWd3Lk1ldGhvZFJlc3BvbnNlW10ge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgQ09SUyBwcmVmbGlnaHQgKE9QVElPTlMpIG1ldGhvZCB0byBhIHJlc291cmNlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZTogYXBpZ3cuSVJlc291cmNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSB0aGlzLmNvcnNPcHRpb25zID8/IHt9O1xuICAgICAgICBjb25zdCBhbGxvd09yaWdpbnMgPSBvcHRzLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHMgPSBvcHRzLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiT1BUSU9OU1wiLCBcIlBBVENIXCIsIFwiSEVBRFwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzID0gb3B0cy5hbGxvd0hlYWRlcnMgPz8gW1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICAgIFwiQXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgICAgXCJYLUFtei1EYXRlXCIsXG4gICAgICAgICAgICBcIlgtQXBpLUtleVwiLFxuICAgICAgICAgICAgXCJYLUFtei1TZWN1cml0eS1Ub2tlblwiLFxuICAgICAgICBdO1xuICAgICAgICBjb25zdCBhbGxvd0NyZWRlbnRpYWxzID0gb3B0cy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBtYXhBZ2UgPSBvcHRzLm1heEFnZSA/PyBEdXJhdGlvbi5zZWNvbmRzKDYwMCk7XG5cbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW4gPSBhbGxvd09yaWdpbnMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kc1N0ciA9IGFsbG93TWV0aG9kcy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzU3RyID0gYWxsb3dIZWFkZXJzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIFwiT1BUSU9OU1wiLFxuICAgICAgICAgICAgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IGAnJHthbGxvd0hlYWRlcnNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogYCcke2FsbG93TWV0aG9kc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IGAnJHthbGxvd09yaWdpbn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogYCcke2FsbG93Q3JlZGVudGlhbHN9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogYCcke21heEFnZS50b1NlY29uZHMoKX0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogJ3tcInN0YXR1c0NvZGVcIjogMjAwfScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICAgIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICAgIH1cbiAgICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==