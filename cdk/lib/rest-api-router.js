"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryRestApiRouter = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = require("aws-cdk-lib/aws-apigateway");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const logs = require("aws-cdk-lib/aws-logs");
const route53 = require("aws-cdk-lib/aws-route53");
const route53targets = require("aws-cdk-lib/aws-route53-targets");
const constructs_1 = require("constructs");
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
    addLambdaIntegration(path, methods, handler, options = {}) {
        const resource = this.resourceForPath(path);
        for (const m of methods) {
            const method = String(m ?? "").trim().toUpperCase();
            if (!method)
                continue;
            // Create the integration
            const integration = this.createLambdaIntegration(handler, options);
            // Add the method
            const createdMethod = resource.addMethod(method, integration, {
                methodResponses: this.corsEnabled ? this.buildMethodResponses() : undefined,
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryRestApiRouter[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "0.24.6-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLG9EQUFvRDtBQUNwRCwwREFBMEQ7QUFFMUQsNkNBQTZDO0FBQzdDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFDbEUsMkNBQXVDO0FBRXZDLHFFQUFnRjtBQUNoRix5REFBMEQ7QUEwUTFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUztJQXlDakQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUMxQixDQUFDO2FBQU0sSUFBSSxLQUFLLENBQUMsSUFBSSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN0RCxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7UUFDbEMsQ0FBQzthQUFNLENBQUM7WUFDSixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQztRQUM3QixDQUFDO1FBQ0QsSUFBSSxDQUFDLGVBQWUsR0FBRyxLQUFLLENBQUMsZUFBZSxJQUFJLElBQUksQ0FBQztRQUNyRCxJQUFJLENBQUMsdUJBQXVCLEdBQUcsS0FBSyxDQUFDLHVCQUF1QixJQUFJLElBQUksQ0FBQztRQUVyRSxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUs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QXFELEVBQUUsSUFBSTt3QkFDM0QscURBQXFELEVBQUUsSUFBSTt3QkFDM0Qsb0RBQW9ELEVBQUUsSUFBSTt3QkFDMUQseURBQXlELEVBQUUsSUFBSTt3QkFDL0QsK0NBQStDLEVBQUUsSUFBSTtxQkFDeEQ7aUJBQ0o7YUFDSjtTQUNKLENBQ0osQ0FBQztJQUNOLENBQUM7O0FBMVdMLHdEQTJXQzs7O0FBRUQ7O0dBRUc7QUFDSCxTQUFTLG1CQUFtQixDQUFDLFVBQWtCLEVBQUUsSUFBeUI7SUFDdEUsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUN4QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNoQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtYXBpLXN0cmVhbWluZ1wiO1xuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbi8qKlxuICogQ09SUyBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgICAqIEBkZWZhdWx0IFsnKiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICAgKiBAZGVmYXVsdCBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUycsICdQQVRDSCcsICdIRUFEJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICAgKiBAZGVmYXVsdCBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJywgJ1gtQW16LURhdGUnLCAnWC1BcGktS2V5JywgJ1gtQW16LVNlY3VyaXR5LVRva2VuJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYWxsb3cgY3JlZGVudGlhbHMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE1heCBhZ2UgZm9yIHByZWZsaWdodCBjYWNoZSBpbiBzZWNvbmRzLlxuICAgICAqIEBkZWZhdWx0IDYwMFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIFN0YWdlLWxldmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogU3RhZ2UgbmFtZS5cbiAgICAgKiBAZGVmYXVsdCAncHJvZCdcbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgICAqIElmIHRydWUsIGEgbG9nIGdyb3VwIHdpbGwgYmUgY3JlYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgICAqIFByb3ZpZGUgYSBMb2dHcm91cCBmb3IgY3VzdG9tIGxvZ2dpbmcgY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUgKGJvb2xlYW4pLlxuICAgICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgICAvKipcbiAgICAgKiBBY2Nlc3MgbG9nIGZvcm1hdC5cbiAgICAgKiBAZGVmYXVsdCBBY2Nlc3NMb2dGb3JtYXQuY2xmKCkgKENvbW1vbiBMb2cgRm9ybWF0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXRhaWxlZCBDbG91ZFdhdGNoIG1ldHJpY3MgYXQgbWV0aG9kL3Jlc291cmNlIGxldmVsLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGV0YWlsZWRNZXRyaWNzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChlLmcuLCBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgKG11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBlZGdlIGVuZHBvaW50cywgc2FtZSByZWdpb24gZm9yIHJlZ2lvbmFsKS5cbiAgICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIElmIHByb3ZpZGVkLCBhbiBBIHJlY29yZCAoYWxpYXMpIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGBob3N0ZWRab25lYCBpcyBwcm92aWRlZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIGZvciB0aGUgQVBJIHVuZGVyIHRoaXMgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobWFwcyB0byB0aGUgcm9vdClcbiAgICAgKi9cbiAgICByZWFkb25seSBiYXNlUGF0aD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGUgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgUkVHSU9OQUxcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGU/OiBhcGlndy5FbmRwb2ludFR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBTZWN1cml0eSBwb2xpY3kgZm9yIHRoZSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgVExTXzFfMlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3cuU2VjdXJpdHlQb2xpY3k7XG59XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgYWRkaW5nIGEgTGFtYmRhIGludGVncmF0aW9uIHRvIGEgcm91dGUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogRW5hYmxlIHJlc3BvbnNlIHN0cmVhbWluZyBmb3IgdGhpcyByb3V0ZS5cbiAgICAgKiBXaGVuIGVuYWJsZWQ6XG4gICAgICogLSBSZXNwb25zZVRyYW5zZmVyTW9kZSBpcyBzZXQgdG8gU1RSRUFNXG4gICAgICogLSBUaGUgTGFtYmRhIGludm9jYXRpb24gVVJJIHVzZXMgL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAqIC0gVGltZW91dCBpcyBzZXQgdG8gMTUgbWludXRlcyAoOTAwMDAwbXMpXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJlYW1pbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGludGVncmF0aW9uIHRpbWVvdXQuXG4gICAgICogRm9yIHN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDE1IG1pbnV0ZXMuXG4gICAgICogRm9yIG5vbi1zdHJlYW1pbmcgcm91dGVzLCBkZWZhdWx0cyB0byAyOSBzZWNvbmRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRpbWVvdXQ/OiBEdXJhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFJlcXVlc3QgdGVtcGxhdGVzIGZvciB0aGUgaW50ZWdyYXRpb24uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkICh1c2UgTGFtYmRhIHByb3h5IGludGVncmF0aW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlcXVlc3RUZW1wbGF0ZXM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuXG4gICAgLyoqXG4gICAgICogUGFzc3Rocm91Z2ggYmVoYXZpb3IgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCBXSEVOX05PX01BVENIXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGFzc3Rocm91Z2hCZWhhdmlvcj86IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3I7XG59XG5cbi8qKlxuICogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMge1xuICAgIC8qKlxuICAgICAqIE5hbWUgb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEZXNjcmlwdGlvbiBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIHNlbnNpYmxlIGRlZmF1bHRzLFxuICAgICAqIG9yIHByb3ZpZGUgY3VzdG9tIG9wdGlvbnMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBDT1JTKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEVuZHBvaW50IHR5cGVzIGZvciB0aGUgUkVTVCBBUEkuXG4gICAgICogQGRlZmF1bHQgW1JFR0lPTkFMXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZXM/OiBhcGlndy5FbmRwb2ludFR5cGVbXTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdGhlIFJFU1QgQVBJIHVzZXMgYmluYXJ5IG1lZGlhIHR5cGVzLlxuICAgICAqIFNwZWNpZnkgbWVkaWEgdHlwZXMgdGhhdCBzaG91bGQgYmUgdHJlYXRlZCBhcyBiaW5hcnkuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmluYXJ5TWVkaWFUeXBlcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBjb21wcmVzc2lvbiBzaXplIGluIGJ5dGVzLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY29tcHJlc3Npb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bUNvbXByZXNzaW9uU2l6ZT86IG51bWJlcjtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBkZXBsb3kgb24gY29uc3RydWN0IGNyZWF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXBsb3k/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogUmV0YWluIGRlcGxveW1lbnQgaGlzdG9yeSB3aGVuIGRlcGxveW1lbnRzIGNoYW5nZS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJldGFpbkRlcGxveW1lbnRzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEFQSSBrZXkgc291cmNlIHR5cGUuXG4gICAgICogQGRlZmF1bHQgSEVBREVSXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpS2V5U291cmNlVHlwZT86IGFwaWd3LkFwaUtleVNvdXJjZVR5cGU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIEFQSSBHYXRld2F5IGNvbnNvbGUgdGVzdCBpbnZvY2F0aW9ucyBzaG91bGQgYmUgZ3JhbnRlZCBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBzdXBwcmVzc2VzIHRoZSBleHRyYSBgdGVzdC1pbnZva2Utc3RhZ2VgIExhbWJkYSBwZXJtaXNzaW9uc1xuICAgICAqIHRoYXQgQ0RLIGFkZHMgZm9yIGVhY2ggUkVTVCBBUEkgbWV0aG9kLiBUaGlzIHJlZHVjZXMgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIHdoaWxlXG4gICAgICogcHJlc2VydmluZyBkZXBsb3llZC1zdGFnZSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgUkVTVCBBUEkgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgICAqIG9uZSBwZXJtaXNzaW9uIHBlciBtZXRob2QvcGF0aCBwYWlyLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIGZyb250LWNvbnRyb2xsZXJcbiAgICAgKiBBUElzIHRoYXQgcm91dGUgbWFueSBSRVNUIHBhdGhzIHRvIHRoZSBzYW1lIExhbWJkYS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogQSBSRVNUIEFQSSB2MSByb3V0ZXIgdGhhdCBzdXBwb3J0cyBtdWx0aS1MYW1iZGEgcm91dGluZyB3aXRoIGZ1bGwgc3RyZWFtaW5nIHBhcml0eS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBhZGRyZXNzZXMgdGhlIGdhcHMgaW4gQXBwVGhlb3J5UmVzdEFwaSBieSBhbGxvd2luZzpcbiAqIC0gTXVsdGlwbGUgTGFtYmRhIGZ1bmN0aW9ucyBhdHRhY2hlZCB0byBkaWZmZXJlbnQgcm91dGVzXG4gKiAtIENvbXBsZXRlIHJlc3BvbnNlIHN0cmVhbWluZyBpbnRlZ3JhdGlvbiAocmVzcG9uc2VUcmFuc2Zlck1vZGUsIFVSSSBzdWZmaXgsIHRpbWVvdXQpXG4gKiAtIFN0YWdlIGNvbnRyb2xzIChhY2Nlc3MgbG9nZ2luZywgbWV0cmljcywgdGhyb3R0bGluZywgQ09SUylcbiAqIC0gQ3VzdG9tIGRvbWFpbiB3aXJpbmcgd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZFxuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCByb3V0ZXIgPSBuZXcgQXBwVGhlb3J5UmVzdEFwaVJvdXRlcih0aGlzLCAnUm91dGVyJywge1xuICogICBhcGlOYW1lOiAnbXktYXBpJyxcbiAqICAgc3RhZ2U6IHsgc3RhZ2VOYW1lOiAncHJvZCcsIGFjY2Vzc0xvZ2dpbmc6IHRydWUsIGRldGFpbGVkTWV0cmljczogdHJ1ZSB9LFxuICogICBjb3JzOiB0cnVlLFxuICogfSk7XG4gKlxuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvc3NlJywgWydHRVQnXSwgc3NlRm4sIHsgc3RyZWFtaW5nOiB0cnVlIH0pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcvYXBpL2dyYXBocWwnLCBbJ1BPU1QnXSwgZ3JhcGhxbEZuKTtcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL3twcm94eSt9JywgWydBTlknXSwgYXBpRm4pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIHVuZGVybHlpbmcgQVBJIEdhdGV3YXkgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3cuUmVzdEFwaTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkZXBsb3ltZW50IHN0YWdlLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3cuU3RhZ2U7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWU7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQSByZWNvcmQgKGlmIGRvbWFpbiBhbmQgaG9zdGVkWm9uZSBhcmUgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFSZWNvcmQ/OiByb3V0ZTUzLkFSZWNvcmQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBQUFBIHJlY29yZCAoaWYgZG9tYWluLCBob3N0ZWRab25lLCBhbmQgY3JlYXRlQUFBQVJlY29yZCBhcmUgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFhYWFSZWNvcmQ/OiByb3V0ZTUzLkFhYWFSZWNvcmQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYWNjZXNzIGxvZyBncm91cCAoaWYgYWNjZXNzIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNPcHRpb25zPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc0VuYWJsZWQ6IGJvb2xlYW47XG4gICAgcHJpdmF0ZSByZWFkb25seSBhbGxvd1Rlc3RJbnZva2U6IGJvb2xlYW47XG4gICAgcHJpdmF0ZSByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogYm9vbGVhbjtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMgPSB7fSkge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIC8vIE5vcm1hbGl6ZSBDT1JTIGNvbmZpZ1xuICAgICAgICBpZiAocHJvcHMuY29ycyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0ge307XG4gICAgICAgIH0gZWxzZSBpZiAocHJvcHMuY29ycyAmJiB0eXBlb2YgcHJvcHMuY29ycyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0gcHJvcHMuY29ycztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmFsbG93VGVzdEludm9rZSA9IHByb3BzLmFsbG93VGVzdEludm9rZSA/PyB0cnVlO1xuICAgICAgICB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID0gcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPz8gdHJ1ZTtcblxuICAgICAgICBjb25zdCBzdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICAgICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcInByb2RcIjtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFJFU1QgQVBJXG4gICAgICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3LlJlc3RBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICAgICAgcmVzdEFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBkZXBsb3k6IHByb3BzLmRlcGxveSA/PyB0cnVlLFxuICAgICAgICAgICAgcmV0YWluRGVwbG95bWVudHM6IHByb3BzLnJldGFpbkRlcGxveW1lbnRzLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlczogcHJvcHMuZW5kcG9pbnRUeXBlcyA/PyBbYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMXSxcbiAgICAgICAgICAgIGJpbmFyeU1lZGlhVHlwZXM6IHByb3BzLmJpbmFyeU1lZGlhVHlwZXMsXG4gICAgICAgICAgICBtaW5pbXVtQ29tcHJlc3Npb25TaXplOiBwcm9wcy5taW5pbXVtQ29tcHJlc3Npb25TaXplPy52YWx1ZU9mKCksXG4gICAgICAgICAgICBhcGlLZXlTb3VyY2VUeXBlOiBwcm9wcy5hcGlLZXlTb3VyY2VUeXBlLFxuICAgICAgICAgICAgZGVwbG95T3B0aW9uczogdGhpcy5idWlsZERlcGxveU9wdGlvbnMoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpLFxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLnN0YWdlID0gdGhpcy5hcGkuZGVwbG95bWVudFN0YWdlO1xuXG4gICAgICAgIC8vIFNldCB1cCBjdXN0b20gZG9tYWluIGlmIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ocHJvcHMuZG9tYWluKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFkZCBhIExhbWJkYSBpbnRlZ3JhdGlvbiBmb3IgdGhlIHNwZWNpZmllZCBwYXRoIGFuZCBIVFRQIG1ldGhvZHMuXG4gICAgICpcbiAgICAgKiBAcGFyYW0gcGF0aCAtIFRoZSByZXNvdXJjZSBwYXRoIChlLmcuLCBcIi9zc2VcIiwgXCIvYXBpL2dyYXBocWxcIiwgXCIve3Byb3h5K31cIilcbiAgICAgKiBAcGFyYW0gbWV0aG9kcyAtIEFycmF5IG9mIEhUVFAgbWV0aG9kcyAoZS5nLiwgW1wiR0VUXCIsIFwiUE9TVFwiXSBvciBbXCJBTllcIl0pXG4gICAgICogQHBhcmFtIGhhbmRsZXIgLSBUaGUgTGFtYmRhIGZ1bmN0aW9uIHRvIGludGVncmF0ZVxuICAgICAqIEBwYXJhbSBvcHRpb25zIC0gSW50ZWdyYXRpb24gb3B0aW9ucyBpbmNsdWRpbmcgc3RyZWFtaW5nIGNvbmZpZ3VyYXRpb25cbiAgICAgKi9cbiAgICBhZGRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgcGF0aDogc3RyaW5nLFxuICAgICAgICBtZXRob2RzOiBzdHJpbmdbXSxcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyA9IHt9LFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCByZXNvdXJjZSA9IHRoaXMucmVzb3VyY2VGb3JQYXRoKHBhdGgpO1xuXG4gICAgICAgIGZvciAoY29uc3QgbSBvZiBtZXRob2RzKSB7XG4gICAgICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcobSA/PyBcIlwiKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgICAgIGlmICghbWV0aG9kKSBjb250aW51ZTtcblxuICAgICAgICAgICAgLy8gQ3JlYXRlIHRoZSBpbnRlZ3JhdGlvblxuICAgICAgICAgICAgY29uc3QgaW50ZWdyYXRpb24gPSB0aGlzLmNyZWF0ZUxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIG9wdGlvbnMpO1xuXG4gICAgICAgICAgICAvLyBBZGQgdGhlIG1ldGhvZFxuICAgICAgICAgICAgY29uc3QgY3JlYXRlZE1ldGhvZCA9IHJlc291cmNlLmFkZE1ldGhvZChtZXRob2QsIGludGVncmF0aW9uLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiB0aGlzLmNvcnNFbmFibGVkID8gdGhpcy5idWlsZE1ldGhvZFJlc3BvbnNlcygpIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIEZvciBzdHJlYW1pbmcgcm91dGVzLCBhcHBseSBMMSBvdmVycmlkZXMgdG8gZW5zdXJlIGZ1bGwgY29tcGF0aWJpbGl0eVxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuc3RyZWFtaW5nKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHBseVN0cmVhbWluZ092ZXJyaWRlcyhjcmVhdGVkTWV0aG9kLCBoYW5kbGVyLCBvcHRpb25zKTtcbiAgICAgICAgICAgICAgICBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyh0aGlzLnN0YWdlLCBtZXRob2QsIHBhdGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIE9QVElPTlMgbWV0aG9kIGZvciBDT1JTIGlmIGVuYWJsZWQgYW5kIG5vdCBhbHJlYWR5IHByZXNlbnRcbiAgICAgICAgaWYgKHRoaXMuY29yc0VuYWJsZWQgJiYgIXJlc291cmNlLm5vZGUudHJ5RmluZENoaWxkKFwiT1BUSU9OU1wiKSkge1xuICAgICAgICAgICAgdGhpcy5hZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBvciBjcmVhdGUgYSByZXNvdXJjZSBmb3IgdGhlIGdpdmVuIHBhdGguXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNvdXJjZUZvclBhdGgoaW5wdXRQYXRoOiBzdHJpbmcpOiBhcGlndy5JUmVzb3VyY2Uge1xuICAgICAgICBsZXQgY3VycmVudDogYXBpZ3cuSVJlc291cmNlID0gdGhpcy5hcGkucm9vdDtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKGlucHV0UGF0aCA/PyBcIlwiKS50cmltKCksIFwiL1wiKTtcbiAgICAgICAgaWYgKCF0cmltbWVkKSByZXR1cm4gY3VycmVudDtcblxuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSBTdHJpbmcoc2VnbWVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIXBhcnQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2UocGFydCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShwYXJ0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBMYW1iZGEgaW50ZWdyYXRpb24gd2l0aCB0aGUgYXBwcm9wcmlhdGUgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICBwcml2YXRlIGNyZWF0ZUxhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IGFwaWd3LkxhbWJkYUludGVncmF0aW9uIHtcbiAgICAgICAgY29uc3Qgc3RyZWFtaW5nID0gb3B0aW9ucy5zdHJlYW1pbmcgPz8gZmFsc2U7XG5cbiAgICAgICAgLy8gRm9yIHN0cmVhbWluZywgd2UgdXNlIFNUUkVBTSByZXNwb25zZVRyYW5zZmVyTW9kZVxuICAgICAgICAvLyBOb3RlOiBUaGUgVVJJIHN1ZmZpeCBhbmQgdGltZW91dCB3aWxsIGJlIGZpeGVkIHZpYSBMMSBvdmVycmlkZXNcbiAgICAgICAgcmV0dXJuIG5ldyBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCB7XG4gICAgICAgICAgICBwcm94eTogdHJ1ZSxcbiAgICAgICAgICAgIGFsbG93VGVzdEludm9rZTogdGhpcy5hbGxvd1Rlc3RJbnZva2UsXG4gICAgICAgICAgICBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCxcbiAgICAgICAgICAgIHJlc3BvbnNlVHJhbnNmZXJNb2RlOiBzdHJlYW1pbmcgPyBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5TVFJFQU0gOiBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5CVUZGRVJFRCxcbiAgICAgICAgICAgIHRpbWVvdXQ6IG9wdGlvbnMudGltZW91dCA/PyAoc3RyZWFtaW5nID8gRHVyYXRpb24ubWludXRlcygxNSkgOiB1bmRlZmluZWQpLFxuICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogb3B0aW9ucy5wYXNzdGhyb3VnaEJlaGF2aW9yLFxuICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczogb3B0aW9ucy5yZXF1ZXN0VGVtcGxhdGVzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBcHBseSBMMSBDRk4gb3ZlcnJpZGVzIGZvciBzdHJlYW1pbmcgcm91dGVzIHRvIGVuc3VyZSBmdWxsIExpZnQgcGFyaXR5LlxuICAgICAqXG4gICAgICogU3RyZWFtaW5nIHJvdXRlcyByZXF1aXJlOlxuICAgICAqIDEuIEludGVncmF0aW9uLlJlc3BvbnNlVHJhbnNmZXJNb2RlID0gU1RSRUFNIChhbHJlYWR5IHNldCB2aWEgTDIpXG4gICAgICogMi4gSW50ZWdyYXRpb24uVXJpIGVuZHMgd2l0aCAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogMy4gSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzID0gOTAwMDAwICgxNSBtaW51dGVzKVxuICAgICAqL1xuICAgIHByaXZhdGUgYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoXG4gICAgICAgIG1ldGhvZDogYXBpZ3cuTWV0aG9kLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCBjZm5NZXRob2QgPSBtZXRob2Qubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3cuQ2ZuTWV0aG9kO1xuICAgICAgICBpZiAoIWNmbk1ldGhvZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBzdHJlYW1pbmcgVVJJXG4gICAgICAgIC8vIFN0YW5kYXJkIGZvcm1hdDogYXJuOntwYXJ0aXRpb259OmFwaWdhdGV3YXk6e3JlZ2lvbn06bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMve2Z1bmN0aW9uQXJufS9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgICAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0Py50b01pbGxpc2Vjb25kcygpID8/IDkwMDAwMDtcblxuICAgICAgICAvLyBPdmVycmlkZSB0aGUgaW50ZWdyYXRpb24gcHJvcGVydGllc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpc1wiLCB0aW1lb3V0TXMpO1xuXG4gICAgICAgIC8vIFRoZSBVUkkgbXVzdCB1c2UgdGhlIHN0cmVhbWluZy1zcGVjaWZpYyBwYXRoXG4gICAgICAgIC8vIFdlIGNvbnN0cnVjdCBpdCB1c2luZyBGbjo6Sm9pbiB0byBwcmVzZXJ2ZSBDbG91ZEZvcm1hdGlvbiBpbnRyaW5zaWNzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVXJpXCIsIHtcbiAgICAgICAgICAgIFwiRm46OkpvaW5cIjogW1xuICAgICAgICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICBcImFybjpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpQYXJ0aXRpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjphcGlnYXRld2F5OlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlJlZ2lvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL1wiLFxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICAgICAgICBcIi9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgZGVwbG95IG9wdGlvbnMgZm9yIHRoZSBzdGFnZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkRGVwbG95T3B0aW9ucyhcbiAgICAgICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zLFxuICAgICAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICApOiBhcGlndy5TdGFnZU9wdGlvbnMge1xuICAgICAgICAvLyBIYW5kbGUgYWNjZXNzIGxvZ2dpbmdcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBhcGlndy5JQWNjZXNzTG9nRGVzdGluYXRpb24gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBhY2Nlc3NMb2dGb3JtYXQgPSBzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgLy8gQ3JlYXRlIGFuIGF1dG8tbWFuYWdlZCBsb2cgZ3JvdXBcbiAgICAgICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbiA9IG5ldyBhcGlndy5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGxvZ0dyb3VwKTtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCA9IGFjY2Vzc0xvZ0Zvcm1hdCA/PyBhcGlndy5BY2Nlc3NMb2dGb3JtYXQuY2xmKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICBjb25zdCBkbW4gPSBuZXcgYXBpZ3cuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICAgICAgICBlbmRwb2ludFR5cGUsXG4gICAgICAgICAgICBzZWN1cml0eVBvbGljeTogZG9tYWluT3B0cy5zZWN1cml0eVBvbGljeSA/PyBhcGlndy5TZWN1cml0eVBvbGljeS5UTFNfMV8yLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBwYXRoIG1hcHBpbmdcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlndy5CYXNlUGF0aE1hcHBpbmcodGhpcywgXCJCYXNlUGF0aE1hcHBpbmdcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgICAgICAgcmVzdEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgICBiYXNlUGF0aDogZG9tYWluT3B0cy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmcgfSkuYmFzZVBhdGhNYXBwaW5nID0gbWFwcGluZztcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkIH0pLmFSZWNvcmQgPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmIChkb21haW5PcHRzLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhYWFhUmVjb3JkID0gbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgKHRoaXMgYXMgeyBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkIH0pLmFhYWFSZWNvcmQgPSBhYWFhUmVjb3JkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgbWV0aG9kIHJlc3BvbnNlcyBmb3IgQ09SUy1lbmFibGVkIGVuZHBvaW50cy5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkTWV0aG9kUmVzcG9uc2VzKCk6IGFwaWd3Lk1ldGhvZFJlc3BvbnNlW10ge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgQ09SUyBwcmVmbGlnaHQgKE9QVElPTlMpIG1ldGhvZCB0byBhIHJlc291cmNlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZTogYXBpZ3cuSVJlc291cmNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSB0aGlzLmNvcnNPcHRpb25zID8/IHt9O1xuICAgICAgICBjb25zdCBhbGxvd09yaWdpbnMgPSBvcHRzLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHMgPSBvcHRzLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiT1BUSU9OU1wiLCBcIlBBVENIXCIsIFwiSEVBRFwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzID0gb3B0cy5hbGxvd0hlYWRlcnMgPz8gW1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICAgIFwiQXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgICAgXCJYLUFtei1EYXRlXCIsXG4gICAgICAgICAgICBcIlgtQXBpLUtleVwiLFxuICAgICAgICAgICAgXCJYLUFtei1TZWN1cml0eS1Ub2tlblwiLFxuICAgICAgICBdO1xuICAgICAgICBjb25zdCBhbGxvd0NyZWRlbnRpYWxzID0gb3B0cy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBtYXhBZ2UgPSBvcHRzLm1heEFnZSA/PyBEdXJhdGlvbi5zZWNvbmRzKDYwMCk7XG5cbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW4gPSBhbGxvd09yaWdpbnMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kc1N0ciA9IGFsbG93TWV0aG9kcy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzU3RyID0gYWxsb3dIZWFkZXJzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIFwiT1BUSU9OU1wiLFxuICAgICAgICAgICAgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IGAnJHthbGxvd0hlYWRlcnNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogYCcke2FsbG93TWV0aG9kc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IGAnJHthbGxvd09yaWdpbn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogYCcke2FsbG93Q3JlZGVudGlhbHN9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogYCcke21heEFnZS50b1NlY29uZHMoKX0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogJ3tcInN0YXR1c0NvZGVcIjogMjAwfScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICAgIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICAgIH1cbiAgICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==