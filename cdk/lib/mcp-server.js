"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpServer = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigwv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const logs = require("aws-cdk-lib/aws-logs");
const route53 = require("aws-cdk-lib/aws-route53");
const constructs_1 = require("constructs");
const mcp_paths_1 = require("./mcp-paths");
/**
 * Umbrella deployment contract for a namespace MCP server.
 *
 * The construct provisions an HTTP API Gateway v2 with a Lambda integration
 * on the conventional POST /mcp path, optional runtime-served RFC 9728
 * discovery routes, optional DynamoDB session state, and an optional custom
 * domain. Resource origins are intentionally absent from the prop surface:
 * the Go runtime derives the protected resource host from each request.
 *
 * @example
 * const server = new AppTheoryMcpServer(this, 'McpServer', {
 *   handler: mcpFn,
 *   enableSessionTable: true,
 *   sessionTtlMinutes: 120,
 * });
 */
class AppTheoryMcpServer extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        this.mcpPath = normalizeRoutePath(props.mcpPath ?? mcp_paths_1.AppTheoryMcpPaths.MCP, "mcpPath");
        this.protectedResourceMetadataPath = `${mcp_paths_1.AppTheoryMcpPaths.OAUTH_PROTECTED_RESOURCE}${this.mcpPath}`;
        const authConfig = normalizeAuthConfig(props);
        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "$default";
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        // Create HTTP API with default stage
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName,
            createDefaultStage: !needsExplicitStage,
        });
        // If custom stage options, create the stage explicitly
        let stage;
        if (needsExplicitStage) {
            stage = new apigwv2.HttpStage(this, "Stage", {
                httpApi: this.api,
                stageName,
                autoDeploy: true,
                throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
                    ? {
                        rateLimit: stageOpts.throttlingRateLimit,
                        burstLimit: stageOpts.throttlingBurstLimit,
                    }
                    : undefined,
            });
            // Set up access logging if enabled
            if (stageOpts.accessLogging) {
                const logGroup = new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
                this.accessLogGroup = logGroup;
                const cfnStage = stage.node.defaultChild;
                cfnStage.accessLogSettings = {
                    destinationArn: logGroup.logGroupArn,
                    format: JSON.stringify({
                        requestId: "$context.requestId",
                        ip: "$context.identity.sourceIp",
                        requestTime: "$context.requestTime",
                        httpMethod: "$context.httpMethod",
                        routeKey: "$context.routeKey",
                        status: "$context.status",
                        protocol: "$context.protocol",
                        responseLength: "$context.responseLength",
                        integrationLatency: "$context.integrationLatency",
                    }),
                };
            }
        }
        else {
            stage = this.api.defaultStage;
        }
        const handlerIntegration = new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, {
            payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        });
        // Route MCP protocol traffic to the application runtime.
        this.api.addRoutes({
            path: this.mcpPath,
            methods: [apigwv2.HttpMethod.POST],
            integration: handlerIntegration,
        });
        if (authConfig) {
            // Discovery stays unauthenticated at API Gateway. The matching Go helper
            // registers these routes with SecureApp Public posture while registering
            // the MCP route as Authenticated.
            this.api.addRoutes({
                path: mcp_paths_1.AppTheoryMcpPaths.OAUTH_PROTECTED_RESOURCE,
                methods: [apigwv2.HttpMethod.GET],
                integration: handlerIntegration,
            });
            this.api.addRoutes({
                path: this.protectedResourceMetadataPath,
                methods: [apigwv2.HttpMethod.GET],
                integration: handlerIntegration,
            });
            this.addEnvironment(props.handler, "APPTHEORY_MCP_PATH", this.mcpPath);
            this.addEnvironment(props.handler, "APPTHEORY_MCP_PROTECTED_RESOURCE_PATH", this.protectedResourceMetadataPath);
            this.addEnvironment(props.handler, "APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER", authConfig.authorizationServerIssuer);
            this.addEnvironment(props.handler, "APPTHEORY_MCP_JWKS_URI", authConfig.jwksUri);
        }
        // Optional session table
        if (props.enableSessionTable) {
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: props.sessionTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.sessionTable = table;
        }
        if (this.sessionTable) {
            this.addEnvironment(props.handler, "MCP_SESSION_TABLE", this.sessionTable.tableName);
            this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(props.sessionTtlMinutes ?? 60));
        }
        // Optional custom domain
        if (props.domain) {
            if (!stage) {
                throw new Error("AppTheoryMcpServer: no stage available for domain mapping");
            }
            this.setupCustomDomain(props.domain, stage);
            this.endpoint = `${stripTrailingSlash(`https://${props.domain.domainName}`)}${this.mcpPath}`;
        }
        else {
            // Compute execute-api endpoint URL (include stage path unless using $default).
            const baseUrl = (stageName === "$default")
                ? this.api.apiEndpoint
                : `${this.api.apiEndpoint}/${stageName}`;
            this.endpoint = `${stripTrailingSlash(baseUrl)}${this.mcpPath}`;
        }
        // Inject environment variables into the Lambda handler
        this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
    }
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise uses L1 override.
     */
    addEnvironment(handler, key, value) {
        if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
            handler.addEnvironment(key, value);
        }
    }
    /**
     * Set up custom domain with optional Route53 record.
     */
    setupCustomDomain(domainOpts, stage) {
        const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryMcpServer: domain requires either certificate or certificateArn");
        }
        const dmn = new apigwv2.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
        });
        this.domainName = dmn;
        const mapping = new apigwv2.ApiMapping(this, "ApiMapping", {
            api: this.api,
            domainName: dmn,
            stage,
        });
        this.apiMapping = mapping;
        if (domainOpts.hostedZone) {
            const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
            const record = new route53.CnameRecord(this, "CnameRecord", {
                zone: domainOpts.hostedZone,
                recordName,
                domainName: dmn.regionalDomainName,
            });
            this.cnameRecord = record;
        }
    }
}
exports.AppTheoryMcpServer = AppTheoryMcpServer;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMcpServer[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "3.1.0-rc" };
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
function stripTrailingSlash(url) {
    return url.replace(/\/$/, "");
}
function normalizeRoutePath(value, propName) {
    if (aws_cdk_lib_1.Token.isUnresolved(value)) {
        throw new Error(`AppTheoryMcpServer: ${propName} must be a synthesis-time literal path`);
    }
    const routePath = String(value ?? "");
    // Literal MCP route paths use only RFC 3986 path characters, with percent-encoding required for whitespace and other characters outside that set.
    const literalRoutePathPattern = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+)*$/;
    if (!literalRoutePathPattern.test(routePath)
        || routePath.split("/").some((segment) => segment === "." || segment === "..")) {
        throw new Error(`AppTheoryMcpServer: ${propName} must be a literal absolute route path`);
    }
    return routePath;
}
function normalizeAuthConfig(props) {
    const hasIssuer = props.authorizationServerIssuer !== undefined;
    const hasJwksUri = props.jwksUri !== undefined;
    if (hasIssuer !== hasJwksUri) {
        throw new Error("AppTheoryMcpServer: authorizationServerIssuer and jwksUri must be supplied together");
    }
    if (!hasIssuer || !hasJwksUri) {
        return undefined;
    }
    const authorizationServerIssuer = String(props.authorizationServerIssuer);
    const jwksUri = String(props.jwksUri);
    // Literal OAuth configuration URLs must be absolute HTTPS URLs without userinfo or fragments.
    // Issuer URLs must also omit queries.
    if (!aws_cdk_lib_1.Token.isUnresolved(authorizationServerIssuer)) {
        const literalIssuer = authorizationServerIssuer.trim();
        let parsedIssuer;
        try {
            parsedIssuer = new URL(literalIssuer);
        }
        catch {
            // The shared validation error below is the public synthesis contract.
        }
        if (!parsedIssuer
            || !literalURLHasRFC3986Authority(literalIssuer)
            || parsedIssuer.protocol !== "https:"
            || !parsedIssuer.hostname
            || parsedIssuer.username !== ""
            || parsedIssuer.password !== ""
            || literalURLAuthorityHasUserinfo(literalIssuer)
            || literalIssuer.includes("?")
            || literalIssuer.includes("#")) {
            throw new Error("AppTheoryMcpServer: authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment");
        }
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(jwksUri)) {
        const literalJwksUri = jwksUri.trim();
        let parsedJwksUri;
        try {
            parsedJwksUri = new URL(literalJwksUri);
        }
        catch {
            // The shared validation error below is the public synthesis contract.
        }
        if (!parsedJwksUri
            || !literalURLHasRFC3986Authority(literalJwksUri)
            || parsedJwksUri.protocol !== "https:"
            || !parsedJwksUri.hostname
            || parsedJwksUri.username !== ""
            || parsedJwksUri.password !== ""
            || literalURLAuthorityHasUserinfo(literalJwksUri)
            || literalJwksUri.includes("#")) {
            throw new Error("AppTheoryMcpServer: jwksUri must be an absolute HTTPS URL with no userinfo or fragment");
        }
    }
    return { authorizationServerIssuer, jwksUri };
}
function literalURLHasRFC3986Authority(value) {
    const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
    return authority !== undefined && !authority.includes("%");
}
function literalURLAuthorityHasUserinfo(value) {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
    return authority?.includes("@") ?? false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUQ7QUFDbkQsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJDQUFnRDtBQStJaEQ7Ozs7Ozs7Ozs7Ozs7OztHQWVHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUztJQThDL0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLE9BQU8sSUFBSSw2QkFBaUIsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDckYsSUFBSSxDQUFDLDZCQUE2QixHQUFHLEdBQUcsNkJBQWlCLENBQUMsd0JBQXdCLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BHLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzlDLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLElBQUksVUFBVSxDQUFDO1FBRXBELE1BQU0sa0JBQWtCLEdBQUcsU0FBUyxLQUFLLFVBQVU7ZUFDOUMsU0FBUyxDQUFDLGFBQWE7ZUFDdkIsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVM7ZUFDM0MsU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztRQUVsRCxxQ0FBcUM7UUFDckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZ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IHsgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFBhdGhzIH0gZnJvbSBcIi4vbWNwLXBhdGhzXCI7XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgTUNQIHNlcnZlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwibWNwLmV4YW1wbGUuY29tXCIpLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhdXRvbWF0aWMgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICogSWYgcHJvdmlkZWQsIGEgQ05BTUUgcmVjb3JkIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIEROUyByZWNvcmQgY3JlYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKipcbiAqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1Agc2VydmVyIEFQSSBHYXRld2F5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKipcbiAgICogVGhlIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyBNQ1AgcmVxdWVzdHMuXG4gICAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBMaXRlcmFsIHJvdXRlIHBhdGggZm9yIHRoZSBNQ1AgZW5kcG9pbnQuXG4gICAqXG4gICAqIFRoaXMgaXMgYSBzeW50aGVzaXMtdGltZSBwYXRoLCBuZXZlciBhbiBvcmlnaW4gb3IgZnVsbCByZXNvdXJjZSBVUkwuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFBhdGhzLk1DUFxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogT0F1dGggYXV0aG9yaXphdGlvbiBzZXJ2ZXIgaXNzdWVyIHBhc3NlZCB0byB0aGUgTGFtYmRhIHJ1bnRpbWUgY29uZmlnLlxuICAgKlxuICAgKiBMaXRlcmFsIHZhbHVlcyBtdXN0IGJlIGFic29sdXRlIEhUVFBTIFVSTHMgd2l0aCBubyB1c2VyaW5mbywgcXVlcnksIG9yXG4gICAqIGZyYWdtZW50LiBDREsgdG9rZW5zIHBhc3MgdGhyb3VnaCB1bnBhcnNlZC4gU3VwcGx5IGBqd2tzVXJpYCB3aXRoIHRoaXMgcHJvcFxuICAgKiB0byBlbmFibGUgdGhlIHJ1bnRpbWUtc2VydmVkIFJGQyA5NzI4IGRpc2NvdmVyeSByb3V0ZXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobGVnYWN5IFBPU1Qtb25seSBNQ1Agcm91dGUpXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPQXV0aCBKU09OIFdlYiBLZXkgU2V0IFVSTCBwYXNzZWQgdG8gdGhlIExhbWJkYSBydW50aW1lIGNvbmZpZy5cbiAgICpcbiAgICogTGl0ZXJhbCB2YWx1ZXMgbXVzdCBiZSBhYnNvbHV0ZSBIVFRQUyBVUkxzIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnQ7XG4gICAqIHF1ZXJpZXMgYXJlIGFsbG93ZWQuIENESyB0b2tlbnMgcGFzcyB0aHJvdWdoIHVucGFyc2VkLiBTdXBwbHlcbiAgICogYGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXJgIHdpdGggdGhpcyBwcm9wLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGxlZ2FjeSBQT1NULW9ubHkgTUNQIHJvdXRlKVxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQ3JlYXRlIGEgRHluYW1vREIgdGFibGUgZm9yIHNlc3Npb24gc3RhdGUgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWUgZm9yIHRoZSBzZXNzaW9uIER5bmFtb0RCIHRhYmxlLlxuICAgKiBPbmx5IHVzZWQgd2hlbiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChhdXRvLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuXG4gICAqIE9ubHkgdXNlZCB3aGVuIGVuYWJsZVNlc3Npb25UYWJsZSBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCA2MFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjdXN0b20gZG9tYWluKVxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChkZWZhdWx0cyBhcHBsaWVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogVW1icmVsbGEgZGVwbG95bWVudCBjb250cmFjdCBmb3IgYSBuYW1lc3BhY2UgTUNQIHNlcnZlci5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgYW4gSFRUUCBBUEkgR2F0ZXdheSB2MiB3aXRoIGEgTGFtYmRhIGludGVncmF0aW9uXG4gKiBvbiB0aGUgY29udmVudGlvbmFsIFBPU1QgL21jcCBwYXRoLCBvcHRpb25hbCBydW50aW1lLXNlcnZlZCBSRkMgOTcyOFxuICogZGlzY292ZXJ5IHJvdXRlcywgb3B0aW9uYWwgRHluYW1vREIgc2Vzc2lvbiBzdGF0ZSwgYW5kIGFuIG9wdGlvbmFsIGN1c3RvbVxuICogZG9tYWluLiBSZXNvdXJjZSBvcmlnaW5zIGFyZSBpbnRlbnRpb25hbGx5IGFic2VudCBmcm9tIHRoZSBwcm9wIHN1cmZhY2U6XG4gKiB0aGUgR28gcnVudGltZSBkZXJpdmVzIHRoZSBwcm90ZWN0ZWQgcmVzb3VyY2UgaG9zdCBmcm9tIGVhY2ggcmVxdWVzdC5cbiAqXG4gKiBAZXhhbXBsZVxuICogY29uc3Qgc2VydmVyID0gbmV3IEFwcFRoZW9yeU1jcFNlcnZlcih0aGlzLCAnTWNwU2VydmVyJywge1xuICogICBoYW5kbGVyOiBtY3BGbixcbiAqICAgZW5hYmxlU2Vzc2lvblRhYmxlOiB0cnVlLFxuICogICBzZXNzaW9uVHRsTWludXRlczogMTIwLFxuICogfSk7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgSFRUUCBBUEkgR2F0ZXdheSB2Mi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSHR0cEFwaTtcblxuICAvKipcbiAgICogVGhlIER5bmFtb0RCIHNlc3Npb24gdGFibGUgKGlmIGVuYWJsZVNlc3Npb25UYWJsZSBpcyB0cnVlKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBNQ1AgZW5kcG9pbnQgVVJMLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExpdGVyYWwgTUNQIGVuZHBvaW50IHJvdXRlIHBhdGguXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQYXRoLXNjb3BlZCBSRkMgOTcyOCBkaXNjb3Zlcnkgcm91dGUgZm9yIHRoaXMgTUNQIGVuZHBvaW50LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgcmVzb3VyY2UgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIG1hcHBpbmcgZm9yIHRoZSBjdXN0b20gZG9tYWluIChpZiBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcblxuICAvKipcbiAgICogVGhlIFJvdXRlNTMgQ05BTUUgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMubWNwUGF0aCA9IG5vcm1hbGl6ZVJvdXRlUGF0aChwcm9wcy5tY3BQYXRoID8/IEFwcFRoZW9yeU1jcFBhdGhzLk1DUCwgXCJtY3BQYXRoXCIpO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGggPSBgJHtBcHBUaGVvcnlNY3BQYXRocy5PQVVUSF9QUk9URUNURURfUkVTT1VSQ0V9JHt0aGlzLm1jcFBhdGh9YDtcbiAgICBjb25zdCBhdXRoQ29uZmlnID0gbm9ybWFsaXplQXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG5cbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgLy8gQ3JlYXRlIEhUVFAgQVBJIHdpdGggZGVmYXVsdCBzdGFnZVxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgIH0pO1xuXG4gICAgLy8gSWYgY3VzdG9tIHN0YWdlIG9wdGlvbnMsIGNyZWF0ZSB0aGUgc3RhZ2UgZXhwbGljaXRseVxuICAgIGxldCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgaWYgKG5lZWRzRXhwbGljaXRTdGFnZSkge1xuICAgICAgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNldCB1cCBhY2Nlc3MgbG9nZ2luZyBpZiBlbmFibGVkXG4gICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgICAgZm9ybWF0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgICAgICAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgICAgICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgICAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgICAgICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICAgICAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgICAgICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgICAgICAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdGFnZSA9IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGVySW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJNY3BIYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgIH0pO1xuXG4gICAgLy8gUm91dGUgTUNQIHByb3RvY29sIHRyYWZmaWMgdG8gdGhlIGFwcGxpY2F0aW9uIHJ1bnRpbWUuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IHRoaXMubWNwUGF0aCxcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogaGFuZGxlckludGVncmF0aW9uLFxuICAgIH0pO1xuXG4gICAgaWYgKGF1dGhDb25maWcpIHtcbiAgICAgIC8vIERpc2NvdmVyeSBzdGF5cyB1bmF1dGhlbnRpY2F0ZWQgYXQgQVBJIEdhdGV3YXkuIFRoZSBtYXRjaGluZyBHbyBoZWxwZXJcbiAgICAgIC8vIHJlZ2lzdGVycyB0aGVzZSByb3V0ZXMgd2l0aCBTZWN1cmVBcHAgUHVibGljIHBvc3R1cmUgd2hpbGUgcmVnaXN0ZXJpbmdcbiAgICAgIC8vIHRoZSBNQ1Agcm91dGUgYXMgQXV0aGVudGljYXRlZC5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IEFwcFRoZW9yeU1jcFBhdGhzLk9BVVRIX1BST1RFQ1RFRF9SRVNPVVJDRSxcbiAgICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogaGFuZGxlckludGVncmF0aW9uLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICBwYXRoOiB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICAgIGludGVncmF0aW9uOiBoYW5kbGVySW50ZWdyYXRpb24sXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIkFQUFRIRU9SWV9NQ1BfUEFUSFwiLCB0aGlzLm1jcFBhdGgpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgICAgXCJBUFBUSEVPUllfTUNQX1BST1RFQ1RFRF9SRVNPVVJDRV9QQVRIXCIsXG4gICAgICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGgsXG4gICAgICApO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgICAgXCJBUFBUSEVPUllfTUNQX0FVVEhPUklaQVRJT05fU0VSVkVSX0lTU1VFUlwiLFxuICAgICAgICBhdXRoQ29uZmlnLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIsXG4gICAgICApO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIkFQUFRIRU9SWV9NQ1BfSldLU19VUklcIiwgYXV0aENvbmZpZy5qd2tzVXJpKTtcbiAgICB9XG5cbiAgICAvLyBPcHRpb25hbCBzZXNzaW9uIHRhYmxlXG4gICAgaWYgKHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLnNlc3Npb25UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNlc3Npb25UYWJsZSkge1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHByb3BzLnNlc3Npb25UdGxNaW51dGVzID8/IDYwKSk7XG4gICAgfVxuXG4gICAgLy8gT3B0aW9uYWwgY3VzdG9tIGRvbWFpblxuICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgIGlmICghc3RhZ2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBubyBzdGFnZSBhdmFpbGFibGUgZm9yIGRvbWFpbiBtYXBwaW5nXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4sIHN0YWdlKTtcbiAgICAgIHRoaXMuZW5kcG9pbnQgPSBgJHtzdHJpcFRyYWlsaW5nU2xhc2goYGh0dHBzOi8vJHtwcm9wcy5kb21haW4uZG9tYWluTmFtZX1gKX0ke3RoaXMubWNwUGF0aH1gO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDb21wdXRlIGV4ZWN1dGUtYXBpIGVuZHBvaW50IFVSTCAoaW5jbHVkZSBzdGFnZSBwYXRoIHVubGVzcyB1c2luZyAkZGVmYXVsdCkuXG4gICAgICBjb25zdCBiYXNlVXJsID0gKHN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiKVxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7c3RhZ2VOYW1lfWA7XG4gICAgICB0aGlzLmVuZHBvaW50ID0gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGJhc2VVcmwpfSR7dGhpcy5tY3BQYXRofWA7XG4gICAgfVxuXG4gICAgLy8gSW5qZWN0IGVudmlyb25tZW50IHZhcmlhYmxlcyBpbnRvIHRoZSBMYW1iZGEgaGFuZGxlclxuICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfRU5EUE9JTlRcIiwgdGhpcy5lbmRwb2ludCk7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGFuIGVudmlyb25tZW50IHZhcmlhYmxlIHRvIHRoZSBMYW1iZGEgZnVuY3Rpb24uXG4gICAqIFVzZXMgYWRkRW52aXJvbm1lbnQgaWYgYXZhaWxhYmxlIChGdW5jdGlvbiksIG90aGVyd2lzZSB1c2VzIEwxIG92ZXJyaWRlLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdXAgY3VzdG9tIGRvbWFpbiB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkLlxuICAgKi9cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG1uID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkbW47XG5cbiAgICBjb25zdCBtYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gbWFwcGluZztcblxuICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgIGRvbWFpbk5hbWU6IGRtbi5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gcmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVQYXRoKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBwYXRoYCk7XG4gIH1cbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpO1xuICAvLyBMaXRlcmFsIE1DUCByb3V0ZSBwYXRocyB1c2Ugb25seSBSRkMgMzk4NiBwYXRoIGNoYXJhY3RlcnMsIHdpdGggcGVyY2VudC1lbmNvZGluZyByZXF1aXJlZCBmb3Igd2hpdGVzcGFjZSBhbmQgb3RoZXIgY2hhcmFjdGVycyBvdXRzaWRlIHRoYXQgc2V0LlxuICBjb25zdCBsaXRlcmFsUm91dGVQYXRoUGF0dGVybiA9IC9eXFwvKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKyg/OlxcLyg/OltBLVphLXowLTkuX34hJCYnKCkqKyw7PTpALV18JVswLTlBLUZhLWZdezJ9KSspKiQvO1xuICBpZiAoXG4gICAgIWxpdGVyYWxSb3V0ZVBhdGhQYXR0ZXJuLnRlc3Qocm91dGVQYXRoKVxuICAgIHx8IHJvdXRlUGF0aC5zcGxpdChcIi9cIikuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIGxpdGVyYWwgYWJzb2x1dGUgcm91dGUgcGF0aGApO1xuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUF1dGhDb25maWcoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbik6IHsgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcjogc3RyaW5nOyBqd2tzVXJpOiBzdHJpbmcgfSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIC8vIExpdGVyYWwgT0F1dGggY29uZmlndXJhdGlvbiBVUkxzIG11c3QgYmUgYWJzb2x1dGUgSFRUUFMgVVJMcyB3aXRob3V0IHVzZXJpbmZvIG9yIGZyYWdtZW50cy5cbiAgLy8gSXNzdWVyIFVSTHMgbXVzdCBhbHNvIG9taXQgcXVlcmllcy5cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoYXV0aG9yaXphdGlvblNlcnZlcklzc3VlcikpIHtcbiAgICBjb25zdCBsaXRlcmFsSXNzdWVyID0gYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlci50cmltKCk7XG4gICAgbGV0IHBhcnNlZElzc3VlcjogVVJMIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWRJc3N1ZXIgPSBuZXcgVVJMKGxpdGVyYWxJc3N1ZXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIHNoYXJlZCB2YWxpZGF0aW9uIGVycm9yIGJlbG93IGlzIHRoZSBwdWJsaWMgc3ludGhlc2lzIGNvbnRyYWN0LlxuICAgIH1cbiAgICBpZiAoXG4gICAgICAhcGFyc2VkSXNzdWVyXG4gICAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbElzc3VlcilcbiAgICAgIHx8IHBhcnNlZElzc3Vlci5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgICAgfHwgIXBhcnNlZElzc3Vlci5ob3N0bmFtZVxuICAgICAgfHwgcGFyc2VkSXNzdWVyLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWRJc3N1ZXIucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyhsaXRlcmFsSXNzdWVyKVxuICAgICAgfHwgbGl0ZXJhbElzc3Vlci5pbmNsdWRlcyhcIj9cIilcbiAgICAgIHx8IGxpdGVyYWxJc3N1ZXIuaW5jbHVkZXMoXCIjXCIpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgY29uc3QgbGl0ZXJhbEp3a3NVcmkgPSBqd2tzVXJpLnRyaW0oKTtcbiAgICBsZXQgcGFyc2VkSndrc1VyaTogVVJMIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWRKd2tzVXJpID0gbmV3IFVSTChsaXRlcmFsSndrc1VyaSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gICAgfVxuICAgIGlmIChcbiAgICAgICFwYXJzZWRKd2tzVXJpXG4gICAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbEp3a3NVcmkpXG4gICAgICB8fCBwYXJzZWRKd2tzVXJpLnByb3RvY29sICE9PSBcImh0dHBzOlwiXG4gICAgICB8fCAhcGFyc2VkSndrc1VyaS5ob3N0bmFtZVxuICAgICAgfHwgcGFyc2VkSndrc1VyaS51c2VybmFtZSAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkSndrc1VyaS5wYXNzd29yZCAhPT0gXCJcIlxuICAgICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWxKd2tzVXJpKVxuICAgICAgfHwgbGl0ZXJhbEp3a3NVcmkuaW5jbHVkZXMoXCIjXCIpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIsIGp3a3NVcmkgfTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXmh0dHBzOlxcL1xcLyhbXi8/I10rKSg/OlsvPyNdfCQpL2kuZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmICFhdXRob3JpdHkuaW5jbHVkZXMoXCIlXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8odmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXltBLVphLXpdW0EtWmEtejAtOSsuLV0qOlxcL1xcLyhbXi8/I10qKS8uZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eT8uaW5jbHVkZXMoXCJAXCIpID8/IGZhbHNlO1xufVxuIl19