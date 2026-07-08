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
AppTheoryRestApiRouter[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "1.17.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZDO0FBQzdDLG9EQUFvRDtBQUNwRCwwREFBMEQ7QUFFMUQsNkNBQTZDO0FBQzdDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFFbEUsMkNBQXVDO0FBRXZDLHlEQUFxRTtBQUNyRSxxRUFBZ0Y7QUFDaEYseURBQTBEO0FBbVIxRDs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7SUFtRGpELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLHdCQUF3QjtRQUN4QixJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7WUFDeEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFDMUIsQ0FBQzthQUFNLElBQUksS0FBSyxDQUFDLElBQUksSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdEQsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7WUFDeEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDO1FBQ2xDLENBQUM7YUFBTSxDQUFDO1lBQ0osSUFBSSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUM7UUFDN0IsQ0FBQztRQUNELElBQUksQ0FBQyxlQUFlLEdBQUcsS0FBSyxDQUFDLGVBQWUsSUFBSSxJQUFJLENBQUM7UUFDckQsSUFBSSxDQUFDLHVCQUF1QixHQUFHLEtBQUssQ0FBQyx1QkFBdUIsSUFBSSxJQUFJLENBQUM7UUFFckUsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtB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Q0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUN4QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNoQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFNpemUgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSBcImF3cy1jZGstbGliL2F3cy13YWZ2MlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgY29uZmlndXJlUmVzdEFwaVJlZ2lvbmFsV2FmIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS13YWZcIjtcbmltcG9ydCB7IG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS1zdHJlYW1pbmdcIjtcbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcblxuLyoqXG4gKiBDT1JTIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAgICogQGRlZmF1bHQgWycqJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgICAqIEBkZWZhdWx0IFsnR0VUJywgJ1BPU1QnLCAnUFVUJywgJ0RFTEVURScsICdPUFRJT05TJywgJ1BBVENIJywgJ0hFQUQnXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgICAqIEBkZWZhdWx0IFsnQ29udGVudC1UeXBlJywgJ0F1dGhvcml6YXRpb24nLCAnWC1BbXotRGF0ZScsICdYLUFwaS1LZXknLCAnWC1BbXotU2VjdXJpdHktVG9rZW4nXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhbGxvdyBjcmVkZW50aWFscy5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogTWF4IGFnZSBmb3IgcHJlZmxpZ2h0IGNhY2hlIGluIHNlY29uZHMuXG4gICAgICogQGRlZmF1bHQgNjAwXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogU3RhZ2UtbGV2ZWwgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBTdGFnZSBuYW1lLlxuICAgICAqIEBkZWZhdWx0ICdwcm9kJ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIGZvciB0aGUgc3RhZ2UuXG4gICAgICogSWYgdHJ1ZSwgYSBsb2cgZ3JvdXAgd2lsbCBiZSBjcmVhdGVkIGF1dG9tYXRpY2FsbHkuXG4gICAgICogUHJvdmlkZSBhIExvZ0dyb3VwIGZvciBjdXN0b20gbG9nZ2luZyBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGFjY2Vzc0xvZ2dpbmcgaXMgdHJ1ZSAoYm9vbGVhbikuXG4gICAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAgIC8qKlxuICAgICAqIEFjY2VzcyBsb2cgZm9ybWF0LlxuICAgICAqIEBkZWZhdWx0IEFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSAoQ29tbW9uIExvZyBGb3JtYXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRldGFpbGVkIENsb3VkV2F0Y2ggbWV0cmljcyBhdCBtZXRob2QvcmVzb3VyY2UgbGV2ZWwuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXRhaWxlZE1ldHJpY3M/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwiYXBpLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSAobXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIGVkZ2UgZW5kcG9pbnRzLCBzYW1lIHJlZ2lvbiBmb3IgcmVnaW9uYWwpLlxuICAgICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYXV0b21hdGljIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogSWYgcHJvdmlkZWQsIGFuIEEgcmVjb3JkIChhbGlhcykgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBETlMgcmVjb3JkIGNyZWF0ZWQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYGhvc3RlZFpvbmVgIGlzIHByb3ZpZGVkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgZm9yIHRoZSBBUEkgdW5kZXIgdGhpcyBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChtYXBzIHRvIHRoZSByb290KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBSRUdJT05BTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZT86IGFwaWd3LkVuZHBvaW50VHlwZTtcblxuICAgIC8qKlxuICAgICAqIFNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBUTFNfMV8yXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlndy5TZWN1cml0eVBvbGljeTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIERlc2NyaXB0aW9uIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ09SUyBjb25maWd1cmF0aW9uLiBTZXQgdG8gdHJ1ZSBmb3Igc2Vuc2libGUgZGVmYXVsdHMsXG4gICAgICogb3IgcHJvdmlkZSBjdXN0b20gb3B0aW9ucy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIENPUlMpXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjdXN0b20gZG9tYWluKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgZm9yIHRoZSBSRVNUIEFQSSBkZXBsb3ltZW50IHN0YWdlLiBTZXQgdG8gdHJ1ZVxuICAgICAqIGZvciBhbiBBcHBUaGVvcnktbWFuYWdlZCBXZWJBQ0wsIG9yIHByb3ZpZGUgb3B0aW9ucyB0byByZXVzZSBhbiBleGlzdGluZ1xuICAgICAqIHJlZ2lvbmFsIFdlYkFDTC5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZXMgZm9yIHRoZSBSRVNUIEFQSS5cbiAgICAgKiBAZGVmYXVsdCBbUkVHSU9OQUxdXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRUeXBlcz86IGFwaWd3LkVuZHBvaW50VHlwZVtdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0aGUgUkVTVCBBUEkgdXNlcyBiaW5hcnkgbWVkaWEgdHlwZXMuXG4gICAgICogU3BlY2lmeSBtZWRpYSB0eXBlcyB0aGF0IHNob3VsZCBiZSB0cmVhdGVkIGFzIGJpbmFyeS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBiaW5hcnlNZWRpYVR5cGVzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBNaW5pbXVtIGNvbXByZXNzaW9uIHNpemUgaW4gYnl0ZXMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjb21wcmVzc2lvbilcbiAgICAgKi9cbiAgICByZWFkb25seSBtaW5pbXVtQ29tcHJlc3Npb25TaXplPzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRlcGxveSBvbiBjb25zdHJ1Y3QgY3JlYXRpb24uXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlcGxveT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBSZXRhaW4gZGVwbG95bWVudCBoaXN0b3J5IHdoZW4gZGVwbG95bWVudHMgY2hhbmdlLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV0YWluRGVwbG95bWVudHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGtleSBzb3VyY2UgdHlwZS5cbiAgICAgKiBAZGVmYXVsdCBIRUFERVJcbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlLZXlTb3VyY2VUeXBlPzogYXBpZ3cuQXBpS2V5U291cmNlVHlwZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgQVBJIEdhdGV3YXkgY29uc29sZSB0ZXN0IGludm9jYXRpb25zIHNob3VsZCBiZSBncmFudGVkIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMuXG4gICAgICpcbiAgICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IHN1cHByZXNzZXMgdGhlIGV4dHJhIGB0ZXN0LWludm9rZS1zdGFnZWAgTGFtYmRhIHBlcm1pc3Npb25zXG4gICAgICogdGhhdCBDREsgYWRkcyBmb3IgZWFjaCBSRVNUIEFQSSBtZXRob2QuIFRoaXMgcmVkdWNlcyBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemUgd2hpbGVcbiAgICAgKiBwcmVzZXJ2aW5nIGRlcGxveWVkLXN0YWdlIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd1Rlc3RJbnZva2U/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBSRVNUIEFQSSBtZXRob2RzLlxuICAgICAqXG4gICAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAgICogb25lIHBlcm1pc3Npb24gcGVyIG1ldGhvZC9wYXRoIHBhaXIuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgZnJvbnQtY29udHJvbGxlclxuICAgICAqIEFQSXMgdGhhdCByb3V0ZSBtYW55IFJFU1QgcGF0aHMgdG8gdGhlIHNhbWUgTGFtYmRhLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBcHBUaGVvcnktbWFuYWdlZCByZWdpb25hbCBXQUYgV2ViQUNMIHdoZW4gZW5hYmxlZCB3aXRob3V0IHdlYkFjbEFybi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMO1xuXG4gICAgLyoqXG4gICAgICogUmVnaW9uYWwgV0FGIGFzc29jaWF0aW9uIGZvciB0aGUgUkVTVCBBUEkgZGVwbG95bWVudCBzdGFnZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgd2FmQXNzb2NpYXRpb24/OiB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEEgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQUFBQSByZWNvcmQgKGlmIGRvbWFpbiwgaG9zdGVkWm9uZSwgYW5kIGNyZWF0ZUFBQUFSZWNvcmQgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzT3B0aW9ucz86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNFbmFibGVkOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlOiBib29sZWFuO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IGJvb2xlYW47XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzID0ge30pIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICAvLyBOb3JtYWxpemUgQ09SUyBjb25maWdcbiAgICAgICAgaWYgKHByb3BzLmNvcnMgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmNvcnMgJiYgdHlwZW9mIHByb3BzLmNvcnMgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5jb3JzT3B0aW9ucyA9IHByb3BzLmNvcnM7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hbGxvd1Rlc3RJbnZva2UgPSBwcm9wcy5hbGxvd1Rlc3RJbnZva2UgPz8gdHJ1ZTtcbiAgICAgICAgdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvTWV0aG9kID8/IHRydWU7XG5cbiAgICAgICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCJwcm9kXCI7XG4gICAgICAgIGNvbnN0IGNvbXByZXNzaW9uUHJvcHMgPVxuICAgICAgICAgICAgcHJvcHMubWluaW11bUNvbXByZXNzaW9uU2l6ZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgPyB7fVxuICAgICAgICAgICAgICAgIDogeyBtaW5Db21wcmVzc2lvblNpemU6IFNpemUuYnl0ZXMocHJvcHMubWluaW11bUNvbXByZXNzaW9uU2l6ZSkgfTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFJFU1QgQVBJXG4gICAgICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3LlJlc3RBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICAgICAgcmVzdEFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICBkZXBsb3k6IHByb3BzLmRlcGxveSA/PyB0cnVlLFxuICAgICAgICAgICAgcmV0YWluRGVwbG95bWVudHM6IHByb3BzLnJldGFpbkRlcGxveW1lbnRzLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlczogcHJvcHMuZW5kcG9pbnRUeXBlcyA/PyBbYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMXSxcbiAgICAgICAgICAgIGJpbmFyeU1lZGlhVHlwZXM6IHByb3BzLmJpbmFyeU1lZGlhVHlwZXMsXG4gICAgICAgICAgICAuLi5jb21wcmVzc2lvblByb3BzLFxuICAgICAgICAgICAgYXBpS2V5U291cmNlVHlwZTogcHJvcHMuYXBpS2V5U291cmNlVHlwZSxcbiAgICAgICAgICAgIGRlcGxveU9wdGlvbnM6IHRoaXMuYnVpbGREZXBsb3lPcHRpb25zKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5zdGFnZSA9IHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZTtcblxuICAgICAgICAvLyBTZXQgdXAgY3VzdG9tIGRvbWFpbiBpZiBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICAgICAgICBjb25zdCB3YWYgPSBjb25maWd1cmVSZXN0QXBpUmVnaW9uYWxXYWYoXG4gICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICB0aGlzLmFwaSxcbiAgICAgICAgICAgICAgICB0aGlzLnN0YWdlLFxuICAgICAgICAgICAgICAgIHByb3BzLndhZixcbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlOYW1lID8/IFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlclwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMIH0pLndlYkFjbCA9IHdhZi53ZWJBY2w7XG4gICAgICAgICAgICAodGhpcyBhcyB7IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24gfSkud2FmQXNzb2NpYXRpb24gPSB3YWYud2FmQXNzb2NpYXRpb247XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYSBMYW1iZGEgaW50ZWdyYXRpb24gZm9yIHRoZSBzcGVjaWZpZWQgcGF0aCBhbmQgSFRUUCBtZXRob2RzLlxuICAgICAqXG4gICAgICogQHBhcmFtIHBhdGggLSBUaGUgcmVzb3VyY2UgcGF0aCAoZS5nLiwgXCIvc3NlXCIsIFwiL2FwaS9ncmFwaHFsXCIsIFwiL3twcm94eSt9XCIpXG4gICAgICogQHBhcmFtIG1ldGhvZHMgLSBBcnJheSBvZiBIVFRQIG1ldGhvZHMgKGUuZy4sIFtcIkdFVFwiLCBcIlBPU1RcIl0gb3IgW1wiQU5ZXCJdKVxuICAgICAqIEBwYXJhbSBoYW5kbGVyIC0gVGhlIExhbWJkYSBmdW5jdGlvbiB0byBpbnRlZ3JhdGVcbiAgICAgKiBAcGFyYW0gb3B0aW9ucyAtIEludGVncmF0aW9uIG9wdGlvbnMgaW5jbHVkaW5nIHN0cmVhbWluZyBjb25maWd1cmF0aW9uXG4gICAgICovXG4gICAgYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHBhdGg6IHN0cmluZyxcbiAgICAgICAgbWV0aG9kczogc3RyaW5nW10sXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlRm9yUGF0aChwYXRoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbWV0aG9kcykge1xuICAgICAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKG0gPz8gXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAoIW1ldGhvZCkgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0aGUgaW50ZWdyYXRpb25cbiAgICAgICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gdGhpcy5jcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCBvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gQWRkIHRoZSBtZXRob2RcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRNZXRob2QgPSByZXNvdXJjZS5hZGRNZXRob2QobWV0aG9kLCBpbnRlZ3JhdGlvbiwge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogdGhpcy5jb3JzRW5hYmxlZCA/IHRoaXMuYnVpbGRNZXRob2RSZXNwb25zZXMoKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBGb3Igc3RyZWFtaW5nIHJvdXRlcywgYXBwbHkgTDEgb3ZlcnJpZGVzIHRvIGVuc3VyZSBmdWxsIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIGlmIChvcHRpb25zLnN0cmVhbWluZykge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoY3JlYXRlZE1ldGhvZCwgaGFuZGxlciwgb3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcodGhpcy5zdGFnZSwgbWV0aG9kLCBwYXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBPUFRJT05TIG1ldGhvZCBmb3IgQ09SUyBpZiBlbmFibGVkIGFuZCBub3QgYWxyZWFkeSBwcmVzZW50XG4gICAgICAgIGlmICh0aGlzLmNvcnNFbmFibGVkICYmICFyZXNvdXJjZS5ub2RlLnRyeUZpbmRDaGlsZChcIk9QVElPTlNcIikpIHtcbiAgICAgICAgICAgIHRoaXMuYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgb3IgY3JlYXRlIGEgcmVzb3VyY2UgZm9yIHRoZSBnaXZlbiBwYXRoLlxuICAgICAqL1xuICAgIHByaXZhdGUgcmVzb3VyY2VGb3JQYXRoKGlucHV0UGF0aDogc3RyaW5nKTogYXBpZ3cuSVJlc291cmNlIHtcbiAgICAgICAgbGV0IGN1cnJlbnQ6IGFwaWd3LklSZXNvdXJjZSA9IHRoaXMuYXBpLnJvb3Q7XG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhpbnB1dFBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gICAgICAgIGlmICghdHJpbW1lZCkgcmV0dXJuIGN1cnJlbnQ7XG5cbiAgICAgICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHRyaW1tZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJ0ID0gU3RyaW5nKHNlZ21lbnQgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgaWYgKCFwYXJ0KSBjb250aW51ZTtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LmdldFJlc291cmNlKHBhcnQpID8/IGN1cnJlbnQuYWRkUmVzb3VyY2UocGFydCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgTGFtYmRhIGludGVncmF0aW9uIHdpdGggdGhlIGFwcHJvcHJpYXRlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcHJpdmF0ZSBjcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbiB7XG4gICAgICAgIGNvbnN0IHN0cmVhbWluZyA9IG9wdGlvbnMuc3RyZWFtaW5nID8/IGZhbHNlO1xuXG4gICAgICAgIC8vIEZvciBzdHJlYW1pbmcsIHdlIHVzZSBTVFJFQU0gcmVzcG9uc2VUcmFuc2Zlck1vZGVcbiAgICAgICAgLy8gTm90ZTogVGhlIFVSSSBzdWZmaXggYW5kIHRpbWVvdXQgd2lsbCBiZSBmaXhlZCB2aWEgTDEgb3ZlcnJpZGVzXG4gICAgICAgIHJldHVybiBuZXcgYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwge1xuICAgICAgICAgICAgcHJveHk6IHRydWUsXG4gICAgICAgICAgICBhbGxvd1Rlc3RJbnZva2U6IHRoaXMuYWxsb3dUZXN0SW52b2tlLFxuICAgICAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QsXG4gICAgICAgICAgICByZXNwb25zZVRyYW5zZmVyTW9kZTogc3RyZWFtaW5nID8gYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuU1RSRUFNIDogYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuQlVGRkVSRUQsXG4gICAgICAgICAgICB0aW1lb3V0OiBvcHRpb25zLnRpbWVvdXQgPz8gKHN0cmVhbWluZyA/IER1cmF0aW9uLm1pbnV0ZXMoMTUpIDogdW5kZWZpbmVkKSxcbiAgICAgICAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IG9wdGlvbnMucGFzc3Rocm91Z2hCZWhhdmlvcixcbiAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IG9wdGlvbnMucmVxdWVzdFRlbXBsYXRlcyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQXBwbHkgTDEgQ0ZOIG92ZXJyaWRlcyBmb3Igc3RyZWFtaW5nIHJvdXRlcyB0byBlbnN1cmUgZnVsbCBMaWZ0IHBhcml0eS5cbiAgICAgKlxuICAgICAqIFN0cmVhbWluZyByb3V0ZXMgcmVxdWlyZTpcbiAgICAgKiAxLiBJbnRlZ3JhdGlvbi5SZXNwb25zZVRyYW5zZmVyTW9kZSA9IFNUUkVBTSAoYWxyZWFkeSBzZXQgdmlhIEwyKVxuICAgICAqIDIuIEludGVncmF0aW9uLlVyaSBlbmRzIHdpdGggL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAqIDMuIEludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpcyA9IDkwMDAwMCAoMTUgbWludXRlcylcbiAgICAgKi9cbiAgICBwcml2YXRlIGFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKFxuICAgICAgICBtZXRob2Q6IGFwaWd3Lk1ldGhvZCxcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgY2ZuTWV0aG9kID0gbWV0aG9kLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3LkNmbk1ldGhvZDtcbiAgICAgICAgaWYgKCFjZm5NZXRob2QpIHJldHVybjtcblxuICAgICAgICAvLyBCdWlsZCB0aGUgc3RyZWFtaW5nIFVSSVxuICAgICAgICAvLyBTdGFuZGFyZCBmb3JtYXQ6IGFybjp7cGFydGl0aW9ufTphcGlnYXRld2F5OntyZWdpb259OmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL3tmdW5jdGlvbkFybn0vcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICAgIGNvbnN0IHRpbWVvdXRNcyA9IG9wdGlvbnMudGltZW91dD8udG9NaWxsaXNlY29uZHMoKSA/PyA5MDAwMDA7XG5cbiAgICAgICAgLy8gT3ZlcnJpZGUgdGhlIGludGVncmF0aW9uIHByb3BlcnRpZXNcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXNcIiwgdGltZW91dE1zKTtcblxuICAgICAgICAvLyBUaGUgVVJJIG11c3QgdXNlIHRoZSBzdHJlYW1pbmctc3BlY2lmaWMgcGF0aFxuICAgICAgICAvLyBXZSBjb25zdHJ1Y3QgaXQgdXNpbmcgRm46OkpvaW4gdG8gcHJlc2VydmUgQ2xvdWRGb3JtYXRpb24gaW50cmluc2ljc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlVyaVwiLCB7XG4gICAgICAgICAgICBcIkZuOjpKb2luXCI6IFtcbiAgICAgICAgICAgICAgICBcIlwiLFxuICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgXCJhcm46XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UGFydGl0aW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6YXBpZ2F0ZXdheTpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpSZWdpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy9cIixcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlci5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgICAgICAgXCIvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXCIsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIGRlcGxveSBvcHRpb25zIGZvciB0aGUgc3RhZ2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZERlcGxveU9wdGlvbnMoXG4gICAgICAgIHN0YWdlT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgKTogYXBpZ3cuU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgLy8gSGFuZGxlIGFjY2VzcyBsb2dnaW5nXG4gICAgICAgIGxldCBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogYXBpZ3cuSUFjY2Vzc0xvZ0Rlc3RpbmF0aW9uIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgYWNjZXNzTG9nRm9ybWF0ID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIENyZWF0ZSBhbiBhdXRvLW1hbmFnZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpO1xuICAgICAgICB9IGVsc2UgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nICYmIHR5cGVvZiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgLy8gVXNlIHByb3ZpZGVkIGxvZyBncm91cFxuICAgICAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmc7XG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbiA9IG5ldyBhcGlndy5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKTtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCA9IGFjY2Vzc0xvZ0Zvcm1hdCA/PyBhcGlndy5BY2Nlc3NMb2dGb3JtYXQuY2xmKCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24sXG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQsXG4gICAgICAgICAgICBtZXRyaWNzRW5hYmxlZDogc3RhZ2VPcHRzLmRldGFpbGVkTWV0cmljcyxcbiAgICAgICAgICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTZXQgdXAgY3VzdG9tIGRvbWFpbiB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkLlxuICAgICAqL1xuICAgIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oZG9tYWluT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMpOiB2b2lkIHtcbiAgICAgICAgLy8gR2V0IG9yIGNyZWF0ZSB0aGUgY2VydGlmaWNhdGUgcmVmZXJlbmNlXG4gICAgICAgIGNvbnN0IGNlcnRpZmljYXRlID0gZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZSA/PyAoZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgICAgICAgPyAoYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQpO1xuXG4gICAgICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVJlc3RBcGlSb3V0ZXI6IGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRvbWFpbiBuYW1lXG4gICAgICAgIGNvbnN0IGVuZHBvaW50VHlwZSA9IGRvbWFpbk9wdHMuZW5kcG9pbnRUeXBlID8/IGFwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTDtcbiAgICAgICAgY29uc3QgZG1uID0gbmV3IGFwaWd3LkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk9wdHMuZG9tYWluTmFtZSxcbiAgICAgICAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlLFxuICAgICAgICAgICAgc2VjdXJpdHlQb2xpY3k6IGRvbWFpbk9wdHMuc2VjdXJpdHlQb2xpY3kgPz8gYXBpZ3cuU2VjdXJpdHlQb2xpY3kuVExTXzFfMixcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRtbjtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGJhc2UgcGF0aCBtYXBwaW5nXG4gICAgICAgIGNvbnN0IG1hcHBpbmcgPSBuZXcgYXBpZ3cuQmFzZVBhdGhNYXBwaW5nKHRoaXMsIFwiQmFzZVBhdGhNYXBwaW5nXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgICAgICAgIHJlc3RBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgICAgYmFzZVBhdGg6IGRvbWFpbk9wdHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nIH0pLmJhc2VQYXRoTWFwcGluZyA9IG1hcHBpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZCB9KS5hUmVjb3JkID0gcmVjb3JkO1xuXG4gICAgICAgICAgICBpZiAoZG9tYWluT3B0cy5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYWFhYVJlY29yZCA9IG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICh0aGlzIGFzIHsgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZCB9KS5hYWFhUmVjb3JkID0gYWFhYVJlY29yZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIG1ldGhvZCByZXNwb25zZXMgZm9yIENPUlMtZW5hYmxlZCBlbmRwb2ludHMuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZE1ldGhvZFJlc3BvbnNlcygpOiBhcGlndy5NZXRob2RSZXNwb25zZVtdIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIENPUlMgcHJlZmxpZ2h0IChPUFRJT05TKSBtZXRob2QgdG8gYSByZXNvdXJjZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2U6IGFwaWd3LklSZXNvdXJjZSk6IHZvaWQge1xuICAgICAgICBjb25zdCBvcHRzID0gdGhpcy5jb3JzT3B0aW9ucyA/PyB7fTtcbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW5zID0gb3B0cy5hbGxvd09yaWdpbnMgPz8gW1wiKlwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzID0gb3B0cy5hbGxvd01ldGhvZHMgPz8gW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIk9QVElPTlNcIiwgXCJQQVRDSFwiLCBcIkhFQURcIl07XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVycyA9IG9wdHMuYWxsb3dIZWFkZXJzID8/IFtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICBcIkF1dGhvcml6YXRpb25cIixcbiAgICAgICAgICAgIFwiWC1BbXotRGF0ZVwiLFxuICAgICAgICAgICAgXCJYLUFwaS1LZXlcIixcbiAgICAgICAgICAgIFwiWC1BbXotU2VjdXJpdHktVG9rZW5cIixcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYWxsb3dDcmVkZW50aWFscyA9IG9wdHMuYWxsb3dDcmVkZW50aWFscyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgbWF4QWdlID0gb3B0cy5tYXhBZ2UgPz8gRHVyYXRpb24uc2Vjb25kcyg2MDApO1xuXG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2luID0gYWxsb3dPcmlnaW5zLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHNTdHIgPSBhbGxvd01ldGhvZHMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVyc1N0ciA9IGFsbG93SGVhZGVycy5qb2luKFwiLFwiKTtcblxuICAgICAgICByZXNvdXJjZS5hZGRNZXRob2QoXG4gICAgICAgICAgICBcIk9QVElPTlNcIixcbiAgICAgICAgICAgIG5ldyBhcGlndy5Nb2NrSW50ZWdyYXRpb24oe1xuICAgICAgICAgICAgICAgIGludGVncmF0aW9uUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiBgJyR7YWxsb3dIZWFkZXJzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IGAnJHthbGxvd01ldGhvZHNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBgJyR7YWxsb3dPcmlnaW59J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IGAnJHthbGxvd0NyZWRlbnRpYWxzfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IGAnJHttYXhBZ2UudG9TZWNvbmRzKCl9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6ICd7XCJzdGF0dXNDb2RlXCI6IDIwMH0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gICAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgICB9XG4gICAgcmV0dXJuIGZxZG47XG59XG4iXX0=