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
        const trimmed = String(inputPath ?? "")
            .trim()
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
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
AppTheoryRestApiRouter[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "0.7.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLG9EQUFvRDtBQUNwRCwwREFBMEQ7QUFFMUQsNkNBQTZDO0FBQzdDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFDbEUsMkNBQXVDO0FBb1B2Qzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7SUF1Q2pELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBcUMsRUFBRTtRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLHdCQUF3QjtRQUN4QixJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7WUFDeEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFDMUIsQ0FBQzthQUFNLElBQUksS0FBSyxDQUFDLElBQUksSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDdEQsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7WUFDeEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDO1FBQ2xDLENBQUM7YUFBTSxDQUFDO1lBQ0osSUFBSSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUM7UUFDN0IsQ0FBQztRQUVELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLElBQUksTUFBTSxDQUFDO1FBRWhELHNCQUFzQjtRQUN0QixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lB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QUcsTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUN4QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3pDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNoQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuLyoqXG4gKiBDT1JTIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckNvcnNPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAgICogQGRlZmF1bHQgWycqJ11cbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgICAqIEBkZWZhdWx0IFsnR0VUJywgJ1BPU1QnLCAnUFVUJywgJ0RFTEVURScsICdPUFRJT05TJywgJ1BBVENIJywgJ0hFQUQnXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgICAqIEBkZWZhdWx0IFsnQ29udGVudC1UeXBlJywgJ0F1dGhvcml6YXRpb24nLCAnWC1BbXotRGF0ZScsICdYLUFwaS1LZXknLCAnWC1BbXotU2VjdXJpdHktVG9rZW4nXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhbGxvdyBjcmVkZW50aWFscy5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogTWF4IGFnZSBmb3IgcHJlZmxpZ2h0IGNhY2hlIGluIHNlY29uZHMuXG4gICAgICogQGRlZmF1bHQgNjAwXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogU3RhZ2UtbGV2ZWwgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBTdGFnZSBuYW1lLlxuICAgICAqIEBkZWZhdWx0ICdwcm9kJ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIGZvciB0aGUgc3RhZ2UuXG4gICAgICogSWYgdHJ1ZSwgYSBsb2cgZ3JvdXAgd2lsbCBiZSBjcmVhdGVkIGF1dG9tYXRpY2FsbHkuXG4gICAgICogUHJvdmlkZSBhIExvZ0dyb3VwIGZvciBjdXN0b20gbG9nZ2luZyBjb25maWd1cmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIGFjY2Vzc0xvZ2dpbmcgaXMgdHJ1ZSAoYm9vbGVhbikuXG4gICAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAgIC8qKlxuICAgICAqIEFjY2VzcyBsb2cgZm9ybWF0LlxuICAgICAqIEBkZWZhdWx0IEFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKSAoQ29tbW9uIExvZyBGb3JtYXQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRldGFpbGVkIENsb3VkV2F0Y2ggbWV0cmljcyBhdCBtZXRob2QvcmVzb3VyY2UgbGV2ZWwuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBkZXRhaWxlZE1ldHJpY3M/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICAgKi9cbiAgICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBSRVNUIEFQSSByb3V0ZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwiYXBpLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSAobXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIGVkZ2UgZW5kcG9pbnRzLCBzYW1lIHJlZ2lvbiBmb3IgcmVnaW9uYWwpLlxuICAgICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYXV0b21hdGljIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogSWYgcHJvdmlkZWQsIGFuIEEgcmVjb3JkIChhbGlhcykgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBETlMgcmVjb3JkIGNyZWF0ZWQpXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYGhvc3RlZFpvbmVgIGlzIHByb3ZpZGVkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaGUgYmFzZSBwYXRoIG1hcHBpbmcgZm9yIHRoZSBBUEkgdW5kZXIgdGhpcyBkb21haW4uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChtYXBzIHRvIHRoZSByb290KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBSRUdJT05BTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuZHBvaW50VHlwZT86IGFwaWd3LkVuZHBvaW50VHlwZTtcblxuICAgIC8qKlxuICAgICAqIFNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCBUTFNfMV8yXG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlndy5TZWN1cml0eVBvbGljeTtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBhZGRpbmcgYSBMYW1iZGEgaW50ZWdyYXRpb24gdG8gYSByb3V0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zIHtcbiAgICAvKipcbiAgICAgKiBFbmFibGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGZvciB0aGlzIHJvdXRlLlxuICAgICAqIFdoZW4gZW5hYmxlZDpcbiAgICAgKiAtIFJlc3BvbnNlVHJhbnNmZXJNb2RlIGlzIHNldCB0byBTVFJFQU1cbiAgICAgKiAtIFRoZSBMYW1iZGEgaW52b2NhdGlvbiBVUkkgdXNlcyAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogLSBUaW1lb3V0IGlzIHNldCB0byAxNSBtaW51dGVzICg5MDAwMDBtcylcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmVhbWluZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gaW50ZWdyYXRpb24gdGltZW91dC5cbiAgICAgKiBGb3Igc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMTUgbWludXRlcy5cbiAgICAgKiBGb3Igbm9uLXN0cmVhbWluZyByb3V0ZXMsIGRlZmF1bHRzIHRvIDI5IHNlY29uZHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgdGltZW91dD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogUmVxdWVzdCB0ZW1wbGF0ZXMgZm9yIHRoZSBpbnRlZ3JhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHVzZSBMYW1iZGEgcHJveHkgaW50ZWdyYXRpb24pXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVxdWVzdFRlbXBsYXRlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG5cbiAgICAvKipcbiAgICAgKiBQYXNzdGhyb3VnaCBiZWhhdmlvciBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IFdIRU5fTk9fTUFUQ0hcbiAgICAgKi9cbiAgICByZWFkb25seSBwYXNzdGhyb3VnaEJlaGF2aW9yPzogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgY29uc3RydWN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyB7XG4gICAgLyoqXG4gICAgICogTmFtZSBvZiB0aGUgUkVTVCBBUEkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIERlc2NyaXB0aW9uIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogQ09SUyBjb25maWd1cmF0aW9uLiBTZXQgdG8gdHJ1ZSBmb3Igc2Vuc2libGUgZGVmYXVsdHMsXG4gICAgICogb3IgcHJvdmlkZSBjdXN0b20gb3B0aW9ucy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIENPUlMpXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjdXN0b20gZG9tYWluKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJEb21haW5PcHRpb25zO1xuXG4gICAgLyoqXG4gICAgICogRW5kcG9pbnQgdHlwZXMgZm9yIHRoZSBSRVNUIEFQSS5cbiAgICAgKiBAZGVmYXVsdCBbUkVHSU9OQUxdXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRUeXBlcz86IGFwaWd3LkVuZHBvaW50VHlwZVtdO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0aGUgUkVTVCBBUEkgdXNlcyBiaW5hcnkgbWVkaWEgdHlwZXMuXG4gICAgICogU3BlY2lmeSBtZWRpYSB0eXBlcyB0aGF0IHNob3VsZCBiZSB0cmVhdGVkIGFzIGJpbmFyeS5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBiaW5hcnlNZWRpYVR5cGVzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBNaW5pbXVtIGNvbXByZXNzaW9uIHNpemUgaW4gYnl0ZXMuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjb21wcmVzc2lvbilcbiAgICAgKi9cbiAgICByZWFkb25seSBtaW5pbXVtQ29tcHJlc3Npb25TaXplPzogbnVtYmVyO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIGRlcGxveSBvbiBjb25zdHJ1Y3QgY3JlYXRpb24uXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlcGxveT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBSZXRhaW4gZGVwbG95bWVudCBoaXN0b3J5IHdoZW4gZGVwbG95bWVudHMgY2hhbmdlLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV0YWluRGVwbG95bWVudHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGtleSBzb3VyY2UgdHlwZS5cbiAgICAgKiBAZGVmYXVsdCBIRUFERVJcbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlLZXlTb3VyY2VUeXBlPzogYXBpZ3cuQXBpS2V5U291cmNlVHlwZTtcbn1cblxuLyoqXG4gKiBBIFJFU1QgQVBJIHYxIHJvdXRlciB0aGF0IHN1cHBvcnRzIG11bHRpLUxhbWJkYSByb3V0aW5nIHdpdGggZnVsbCBzdHJlYW1pbmcgcGFyaXR5LlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHJlc3NlcyB0aGUgZ2FwcyBpbiBBcHBUaGVvcnlSZXN0QXBpIGJ5IGFsbG93aW5nOlxuICogLSBNdWx0aXBsZSBMYW1iZGEgZnVuY3Rpb25zIGF0dGFjaGVkIHRvIGRpZmZlcmVudCByb3V0ZXNcbiAqIC0gQ29tcGxldGUgcmVzcG9uc2Ugc3RyZWFtaW5nIGludGVncmF0aW9uIChyZXNwb25zZVRyYW5zZmVyTW9kZSwgVVJJIHN1ZmZpeCwgdGltZW91dClcbiAqIC0gU3RhZ2UgY29udHJvbHMgKGFjY2VzcyBsb2dnaW5nLCBtZXRyaWNzLCB0aHJvdHRsaW5nLCBDT1JTKVxuICogLSBDdXN0b20gZG9tYWluIHdpcmluZyB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHJvdXRlciA9IG5ldyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyKHRoaXMsICdSb3V0ZXInLCB7XG4gKiAgIGFwaU5hbWU6ICdteS1hcGknLFxuICogICBzdGFnZTogeyBzdGFnZU5hbWU6ICdwcm9kJywgYWNjZXNzTG9nZ2luZzogdHJ1ZSwgZGV0YWlsZWRNZXRyaWNzOiB0cnVlIH0sXG4gKiAgIGNvcnM6IHRydWUsXG4gKiB9KTtcbiAqXG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9zc2UnLCBbJ0dFVCddLCBzc2VGbiwgeyBzdHJlYW1pbmc6IHRydWUgfSk7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy9hcGkvZ3JhcGhxbCcsIFsnUE9TVCddLCBncmFwaHFsRm4pO1xuICogcm91dGVyLmFkZExhbWJkYUludGVncmF0aW9uKCcve3Byb3h5K30nLCBbJ0FOWSddLCBhcGlGbik7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgdW5kZXJseWluZyBBUEkgR2F0ZXdheSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlndy5SZXN0QXBpO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRlcGxveW1lbnQgc3RhZ2UuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlndy5TdGFnZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmc7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUm91dGU1MyBBIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEFBQUEgcmVjb3JkIChpZiBkb21haW4sIGhvc3RlZFpvbmUsIGFuZCBjcmVhdGVBQUFBUmVjb3JkIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29yc09wdGlvbnM/OiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnM7XG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzRW5hYmxlZDogYm9vbGVhbjtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyUHJvcHMgPSB7fSkge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIC8vIE5vcm1hbGl6ZSBDT1JTIGNvbmZpZ1xuICAgICAgICBpZiAocHJvcHMuY29ycyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0ge307XG4gICAgICAgIH0gZWxzZSBpZiAocHJvcHMuY29ycyAmJiB0eXBlb2YgcHJvcHMuY29ycyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmNvcnNPcHRpb25zID0gcHJvcHMuY29ycztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuY29yc0VuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgICAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwicHJvZFwiO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgUkVTVCBBUElcbiAgICAgICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3cuUmVzdEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgICAgICByZXN0QXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBwcm9wcy5kZXNjcmlwdGlvbixcbiAgICAgICAgICAgIGRlcGxveTogcHJvcHMuZGVwbG95ID8/IHRydWUsXG4gICAgICAgICAgICByZXRhaW5EZXBsb3ltZW50czogcHJvcHMucmV0YWluRGVwbG95bWVudHMsXG4gICAgICAgICAgICBlbmRwb2ludFR5cGVzOiBwcm9wcy5lbmRwb2ludFR5cGVzID8/IFthcGlndy5FbmRwb2ludFR5cGUuUkVHSU9OQUxdLFxuICAgICAgICAgICAgYmluYXJ5TWVkaWFUeXBlczogcHJvcHMuYmluYXJ5TWVkaWFUeXBlcyxcbiAgICAgICAgICAgIG1pbmltdW1Db21wcmVzc2lvblNpemU6IHByb3BzLm1pbmltdW1Db21wcmVzc2lvblNpemU/LnZhbHVlT2YoKSxcbiAgICAgICAgICAgIGFwaUtleVNvdXJjZVR5cGU6IHByb3BzLmFwaUtleVNvdXJjZVR5cGUsXG4gICAgICAgICAgICBkZXBsb3lPcHRpb25zOiB0aGlzLmJ1aWxkRGVwbG95T3B0aW9ucyhzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuc3RhZ2UgPSB0aGlzLmFwaS5kZXBsb3ltZW50U3RhZ2U7XG5cbiAgICAgICAgLy8gU2V0IHVwIGN1c3RvbSBkb21haW4gaWYgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgTGFtYmRhIGludGVncmF0aW9uIGZvciB0aGUgc3BlY2lmaWVkIHBhdGggYW5kIEhUVFAgbWV0aG9kcy5cbiAgICAgKlxuICAgICAqIEBwYXJhbSBwYXRoIC0gVGhlIHJlc291cmNlIHBhdGggKGUuZy4sIFwiL3NzZVwiLCBcIi9hcGkvZ3JhcGhxbFwiLCBcIi97cHJveHkrfVwiKVxuICAgICAqIEBwYXJhbSBtZXRob2RzIC0gQXJyYXkgb2YgSFRUUCBtZXRob2RzIChlLmcuLCBbXCJHRVRcIiwgXCJQT1NUXCJdIG9yIFtcIkFOWVwiXSlcbiAgICAgKiBAcGFyYW0gaGFuZGxlciAtIFRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gaW50ZWdyYXRlXG4gICAgICogQHBhcmFtIG9wdGlvbnMgLSBJbnRlZ3JhdGlvbiBvcHRpb25zIGluY2x1ZGluZyBzdHJlYW1pbmcgY29uZmlndXJhdGlvblxuICAgICAqL1xuICAgIGFkZExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBwYXRoOiBzdHJpbmcsXG4gICAgICAgIG1ldGhvZHM6IHN0cmluZ1tdLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IHJlc291cmNlID0gdGhpcy5yZXNvdXJjZUZvclBhdGgocGF0aCk7XG5cbiAgICAgICAgZm9yIChjb25zdCBtIG9mIG1ldGhvZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhtID8/IFwiXCIpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgaWYgKCFtZXRob2QpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAvLyBDcmVhdGUgdGhlIGludGVncmF0aW9uXG4gICAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IHRoaXMuY3JlYXRlTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwgb3B0aW9ucyk7XG5cbiAgICAgICAgICAgIC8vIEFkZCB0aGUgbWV0aG9kXG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkTWV0aG9kID0gcmVzb3VyY2UuYWRkTWV0aG9kKG1ldGhvZCwgaW50ZWdyYXRpb24sIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IHRoaXMuY29yc0VuYWJsZWQgPyB0aGlzLmJ1aWxkTWV0aG9kUmVzcG9uc2VzKCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRm9yIHN0cmVhbWluZyByb3V0ZXMsIGFwcGx5IEwxIG92ZXJyaWRlcyB0byBlbnN1cmUgZnVsbCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5zdHJlYW1pbmcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKGNyZWF0ZWRNZXRob2QsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIE9QVElPTlMgbWV0aG9kIGZvciBDT1JTIGlmIGVuYWJsZWQgYW5kIG5vdCBhbHJlYWR5IHByZXNlbnRcbiAgICAgICAgaWYgKHRoaXMuY29yc0VuYWJsZWQgJiYgIXJlc291cmNlLm5vZGUudHJ5RmluZENoaWxkKFwiT1BUSU9OU1wiKSkge1xuICAgICAgICAgICAgdGhpcy5hZGRDb3JzUHJlZmxpZ2h0TWV0aG9kKHJlc291cmNlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBvciBjcmVhdGUgYSByZXNvdXJjZSBmb3IgdGhlIGdpdmVuIHBhdGguXG4gICAgICovXG4gICAgcHJpdmF0ZSByZXNvdXJjZUZvclBhdGgoaW5wdXRQYXRoOiBzdHJpbmcpOiBhcGlndy5JUmVzb3VyY2Uge1xuICAgICAgICBsZXQgY3VycmVudDogYXBpZ3cuSVJlc291cmNlID0gdGhpcy5hcGkucm9vdDtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhpbnB1dFBhdGggPz8gXCJcIilcbiAgICAgICAgICAgIC50cmltKClcbiAgICAgICAgICAgIC5yZXBsYWNlKC9eXFwvKy8sIFwiXCIpXG4gICAgICAgICAgICAucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgICAgICAgaWYgKCF0cmltbWVkKSByZXR1cm4gY3VycmVudDtcblxuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnQgPSBTdHJpbmcoc2VnbWVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIXBhcnQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2UocGFydCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShwYXJ0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBMYW1iZGEgaW50ZWdyYXRpb24gd2l0aCB0aGUgYXBwcm9wcmlhdGUgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICBwcml2YXRlIGNyZWF0ZUxhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IGFwaWd3LkxhbWJkYUludGVncmF0aW9uIHtcbiAgICAgICAgY29uc3Qgc3RyZWFtaW5nID0gb3B0aW9ucy5zdHJlYW1pbmcgPz8gZmFsc2U7XG5cbiAgICAgICAgLy8gRm9yIHN0cmVhbWluZywgd2UgdXNlIFNUUkVBTSByZXNwb25zZVRyYW5zZmVyTW9kZVxuICAgICAgICAvLyBOb3RlOiBUaGUgVVJJIHN1ZmZpeCBhbmQgdGltZW91dCB3aWxsIGJlIGZpeGVkIHZpYSBMMSBvdmVycmlkZXNcbiAgICAgICAgcmV0dXJuIG5ldyBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCB7XG4gICAgICAgICAgICBwcm94eTogdHJ1ZSxcbiAgICAgICAgICAgIHJlc3BvbnNlVHJhbnNmZXJNb2RlOiBzdHJlYW1pbmcgPyBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5TVFJFQU0gOiBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5CVUZGRVJFRCxcbiAgICAgICAgICAgIHRpbWVvdXQ6IG9wdGlvbnMudGltZW91dCA/PyAoc3RyZWFtaW5nID8gRHVyYXRpb24ubWludXRlcygxNSkgOiB1bmRlZmluZWQpLFxuICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogb3B0aW9ucy5wYXNzdGhyb3VnaEJlaGF2aW9yLFxuICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczogb3B0aW9ucy5yZXF1ZXN0VGVtcGxhdGVzLFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBcHBseSBMMSBDRk4gb3ZlcnJpZGVzIGZvciBzdHJlYW1pbmcgcm91dGVzIHRvIGVuc3VyZSBmdWxsIExpZnQgcGFyaXR5LlxuICAgICAqXG4gICAgICogU3RyZWFtaW5nIHJvdXRlcyByZXF1aXJlOlxuICAgICAqIDEuIEludGVncmF0aW9uLlJlc3BvbnNlVHJhbnNmZXJNb2RlID0gU1RSRUFNIChhbHJlYWR5IHNldCB2aWEgTDIpXG4gICAgICogMi4gSW50ZWdyYXRpb24uVXJpIGVuZHMgd2l0aCAvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICogMy4gSW50ZWdyYXRpb24uVGltZW91dEluTWlsbGlzID0gOTAwMDAwICgxNSBtaW51dGVzKVxuICAgICAqL1xuICAgIHByaXZhdGUgYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoXG4gICAgICAgIG1ldGhvZDogYXBpZ3cuTWV0aG9kLFxuICAgICAgICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgICAgICBvcHRpb25zOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVySW50ZWdyYXRpb25PcHRpb25zLFxuICAgICk6IHZvaWQge1xuICAgICAgICBjb25zdCBjZm5NZXRob2QgPSBtZXRob2Qubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3cuQ2ZuTWV0aG9kO1xuICAgICAgICBpZiAoIWNmbk1ldGhvZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBzdHJlYW1pbmcgVVJJXG4gICAgICAgIC8vIFN0YW5kYXJkIGZvcm1hdDogYXJuOntwYXJ0aXRpb259OmFwaWdhdGV3YXk6e3JlZ2lvbn06bGFtYmRhOnBhdGgvMjAyMS0xMS0xNS9mdW5jdGlvbnMve2Z1bmN0aW9uQXJufS9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgICAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0Py50b01pbGxpc2Vjb25kcygpID8/IDkwMDAwMDtcblxuICAgICAgICAvLyBPdmVycmlkZSB0aGUgaW50ZWdyYXRpb24gcHJvcGVydGllc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpc1wiLCB0aW1lb3V0TXMpO1xuXG4gICAgICAgIC8vIFRoZSBVUkkgbXVzdCB1c2UgdGhlIHN0cmVhbWluZy1zcGVjaWZpYyBwYXRoXG4gICAgICAgIC8vIFdlIGNvbnN0cnVjdCBpdCB1c2luZyBGbjo6Sm9pbiB0byBwcmVzZXJ2ZSBDbG91ZEZvcm1hdGlvbiBpbnRyaW5zaWNzXG4gICAgICAgIGNmbk1ldGhvZC5hZGRQcm9wZXJ0eU92ZXJyaWRlKFwiSW50ZWdyYXRpb24uVXJpXCIsIHtcbiAgICAgICAgICAgIFwiRm46OkpvaW5cIjogW1xuICAgICAgICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICBcImFybjpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpQYXJ0aXRpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjphcGlnYXRld2F5OlwiLFxuICAgICAgICAgICAgICAgICAgICB7IFJlZjogXCJBV1M6OlJlZ2lvblwiIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiOmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL1wiLFxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICAgICAgICBcIi9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcIixcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgZGVwbG95IG9wdGlvbnMgZm9yIHRoZSBzdGFnZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkRGVwbG95T3B0aW9ucyhcbiAgICAgICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyU3RhZ2VPcHRpb25zLFxuICAgICAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICApOiBhcGlndy5TdGFnZU9wdGlvbnMge1xuICAgICAgICAvLyBIYW5kbGUgYWNjZXNzIGxvZ2dpbmdcbiAgICAgICAgbGV0IGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBhcGlndy5JQWNjZXNzTG9nRGVzdGluYXRpb24gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBhY2Nlc3NMb2dGb3JtYXQgPSBzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0O1xuXG4gICAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgLy8gQ3JlYXRlIGFuIGF1dG8tbWFuYWdlZCBsb2cgZ3JvdXBcbiAgICAgICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbiA9IG5ldyBhcGlndy5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGxvZ0dyb3VwKTtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCA9IGFjY2Vzc0xvZ0Zvcm1hdCA/PyBhcGlndy5BY2Nlc3NMb2dGb3JtYXQuY2xmKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgJiYgdHlwZW9mIHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICAvLyBVc2UgcHJvdmlkZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uID0gbmV3IGFwaWd3LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpO1xuICAgICAgICAgICAgYWNjZXNzTG9nRm9ybWF0ID0gYWNjZXNzTG9nRm9ybWF0ID8/IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jbGYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbixcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCxcbiAgICAgICAgICAgIG1ldHJpY3NFbmFibGVkOiBzdGFnZU9wdHMuZGV0YWlsZWRNZXRyaWNzLFxuICAgICAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAgICovXG4gICAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgICAgICAvLyBHZXQgb3IgY3JlYXRlIHRoZSBjZXJ0aWZpY2F0ZSByZWZlcmVuY2VcbiAgICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICAgICAgICA/IChhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGUpXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICAgICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZG9tYWluIG5hbWVcbiAgICAgICAgY29uc3QgZW5kcG9pbnRUeXBlID0gZG9tYWluT3B0cy5lbmRwb2ludFR5cGUgPz8gYXBpZ3cuRW5kcG9pbnRUeXBlLlJFR0lPTkFMO1xuICAgICAgICBjb25zdCBkbW4gPSBuZXcgYXBpZ3cuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgICAgICAgY2VydGlmaWNhdGUsXG4gICAgICAgICAgICBlbmRwb2ludFR5cGUsXG4gICAgICAgICAgICBzZWN1cml0eVBvbGljeTogZG9tYWluT3B0cy5zZWN1cml0eVBvbGljeSA/PyBhcGlndy5TZWN1cml0eVBvbGljeS5UTFNfMV8yLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3cuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBwYXRoIG1hcHBpbmdcbiAgICAgICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlndy5CYXNlUGF0aE1hcHBpbmcodGhpcywgXCJCYXNlUGF0aE1hcHBpbmdcIiwge1xuICAgICAgICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgICAgICAgcmVzdEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgICBiYXNlUGF0aDogZG9tYWluT3B0cy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHN0YWdlOiB0aGlzLnN0YWdlLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBiYXNlUGF0aE1hcHBpbmc/OiBhcGlndy5CYXNlUGF0aE1hcHBpbmcgfSkuYmFzZVBhdGhNYXBwaW5nID0gbWFwcGluZztcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgcm91dGU1M3RhcmdldHMuQXBpR2F0ZXdheURvbWFpbihkbW4pKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgKHRoaXMgYXMgeyBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkIH0pLmFSZWNvcmQgPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmIChkb21haW5PcHRzLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBhYWFhUmVjb3JkID0gbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgKHRoaXMgYXMgeyBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkIH0pLmFhYWFSZWNvcmQgPSBhYWFhUmVjb3JkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgbWV0aG9kIHJlc3BvbnNlcyBmb3IgQ09SUy1lbmFibGVkIGVuZHBvaW50cy5cbiAgICAgKi9cbiAgICBwcml2YXRlIGJ1aWxkTWV0aG9kUmVzcG9uc2VzKCk6IGFwaWd3Lk1ldGhvZFJlc3BvbnNlW10ge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgQ09SUyBwcmVmbGlnaHQgKE9QVElPTlMpIG1ldGhvZCB0byBhIHJlc291cmNlLlxuICAgICAqL1xuICAgIHByaXZhdGUgYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZTogYXBpZ3cuSVJlc291cmNlKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IG9wdHMgPSB0aGlzLmNvcnNPcHRpb25zID8/IHt9O1xuICAgICAgICBjb25zdCBhbGxvd09yaWdpbnMgPSBvcHRzLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHMgPSBvcHRzLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiT1BUSU9OU1wiLCBcIlBBVENIXCIsIFwiSEVBRFwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzID0gb3B0cy5hbGxvd0hlYWRlcnMgPz8gW1xuICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICAgIFwiQXV0aG9yaXphdGlvblwiLFxuICAgICAgICAgICAgXCJYLUFtei1EYXRlXCIsXG4gICAgICAgICAgICBcIlgtQXBpLUtleVwiLFxuICAgICAgICAgICAgXCJYLUFtei1TZWN1cml0eS1Ub2tlblwiLFxuICAgICAgICBdO1xuICAgICAgICBjb25zdCBhbGxvd0NyZWRlbnRpYWxzID0gb3B0cy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBtYXhBZ2UgPSBvcHRzLm1heEFnZSA/PyBEdXJhdGlvbi5zZWNvbmRzKDYwMCk7XG5cbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW4gPSBhbGxvd09yaWdpbnMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93TWV0aG9kc1N0ciA9IGFsbG93TWV0aG9kcy5qb2luKFwiLFwiKTtcbiAgICAgICAgY29uc3QgYWxsb3dIZWFkZXJzU3RyID0gYWxsb3dIZWFkZXJzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIFwiT1BUSU9OU1wiLFxuICAgICAgICAgICAgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IGAnJHthbGxvd0hlYWRlcnNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogYCcke2FsbG93TWV0aG9kc1N0cn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IGAnJHthbGxvd09yaWdpbn0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogYCcke2FsbG93Q3JlZGVudGlhbHN9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogYCcke21heEFnZS50b1NlY29uZHMoKX0nYCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAgICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogJ3tcInN0YXR1c0NvZGVcIjogMjAwfScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kc1wiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW5cIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctQ3JlZGVudGlhbHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtTWF4LUFnZVwiOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICAgIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICAgIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICAgICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICAgIH1cbiAgICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==