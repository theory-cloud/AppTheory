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
AppTheoryMcpServer[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "3.0.2" };
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
            || parsedIssuer.protocol !== "https:"
            || !parsedIssuer.hostname
            || parsedIssuer.username !== ""
            || parsedIssuer.password !== ""
            || literalIssuer.includes("?")
            || literalIssuer.includes("#")) {
            throw new Error("AppTheoryMcpServer: authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment");
        }
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(jwksUri) && !jwksUri.trim()) {
        throw new Error("AppTheoryMcpServer: jwksUri must not be empty");
    }
    return { authorizationServerIssuer, jwksUri };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUQ7QUFDbkQsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJDQUFnRDtBQThJaEQ7Ozs7Ozs7Ozs7Ozs7OztHQWVHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUztJQThDL0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLE9BQU8sSUFBSSw2QkFBaUIsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDckYsSUFBSSxDQUFDLDZCQUE2QixHQUFHLEdBQUcsNkJBQWlCLENBQUMsd0JBQXdCLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BHLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzlDLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLElBQUksVUFBVSxDQUFDO1FBRXBELE1BQU0sa0JBQWtCLEdBQUcsU0FBUyxLQUFLLFVBQVU7ZUFDOUMsU0FBUyxDQUFDLGFBQWE7ZUFDdkIsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVM7ZUFDM0MsU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztRQUVsRCxxQ0FBcUM7UUFDckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZ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QUFPLEVBQUUsQ0FBQztBQUNoRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFBhdGhzIH0gZnJvbSBcIi4vbWNwLXBhdGhzXCI7XG5cbi8qKlxuICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgTUNQIHNlcnZlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGUuZy4sIFwibWNwLmV4YW1wbGUuY29tXCIpLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhdXRvbWF0aWMgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICogSWYgcHJvdmlkZWQsIGEgQ05BTUUgcmVjb3JkIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIEROUyByZWNvcmQgY3JlYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKipcbiAqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1Agc2VydmVyIEFQSSBHYXRld2F5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKipcbiAgICogVGhlIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyBNQ1AgcmVxdWVzdHMuXG4gICAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBMaXRlcmFsIHJvdXRlIHBhdGggZm9yIHRoZSBNQ1AgZW5kcG9pbnQuXG4gICAqXG4gICAqIFRoaXMgaXMgYSBzeW50aGVzaXMtdGltZSBwYXRoLCBuZXZlciBhbiBvcmlnaW4gb3IgZnVsbCByZXNvdXJjZSBVUkwuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFBhdGhzLk1DUFxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogT0F1dGggYXV0aG9yaXphdGlvbiBzZXJ2ZXIgaXNzdWVyIHBhc3NlZCB0byB0aGUgTGFtYmRhIHJ1bnRpbWUgY29uZmlnLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgZG9lcyBub3QgcGFyc2UgdGhpcyB2YWx1ZSBvciB1c2UgaXQgdG8gc3ludGhlc2l6ZSByZXNvdXJjZSBVUkxzLlxuICAgKiBTdXBwbHkgYGp3a3NVcmlgIHdpdGggdGhpcyBwcm9wIHRvIGVuYWJsZSB0aGUgcnVudGltZS1zZXJ2ZWQgUkZDIDk3MjhcbiAgICogZGlzY292ZXJ5IHJvdXRlcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChsZWdhY3kgUE9TVC1vbmx5IE1DUCByb3V0ZSlcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9BdXRoIEpTT04gV2ViIEtleSBTZXQgVVJMIHBhc3NlZCB0byB0aGUgTGFtYmRhIHJ1bnRpbWUgY29uZmlnLlxuICAgKlxuICAgKiBTdXBwbHkgYGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXJgIHdpdGggdGhpcyBwcm9wLiBDREsgdG9rZW5zIGFyZSBhY2NlcHRlZFxuICAgKiBiZWNhdXNlIHRoZSB2YWx1ZSBpcyBmb3J3YXJkZWQsIG5vdCBwYXJzZWQgZHVyaW5nIHN5bnRoZXNpcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChsZWdhY3kgUE9TVC1vbmx5IE1DUCByb3V0ZSlcbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIER5bmFtb0RCIHRhYmxlIGZvciBzZXNzaW9uIHN0YXRlIHN0b3JhZ2UuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgc2Vzc2lvbiBEeW5hbW9EQiB0YWJsZS5cbiAgICogT25seSB1c2VkIHdoZW4gZW5hYmxlU2Vzc2lvblRhYmxlIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoYXV0by1nZW5lcmF0ZWQpXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUVEwgaW4gbWludXRlcyBmb3Igc2Vzc2lvbiByZWNvcmRzLlxuICAgKiBPbmx5IHVzZWQgd2hlbiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZS5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVmYXVsdHMgYXBwbGllZClcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIFVtYnJlbGxhIGRlcGxveW1lbnQgY29udHJhY3QgZm9yIGEgbmFtZXNwYWNlIE1DUCBzZXJ2ZXIuXG4gKlxuICogVGhlIGNvbnN0cnVjdCBwcm92aXNpb25zIGFuIEhUVFAgQVBJIEdhdGV3YXkgdjIgd2l0aCBhIExhbWJkYSBpbnRlZ3JhdGlvblxuICogb24gdGhlIGNvbnZlbnRpb25hbCBQT1NUIC9tY3AgcGF0aCwgb3B0aW9uYWwgcnVudGltZS1zZXJ2ZWQgUkZDIDk3MjhcbiAqIGRpc2NvdmVyeSByb3V0ZXMsIG9wdGlvbmFsIER5bmFtb0RCIHNlc3Npb24gc3RhdGUsIGFuZCBhbiBvcHRpb25hbCBjdXN0b21cbiAqIGRvbWFpbi4gUmVzb3VyY2Ugb3JpZ2lucyBhcmUgaW50ZW50aW9uYWxseSBhYnNlbnQgZnJvbSB0aGUgcHJvcCBzdXJmYWNlOlxuICogdGhlIEdvIHJ1bnRpbWUgZGVyaXZlcyB0aGUgcHJvdGVjdGVkIHJlc291cmNlIGhvc3QgZnJvbSBlYWNoIHJlcXVlc3QuXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHNlcnZlciA9IG5ldyBBcHBUaGVvcnlNY3BTZXJ2ZXIodGhpcywgJ01jcFNlcnZlcicsIHtcbiAqICAgaGFuZGxlcjogbWNwRm4sXG4gKiAgIGVuYWJsZVNlc3Npb25UYWJsZTogdHJ1ZSxcbiAqICAgc2Vzc2lvblR0bE1pbnV0ZXM6IDEyMCxcbiAqIH0pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFRoZSBEeW5hbW9EQiBzZXNzaW9uIHRhYmxlIChpZiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZSkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgTUNQIGVuZHBvaW50IFVSTC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBMaXRlcmFsIE1DUCBlbmRwb2ludCByb3V0ZSBwYXRoLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKipcbiAgICogUGF0aC1zY29wZWQgUkZDIDk3MjggZGlzY292ZXJ5IHJvdXRlIGZvciB0aGlzIE1DUCBlbmRwb2ludC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIHJlc291cmNlIChpZiBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcblxuICAvKipcbiAgICogVGhlIEFQSSBtYXBwaW5nIGZvciB0aGUgY3VzdG9tIGRvbWFpbiAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBSb3V0ZTUzIENOQU1FIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB0aGlzLm1jcFBhdGggPSBub3JtYWxpemVSb3V0ZVBhdGgocHJvcHMubWNwUGF0aCA/PyBBcHBUaGVvcnlNY3BQYXRocy5NQ1AsIFwibWNwUGF0aFwiKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gYCR7QXBwVGhlb3J5TWNwUGF0aHMuT0FVVEhfUFJPVEVDVEVEX1JFU09VUkNFfSR7dGhpcy5tY3BQYXRofWA7XG4gICAgY29uc3QgYXV0aENvbmZpZyA9IG5vcm1hbGl6ZUF1dGhDb25maWcocHJvcHMpO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiO1xuXG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIC8vIENyZWF0ZSBIVFRQIEFQSSB3aXRoIGRlZmF1bHQgc3RhZ2VcbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogIW5lZWRzRXhwbGljaXRTdGFnZSxcbiAgICB9KTtcblxuICAgIC8vIElmIGN1c3RvbSBzdGFnZSBvcHRpb25zLCBjcmVhdGUgdGhlIHN0YWdlIGV4cGxpY2l0bHlcbiAgICBsZXQgc3RhZ2U6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkO1xuICAgIGlmIChuZWVkc0V4cGxpY2l0U3RhZ2UpIHtcbiAgICAgIHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBTZXQgdXAgYWNjZXNzIGxvZ2dpbmcgaWYgZW5hYmxlZFxuICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgICAgICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICAgICAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICAgICAgICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgICAgICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICAgICAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc3RhZ2UgPSB0aGlzLmFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgfVxuXG4gICAgY29uc3QgaGFuZGxlckludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiTWNwSGFuZGxlclwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICB9KTtcblxuICAgIC8vIFJvdXRlIE1DUCBwcm90b2NvbCB0cmFmZmljIHRvIHRoZSBhcHBsaWNhdGlvbiBydW50aW1lLlxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiB0aGlzLm1jcFBhdGgsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IGhhbmRsZXJJbnRlZ3JhdGlvbixcbiAgICB9KTtcblxuICAgIGlmIChhdXRoQ29uZmlnKSB7XG4gICAgICAvLyBEaXNjb3Zlcnkgc3RheXMgdW5hdXRoZW50aWNhdGVkIGF0IEFQSSBHYXRld2F5LiBUaGUgbWF0Y2hpbmcgR28gaGVscGVyXG4gICAgICAvLyByZWdpc3RlcnMgdGhlc2Ugcm91dGVzIHdpdGggU2VjdXJlQXBwIFB1YmxpYyBwb3N0dXJlIHdoaWxlIHJlZ2lzdGVyaW5nXG4gICAgICAvLyB0aGUgTUNQIHJvdXRlIGFzIEF1dGhlbnRpY2F0ZWQuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICBwYXRoOiBBcHBUaGVvcnlNY3BQYXRocy5PQVVUSF9QUk9URUNURURfUkVTT1VSQ0UsXG4gICAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuR0VUXSxcbiAgICAgICAgaW50ZWdyYXRpb246IGhhbmRsZXJJbnRlZ3JhdGlvbixcbiAgICAgIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCxcbiAgICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogaGFuZGxlckludGVncmF0aW9uLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJBUFBUSEVPUllfTUNQX1BBVEhcIiwgdGhpcy5tY3BQYXRoKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQoXG4gICAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICAgIFwiQVBQVEhFT1JZX01DUF9QUk9URUNURURfUkVTT1VSQ0VfUEFUSFwiLFxuICAgICAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoLFxuICAgICAgKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQoXG4gICAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICAgIFwiQVBQVEhFT1JZX01DUF9BVVRIT1JJWkFUSU9OX1NFUlZFUl9JU1NVRVJcIixcbiAgICAgICAgYXV0aENvbmZpZy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyLFxuICAgICAgKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJBUFBUSEVPUllfTUNQX0pXS1NfVVJJXCIsIGF1dGhDb25maWcuandrc1VyaSk7XG4gICAgfVxuXG4gICAgLy8gT3B0aW9uYWwgc2Vzc2lvbiB0YWJsZVxuICAgIGlmIChwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5zZXNzaW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcblxuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zZXNzaW9uVGFibGUpIHtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhwcm9wcy5zZXNzaW9uVHRsTWludXRlcyA/PyA2MCkpO1xuICAgIH1cblxuICAgIC8vIE9wdGlvbmFsIGN1c3RvbSBkb21haW5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICBpZiAoIXN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogbm8gc3RhZ2UgYXZhaWxhYmxlIGZvciBkb21haW4gbWFwcGluZ1wiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ocHJvcHMuZG9tYWluLCBzdGFnZSk7XG4gICAgICB0aGlzLmVuZHBvaW50ID0gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGBodHRwczovLyR7cHJvcHMuZG9tYWluLmRvbWFpbk5hbWV9YCl9JHt0aGlzLm1jcFBhdGh9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQ29tcHV0ZSBleGVjdXRlLWFwaSBlbmRwb2ludCBVUkwgKGluY2x1ZGUgc3RhZ2UgcGF0aCB1bmxlc3MgdXNpbmcgJGRlZmF1bHQpLlxuICAgICAgY29uc3QgYmFzZVVybCA9IChzdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIilcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke3N0YWdlTmFtZX1gO1xuICAgICAgdGhpcy5lbmRwb2ludCA9IGAke3N0cmlwVHJhaWxpbmdTbGFzaChiYXNlVXJsKX0ke3RoaXMubWNwUGF0aH1gO1xuICAgIH1cblxuICAgIC8vIEluamVjdCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgaW50byB0aGUgTGFtYmRhIGhhbmRsZXJcbiAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX0VORFBPSU5UXCIsIHRoaXMuZW5kcG9pbnQpO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZCBhbiBlbnZpcm9ubWVudCB2YXJpYWJsZSB0byB0aGUgTGFtYmRhIGZ1bmN0aW9uLlxuICAgKiBVc2VzIGFkZEVudmlyb25tZW50IGlmIGF2YWlsYWJsZSAoRnVuY3Rpb24pLCBvdGhlcndpc2UgdXNlcyBMMSBvdmVycmlkZS5cbiAgICovXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2V0IHVwIGN1c3RvbSBkb21haW4gd2l0aCBvcHRpb25hbCBSb3V0ZTUzIHJlY29yZC5cbiAgICovXG4gIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oZG9tYWluT3B0czogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucywgc3RhZ2U6IGFwaWd3djIuSVN0YWdlKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuXG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRtbiA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk9wdHMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG1uO1xuXG4gICAgY29uc3QgbWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lOiBkbW4sXG4gICAgICBzdGFnZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmcgfSkuYXBpTWFwcGluZyA9IG1hcHBpbmc7XG5cbiAgICBpZiAoZG9tYWluT3B0cy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCByZWNvcmROYW1lID0gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5PcHRzLmRvbWFpbk5hbWUsIGRvbWFpbk9wdHMuaG9zdGVkWm9uZSk7XG4gICAgICBjb25zdCByZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNuYW1lUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICBkb21haW5OYW1lOiBkbW4ucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IHJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBDb252ZXJ0IGEgZG9tYWluIG5hbWUgdG8gYSBSb3V0ZTUzIHJlY29yZCBuYW1lIHJlbGF0aXZlIHRvIHRoZSB6b25lLlxuICovXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgaWYgKGZxZG4uZW5kc1dpdGgoc3VmZml4KSkge1xuICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcGF0aGApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgLy8gTGl0ZXJhbCBNQ1Agcm91dGUgcGF0aHMgdXNlIG9ubHkgUkZDIDM5ODYgcGF0aCBjaGFyYWN0ZXJzLCB3aXRoIHBlcmNlbnQtZW5jb2RpbmcgcmVxdWlyZWQgZm9yIHdoaXRlc3BhY2UgYW5kIG90aGVyIGNoYXJhY3RlcnMgb3V0c2lkZSB0aGF0IHNldC5cbiAgY29uc3QgbGl0ZXJhbFJvdXRlUGF0aFBhdHRlcm4gPSAvXlxcLyg/OltBLVphLXowLTkuX34hJCYnKCkqKyw7PTpALV18JVswLTlBLUZhLWZdezJ9KSsoPzpcXC8oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrKSokLztcbiAgaWYgKFxuICAgICFsaXRlcmFsUm91dGVQYXRoUGF0dGVybi50ZXN0KHJvdXRlUGF0aClcbiAgICB8fCByb3V0ZVBhdGguc3BsaXQoXCIvXCIpLnNvbWUoKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBsaXRlcmFsIGFic29sdXRlIHJvdXRlIHBhdGhgKTtcbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVBdXRoQ29uZmlnKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4pOiB7IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI6IHN0cmluZzsgandrc1VyaTogc3RyaW5nIH0gfCB1bmRlZmluZWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyID0gU3RyaW5nKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIpO1xuICBjb25zdCBqd2tzVXJpID0gU3RyaW5nKHByb3BzLmp3a3NVcmkpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChhdXRob3JpemF0aW9uU2VydmVySXNzdWVyKSkge1xuICAgIGNvbnN0IGxpdGVyYWxJc3N1ZXIgPSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyLnRyaW0oKTtcbiAgICBsZXQgcGFyc2VkSXNzdWVyOiBVUkwgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZElzc3VlciA9IG5ldyBVUkwobGl0ZXJhbElzc3Vlcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gICAgfVxuICAgIGlmIChcbiAgICAgICFwYXJzZWRJc3N1ZXJcbiAgICAgIHx8IHBhcnNlZElzc3Vlci5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgICAgfHwgIXBhcnNlZElzc3Vlci5ob3N0bmFtZVxuICAgICAgfHwgcGFyc2VkSXNzdWVyLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWRJc3N1ZXIucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IGxpdGVyYWxJc3N1ZXIuaW5jbHVkZXMoXCI/XCIpXG4gICAgICB8fCBsaXRlcmFsSXNzdWVyLmluY2x1ZGVzKFwiI1wiKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChqd2tzVXJpKSAmJiAhandrc1VyaS50cmltKCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGp3a3NVcmkgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgcmV0dXJuIHsgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlciwgandrc1VyaSB9O1xufVxuIl19