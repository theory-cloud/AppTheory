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
const rest_api_waf_1 = require("./private/rest-api-waf");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "6.4.0-rc" };
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
        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "prod";
        const compressionProps = props.minimumCompressionSize === undefined
            ? {}
            : { minCompressionSize: aws_cdk_lib_1.Size.bytes(props.minimumCompressionSize) };
        // Create the REST API
        this.api = new apigw.RestApi(this, "Api", {
            restApiName: props.apiName,
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
    buildDeployOptions(stageOpts, stageName) {
        // Handle access logging
        let accessLogDestination;
        let accessLogFormat = stageOpts.accessLogFormat;
        if (stageOpts.accessLogging === true) {
            // Create an auto-managed log group
            const logGroup = new logs.LogGroup(this, "AccessLogs", {
                retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
            });
            this.accessLogGroup = logGroup;
            accessLogDestination = new apigw.LogGroupLogDestination(logGroup);
            accessLogFormat = accessLogFormat ?? apigw.AccessLogFormat.clf();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkM7QUFDN0Msa0VBQW9EO0FBQ3BELHdFQUEwRDtBQUUxRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELGdGQUFrRTtBQUVsRSwyQ0FBdUM7QUFFdkMseURBQXFFO0FBQ3JFLHFFQUFnRjtBQUNoRix5REFBMEQ7QUF1UzFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUzs7SUFDakQ7O09BRUc7SUFDYSxHQUFHLENBQWdCO0lBRW5DOztPQUVHO0lBQ2EsS0FBSyxDQUFjO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFvQjtJQUU5Qzs7T0FFRztJQUNhLGVBQWUsQ0FBeUI7SUFFeEQ7O09BRUc7SUFDYSxNQUFNLENBQW1CO0lBRXpDOztPQUVHO0lBQ2EsY0FBYyxDQUE4QjtJQUU1RDs7T0FFRztJQUNhLE9BQU8sQ0FBbUI7SUFFMUM7O09BRUc7SUFDYSxVQUFVLENBQXNCO0lBRWhEOztPQUVHO0lBQ2EsY0FBYyxDQUFrQjtJQUUvQixXQUFXLENBQXFDO0lBQ2hELFdBQVcsQ0FBVTtJQUNyQixlQUFlLENBQVU7SUFDekIsdUJBQXVCLENBQVU7SUFDakMsVUFBVSxDQUFxQjtJQUMvQixpQkFBaUIsQ0FBMkI7SUFFN0QsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEVB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UTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDeEIsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDaEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBTaXplIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgcm91dGU1M3RhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtd2FmdjJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGNvbmZpZ3VyZVJlc3RBcGlSZWdpb25hbFdhZiB9IGZyb20gXCIuL3ByaXZhdGUvcmVzdC1hcGktd2FmXCI7XG5pbXBvcnQgeyBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyB9IGZyb20gXCIuL3ByaXZhdGUvcmVzdC1hcGktc3RyZWFtaW5nXCI7XG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbi8qKlxuICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgICAqIEBkZWZhdWx0IFsnKiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICAgKiBAZGVmYXVsdCBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUycsICdQQVRDSCcsICdIRUFEJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICAgKiBAZGVmYXVsdCBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJywgJ1gtQW16LURhdGUnLCAnWC1BcGktS2V5JywgJ1gtQW16LVNlY3VyaXR5LVRva2VuJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYWxsb3cgY3JlZGVudGlhbHMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE1heCBhZ2UgZm9yIHByZWZsaWdodCBjYWNoZSBpbiBzZWNvbmRzLlxuICAgICAqIEBkZWZhdWx0IDYwMFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIFN0YWdlLWxldmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogU3RhZ2UgbmFtZS5cbiAgICAgKiBAZGVmYXVsdCAncHJvZCdcbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgICAqIElmIHRydWUsIGEgbG9nIGdyb3VwIHdpbGwgYmUgY3JlYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgICAqIFByb3ZpZGUgYSBMb2dHcm91cCBmb3IgY3VzdG9tIGxvZ2dpbmcgY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUgKGJvb2xlYW4pLlxuICAgICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgICAvKipcbiAgICAgKiBBY2Nlc3MgbG9nIGZvcm1hdC5cbiAgICAgKiBAZGVmYXVsdCBBY2Nlc3NMb2dGb3JtYXQuY2xmKCkgKENvbW1vbiBMb2cgRm9ybWF0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXRhaWxlZCBDbG91ZFdhdGNoIG1ldHJpY3MgYXQgbWV0aG9kL3Jlc291cmNlIGxldmVsLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGV0YWlsZWRNZXRyaWNzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChlLmcuLCBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgKG11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBlZGdlIGVuZHBvaW50cywgc2FtZSByZWdpb24gZm9yIHJlZ2lvbmFsKS5cbiAgICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIElmIHByb3ZpZGVkLCBhbiBBIHJlY29yZCAoYWxpYXMpIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGBob3N0ZWRab25lYCBpcyBwcm92aWRlZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIGZvciB0aGUgQVBJIHVuZGVyIHRoaXMgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobWFwcyB0byB0aGUgcm9vdClcbiAgICAgKi9cbiAgICByZWFkb25seSBiYXNlUGF0aD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGUgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgUkVHSU9OQUxcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGU/OiBhcGlndy5FbmRwb2ludFR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBTZWN1cml0eSBwb2xpY3kgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgVExTXzFfMlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3cuU2VjdXJpdHlQb2xpY3k7XG59XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgYWRkaW5nIGEgTGFtYmRhIGludGVncmF0aW9uIHRvIGEgcm91dGUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogRW5hYmxlIHJlc3BvbnNlIHN0cmVhbWluZyBmb3IgdGhpcyByb3V0ZS5cbiAgICAgKiBXaGVuIGVuYWJsZWQ6XG4gICAgICogLSBSZXNwb25zZVRyYW5zZmVyTW9kZSBpcyBzZXQgdG8gU1RSRUFNXG4gICAgICogLSBUaGUgTGFtYmRhIGludm9jYXRpb24gVVJJIHVzZXMgL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAqIC0gVGltZW91dCBpcyBzZXQgdG8gMTUgbWludXRlcyAoOTAwMDAwbXMpXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJlYW1pbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGludGVncmF0aW9uIHRpbWVvdXQuXG4gICAgICogRm9yIHN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDE1IG1pbnV0ZXMuXG4gICAgICogRm9yIG5vbi1zdHJlYW1pbmcgcm91dGVzLCBkZWZhdWx0cyB0byAyOSBzZWNvbmRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRpbWVvdXQ/OiBEdXJhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFJlcXVlc3QgdGVtcGxhdGVzIGZvciB0aGUgaW50ZWdyYXRpb24uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkICh1c2UgTGFtYmRhIHByb3h5IGludGVncmF0aW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlcXVlc3RUZW1wbGF0ZXM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gICAgLyoqXG4gICAgICogUGFzc3Rocm91Z2ggYmVoYXZpb3IgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBXSEVOX05PX01BVENIXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGFzc3Rocm91Z2hCZWhhdmlvcj86IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3I7XG59XG5cbi8qKlxuICogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMge1xuICAgIC8qKlxuICAgICAqIE5hbWUgb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEZXNjcmlwdGlvbiBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIHNlbnNpYmxlIGRlZmF1bHRzLFxuICAgICAqIG9yIHByb3ZpZGUgY3VzdG9tIG9wdGlvbnMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBDT1JTKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS4gU2V0IHRvIHRydWVcbiAgICAgKiBmb3IgYW4gQXBwVGhlb3J5LW1hbmFnZWQgV2ViQUNMLCBvciBwcm92aWRlIG9wdGlvbnMgdG8gcmV1c2UgYW4gZXhpc3RpbmdcbiAgICAgKiByZWdpb25hbCBXZWJBQ0wuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGVzIGZvciB0aGUgUkVTVCBBUEkuXG4gICAgICogQGRlZmF1bHQgW1JFR0lPTkFMXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZXM/OiBhcGlndy5FbmRwb2ludFR5cGVbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdGhlIFJFU1QgQVBJIHVzZXMgYmluYXJ5IG1lZGlhIHR5cGVzLlxuICAgICAqIFNwZWNpZnkgbWVkaWEgdHlwZXMgdGhhdCBzaG91bGQgYmUgdHJlYXRlZCBhcyBiaW5hcnkuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmluYXJ5TWVkaWFUeXBlcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBjb21wcmVzc2lvbiBzaXplIGluIGJ5dGVzLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY29tcHJlc3Npb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bUNvbXByZXNzaW9uU2l6ZT86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXBsb3kgb24gY29uc3RydWN0IGNyZWF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXBsb3k/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogUmV0YWluIGRlcGxveW1lbnQgaGlzdG9yeSB3aGVuIGRlcGxveW1lbnRzIGNoYW5nZS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJldGFpbkRlcGxveW1lbnRzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEFQSSBrZXkgc291cmNlIHR5cGUuXG4gICAgICogQGRlZmF1bHQgSEVBREVSXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpS2V5U291cmNlVHlwZT86IGFwaWd3LkFwaUtleVNvdXJjZVR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIEFQSSBHYXRld2F5IGNvbnNvbGUgdGVzdCBpbnZvY2F0aW9ucyBzaG91bGQgYmUgZ3JhbnRlZCBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBzdXBwcmVzc2VzIHRoZSBleHRyYSBgdGVzdC1pbnZva2Utc3RhZ2VgIExhbWJkYSBwZXJtaXNzaW9uc1xuICAgICAqIHRoYXQgQ0RLIGFkZHMgZm9yIGVhY2ggUkVTVCBBUEkgbWV0aG9kLiBUaGlzIHJlZHVjZXMgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIHdoaWxlXG4gICAgICogcHJlc2VydmluZyBkZXBsb3llZC1zdGFnZSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgUkVTVCBBUEkgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgICAqIG9uZSBwZXJtaXNzaW9uIHBlciBtZXRob2QvcGF0aCBwYWlyLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIGZyb250LWNvbnRyb2xsZXJcbiAgICAgKiBBUElzIHRoYXQgcm91dGUgbWFueSBSRVNUIHBhdGhzIHRvIHRoZSBzYW1lIExhbWJkYS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBBUEkgR2F0ZXdheSBhdXRob3JpemVyIGFwcGxpZWQgdG8gZXZlcnkgTGFtYmRhIGludGVncmF0aW9uIG1ldGhvZC5cbiAgICAgKlxuICAgICAqIFdoZW4gb21pdHRlZCwgbWV0aG9kcyBrZWVwIEFQSSBHYXRld2F5J3Mgb3BlbiBkZWZhdWx0IChgQXV0aG9yaXphdGlvblR5cGUuTk9ORWApLlxuICAgICAqIENPUlMgcHJlZmxpZ2h0IGBPUFRJT05TYCBtZXRob2RzIHN0YXkgdW5hdXRoZW50aWNhdGVkIHJlZ2FyZGxlc3Mgb2YgdGhpcyBzZXR0aW5nLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBhdXRob3JpemVyKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlndy5JQXV0aG9yaXplcjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIEFQSSBHYXRld2F5IGF1dGhvcml6YXRpb24gdHlwZSBmb3IgdGhlIExhbWJkYSBpbnRlZ3JhdGlvbiBtZXRob2RzLlxuICAgICAqXG4gICAgICogVXN1YWxseSBvbWl0dGVkOiB3aGVuIGBhdXRob3JpemVyYCBpcyBzZXQsIEFQSSBHYXRld2F5IGRlcml2ZXMgdGhlIHR5cGUgZnJvbSB0aGVcbiAgICAgKiBhdXRob3JpemVyIGl0c2VsZi4gU2V0IHRoaXMgZXhwbGljaXRseSB0byBvdmVycmlkZSB0aGF0IGluZmVyZW5jZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVyaXZlZCBmcm9tIGBhdXRob3JpemVyYCwgb3IgYE5PTkVgIHdoZW4gbm8gYXV0aG9yaXplciBpcyBzZXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlndy5BdXRob3JpemF0aW9uVHlwZTtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBcHBUaGVvcnktbWFuYWdlZCByZWdpb25hbCBXQUYgV2ViQUNMIHdoZW4gZW5hYmxlZCB3aXRob3V0IHdlYkFjbEFybi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMO1xuXG4gICAgLyoqXG4gICAgICogUmVnaW9uYWwgV0FGIGFzc29jaWF0aW9uIGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2FmQXNzb2NpYXRpb24/OiB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEEgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQUFBQSByZWNvcmQgKGlmIGRvbWFpbiwgaG9zdGVkWm9uZSwgYW5kIGNyZWF0ZUFBQUFSZWNvcmQgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzT3B0aW9ucz86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNFbmFibGVkOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IGJvb2xlYW47XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ3cuSUF1dGhvcml6ZXI7XG4gICAgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpemF0aW9uVHlwZT86IGFwaWd3LkF1dGhvcml6YXRpb25UeXBlO1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyA9IHt9KSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgLy8gTm9ybWFsaXplIENPUlMgY29uZmlnXG4gICAgICAgIGlmIChwcm9wcy5jb3JzID09PSB0cnVlKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSB7fTtcbiAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5jb3JzICYmIHR5cGVvZiBwcm9wcy5jb3JzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSBwcm9wcy5jb3JzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYWxsb3dUZXN0SW52b2tlID0gcHJvcHMuYWxsb3dUZXN0SW52b2tlID8/IHRydWU7XG4gICAgICAgIHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPSBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA/PyB0cnVlO1xuICAgICAgICB0aGlzLmF1dGhvcml6ZXIgPSBwcm9wcy5hdXRob3JpemVyO1xuICAgICAgICB0aGlzLmF1dGhvcml6YXRpb25UeXBlID0gcHJvcHMuYXV0aG9yaXphdGlvblR5cGU7XG5cbiAgICAgICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCJwcm9kXCI7XG4gICAgICAgIGNvbnN0IGNvbXByZXNzaW9uUHJvcHMgPVxuICAgICAgICAgICAgcHJvcHMubWluaW11bUNvbXByZXNzaW9uU2l6ZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgIDogeyBtaW5Db21wcmVzc2lvblNpemU6IFNpemUuYnl0ZXMocHJvcHMubWluaW11bUNvbXByZXNzaW9uU2l6ZSkgfTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFJFU1QgQVBJXG4gICAgICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3LlJlc3RBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICAgICAgcmVzdEFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBkZXBsb3k6IHByb3BzLmRlcGxveSA/PyB0cnVlLFxuICAgICAgICAgICAgcmV0YWluRGVwbG95bWVudHM6IHByb3BzLnJldGFpbkRlcGxveW1lbnRzLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlczogcHJvcHMuZW5kcG9pbnRUeXBlcyA/PyBbYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMXSxcbiAgICAgICAgICAgIGJpbmFyeU1lZGlhVHlwZXM6IHByb3BzLmJpbmFyeU1lZGlhVHlwZXMsXG4gICAgICAgICAgICAuLi5jb21wcmVzc2lvblByb3BzLFxuICAgICAgICAgICAgYXBpS2V5U291cmNlVHlwZTogcHJvcHMuYXBpS2V5U291cmNlVHlwZSxcbiAgICAgICAgICAgIGRlcGxveU9wdGlvbnM6IHRoaXMuYnVpbGREZXBsb3lPcHRpb25zKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5zdGFnZSA9IHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZTtcblxuICAgICAgICAvLyBTZXQgdXAgY3VzdG9tIGRvbWFpbiBpZiBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICAgICAgICBjb25zdCB3YWYgPSBjb25maWd1cmVSZXN0QXBpUmVnaW9uYWxXYWYoXG4gICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICB0aGlzLmFwaSxcbiAgICAgICAgICAgICAgICB0aGlzLnN0YWdlLFxuICAgICAgICAgICAgICAgIHByb3BzLndhZixcbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlOYW1lID8/IFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMIH0pLndlYkFjbCA9IHdhZi53ZWJBY2w7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24gfSkud2FmQXNzb2NpYXRpb24gPSB3YWYud2FmQXNzb2NpYXRpb247XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYSBMYW1iZGEgaW50ZWdyYXRpb24gZm9yIHRoZSBzcGVjaWZpZWQgcGF0aCBhbmQgSFRUUCBtZXRob2RzLlxuICAgICAqXG4gICAgICogQHBhcmFtIHBhdGggLSBUaGUgcmVzb3VyY2UgcGF0aCAoZS5nLiwgXCIvc3NlXCIsIFwiL2FwaS9ncmFwaHFsXCIsIFwiL3twcm94eSt9XCIpXG4gICAgICogQHBhcmFtIG1ldGhvZHMgLSBBcnJheSBvZiBIVFRQIG1ldGhvZHMgKGUuZy4sIFtcIkdFVFwiLCBcIlBPU1RcIl0gb3IgW1wiQU5ZXCJdKVxuICAgICAqIEBwYXJhbSBoYW5kbGVyIC0gVGhlIExhbWJkYSBmdW5jdGlvbiB0byBpbnRlZ3JhdGVcbiAgICAgKiBAcGFyYW0gb3B0aW9ucyAtIEludGVncmF0aW9uIG9wdGlvbnMgaW5jbHVkaW5nIHN0cmVhbWluZyBjb25maWd1cmF0aW9uXG4gICAgICovXG4gICAgYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHBhdGg6IHN0cmluZyxcbiAgICAgICAgbWV0aG9kczogc3RyaW5nW10sXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlRm9yUGF0aChwYXRoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbWV0aG9kcykge1xuICAgICAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKG0gPz8gXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAoIW1ldGhvZCkgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0aGUgaW50ZWdyYXRpb25cbiAgICAgICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gdGhpcy5jcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCBvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gQWRkIHRoZSBtZXRob2RcbiAgICAgICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25PcHRpb25zID1cbiAgICAgICAgICAgICAgICB0aGlzLmF1dGhvcml6ZXIgPT09IHVuZGVmaW5lZCAmJiB0aGlzLmF1dGhvcml6YXRpb25UeXBlID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXplciA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplciB9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHRoaXMuYXV0aG9yaXphdGlvblR5cGUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB7IGF1dGhvcml6YXRpb25UeXBlOiB0aGlzLmF1dGhvcml6YXRpb25UeXBlIH0pLFxuICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkTWV0aG9kID0gcmVzb3VyY2UuYWRkTWV0aG9kKG1ldGhvZCwgaW50ZWdyYXRpb24sIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IHRoaXMuY29yc0VuYWJsZWQgPyB0aGlzLmJ1aWxkTWV0aG9kUmVzcG9uc2VzKCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgLi4uYXV0aG9yaXphdGlvbk9wdGlvbnMsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRm9yIHN0cmVhbWluZyByb3V0ZXMsIGFwcGx5IEwxIG92ZXJyaWRlcyB0byBlbnN1cmUgZnVsbCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5zdHJlYW1pbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKGNyZWF0ZWRNZXRob2QsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nKHRoaXMuc3RhZ2UsIG1ldGhvZCwgcGF0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgT1BUSU9OUyBtZXRob2QgZm9yIENPUlMgaWYgZW5hYmxlZCBhbmQgbm90IGFscmVhZHkgcHJlc2VudFxuICAgICAgICBpZiAodGhpcy5jb3JzRW5hYmxlZCAmJiAhcmVzb3VyY2Uubm9kZS50cnlGaW5kQ2hpbGQoXCJPUFRJT05TXCIpKSB7XG4gICAgICAgICAgICB0aGlzLmFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2UpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG9yIGNyZWF0ZSBhIHJlc291cmNlIGZvciB0aGUgZ2l2ZW4gcGF0aC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHJlc291cmNlRm9yUGF0aChpbnB1dFBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gICAgICAgIGxldCBjdXJyZW50OiBhcGlndy5JUmVzb3VyY2UgPSB0aGlzLmFwaS5yb290O1xuICAgICAgICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoaW5wdXRQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBjdXJyZW50O1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFydCA9IFN0cmluZyhzZWdtZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghcGFydCkgY29udGludWU7XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShwYXJ0KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHBhcnQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIExhbWJkYSBpbnRlZ3JhdGlvbiB3aXRoIHRoZSBhcHByb3ByaWF0ZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHByaXZhdGUgY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24ge1xuICAgICAgICBjb25zdCBzdHJlYW1pbmcgPSBvcHRpb25zLnN0cmVhbWluZyA/PyBmYWxzZTtcblxuICAgICAgICAvLyBGb3Igc3RyZWFtaW5nLCB3ZSB1c2UgU1RSRUFNIHJlc3BvbnNlVHJhbnNmZXJNb2RlXG4gICAgICAgIC8vIE5vdGU6IFRoZSBVUkkgc3VmZml4IGFuZCB0aW1lb3V0IHdpbGwgYmUgZml4ZWQgdmlhIEwxIG92ZXJyaWRlc1xuICAgICAgICByZXR1cm4gbmV3IGFwaWd3LkxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIHtcbiAgICAgICAgICAgIHByb3h5OiB0cnVlLFxuICAgICAgICAgICAgYWxsb3dUZXN0SW52b2tlOiB0aGlzLmFsbG93VGVzdEludm9rZSxcbiAgICAgICAgICAgIHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kLFxuICAgICAgICAgICAgcmVzcG9uc2VUcmFuc2Zlck1vZGU6IHN0cmVhbWluZyA/IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLlNUUkVBTSA6IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLkJVRkZFUkVELFxuICAgICAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0ID8/IChzdHJlYW1pbmcgPyBEdXJhdGlvbi5taW51dGVzKDE1KSA6IHVuZGVmaW5lZCksXG4gICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBvcHRpb25zLnBhc3N0aHJvdWdoQmVoYXZpb3IsXG4gICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiBvcHRpb25zLnJlcXVlc3RUZW1wbGF0ZXMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFwcGx5IEwxIENGTiBvdmVycmlkZXMgZm9yIHN0cmVhbWluZyByb3V0ZXMgdG8gZW5zdXJlIGZ1bGwgTGlmdCBwYXJpdHkuXG4gICAgICpcbiAgICAgKiBTdHJlYW1pbmcgcm91dGVzIHJlcXVpcmU6XG4gICAgICogMS4gSW50ZWdyYXRpb24uUmVzcG9uc2VUcmFuc2Zlck1vZGUgPSBTVFJFQU0gKGFscmVhZHkgc2V0IHZpYSBMMilcbiAgICAgKiAyLiBJbnRlZ3JhdGlvbi5VcmkgZW5kcyB3aXRoIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAzLiBJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXMgPSA5MDAwMDAgKDE1IG1pbnV0ZXMpXG4gICAgICovXG4gICAgcHJpdmF0ZSBhcHBseVN0cmVhbWluZ092ZXJyaWRlcyhcbiAgICAgICAgbWV0aG9kOiBhcGlndy5NZXRob2QsXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNmbk1ldGhvZCA9IG1ldGhvZC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlndy5DZm5NZXRob2Q7XG4gICAgICAgIGlmICghY2ZuTWV0aG9kKSByZXR1cm47XG5cbiAgICAgICAgLy8gQnVpbGQgdGhlIHN0cmVhbWluZyBVUklcbiAgICAgICAgLy8gU3RhbmRhcmQgZm9ybWF0OiBhcm46e3BhcnRpdGlvbn06YXBpZ2F0ZXdheTp7cmVnaW9ufTpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy97ZnVuY3Rpb25Bcm59L3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAgICBjb25zdCB0aW1lb3V0TXMgPSBvcHRpb25zLnRpbWVvdXQ/LnRvTWlsbGlzZWNvbmRzKCkgPz8gOTAwMDAwO1xuXG4gICAgICAgIC8vIE92ZXJyaWRlIHRoZSBpbnRlZ3JhdGlvbiBwcm9wZXJ0aWVzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzXCIsIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgLy8gVGhlIFVSSSBtdXN0IHVzZSB0aGUgc3RyZWFtaW5nLXNwZWNpZmljIHBhdGhcbiAgICAgICAgLy8gV2UgY29uc3RydWN0IGl0IHVzaW5nIEZuOjpKb2luIHRvIHByZXNlcnZlIENsb3VkRm9ybWF0aW9uIGludHJpbnNpY3NcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5VcmlcIiwge1xuICAgICAgICAgICAgXCJGbjo6Sm9pblwiOiBbXG4gICAgICAgICAgICAgICAgXCJcIixcbiAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIFwiYXJuOlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlBhcnRpdGlvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmFwaWdhdGV3YXk6XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UmVnaW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMvXCIsXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIuZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgICAgICAgIFwiL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBdLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBkZXBsb3kgb3B0aW9ucyBmb3IgdGhlIHN0YWdlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYnVpbGREZXBsb3lPcHRpb25zKFxuICAgICAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICAgICk6IGFwaWd3LlN0YWdlT3B0aW9ucyB7XG4gICAgICAgIC8vIEhhbmRsZSBhY2Nlc3MgbG9nZ2luZ1xuICAgICAgICBsZXQgYWNjZXNzTG9nRGVzdGluYXRpb246IGFwaWd3LklBY2Nlc3NMb2dEZXN0aW5hdGlvbiB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Zvcm1hdCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICAgICAgICAvLyBDcmVhdGUgYW4gYXV0by1tYW5hZ2VkIGxvZyBncm91cFxuICAgICAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfSBlbHNlIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyAmJiB0eXBlb2Ygc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIC8vIFVzZSBwcm92aWRlZCBsb2cgZ3JvdXBcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uLFxuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0LFxuICAgICAgICAgICAgbWV0cmljc0VuYWJsZWQ6IHN0YWdlT3B0cy5kZXRhaWxlZE1ldHJpY3MsXG4gICAgICAgICAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU2V0IHVwIGN1c3RvbSBkb21haW4gd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKGRvbWFpbk9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgICAgIC8vIEdldCBvciBjcmVhdGUgdGhlIGNlcnRpZmljYXRlIHJlZmVyZW5jZVxuICAgICAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgICAgICAgID8gKGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZSlcbiAgICAgICAgICAgIDogdW5kZWZpbmVkKTtcblxuICAgICAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyOiBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkb21haW4gbmFtZVxuICAgICAgICBjb25zdCBlbmRwb2ludFR5cGUgPSBkb21haW5PcHRzLmVuZHBvaW50VHlwZSA/PyBhcGlndy5FbmRwb2ludFR5cGUuUkVHSU9OQUw7XG4gICAgICAgIGNvbnN0IGRtbiA9IG5ldyBhcGlndy5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZSxcbiAgICAgICAgICAgIHNlY3VyaXR5UG9saWN5OiBkb21haW5PcHRzLnNlY3VyaXR5UG9saWN5ID8/IGFwaWd3LlNlY3VyaXR5UG9saWN5LlRMU18xXzIsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlndy5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkbW47XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBiYXNlIHBhdGggbWFwcGluZ1xuICAgICAgICBjb25zdCBtYXBwaW5nID0gbmV3IGFwaWd3LkJhc2VQYXRoTWFwcGluZyh0aGlzLCBcIkJhc2VQYXRoTWFwcGluZ1wiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkbW4sXG4gICAgICAgICAgICByZXN0QXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICAgIGJhc2VQYXRoOiBkb21haW5PcHRzLmJhc2VQYXRoLFxuICAgICAgICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2UsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGJhc2VQYXRoTWFwcGluZz86IGFwaWd3LkJhc2VQYXRoTWFwcGluZyB9KS5iYXNlUGF0aE1hcHBpbmcgPSBtYXBwaW5nO1xuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAoZG9tYWluT3B0cy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBjb25zdCByZWNvcmROYW1lID0gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5PcHRzLmRvbWFpbk5hbWUsIGRvbWFpbk9wdHMuaG9zdGVkWm9uZSk7XG4gICAgICAgICAgICBjb25zdCByZWNvcmQgPSBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFSZWNvcmQ/OiByb3V0ZTUzLkFSZWNvcmQgfSkuYVJlY29yZCA9IHJlY29yZDtcblxuICAgICAgICAgICAgaWYgKGRvbWFpbk9wdHMuY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGFhYWFSZWNvcmQgPSBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAodGhpcyBhcyB7IGFhYWFSZWNvcmQ/OiByb3V0ZTUzLkFhYWFSZWNvcmQgfSkuYWFhYVJlY29yZCA9IGFhYWFSZWNvcmQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBtZXRob2QgcmVzcG9uc2VzIGZvciBDT1JTLWVuYWJsZWQgZW5kcG9pbnRzLlxuICAgICAqL1xuICAgIHByaXZhdGUgYnVpbGRNZXRob2RSZXNwb25zZXMoKTogYXBpZ3cuTWV0aG9kUmVzcG9uc2VbXSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFkZCBDT1JTIHByZWZsaWdodCAoT1BUSU9OUykgbWV0aG9kIHRvIGEgcmVzb3VyY2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBhZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlOiBhcGlndy5JUmVzb3VyY2UpOiB2b2lkIHtcbiAgICAgICAgY29uc3Qgb3B0cyA9IHRoaXMuY29yc09wdGlvbnMgPz8ge307XG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2lucyA9IG9wdHMuYWxsb3dPcmlnaW5zID8/IFtcIipcIl07XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kcyA9IG9wdHMuYWxsb3dNZXRob2RzID8/IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJPUFRJT05TXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCJdO1xuICAgICAgICBjb25zdCBhbGxvd0hlYWRlcnMgPSBvcHRzLmFsbG93SGVhZGVycyA/PyBbXG4gICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiLFxuICAgICAgICAgICAgXCJBdXRob3JpemF0aW9uXCIsXG4gICAgICAgICAgICBcIlgtQW16LURhdGVcIixcbiAgICAgICAgICAgIFwiWC1BcGktS2V5XCIsXG4gICAgICAgICAgICBcIlgtQW16LVNlY3VyaXR5LVRva2VuXCIsXG4gICAgICAgIF07XG4gICAgICAgIGNvbnN0IGFsbG93Q3JlZGVudGlhbHMgPSBvcHRzLmFsbG93Q3JlZGVudGlhbHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IG1heEFnZSA9IG9wdHMubWF4QWdlID8/IER1cmF0aW9uLnNlY29uZHMoNjAwKTtcblxuICAgICAgICBjb25zdCBhbGxvd09yaWdpbiA9IGFsbG93T3JpZ2lucy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzU3RyID0gYWxsb3dNZXRob2RzLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd0hlYWRlcnNTdHIgPSBhbGxvd0hlYWRlcnMuam9pbihcIixcIik7XG5cbiAgICAgICAgcmVzb3VyY2UuYWRkTWV0aG9kKFxuICAgICAgICAgICAgXCJPUFRJT05TXCIsXG4gICAgICAgICAgICBuZXcgYXBpZ3cuTW9ja0ludGVncmF0aW9uKHtcbiAgICAgICAgICAgICAgICBpbnRlZ3JhdGlvblJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogYCcke2FsbG93SGVhZGVyc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiBgJyR7YWxsb3dNZXRob2RzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogYCcke2FsbG93T3JpZ2lufSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1DcmVkZW50aWFsc1wiOiBgJyR7YWxsb3dDcmVkZW50aWFsc30nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiBgJyR7bWF4QWdlLnRvU2Vjb25kcygpfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3IuV0hFTl9OT19NQVRDSCxcbiAgICAgICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwiYXBwbGljYXRpb24vanNvblwiOiAne1wic3RhdHVzQ29kZVwiOiAyMDB9JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1DcmVkZW50aWFsc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgIH1cbn1cblxuLyoqXG4gKiBDb252ZXJ0IGEgZG9tYWluIG5hbWUgdG8gYSBSb3V0ZTUzIHJlY29yZCBuYW1lIHJlbGF0aXZlIHRvIHRoZSB6b25lLlxuICovXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gICAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICAgIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gICAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gICAgaWYgKGZxZG4uZW5kc1dpdGgoc3VmZml4KSkge1xuICAgICAgICByZXR1cm4gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCk7XG4gICAgfVxuICAgIHJldHVybiBmcWRuO1xufVxuIl19