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
AppTheoryRestApiRouter[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter", version: "0.23.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGktcm91dGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicmVzdC1hcGktcm91dGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLG9EQUFvRDtBQUNwRCwwREFBMEQ7QUFFMUQsNkNBQTZDO0FBQzdDLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFDbEUsMkNBQXVDO0FBRXZDLHFFQUFnRjtBQUNoRix5REFBMEQ7QUFvUDFEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBbUJHO0FBQ0gsTUFBYSxzQkFBdUIsU0FBUSxzQkFBUztJQXVDakQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUFxQyxFQUFFO1FBQzdFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsd0JBQXdCO1FBQ3hCLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUMxQixDQUFDO2FBQU0sSUFBSSxLQUFLLENBQUMsSUFBSSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN0RCxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7UUFDbEMsQ0FBQzthQUFNLENBQUM7WUFDSixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQztRQUM3QixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxNQUFNLENBQUM7UUFFaEQsc0JBQXNCO1FBQ3RCLElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsT0FBTyxD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Q0gsU0FBUyxtQkFBbUIsQ0FBQyxVQUFrQixFQUFFLElBQXlCO0lBQ3RFLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNoRSxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZFLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0IsSUFBSSxJQUFJLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDeEIsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBQ0QsT0FBTyxJQUFJLENBQUM7QUFDaEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgcm91dGU1M3RhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LWFwaS1zdHJlYW1pbmdcIjtcbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG4vKipcbiAqIENPUlMgY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyQ29yc09wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICAgKiBAZGVmYXVsdCBbJyonXVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93T3JpZ2lucz86IHN0cmluZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAgICogQGRlZmF1bHQgWydHRVQnLCAnUE9TVCcsICdQVVQnLCAnREVMRVRFJywgJ09QVElPTlMnLCAnUEFUQ0gnLCAnSEVBRCddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIGhlYWRlcnMuXG4gICAgICogQGRlZmF1bHQgWydDb250ZW50LVR5cGUnLCAnQXV0aG9yaXphdGlvbicsICdYLUFtei1EYXRlJywgJ1gtQXBpLUtleScsICdYLUFtei1TZWN1cml0eS1Ub2tlbiddXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGFsbG93IGNyZWRlbnRpYWxzLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBNYXggYWdlIGZvciBwcmVmbGlnaHQgY2FjaGUgaW4gc2Vjb25kcy5cbiAgICAgKiBAZGVmYXVsdCA2MDBcbiAgICAgKi9cbiAgICByZWFkb25seSBtYXhBZ2U/OiBEdXJhdGlvbjtcbn1cblxuLyoqXG4gKiBTdGFnZS1sZXZlbCBjb25maWd1cmF0aW9uIGZvciB0aGUgUkVTVCBBUEkgcm91dGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIFN0YWdlIG5hbWUuXG4gICAgICogQGRlZmF1bHQgJ3Byb2QnXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICAgKiBJZiB0cnVlLCBhIGxvZyBncm91cCB3aWxsIGJlIGNyZWF0ZWQgYXV0b21hdGljYWxseS5cbiAgICAgKiBQcm92aWRlIGEgTG9nR3JvdXAgZm9yIGN1c3RvbSBsb2dnaW5nIGNvbmZpZ3VyYXRpb24uXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgLyoqXG4gICAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgYXV0by1jcmVhdGVkIGFjY2VzcyBsb2cgZ3JvdXAuXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlIChib29sZWFuKS5cbiAgICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gICAgLyoqXG4gICAgICogQWNjZXNzIGxvZyBmb3JtYXQuXG4gICAgICogQGRlZmF1bHQgQWNjZXNzTG9nRm9ybWF0LmNsZigpIChDb21tb24gTG9nIEZvcm1hdClcbiAgICAgKi9cbiAgICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlndy5BY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGV0YWlsZWQgQ2xvdWRXYXRjaCBtZXRyaWNzIGF0IG1ldGhvZC9yZXNvdXJjZSBsZXZlbC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRldGFpbGVkTWV0cmljcz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQgKHJlcXVlc3RzIHBlciBzZWNvbmQpIGZvciB0aGUgc3RhZ2UuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIFJFU1QgQVBJIHJvdXRlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXN0QXBpUm91dGVyRG9tYWluT3B0aW9ucyB7XG4gICAgLyoqXG4gICAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZS5nLiwgXCJhcGkuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIChtdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgZWRnZSBlbmRwb2ludHMsIHNhbWUgcmVnaW9uIGZvciByZWdpb25hbCkuXG4gICAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhdXRvbWF0aWMgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBJZiBwcm92aWRlZCwgYW4gQSByZWNvcmQgKGFsaWFzKSB3aWxsIGJlIGNyZWF0ZWQgcG9pbnRpbmcgdG8gdGhlIEFQSSBHYXRld2F5IGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIEROUyByZWNvcmQgY3JlYXRlZClcbiAgICAgKi9cbiAgICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEFBQUEgYWxpYXMgcmVjb3JkIGluIGFkZGl0aW9uIHRvIHRoZSBBIGFsaWFzIHJlY29yZC5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBgaG9zdGVkWm9uZWAgaXMgcHJvdmlkZWQuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjcmVhdGVBQUFBUmVjb3JkPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBiYXNlIHBhdGggbWFwcGluZyBmb3IgdGhlIEFQSSB1bmRlciB0aGlzIGRvbWFpbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG1hcHMgdG8gdGhlIHJvb3QpXG4gICAgICovXG4gICAgcmVhZG9ubHkgYmFzZVBhdGg/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlIGZvciB0aGUgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IFJFR0lPTkFMXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5kcG9pbnRUeXBlPzogYXBpZ3cuRW5kcG9pbnRUeXBlO1xuXG4gICAgLyoqXG4gICAgICogU2VjdXJpdHkgcG9saWN5IGZvciB0aGUgZG9tYWluLlxuICAgICAqIEBkZWZhdWx0IFRMU18xXzJcbiAgICAgKi9cbiAgICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3LlNlY3VyaXR5UG9saWN5O1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGFkZGluZyBhIExhbWJkYSBpbnRlZ3JhdGlvbiB0byBhIHJvdXRlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMge1xuICAgIC8qKlxuICAgICAqIEVuYWJsZSByZXNwb25zZSBzdHJlYW1pbmcgZm9yIHRoaXMgcm91dGUuXG4gICAgICogV2hlbiBlbmFibGVkOlxuICAgICAqIC0gUmVzcG9uc2VUcmFuc2Zlck1vZGUgaXMgc2V0IHRvIFNUUkVBTVxuICAgICAqIC0gVGhlIExhbWJkYSBpbnZvY2F0aW9uIFVSSSB1c2VzIC9yZXNwb25zZS1zdHJlYW1pbmctaW52b2NhdGlvbnNcbiAgICAgKiAtIFRpbWVvdXQgaXMgc2V0IHRvIDE1IG1pbnV0ZXMgKDkwMDAwMG1zKVxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3RyZWFtaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBpbnRlZ3JhdGlvbiB0aW1lb3V0LlxuICAgICAqIEZvciBzdHJlYW1pbmcgcm91dGVzLCBkZWZhdWx0cyB0byAxNSBtaW51dGVzLlxuICAgICAqIEZvciBub24tc3RyZWFtaW5nIHJvdXRlcywgZGVmYXVsdHMgdG8gMjkgc2Vjb25kcy5cbiAgICAgKi9cbiAgICByZWFkb25seSB0aW1lb3V0PzogRHVyYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBSZXF1ZXN0IHRlbXBsYXRlcyBmb3IgdGhlIGludGVncmF0aW9uLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAodXNlIExhbWJkYSBwcm94eSBpbnRlZ3JhdGlvbilcbiAgICAgKi9cbiAgICByZWFkb25seSByZXF1ZXN0VGVtcGxhdGVzPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcblxuICAgIC8qKlxuICAgICAqIFBhc3N0aHJvdWdoIGJlaGF2aW9yIGZvciB0aGUgaW50ZWdyYXRpb24uXG4gICAgICogQGRlZmF1bHQgV0hFTl9OT19NQVRDSFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhc3N0aHJvdWdoQmVoYXZpb3I/OiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdEFwaVJvdXRlclByb3BzIHtcbiAgICAvKipcbiAgICAgKiBOYW1lIG9mIHRoZSBSRVNUIEFQSS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRGVzY3JpcHRpb24gb2YgdGhlIFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJTdGFnZU9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBzZW5zaWJsZSBkZWZhdWx0cyxcbiAgICAgKiBvciBwcm92aWRlIGN1c3RvbSBvcHRpb25zLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gQ09SUylcbiAgICAgKi9cbiAgICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcblxuICAgIC8qKlxuICAgICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGN1c3RvbSBkb21haW4pXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnM7XG5cbiAgICAvKipcbiAgICAgKiBFbmRwb2ludCB0eXBlcyBmb3IgdGhlIFJFU1QgQVBJLlxuICAgICAqIEBkZWZhdWx0IFtSRUdJT05BTF1cbiAgICAgKi9cbiAgICByZWFkb25seSBlbmRwb2ludFR5cGVzPzogYXBpZ3cuRW5kcG9pbnRUeXBlW107XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRoZSBSRVNUIEFQSSB1c2VzIGJpbmFyeSBtZWRpYSB0eXBlcy5cbiAgICAgKiBTcGVjaWZ5IG1lZGlhIHR5cGVzIHRoYXQgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgYmluYXJ5LlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJpbmFyeU1lZGlhVHlwZXM/OiBzdHJpbmdbXTtcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gY29tcHJlc3Npb24gc2l6ZSBpbiBieXRlcy5cbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGNvbXByZXNzaW9uKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Db21wcmVzc2lvblNpemU/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgZGVwbG95IG9uIGNvbnN0cnVjdCBjcmVhdGlvbi5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVwbG95PzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFJldGFpbiBkZXBsb3ltZW50IGhpc3Rvcnkgd2hlbiBkZXBsb3ltZW50cyBjaGFuZ2UuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSByZXRhaW5EZXBsb3ltZW50cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBBUEkga2V5IHNvdXJjZSB0eXBlLlxuICAgICAqIEBkZWZhdWx0IEhFQURFUlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUtleVNvdXJjZVR5cGU/OiBhcGlndy5BcGlLZXlTb3VyY2VUeXBlO1xufVxuXG4vKipcbiAqIEEgUkVTVCBBUEkgdjEgcm91dGVyIHRoYXQgc3VwcG9ydHMgbXVsdGktTGFtYmRhIHJvdXRpbmcgd2l0aCBmdWxsIHN0cmVhbWluZyBwYXJpdHkuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgYWRkcmVzc2VzIHRoZSBnYXBzIGluIEFwcFRoZW9yeVJlc3RBcGkgYnkgYWxsb3dpbmc6XG4gKiAtIE11bHRpcGxlIExhbWJkYSBmdW5jdGlvbnMgYXR0YWNoZWQgdG8gZGlmZmVyZW50IHJvdXRlc1xuICogLSBDb21wbGV0ZSByZXNwb25zZSBzdHJlYW1pbmcgaW50ZWdyYXRpb24gKHJlc3BvbnNlVHJhbnNmZXJNb2RlLCBVUkkgc3VmZml4LCB0aW1lb3V0KVxuICogLSBTdGFnZSBjb250cm9scyAoYWNjZXNzIGxvZ2dpbmcsIG1ldHJpY3MsIHRocm90dGxpbmcsIENPUlMpXG4gKiAtIEN1c3RvbSBkb21haW4gd2lyaW5nIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmRcbiAqXG4gKiBAZXhhbXBsZVxuICogY29uc3Qgcm91dGVyID0gbmV3IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIodGhpcywgJ1JvdXRlcicsIHtcbiAqICAgYXBpTmFtZTogJ215LWFwaScsXG4gKiAgIHN0YWdlOiB7IHN0YWdlTmFtZTogJ3Byb2QnLCBhY2Nlc3NMb2dnaW5nOiB0cnVlLCBkZXRhaWxlZE1ldHJpY3M6IHRydWUgfSxcbiAqICAgY29yczogdHJ1ZSxcbiAqIH0pO1xuICpcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL3NzZScsIFsnR0VUJ10sIHNzZUZuLCB7IHN0cmVhbWluZzogdHJ1ZSB9KTtcbiAqIHJvdXRlci5hZGRMYW1iZGFJbnRlZ3JhdGlvbignL2FwaS9ncmFwaHFsJywgWydQT1NUJ10sIGdyYXBocWxGbik7XG4gKiByb3V0ZXIuYWRkTGFtYmRhSW50ZWdyYXRpb24oJy97cHJveHkrfScsIFsnQU5ZJ10sIGFwaUZuKTtcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSB1bmRlcmx5aW5nIEFQSSBHYXRld2F5IFJFU1QgQVBJLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3LlJlc3RBcGk7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgZGVwbG95bWVudCBzdGFnZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3LlN0YWdlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoaWYgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlndy5Eb21haW5OYW1lO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGJhc2UgcGF0aCBtYXBwaW5nIChpZiBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGJhc2VQYXRoTWFwcGluZz86IGFwaWd3LkJhc2VQYXRoTWFwcGluZztcblxuICAgIC8qKlxuICAgICAqIFRoZSBSb3V0ZTUzIEEgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhUmVjb3JkPzogcm91dGU1My5BUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFJvdXRlNTMgQUFBQSByZWNvcmQgKGlmIGRvbWFpbiwgaG9zdGVkWm9uZSwgYW5kIGNyZWF0ZUFBQUFSZWNvcmQgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhYWFhUmVjb3JkPzogcm91dGU1My5BYWFhUmVjb3JkO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gICAgcHJpdmF0ZSByZWFkb25seSBjb3JzT3B0aW9ucz86IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJDb3JzT3B0aW9ucztcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvcnNFbmFibGVkOiBib29sZWFuO1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJQcm9wcyA9IHt9KSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgLy8gTm9ybWFsaXplIENPUlMgY29uZmlnXG4gICAgICAgIGlmIChwcm9wcy5jb3JzID09PSB0cnVlKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSB7fTtcbiAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5jb3JzICYmIHR5cGVvZiBwcm9wcy5jb3JzID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICB0aGlzLmNvcnNFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuY29yc09wdGlvbnMgPSBwcm9wcy5jb3JzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5jb3JzRW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCJwcm9kXCI7XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBSRVNUIEFQSVxuICAgICAgICB0aGlzLmFwaSA9IG5ldyBhcGlndy5SZXN0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgICAgIHJlc3RBcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgZGVwbG95OiBwcm9wcy5kZXBsb3kgPz8gdHJ1ZSxcbiAgICAgICAgICAgIHJldGFpbkRlcGxveW1lbnRzOiBwcm9wcy5yZXRhaW5EZXBsb3ltZW50cyxcbiAgICAgICAgICAgIGVuZHBvaW50VHlwZXM6IHByb3BzLmVuZHBvaW50VHlwZXMgPz8gW2FwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTF0sXG4gICAgICAgICAgICBiaW5hcnlNZWRpYVR5cGVzOiBwcm9wcy5iaW5hcnlNZWRpYVR5cGVzLFxuICAgICAgICAgICAgbWluaW11bUNvbXByZXNzaW9uU2l6ZTogcHJvcHMubWluaW11bUNvbXByZXNzaW9uU2l6ZT8udmFsdWVPZigpLFxuICAgICAgICAgICAgYXBpS2V5U291cmNlVHlwZTogcHJvcHMuYXBpS2V5U291cmNlVHlwZSxcbiAgICAgICAgICAgIGRlcGxveU9wdGlvbnM6IHRoaXMuYnVpbGREZXBsb3lPcHRpb25zKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5zdGFnZSA9IHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZTtcblxuICAgICAgICAvLyBTZXQgdXAgY3VzdG9tIGRvbWFpbiBpZiBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYSBMYW1iZGEgaW50ZWdyYXRpb24gZm9yIHRoZSBzcGVjaWZpZWQgcGF0aCBhbmQgSFRUUCBtZXRob2RzLlxuICAgICAqXG4gICAgICogQHBhcmFtIHBhdGggLSBUaGUgcmVzb3VyY2UgcGF0aCAoZS5nLiwgXCIvc3NlXCIsIFwiL2FwaS9ncmFwaHFsXCIsIFwiL3twcm94eSt9XCIpXG4gICAgICogQHBhcmFtIG1ldGhvZHMgLSBBcnJheSBvZiBIVFRQIG1ldGhvZHMgKGUuZy4sIFtcIkdFVFwiLCBcIlBPU1RcIl0gb3IgW1wiQU5ZXCJdKVxuICAgICAqIEBwYXJhbSBoYW5kbGVyIC0gVGhlIExhbWJkYSBmdW5jdGlvbiB0byBpbnRlZ3JhdGVcbiAgICAgKiBAcGFyYW0gb3B0aW9ucyAtIEludGVncmF0aW9uIG9wdGlvbnMgaW5jbHVkaW5nIHN0cmVhbWluZyBjb25maWd1cmF0aW9uXG4gICAgICovXG4gICAgYWRkTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIHBhdGg6IHN0cmluZyxcbiAgICAgICAgbWV0aG9kczogc3RyaW5nW10sXG4gICAgICAgIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgICAgIG9wdGlvbnM6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXJJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlRm9yUGF0aChwYXRoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IG0gb2YgbWV0aG9kcykge1xuICAgICAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKG0gPz8gXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAoIW1ldGhvZCkgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIENyZWF0ZSB0aGUgaW50ZWdyYXRpb25cbiAgICAgICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gdGhpcy5jcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihoYW5kbGVyLCBvcHRpb25zKTtcblxuICAgICAgICAgICAgLy8gQWRkIHRoZSBtZXRob2RcbiAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWRNZXRob2QgPSByZXNvdXJjZS5hZGRNZXRob2QobWV0aG9kLCBpbnRlZ3JhdGlvbiwge1xuICAgICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogdGhpcy5jb3JzRW5hYmxlZCA/IHRoaXMuYnVpbGRNZXRob2RSZXNwb25zZXMoKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBGb3Igc3RyZWFtaW5nIHJvdXRlcywgYXBwbHkgTDEgb3ZlcnJpZGVzIHRvIGVuc3VyZSBmdWxsIGNvbXBhdGliaWxpdHlcbiAgICAgICAgICAgIGlmIChvcHRpb25zLnN0cmVhbWluZykge1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwbHlTdHJlYW1pbmdPdmVycmlkZXMoY3JlYXRlZE1ldGhvZCwgaGFuZGxlciwgb3B0aW9ucyk7XG4gICAgICAgICAgICAgICAgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcodGhpcy5zdGFnZSwgbWV0aG9kLCBwYXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBPUFRJT05TIG1ldGhvZCBmb3IgQ09SUyBpZiBlbmFibGVkIGFuZCBub3QgYWxyZWFkeSBwcmVzZW50XG4gICAgICAgIGlmICh0aGlzLmNvcnNFbmFibGVkICYmICFyZXNvdXJjZS5ub2RlLnRyeUZpbmRDaGlsZChcIk9QVElPTlNcIikpIHtcbiAgICAgICAgICAgIHRoaXMuYWRkQ29yc1ByZWZsaWdodE1ldGhvZChyZXNvdXJjZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgb3IgY3JlYXRlIGEgcmVzb3VyY2UgZm9yIHRoZSBnaXZlbiBwYXRoLlxuICAgICAqL1xuICAgIHByaXZhdGUgcmVzb3VyY2VGb3JQYXRoKGlucHV0UGF0aDogc3RyaW5nKTogYXBpZ3cuSVJlc291cmNlIHtcbiAgICAgICAgbGV0IGN1cnJlbnQ6IGFwaWd3LklSZXNvdXJjZSA9IHRoaXMuYXBpLnJvb3Q7XG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhpbnB1dFBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gICAgICAgIGlmICghdHJpbW1lZCkgcmV0dXJuIGN1cnJlbnQ7XG5cbiAgICAgICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHRyaW1tZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJ0ID0gU3RyaW5nKHNlZ21lbnQgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgaWYgKCFwYXJ0KSBjb250aW51ZTtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LmdldFJlc291cmNlKHBhcnQpID8/IGN1cnJlbnQuYWRkUmVzb3VyY2UocGFydCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgTGFtYmRhIGludGVncmF0aW9uIHdpdGggdGhlIGFwcHJvcHJpYXRlIGNvbmZpZ3VyYXRpb24uXG4gICAgICovXG4gICAgcHJpdmF0ZSBjcmVhdGVMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiBhcGlndy5MYW1iZGFJbnRlZ3JhdGlvbiB7XG4gICAgICAgIGNvbnN0IHN0cmVhbWluZyA9IG9wdGlvbnMuc3RyZWFtaW5nID8/IGZhbHNlO1xuXG4gICAgICAgIC8vIEZvciBzdHJlYW1pbmcsIHdlIHVzZSBTVFJFQU0gcmVzcG9uc2VUcmFuc2Zlck1vZGVcbiAgICAgICAgLy8gTm90ZTogVGhlIFVSSSBzdWZmaXggYW5kIHRpbWVvdXQgd2lsbCBiZSBmaXhlZCB2aWEgTDEgb3ZlcnJpZGVzXG4gICAgICAgIHJldHVybiBuZXcgYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24oaGFuZGxlciwge1xuICAgICAgICAgICAgcHJveHk6IHRydWUsXG4gICAgICAgICAgICByZXNwb25zZVRyYW5zZmVyTW9kZTogc3RyZWFtaW5nID8gYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuU1RSRUFNIDogYXBpZ3cuUmVzcG9uc2VUcmFuc2Zlck1vZGUuQlVGRkVSRUQsXG4gICAgICAgICAgICB0aW1lb3V0OiBvcHRpb25zLnRpbWVvdXQgPz8gKHN0cmVhbWluZyA/IER1cmF0aW9uLm1pbnV0ZXMoMTUpIDogdW5kZWZpbmVkKSxcbiAgICAgICAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IG9wdGlvbnMucGFzc3Rocm91Z2hCZWhhdmlvcixcbiAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IG9wdGlvbnMucmVxdWVzdFRlbXBsYXRlcyxcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQXBwbHkgTDEgQ0ZOIG92ZXJyaWRlcyBmb3Igc3RyZWFtaW5nIHJvdXRlcyB0byBlbnN1cmUgZnVsbCBMaWZ0IHBhcml0eS5cbiAgICAgKlxuICAgICAqIFN0cmVhbWluZyByb3V0ZXMgcmVxdWlyZTpcbiAgICAgKiAxLiBJbnRlZ3JhdGlvbi5SZXNwb25zZVRyYW5zZmVyTW9kZSA9IFNUUkVBTSAoYWxyZWFkeSBzZXQgdmlhIEwyKVxuICAgICAqIDIuIEludGVncmF0aW9uLlVyaSBlbmRzIHdpdGggL3Jlc3BvbnNlLXN0cmVhbWluZy1pbnZvY2F0aW9uc1xuICAgICAqIDMuIEludGVncmF0aW9uLlRpbWVvdXRJbk1pbGxpcyA9IDkwMDAwMCAoMTUgbWludXRlcylcbiAgICAgKi9cbiAgICBwcml2YXRlIGFwcGx5U3RyZWFtaW5nT3ZlcnJpZGVzKFxuICAgICAgICBtZXRob2Q6IGFwaWd3Lk1ldGhvZCxcbiAgICAgICAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICAgICAgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckludGVncmF0aW9uT3B0aW9ucyxcbiAgICApOiB2b2lkIHtcbiAgICAgICAgY29uc3QgY2ZuTWV0aG9kID0gbWV0aG9kLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3LkNmbk1ldGhvZDtcbiAgICAgICAgaWYgKCFjZm5NZXRob2QpIHJldHVybjtcblxuICAgICAgICAvLyBCdWlsZCB0aGUgc3RyZWFtaW5nIFVSSVxuICAgICAgICAvLyBTdGFuZGFyZCBmb3JtYXQ6IGFybjp7cGFydGl0aW9ufTphcGlnYXRld2F5OntyZWdpb259OmxhbWJkYTpwYXRoLzIwMjEtMTEtMTUvZnVuY3Rpb25zL3tmdW5jdGlvbkFybn0vcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXG4gICAgICAgIGNvbnN0IHRpbWVvdXRNcyA9IG9wdGlvbnMudGltZW91dD8udG9NaWxsaXNlY29uZHMoKSA/PyA5MDAwMDA7XG5cbiAgICAgICAgLy8gT3ZlcnJpZGUgdGhlIGludGVncmF0aW9uIHByb3BlcnRpZXNcbiAgICAgICAgY2ZuTWV0aG9kLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJJbnRlZ3JhdGlvbi5UaW1lb3V0SW5NaWxsaXNcIiwgdGltZW91dE1zKTtcblxuICAgICAgICAvLyBUaGUgVVJJIG11c3QgdXNlIHRoZSBzdHJlYW1pbmctc3BlY2lmaWMgcGF0aFxuICAgICAgICAvLyBXZSBjb25zdHJ1Y3QgaXQgdXNpbmcgRm46OkpvaW4gdG8gcHJlc2VydmUgQ2xvdWRGb3JtYXRpb24gaW50cmluc2ljc1xuICAgICAgICBjZm5NZXRob2QuYWRkUHJvcGVydHlPdmVycmlkZShcIkludGVncmF0aW9uLlVyaVwiLCB7XG4gICAgICAgICAgICBcIkZuOjpKb2luXCI6IFtcbiAgICAgICAgICAgICAgICBcIlwiLFxuICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgXCJhcm46XCIsXG4gICAgICAgICAgICAgICAgICAgIHsgUmVmOiBcIkFXUzo6UGFydGl0aW9uXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgXCI6YXBpZ2F0ZXdheTpcIixcbiAgICAgICAgICAgICAgICAgICAgeyBSZWY6IFwiQVdTOjpSZWdpb25cIiB9LFxuICAgICAgICAgICAgICAgICAgICBcIjpsYW1iZGE6cGF0aC8yMDIxLTExLTE1L2Z1bmN0aW9ucy9cIixcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlci5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgICAgICAgXCIvcmVzcG9uc2Utc3RyZWFtaW5nLWludm9jYXRpb25zXCIsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIGRlcGxveSBvcHRpb25zIGZvciB0aGUgc3RhZ2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZERlcGxveU9wdGlvbnMoXG4gICAgICAgIHN0YWdlT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlclN0YWdlT3B0aW9ucyxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgKTogYXBpZ3cuU3RhZ2VPcHRpb25zIHtcbiAgICAgICAgLy8gSGFuZGxlIGFjY2VzcyBsb2dnaW5nXG4gICAgICAgIGxldCBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogYXBpZ3cuSUFjY2Vzc0xvZ0Rlc3RpbmF0aW9uIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgYWNjZXNzTG9nRm9ybWF0ID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAgICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIENyZWF0ZSBhbiBhdXRvLW1hbmFnZWQgbG9nIGdyb3VwXG4gICAgICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24gPSBuZXcgYXBpZ3cuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCk7XG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQgPSBhY2Nlc3NMb2dGb3JtYXQgPz8gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmNsZigpO1xuICAgICAgICB9IGVsc2UgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nICYmIHR5cGVvZiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICAgICAgLy8gVXNlIHByb3ZpZGVkIGxvZyBncm91cFxuICAgICAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmc7XG4gICAgICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbiA9IG5ldyBhcGlndy5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKTtcbiAgICAgICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdCA9IGFjY2Vzc0xvZ0Zvcm1hdCA/PyBhcGlndy5BY2Nlc3NMb2dGb3JtYXQuY2xmKCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb24sXG4gICAgICAgICAgICBhY2Nlc3NMb2dGb3JtYXQsXG4gICAgICAgICAgICBtZXRyaWNzRW5hYmxlZDogc3RhZ2VPcHRzLmRldGFpbGVkTWV0cmljcyxcbiAgICAgICAgICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTZXQgdXAgY3VzdG9tIGRvbWFpbiB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkLlxuICAgICAqL1xuICAgIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oZG9tYWluT3B0czogQXBwVGhlb3J5UmVzdEFwaVJvdXRlckRvbWFpbk9wdGlvbnMpOiB2b2lkIHtcbiAgICAgICAgLy8gR2V0IG9yIGNyZWF0ZSB0aGUgY2VydGlmaWNhdGUgcmVmZXJlbmNlXG4gICAgICAgIGNvbnN0IGNlcnRpZmljYXRlID0gZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZSA/PyAoZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgICAgICAgPyAoYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQpO1xuXG4gICAgICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVJlc3RBcGlSb3V0ZXI6IGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRvbWFpbiBuYW1lXG4gICAgICAgIGNvbnN0IGVuZHBvaW50VHlwZSA9IGRvbWFpbk9wdHMuZW5kcG9pbnRUeXBlID8/IGFwaWd3LkVuZHBvaW50VHlwZS5SRUdJT05BTDtcbiAgICAgICAgY29uc3QgZG1uID0gbmV3IGFwaWd3LkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk9wdHMuZG9tYWluTmFtZSxcbiAgICAgICAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgICAgICAgZW5kcG9pbnRUeXBlLFxuICAgICAgICAgICAgc2VjdXJpdHlQb2xpY3k6IGRvbWFpbk9wdHMuc2VjdXJpdHlQb2xpY3kgPz8gYXBpZ3cuU2VjdXJpdHlQb2xpY3kuVExTXzFfMixcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3LkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRtbjtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGJhc2UgcGF0aCBtYXBwaW5nXG4gICAgICAgIGNvbnN0IG1hcHBpbmcgPSBuZXcgYXBpZ3cuQmFzZVBhdGhNYXBwaW5nKHRoaXMsIFwiQmFzZVBhdGhNYXBwaW5nXCIsIHtcbiAgICAgICAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgICAgICAgIHJlc3RBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgICAgYmFzZVBhdGg6IGRvbWFpbk9wdHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYmFzZVBhdGhNYXBwaW5nPzogYXBpZ3cuQmFzZVBhdGhNYXBwaW5nIH0pLmJhc2VQYXRoTWFwcGluZyA9IG1hcHBpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHJvdXRlNTN0YXJnZXRzLkFwaUdhdGV3YXlEb21haW4oZG1uKSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICh0aGlzIGFzIHsgYVJlY29yZD86IHJvdXRlNTMuQVJlY29yZCB9KS5hUmVjb3JkID0gcmVjb3JkO1xuXG4gICAgICAgICAgICBpZiAoZG9tYWluT3B0cy5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYWFhYVJlY29yZCA9IG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyByb3V0ZTUzdGFyZ2V0cy5BcGlHYXRld2F5RG9tYWluKGRtbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICh0aGlzIGFzIHsgYWFhYVJlY29yZD86IHJvdXRlNTMuQWFhYVJlY29yZCB9KS5hYWFhUmVjb3JkID0gYWFhYVJlY29yZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJ1aWxkIG1ldGhvZCByZXNwb25zZXMgZm9yIENPUlMtZW5hYmxlZCBlbmRwb2ludHMuXG4gICAgICovXG4gICAgcHJpdmF0ZSBidWlsZE1ldGhvZFJlc3BvbnNlcygpOiBhcGlndy5NZXRob2RSZXNwb25zZVtdIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIENPUlMgcHJlZmxpZ2h0IChPUFRJT05TKSBtZXRob2QgdG8gYSByZXNvdXJjZS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGFkZENvcnNQcmVmbGlnaHRNZXRob2QocmVzb3VyY2U6IGFwaWd3LklSZXNvdXJjZSk6IHZvaWQge1xuICAgICAgICBjb25zdCBvcHRzID0gdGhpcy5jb3JzT3B0aW9ucyA/PyB7fTtcbiAgICAgICAgY29uc3QgYWxsb3dPcmlnaW5zID0gb3B0cy5hbGxvd09yaWdpbnMgPz8gW1wiKlwiXTtcbiAgICAgICAgY29uc3QgYWxsb3dNZXRob2RzID0gb3B0cy5hbGxvd01ldGhvZHMgPz8gW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIk9QVElPTlNcIiwgXCJQQVRDSFwiLCBcIkhFQURcIl07XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVycyA9IG9wdHMuYWxsb3dIZWFkZXJzID8/IFtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCIsXG4gICAgICAgICAgICBcIkF1dGhvcml6YXRpb25cIixcbiAgICAgICAgICAgIFwiWC1BbXotRGF0ZVwiLFxuICAgICAgICAgICAgXCJYLUFwaS1LZXlcIixcbiAgICAgICAgICAgIFwiWC1BbXotU2VjdXJpdHktVG9rZW5cIixcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYWxsb3dDcmVkZW50aWFscyA9IG9wdHMuYWxsb3dDcmVkZW50aWFscyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgbWF4QWdlID0gb3B0cy5tYXhBZ2UgPz8gRHVyYXRpb24uc2Vjb25kcyg2MDApO1xuXG4gICAgICAgIGNvbnN0IGFsbG93T3JpZ2luID0gYWxsb3dPcmlnaW5zLmpvaW4oXCIsXCIpO1xuICAgICAgICBjb25zdCBhbGxvd01ldGhvZHNTdHIgPSBhbGxvd01ldGhvZHMuam9pbihcIixcIik7XG4gICAgICAgIGNvbnN0IGFsbG93SGVhZGVyc1N0ciA9IGFsbG93SGVhZGVycy5qb2luKFwiLFwiKTtcblxuICAgICAgICByZXNvdXJjZS5hZGRNZXRob2QoXG4gICAgICAgICAgICBcIk9QVElPTlNcIixcbiAgICAgICAgICAgIG5ldyBhcGlndy5Nb2NrSW50ZWdyYXRpb24oe1xuICAgICAgICAgICAgICAgIGludGVncmF0aW9uUmVzcG9uc2VzOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVyc1wiOiBgJyR7YWxsb3dIZWFkZXJzU3RyfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzXCI6IGAnJHthbGxvd01ldGhvZHNTdHJ9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpblwiOiBgJyR7YWxsb3dPcmlnaW59J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IGAnJHthbGxvd0NyZWRlbnRpYWxzfSdgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1NYXgtQWdlXCI6IGAnJHttYXhBZ2UudG9TZWNvbmRzKCl9J2AsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6ICd7XCJzdGF0dXNDb2RlXCI6IDIwMH0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5BY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHNcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLUFsbG93LUNyZWRlbnRpYWxzXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkFjY2Vzcy1Db250cm9sLU1heC1BZ2VcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICk7XG4gICAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gICAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gICAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgICB9XG4gICAgcmV0dXJuIGZxZG47XG59XG4iXX0=