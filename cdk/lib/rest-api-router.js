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
AppTheoryRestApiRouter[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "1.13.1-rc.1" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZDO0FBQzdDLG9EQUFvRDtBQUNwRCwwREFBMEQ7QUFFMUQsNkNBQTZDO0FBQzdDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFDbEUsMkNBQXVDO0FBRXZDLHFFQUFnRjtBQUNoRix5REFBMEQ7QUEwUTFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUztJQXlDakQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUMxQixDQUFDO2FBQU0sSUFBSSxLQUFLLENBQUMsSUFBSSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN0RCxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7UUFDbEMsQ0FBQzthQUFNLENBQUM7WUFDSixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQztRQUM3QixDQUFDO1FBQ0QsSUFBSSxDQUFDLGVBQWUsR0FBRyxLQUFLLENBQUMsZUFBZSxJQUFJLElBQUksQ0FBQztRQUNyRCxJQUFJLENBQUMsdUJBQXVCLEdBQUcsS0FBSyxDQUFDLHVCQUF1QixJQUFJLElBQUksQ0FBQztRQUVyRSxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUs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ZSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBtYXJrUmVzdEFwaVN0YWdlUm91dGVBc1N0cmVhbWluZyB9IGZyb20gXCIuL3ByaXZhdGUvcmVzdC1hcGktc3RyZWFtaW5nXCI7XG5pbXBvcnQgeyB0cmltUmVwZWF0ZWRDaGFyIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuLyoqXG4gKiBDT1JTIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAgICogQGRlZmF1bHQgWycqJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgICAqIEBkZWZhdWx0IFsnR0VUJywgJ1BPU1QnLCAnUFVUJywgJ0RFTEVURScsICdPUFRJT05TJywgJ1BBVENIJywgJ0hFQUQnXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgICAqIEBkZWZhdWx0IFsnQ29udGVudC1UeXBlJywgJ0F1dGhvcml6YXRpb24nLCAnWC1BbXotRGF0ZScsICdYLUFwaS1LZXknLCAnWC1BbXotU2VjdXJpdHktVG9rZW4nXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhbGxvdyBjcmVkZW50aWFscy5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogTWF4IGFnZSBmb3IgcHJlZmxpZ2h0IGNhY2hlIGluIHNlY29uZHMuXG4gICAgICogQGRlZmF1bHQgNjAwXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogU3RhZ2UtbGV2ZWwgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBTdGFnZSBuYW1lLlxuICAgICAqIEBkZWZhdWx0ICdwcm9kJ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIGZvciB0aGUgc3RhZ2UuXG4gICAgICogSWYgdHJ1ZSwgYSBsb2cgZ3JvdXAgd2lsbCBiZSBjcmVhdGVkIGF1dG9tYXRpY2FsbHkuXG4gICAgICogUHJvdmlkZSBhIExvZ0dyb3VwIGZvciBjdXN0b20gbG9nZ2luZyBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGFjY2Vzc0xvZ2dpbmcgaXMgdHJ1ZSAoYm9vbGVhbikuXG4gICAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAgIC8qKlxuICAgICAqIEFjY2VzcyBsb2cgZm9ybWF0LlxuICAgICAqIEBkZWZhdWx0IEFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSAoQ29tbW9uIExvZyBGb3JtYXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRldGFpbGVkIENsb3VkV2F0Y2ggbWV0cmljcyBhdCBtZXRob2QvcmVzb3VyY2UgbGV2ZWwuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXRhaWxlZE1ldHJpY3M/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwiYXBpLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSAobXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIGVkZ2UgZW5kcG9pbnRzLCBzYW1lIHJlZ2lvbiBmb3IgcmVnaW9uYWwpLlxuICAgICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYXV0b21hdGljIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogSWYgcHJvdmlkZWQsIGFuIEEgcmVjb3JkIChhbGlhcykgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBETlMgcmVjb3JkIGNyZWF0ZWQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYGhvc3RlZFpvbmVgIGlzIHByb3ZpZGVkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgZm9yIHRoZSBBUEkgdW5kZXIgdGhpcyBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChtYXBzIHRvIHRoZSByb290KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBSRUdJT05BTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZT86IGFwaWd3LkVuZHBvaW50VHlwZTtcblxuICAgIC8qKlxuICAgICAqIFNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBUTFNfMV8yXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlndy5TZWN1cml0eVBvbGljeTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIERlc2NyaXB0aW9uIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ09SUyBjb25maWd1cmF0aW9uLiBTZXQgdG8gdHJ1ZSBmb3Igc2Vuc2libGUgZGVmYXVsdHMsXG4gICAgICogb3IgcHJvdmlkZSBjdXN0b20gb3B0aW9ucy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIENPUlMpXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjdXN0b20gZG9tYWluKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZXMgZm9yIHRoZSBSRVNUIEFQSS5cbiAgICAgKiBAZGVmYXVsdCBbUkVHSU9OQUxdXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRUeXBlcz86IGFwaWd3LkVuZHBvaW50VHlwZVtdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0aGUgUkVTVCBBUEkgdXNlcyBiaW5hcnkgbWVkaWEgdHlwZXMuXG4gICAgICogU3BlY2lmeSBtZWRpYSB0eXBlcyB0aGF0IHNob3VsZCBiZSB0cmVhdGVkIGFzIGJpbmFyeS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBiaW5hcnlNZWRpYVR5cGVzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBNaW5pbXVtIGNvbXByZXNzaW9uIHNpemUgaW4gYnl0ZXMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjb21wcmVzc2lvbilcbiAgICAgKi9cbiAgICByZWFkb25seSBtaW5pbXVtQ29tcHJlc3Npb25TaXplPzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRlcGxveSBvbiBjb25zdHJ1Y3QgY3JlYXRpb24uXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlcGxveT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBSZXRhaW4gZGVwbG95bWVudCBoaXN0b3J5IHdoZW4gZGVwbG95bWVudHMgY2hhbmdlLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV0YWluRGVwbG95bWVudHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGtleSBzb3VyY2UgdHlwZS5cbiAgICAgKiBAZGVmYXVsdCBIRUFERVJcbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlLZXlTb3VyY2VUeXBlPzogYXBpZ3cuQXBpS2V5U291cmNlVHlwZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgQVBJIEdhdGV3YXkgY29uc29sZSB0ZXN0IGludm9jYXRpb25zIHNob3VsZCBiZSBncmFudGVkIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IHN1cHByZXNzZXMgdGhlIGV4dHJhIGB0ZXN0LWludm9rZS1zdGFnZWAgTGFtYmRhIHBlcm1pc3Npb25zXG4gICAgICogdGhhdCBDREsgYWRkcyBmb3IgZWFjaCBSRVNUIEFQSSBtZXRob2QuIFRoaXMgcmVkdWNlcyBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemUgd2hpbGVcbiAgICAgKiBwcmVzZXJ2aW5nIGRlcGxveWVkLXN0YWdlIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd1Rlc3RJbnZva2U/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBSRVNUIEFQSSBtZXRob2RzLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAgICogb25lIHBlcm1pc3Npb24gcGVyIG1ldGhvZC9wYXRoIHBhaXIuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgZnJvbnQtY29udHJvbGxlclxuICAgICAqIEFQSXMgdGhhdCByb3V0ZSBtYW55IFJFU1QgcGF0aHMgdG8gdGhlIHNhbWUgTGFtYmRhLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEFBQUEgcmVjb3JkIChpZiBkb21haW4sIGhvc3RlZFpvbmUsIGFuZCBjcmVhdGVBQUFBUmVjb3JkIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc09wdGlvbnM/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzRW5hYmxlZDogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IGFsbG93VGVzdEludm9rZTogYm9vbGVhbjtcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiBib29sZWFuO1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyA9IHt9KSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgLy8gTm9ybWFsaXplIENPUlMgY29uZmlnXG4gICAgICAgIGlmIChwcm9wcy5jb3JzID09PSB0cnVlKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSB7fTtcbiAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5jb3JzICYmIHR5cGVvZiBwcm9wcy5jb3JzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSBwcm9wcy5jb3JzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYWxsb3dUZXN0SW52b2tlID0gcHJvcHMuYWxsb3dUZXN0SW52b2tlID8/IHRydWU7XG4gICAgICAgIHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPSBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA/PyB0cnVlO1xuXG4gICAgICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgICAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwicHJvZFwiO1xuICAgICAgICBjb25zdCBjb21wcmVzc2lvblByb3BzID1cbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUgPT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgID8ge31cbiAgICAgICAgICAgICAgICA6IHsgbWluQ29tcHJlc3Npb25TaXplOiBTaXplLmJ5dGVzKHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemUpIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBSRVNUIEFQSVxuICAgICAgICB0aGlzLmFwaSA9IG5ldyBhcGlndy5SZXN0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgICAgIHJlc3RBcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgZGVwbG95OiBwcm9wcy5kZXBsb3kgPz8gdHJ1ZSxcbiAgICAgICAgICAgIHJldGFpbkRlcGxveW1lbnRzOiBwcm9wcy5yZXRhaW5EZXBsb3ltZW50cyxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZXM6IHByb3BzLmVuZHBvaW50VHlwZXMgPz8gW2FwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTF0sXG4gICAgICAgICAgICBiaW5hcnlNZWRpYVR5cGVzOiBwcm9wcy5iaW5hcnlNZWRpYVR5cGVzLFxuICAgICAgICAgICAgLi4uY29tcHJlc3Npb25Qcm9wcyxcbiAgICAgICAgICAgIGFwaUtleVNvdXJjZVR5cGU6IHByb3BzLmFwaUtleVNvdXJjZVR5cGUsXG4gICAgICAgICAgICBkZXBsb3lPcHRpb25zOiB0aGlzLmJ1aWxkRGVwbG95T3B0aW9ucyhzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuc3RhZ2UgPSB0aGlzLmFwaS5kZXBsb3ltZW50U3RhZ2U7XG5cbiAgICAgICAgLy8gU2V0IHVwIGN1c3RvbSBkb21haW4gaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgTGFtYmRhIGludGVncmF0aW9uIGZvciB0aGUgc3BlY2lmaWVkIHBhdGggYW5kIEhUVFAgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXRoIC0gVGhlIHJlc291cmNlIHBhdGggKGUuZy4sIFwiL3NzZVwiLCBcIi9hcGkvZ3JhcGhxbFwiLCBcIi97cHJveHkrfVwiKVxuICAgICAqIEBwYXJhbSBtZXRob2RzIC0gQXJyYXkgb2YgSFRUUCBtZXRob2RzIChlLmcuLCBbXCJHRVRcIiwgXCJQT1NUXCJdIG9yIFtcIkFOWVwiXSlcbiAgICAgKiBAcGFyYW0gaGFuZGxlciAtIFRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gaW50ZWdyYXRlXG4gICAgICogQHBhcmFtIG9wdGlvbnMgLSBJbnRlZ3JhdGlvbiBvcHRpb25zIGluY2x1ZGluZyBzdHJlYW1pbmcgY29uZmlndXJhdGlvblxuICAgICAqL1xuICAgIGFkZExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBwYXRoOiBzdHJpbmcsXG4gICAgICAgIG1ldGhvZHM6IHN0cmluZ1tdLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHJlc291cmNlID0gdGhpcy5yZXNvdXJjZUZvclBhdGgocGF0aCk7XG5cbiAgICAgICAgZm9yIChjb25zdCBtIG9mIG1ldGhvZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhtID8/IFwiXCIpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgaWYgKCFtZXRob2QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAvLyBDcmVhdGUgdGhlIGludGVncmF0aW9uXG4gICAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IHRoaXMuY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwgb3B0aW9ucyk7XG5cbiAgICAgICAgICAgIC8vIEFkZCB0aGUgbWV0aG9kXG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkTWV0aG9kID0gcmVzb3VyY2UuYWRkTWV0aG9kKG1ldGhvZCwgaW50ZWdyYXRpb24sIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IHRoaXMuY29yc0VuYWJsZWQgPyB0aGlzLmJ1aWxkTWV0aG9kUmVzcG9uc2VzKCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRm9yIHN0cmVhbWluZyByb3V0ZXMsIGFwcGx5IEwxIG92ZXJyaWRlcyB0byBlbnN1cmUgZnVsbCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5zdHJlYW1pbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKGNyZWF0ZWRNZXRob2QsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICAgICAgICAgICAgICAgIG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nKHRoaXMuc3RhZ2UsIG1ldGhvZCwgcGF0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgT1BUSU9OUyBtZXRob2QgZm9yIENPUlMgaWYgZW5hYmxlZCBhbmQgbm90IGFscmVhZHkgcHJlc2VudFxuICAgICAgICBpZiAodGhpcy5jb3JzRW5hYmxlZCAmJiAhcmVzb3VyY2Uubm9kZS50cnlGaW5kQ2hpbGQoXCJPUFRJT05TXCIpKSB7XG4gICAgICAgICAgICB0aGlzLmFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2UpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG9yIGNyZWF0ZSBhIHJlc291cmNlIGZvciB0aGUgZ2l2ZW4gcGF0aC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHJlc291cmNlRm9yUGF0aChpbnB1dFBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gICAgICAgIGxldCBjdXJyZW50OiBhcGlndy5JUmVzb3VyY2UgPSB0aGlzLmFwaS5yb290O1xuICAgICAgICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoaW5wdXRQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBjdXJyZW50O1xuXG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFydCA9IFN0cmluZyhzZWdtZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghcGFydCkgY29udGludWU7XG4gICAgICAgICAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShwYXJ0KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHBhcnQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIExhbWJkYSBpbnRlZ3JhdGlvbiB3aXRoIHRoZSBhcHByb3ByaWF0ZSBjb25maWd1cmF0aW9uLlxuICAgICAqL1xuICAgIHByaXZhdGUgY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24ge1xuICAgICAgICBjb25zdCBzdHJlYW1pbmcgPSBvcHRpb25zLnN0cmVhbWluZyA/PyBmYWxzZTtcblxuICAgICAgICAvLyBGb3Igc3RyZWFtaW5nLCB3ZSB1c2UgU1RSRUFNIHJlc3BvbnNlVHJhbnNmZXJNb2RlXG4gICAgICAgIC8vIE5vdGU6IFRoZSBVUkkgc3VmZml4IGFuZCB0aW1lb3V0IHdpbGwgYmUgZml4ZWQgdmlhIEwxIG92ZXJyaWRlc1xuICAgICAgICByZXR1cm4gbmV3IGFwaWd3LkxhbWJkYUludGVncmF0aW9uKGhhbmRsZXIsIHtcbiAgICAgICAgICAgIHByb3h5OiB0cnVlLFxuICAgICAgICAgICAgYWxsb3dUZXN0SW52b2tlOiB0aGlzLmFsbG93VGVzdEludm9rZSxcbiAgICAgICAgICAgIHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiB0aGlzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kLFxuICAgICAgICAgICAgcmVzcG9uc2VUcmFuc2Zlck1vZGU6IHN0cmVhbWluZyA/IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLlNUUkVBTSA6IGFwaWd3LlJlc3BvbnNlVHJhbnNmZXJNb2RlLkJVRkZFUkVELFxuICAgICAgICAgICAgdGltZW91dDogb3B0aW9ucy50aW1lb3V0ID8/IChzdHJlYW1pbmcgPyBEdXJhdGlvbi5taW51dGVzKDE1KSA6IHVuZGVmaW5lZCksXG4gICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBvcHRpb25zLnBhc3N0aHJvdWdoQmVoYXZpb3IsXG4gICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiBvcHRpb25zLnJlcXVlc3RUZW1wbGF0ZXMsXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFwcGx5IEwxIENGTiBvdmVycmlkZXMgZm9yIHN0cmVhbWluZyByb3V0ZXMgdG8gZW5zdXJlIGZ1bGwgTGlmdCBwYXJpdHkuXG4gICAgICpcbiAgICAgKiBTdHJlYW1pbmcgcm91dGVzIHJlcXVpcmU6XG4gICAgICogMS4gSW50ZWdyYXRpb24uUmVzcG9uc2VUcmFuc2Zlck1vZGUgPSBTVFJFQU0gKGFscmVhZHkgc2V0IHZpYSBMMilcbiAgICAgKiAyLiBJbnRlZ3JhdGlvbi5VcmkgZW5kcyB3aXRoIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAzLiBJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXMgPSA5MDAwMDAgKDE1IG1pbnV0ZXMpXG4gICAgICovXG4gICAgcHJpdmF0ZSBhcHBseVN0cmVhbWluZ092ZXJyaWRlcyhcbiAgICAgICAgbWV0aG9kOiBhcGlndy5NZXRob2QsXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMsXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGNmbk1ldGhvZCA9IG1ldGhvZC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlndy5DZm5NZXRob2Q7XG4gICAgICAgIGlmICghY2ZuTWV0aG9kKSByZXR1cm47XG5cbiAgICAgICAgLy8gQnVpbGQgdGhlIHN0cmVhbWluZyBVUklcbiAgICAgICAgLy8gU3RhbmRhcmQgZm9ybWF0OiBhcm46e3BhcnRpdGlvbn06YXBpZ2F0ZXdheTp7cmVnaW9ufTpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy97ZnVuY3Rpb25Bcm59L3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAgICBjb25zdCB0aW1lb3V0TXMgPSBvcHRpb25zLnRpbWVvdXQ/LnRvTWlsbGlzZWNvbmRzKCkgPz8gOTAwMDAwO1xuXG4gICAgICAgIC8vIE92ZXJyaWRlIHRoZSBpbnRlZ3JhdGlvbiBwcm9wZXJ0aWVzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzXCIsIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgLy8gVGhlIFVSSSBtdXN0IHVzZSB0aGUgc3RyZWFtaW5nLXNwZWNpZmljIHBhdGhcbiAgICAgICAgLy8gV2UgY29uc3RydWN0IGl0IHVzaW5nIEZuOjpKb2luIHRvIHByZXNlcnZlIENsb3VkRm9ybWF0aW9uIGludHJpbnNpY3NcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5VcmlcIiwge1xuICAgICAgICAgICAgXCJGbjo6Sm9pblwiOiBbXG4gICAgICAgICAgICAgICAgXCJcIixcbiAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIFwiYXJuOlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlBhcnRpdGlvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmFwaWdhdGV3YXk6XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UmVnaW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMvXCIsXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIuZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgICAgICAgIFwiL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1wiLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBdLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBkZXBsb3kgb3B0aW9ucyBmb3IgdGhlIHN0YWdlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYnVpbGREZXBsb3lPcHRpb25zKFxuICAgICAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMsXG4gICAgICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICAgICk6IGFwaWd3LlN0YWdlT3B0aW9ucyB7XG4gICAgICAgIC8vIEhhbmRsZSBhY2Nlc3MgbG9nZ2luZ1xuICAgICAgICBsZXQgYWNjZXNzTG9nRGVzdGluYXRpb246IGFwaWd3LklBY2Nlc3NMb2dEZXN0aW5hdGlvbiB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Zvcm1hdCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICAgICAgICAvLyBDcmVhdGUgYW4gYXV0by1tYW5hZ2VkIGxvZyBncm91cFxuICAgICAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfSBlbHNlIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyAmJiB0eXBlb2Ygc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIC8vIFVzZSBwcm92aWRlZCBsb2cgZ3JvdXBcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uLFxuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0LFxuICAgICAgICAgICAgbWV0cmljc0VuYWJsZWQ6IHN0YWdlT3B0cy5kZXRhaWxlZE1ldHJpY3MsXG4gICAgICAgICAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU2V0IHVwIGN1c3RvbSBkb21haW4gd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZC5cbiAgICAgKi9cbiAgICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKGRvbWFpbk9wdHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgICAgIC8vIEdldCBvciBjcmVhdGUgdGhlIGNlcnRpZmljYXRlIHJlZmVyZW5jZVxuICAgICAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgICAgICAgID8gKGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZSlcbiAgICAgICAgICAgIDogdW5kZWZpbmVkKTtcblxuICAgICAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlSZXN0QXBpUm91dGVyOiBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkb21haW4gbmFtZVxuICAgICAgICBjb25zdCBlbmRwb2ludFR5cGUgPSBkb21haW5PcHRzLmVuZHBvaW50VHlwZSA/PyBhcGlndy5FbmRwb2ludFR5cGUuUkVHSU9OQUw7XG4gICAgICAgIGNvbnN0IGRtbiA9IG5ldyBhcGlndy5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZSxcbiAgICAgICAgICAgIHNlY3VyaXR5UG9saWN5OiBkb21haW5PcHRzLnNlY3VyaXR5UG9saWN5ID8/IGFwaWd3LlNlY3VyaXR5UG9saWN5LlRMU18xXzIsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlndy5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkbW47XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBiYXNlIHBhdGggbWFwcGluZ1xuICAgICAgICBjb25zdCBtYXBwaW5nID0gbmV3IGFwaWd3LkJhc2VQYXRoTWFwcGluZyh0aGlzLCBcIkJhc2VQYXRoTWFwcGluZ1wiLCB7XG4gICAgICAgICAgICBkb21haW5OYW1lOiBkbW4sXG4gICAgICAgICAgICByZXN0QXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICAgIGJhc2VQYXRoOiBkb21haW5PcHRzLmJhc2VQYXRoLFxuICAgICAgICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2UsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGJhc2VQYXRoTWFwcGluZz86IGFwaWd3LkJhc2VQYXRoTWFwcGluZyB9KS5iYXNlUGF0aE1hcHBpbmcgPSBtYXBwaW5nO1xuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAoZG9tYWluT3B0cy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBjb25zdCByZWNvcmROYW1lID0gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5PcHRzLmRvbWFpbk5hbWUsIGRvbWFpbk9wdHMuaG9zdGVkWm9uZSk7XG4gICAgICAgICAgICBjb25zdCByZWNvcmQgPSBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAodGhpcyBhcyB7IGFSZWNvcmQ/OiByb3V0ZTUzLkFSZWNvcmQgfSkuYVJlY29yZCA9IHJlY29yZDtcblxuICAgICAgICAgICAgaWYgKGRvbWFpbk9wdHMuY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGFhYWFSZWNvcmQgPSBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAodGhpcyBhcyB7IGFhYWFSZWNvcmQ/OiByb3V0ZTUzLkFhYWFSZWNvcmQgfSkuYWFhYVJlY29yZCA9IGFhYWFSZWNvcmQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBtZXRob2QgcmVzcG9uc2VzIGZvciBDT1JTLWVuYWJsZWQgZW5kcG9pbnRzLlxuICAgICAqL1xuICAgIHByaXZhdGUgYnVpbGRNZXRob2RSZXNwb25zZXMoKTogYXBpZ3cuTWV0aG9kUmVzcG9uc2VbXSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFkZCBDT1JTIHByZWZsaWdodCAoT1BUSU9OUykgbWV0aG9kIHRvIGEgcmVzb3VyY2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBhZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlOiBhcGlndy5JUmVzb3VyY2UpOiB2b2lkIHtcbiAgICAgICAgY29uc3Qgb3B0cyA9IHRoaXMuY29yc09wdGlvbnMgPz8ge307XG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2lucyA9IG9wdHMuYWxsb3dPcmlnaW5zID8/IFtcIipcIl07XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kcyA9IG9wdHMuYWxsb3dNZXRob2RzID8/IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJPUFRJT05TXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCJdO1xuICAgICAgICBjb25zdCBhbGxvd0hlYWRlcnMgPSBvcHRzLmFsbG93SGVhZGVycyA/PyBbXG4gICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiLFxuICAgICAgICAgICAgXCJBdXRob3JpemF0aW9uXCIsXG4gICAgICAgICAgICBcIlgtQW16LURhdGVcIixcbiAgICAgICAgICAgIFwiWC1BcGktS2V5XCIsXG4gICAgICAgICAgICBcIlgtQW16LVNlY3VyaXR5LVRva2VuXCIsXG4gICAgICAgIF07XG4gICAgICAgIGNvbnN0IGFsbG93Q3JlZGVudGlhbHMgPSBvcHRzLmFsbG93Q3JlZGVudGlhbHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IG1heEFnZSA9IG9wdHMubWF4QWdlID8/IER1cmF0aW9uLnNlY29uZHMoNjAwKTtcblxuICAgICAgICBjb25zdCBhbGxvd09yaWdpbiA9IGFsbG93T3JpZ2lucy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzU3RyID0gYWxsb3dNZXRob2RzLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd0hlYWRlcnNTdHIgPSBhbGxvd0hlYWRlcnMuam9pbihcIixcIik7XG5cbiAgICAgICAgcmVzb3VyY2UuYWRkTWV0aG9kKFxuICAgICAgICAgICAgXCJPUFRJT05TXCIsXG4gICAgICAgICAgICBuZXcgYXBpZ3cuTW9ja0ludGVncmF0aW9uKHtcbiAgICAgICAgICAgICAgICBpbnRlZ3JhdGlvblJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogYCcke2FsbG93SGVhZGVyc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiBgJyR7YWxsb3dNZXRob2RzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogYCcke2FsbG93T3JpZ2lufSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1DcmVkZW50aWFsc1wiOiBgJyR7YWxsb3dDcmVkZW50aWFsc30nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiBgJyR7bWF4QWdlLnRvU2Vjb25kcygpfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3IuV0hFTl9OT19NQVRDSCxcbiAgICAgICAgICAgICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwiYXBwbGljYXRpb24vanNvblwiOiAne1wic3RhdHVzQ29kZVwiOiAyMDB9JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1DcmVkZW50aWFsc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgIH1cbn1cblxuLyoqXG4gKiBDb252ZXJ0IGEgZG9tYWluIG5hbWUgdG8gYSBSb3V0ZTUzIHJlY29yZCBuYW1lIHJlbGF0aXZlIHRvIHRoZSB6b25lLlxuICovXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gICAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICAgIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gICAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gICAgaWYgKGZxZG4uZW5kc1dpdGgoc3VmZml4KSkge1xuICAgICAgICByZXR1cm4gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCk7XG4gICAgfVxuICAgIHJldHVybiBmcWRuO1xufVxuIl19