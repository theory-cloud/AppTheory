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
function literalURLAuthorityHasUserinfo(value) {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
    return authority?.includes("@") ?? false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUQ7QUFDbkQsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJDQUFnRDtBQStJaEQ7Ozs7Ozs7Ozs7Ozs7OztHQWVHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUztJQThDL0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLE9BQU8sSUFBSSw2QkFBaUIsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDckYsSUFBSSxDQUFDLDZCQUE2QixHQUFHLEdBQUcsNkJBQWlCLENBQUMsd0JBQXdCLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BHLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzlDLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLElBQUksVUFBVSxDQUFDO1FBRXBELE1BQU0sa0JBQWtCLEdBQUcsU0FBUyxLQUFLLFVBQVU7ZUFDOUMsU0FBUyxDQUFDLGFBQWE7ZUFDdkIsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVM7ZUFDM0MsU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztRQUVsRCxxQ0FBcUM7UUFDckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZ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QUE4QixDQUFDO1FBQ25DLElBQUksQ0FBQztZQUNILGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUMxQyxDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ1Asc0VBQXNFO1FBQ3hFLENBQUM7UUFDRCxJQUNFLENBQUMsYUFBYTtlQUNYLGFBQWEsQ0FBQyxRQUFRLEtBQUssUUFBUTtlQUNuQyxDQUFDLGFBQWEsQ0FBQyxRQUFRO2VBQ3ZCLGFBQWEsQ0FBQyxRQUFRLEtBQUssRUFBRTtlQUM3QixhQUFhLENBQUMsUUFBUSxLQUFLLEVBQUU7ZUFDN0IsOEJBQThCLENBQUMsY0FBYyxDQUFDO2VBQzlDLGNBQWMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQy9CLENBQUM7WUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLHdGQUF3RixDQUN6RixDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLEVBQUUseUJBQXlCLEVBQUUsT0FBTyxFQUFFLENBQUM7QUFDaEQsQ0FBQztBQUVELFNBQVMsOEJBQThCLENBQUMsS0FBYTtJQUNuRCxNQUFNLFNBQVMsR0FBRyx3Q0FBd0MsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxPQUFPLFNBQVMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDO0FBQzNDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUGF0aHMgfSBmcm9tIFwiLi9tY3AtcGF0aHNcIjtcblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1Agc2VydmVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZS5nLiwgXCJtY3AuZXhhbXBsZS5jb21cIikuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBJZiBwcm92aWRlZCwgYSBDTkFNRSByZWNvcmQgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCBzZXJ2ZXIgQVBJIEdhdGV3YXkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIE1DUCByZXF1ZXN0cy5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIExpdGVyYWwgcm91dGUgcGF0aCBmb3IgdGhlIE1DUCBlbmRwb2ludC5cbiAgICpcbiAgICogVGhpcyBpcyBhIHN5bnRoZXNpcy10aW1lIHBhdGgsIG5ldmVyIGFuIG9yaWdpbiBvciBmdWxsIHJlc291cmNlIFVSTC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUGF0aHMuTUNQXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPQXV0aCBhdXRob3JpemF0aW9uIHNlcnZlciBpc3N1ZXIgcGFzc2VkIHRvIHRoZSBMYW1iZGEgcnVudGltZSBjb25maWcuXG4gICAqXG4gICAqIExpdGVyYWwgdmFsdWVzIG11c3QgYmUgYWJzb2x1dGUgSFRUUFMgVVJMcyB3aXRoIG5vIHVzZXJpbmZvLCBxdWVyeSwgb3JcbiAgICogZnJhZ21lbnQuIENESyB0b2tlbnMgcGFzcyB0aHJvdWdoIHVucGFyc2VkLiBTdXBwbHkgYGp3a3NVcmlgIHdpdGggdGhpcyBwcm9wXG4gICAqIHRvIGVuYWJsZSB0aGUgcnVudGltZS1zZXJ2ZWQgUkZDIDk3MjggZGlzY292ZXJ5IHJvdXRlcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChsZWdhY3kgUE9TVC1vbmx5IE1DUCByb3V0ZSlcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9BdXRoIEpTT04gV2ViIEtleSBTZXQgVVJMIHBhc3NlZCB0byB0aGUgTGFtYmRhIHJ1bnRpbWUgY29uZmlnLlxuICAgKlxuICAgKiBMaXRlcmFsIHZhbHVlcyBtdXN0IGJlIGFic29sdXRlIEhUVFBTIFVSTHMgd2l0aCBubyB1c2VyaW5mbyBvciBmcmFnbWVudDtcbiAgICogcXVlcmllcyBhcmUgYWxsb3dlZC4gQ0RLIHRva2VucyBwYXNzIHRocm91Z2ggdW5wYXJzZWQuIFN1cHBseVxuICAgKiBgYXV0aG9yaXphdGlvblNlcnZlcklzc3VlcmAgd2l0aCB0aGlzIHByb3AuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobGVnYWN5IFBPU1Qtb25seSBNQ1Agcm91dGUpXG4gICAqL1xuICByZWFkb25seSBqd2tzVXJpPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBEeW5hbW9EQiB0YWJsZSBmb3Igc2Vzc2lvbiBzdGF0ZSBzdG9yYWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogTmFtZSBmb3IgdGhlIHNlc3Npb24gRHluYW1vREIgdGFibGUuXG4gICAqIE9ubHkgdXNlZCB3aGVuIGVuYWJsZVNlc3Npb25UYWJsZSBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGF1dG8tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVFRMIGluIG1pbnV0ZXMgZm9yIHNlc3Npb24gcmVjb3Jkcy5cbiAgICogT25seSB1c2VkIHdoZW4gZW5hYmxlU2Vzc2lvblRhYmxlIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIGN1c3RvbSBkb21haW4pXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHRzIGFwcGxpZWQpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBVbWJyZWxsYSBkZXBsb3ltZW50IGNvbnRyYWN0IGZvciBhIG5hbWVzcGFjZSBNQ1Agc2VydmVyLlxuICpcbiAqIFRoZSBjb25zdHJ1Y3QgcHJvdmlzaW9ucyBhbiBIVFRQIEFQSSBHYXRld2F5IHYyIHdpdGggYSBMYW1iZGEgaW50ZWdyYXRpb25cbiAqIG9uIHRoZSBjb252ZW50aW9uYWwgUE9TVCAvbWNwIHBhdGgsIG9wdGlvbmFsIHJ1bnRpbWUtc2VydmVkIFJGQyA5NzI4XG4gKiBkaXNjb3Zlcnkgcm91dGVzLCBvcHRpb25hbCBEeW5hbW9EQiBzZXNzaW9uIHN0YXRlLCBhbmQgYW4gb3B0aW9uYWwgY3VzdG9tXG4gKiBkb21haW4uIFJlc291cmNlIG9yaWdpbnMgYXJlIGludGVudGlvbmFsbHkgYWJzZW50IGZyb20gdGhlIHByb3Agc3VyZmFjZTpcbiAqIHRoZSBHbyBydW50aW1lIGRlcml2ZXMgdGhlIHByb3RlY3RlZCByZXNvdXJjZSBob3N0IGZyb20gZWFjaCByZXF1ZXN0LlxuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCBzZXJ2ZXIgPSBuZXcgQXBwVGhlb3J5TWNwU2VydmVyKHRoaXMsICdNY3BTZXJ2ZXInLCB7XG4gKiAgIGhhbmRsZXI6IG1jcEZuLFxuICogICBlbmFibGVTZXNzaW9uVGFibGU6IHRydWUsXG4gKiAgIHNlc3Npb25UdGxNaW51dGVzOiAxMjAsXG4gKiB9KTtcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBIVFRQIEFQSSBHYXRld2F5IHYyLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgRHluYW1vREIgc2Vzc2lvbiB0YWJsZSAoaWYgZW5hYmxlU2Vzc2lvblRhYmxlIGlzIHRydWUpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICAvKipcbiAgICogVGhlIE1DUCBlbmRwb2ludCBVUkwuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogTGl0ZXJhbCBNQ1AgZW5kcG9pbnQgcm91dGUgcGF0aC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFBhdGgtc2NvcGVkIFJGQyA5NzI4IGRpc2NvdmVyeSByb3V0ZSBmb3IgdGhpcyBNQ1AgZW5kcG9pbnQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGg6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSByZXNvdXJjZSAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkgbWFwcGluZyBmb3IgdGhlIGN1c3RvbSBkb21haW4gKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgUm91dGU1MyBDTkFNRSByZWNvcmQgKGlmIGRvbWFpbiBhbmQgaG9zdGVkWm9uZSBhcmUgY29uZmlndXJlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjZXNzIGxvZyBncm91cCAoaWYgYWNjZXNzIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5tY3BQYXRoID0gbm9ybWFsaXplUm91dGVQYXRoKHByb3BzLm1jcFBhdGggPz8gQXBwVGhlb3J5TWNwUGF0aHMuTUNQLCBcIm1jcFBhdGhcIik7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IGAke0FwcFRoZW9yeU1jcFBhdGhzLk9BVVRIX1BST1RFQ1RFRF9SRVNPVVJDRX0ke3RoaXMubWNwUGF0aH1gO1xuICAgIGNvbnN0IGF1dGhDb25maWcgPSBub3JtYWxpemVBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIjtcblxuICAgIGNvbnN0IG5lZWRzRXhwbGljaXRTdGFnZSA9IHN0YWdlTmFtZSAhPT0gXCIkZGVmYXVsdFwiXG4gICAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZ1xuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQ7XG5cbiAgICAvLyBDcmVhdGUgSFRUUCBBUEkgd2l0aCBkZWZhdWx0IHN0YWdlXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgfSk7XG5cbiAgICAvLyBJZiBjdXN0b20gc3RhZ2Ugb3B0aW9ucywgY3JlYXRlIHRoZSBzdGFnZSBleHBsaWNpdGx5XG4gICAgbGV0IHN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAobmVlZHNFeHBsaWNpdFN0YWdlKSB7XG4gICAgICBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcblxuICAgICAgLy8gU2V0IHVwIGFjY2VzcyBsb2dnaW5nIGlmIGVuYWJsZWRcbiAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgICAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgICAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YWdlID0gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGNvbnN0IGhhbmRsZXJJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIk1jcEhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgfSk7XG5cbiAgICAvLyBSb3V0ZSBNQ1AgcHJvdG9jb2wgdHJhZmZpYyB0byB0aGUgYXBwbGljYXRpb24gcnVudGltZS5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogdGhpcy5tY3BQYXRoLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBoYW5kbGVySW50ZWdyYXRpb24sXG4gICAgfSk7XG5cbiAgICBpZiAoYXV0aENvbmZpZykge1xuICAgICAgLy8gRGlzY292ZXJ5IHN0YXlzIHVuYXV0aGVudGljYXRlZCBhdCBBUEkgR2F0ZXdheS4gVGhlIG1hdGNoaW5nIEdvIGhlbHBlclxuICAgICAgLy8gcmVnaXN0ZXJzIHRoZXNlIHJvdXRlcyB3aXRoIFNlY3VyZUFwcCBQdWJsaWMgcG9zdHVyZSB3aGlsZSByZWdpc3RlcmluZ1xuICAgICAgLy8gdGhlIE1DUCByb3V0ZSBhcyBBdXRoZW50aWNhdGVkLlxuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogQXBwVGhlb3J5TWNwUGF0aHMuT0FVVEhfUFJPVEVDVEVEX1JFU09VUkNFLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICAgIGludGVncmF0aW9uOiBoYW5kbGVySW50ZWdyYXRpb24sXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGgsXG4gICAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuR0VUXSxcbiAgICAgICAgaW50ZWdyYXRpb246IGhhbmRsZXJJbnRlZ3JhdGlvbixcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiQVBQVEhFT1JZX01DUF9QQVRIXCIsIHRoaXMubWNwUGF0aCk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KFxuICAgICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAgICBcIkFQUFRIRU9SWV9NQ1BfUFJPVEVDVEVEX1JFU09VUkNFX1BBVEhcIixcbiAgICAgICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCxcbiAgICAgICk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KFxuICAgICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAgICBcIkFQUFRIRU9SWV9NQ1BfQVVUSE9SSVpBVElPTl9TRVJWRVJfSVNTVUVSXCIsXG4gICAgICAgIGF1dGhDb25maWcuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlcixcbiAgICAgICk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiQVBQVEhFT1JZX01DUF9KV0tTX1VSSVwiLCBhdXRoQ29uZmlnLmp3a3NVcmkpO1xuICAgIH1cblxuICAgIC8vIE9wdGlvbmFsIHNlc3Npb24gdGFibGVcbiAgICBpZiAocHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlKSB7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwic2Vzc2lvbklkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG5cbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGFibGU7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc2Vzc2lvblRhYmxlKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVEFCTEVcIiwgdGhpcy5zZXNzaW9uVGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UVExfTUlOVVRFU1wiLCBTdHJpbmcocHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgPz8gNjApKTtcbiAgICB9XG5cbiAgICAvLyBPcHRpb25hbCBjdXN0b20gZG9tYWluXG4gICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgaWYgKCFzdGFnZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG5vIHN0YWdlIGF2YWlsYWJsZSBmb3IgZG9tYWluIG1hcHBpbmdcIik7XG4gICAgICB9XG4gICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKHByb3BzLmRvbWFpbiwgc3RhZ2UpO1xuICAgICAgdGhpcy5lbmRwb2ludCA9IGAke3N0cmlwVHJhaWxpbmdTbGFzaChgaHR0cHM6Ly8ke3Byb3BzLmRvbWFpbi5kb21haW5OYW1lfWApfSR7dGhpcy5tY3BQYXRofWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIENvbXB1dGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgVVJMIChpbmNsdWRlIHN0YWdlIHBhdGggdW5sZXNzIHVzaW5nICRkZWZhdWx0KS5cbiAgICAgIGNvbnN0IGJhc2VVcmwgPSAoc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCIpXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtzdGFnZU5hbWV9YDtcbiAgICAgIHRoaXMuZW5kcG9pbnQgPSBgJHtzdHJpcFRyYWlsaW5nU2xhc2goYmFzZVVybCl9JHt0aGlzLm1jcFBhdGh9YDtcbiAgICB9XG5cbiAgICAvLyBJbmplY3QgZW52aXJvbm1lbnQgdmFyaWFibGVzIGludG8gdGhlIExhbWJkYSBoYW5kbGVyXG4gICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9FTkRQT0lOVFwiLCB0aGlzLmVuZHBvaW50KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGQgYW4gZW52aXJvbm1lbnQgdmFyaWFibGUgdG8gdGhlIExhbWJkYSBmdW5jdGlvbi5cbiAgICogVXNlcyBhZGRFbnZpcm9ubWVudCBpZiBhdmFpbGFibGUgKEZ1bmN0aW9uKSwgb3RoZXJ3aXNlIHVzZXMgTDEgb3ZlcnJpZGUuXG4gICAqL1xuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNldCB1cCBjdXN0b20gZG9tYWluIHdpdGggb3B0aW9uYWwgUm91dGU1MyByZWNvcmQuXG4gICAqL1xuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKGRvbWFpbk9wdHM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsIHN0YWdlOiBhcGlnd3YyLklTdGFnZSk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZSA/PyAoZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGVcbiAgICAgIDogdW5kZWZpbmVkKTtcblxuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBkbW4gPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRtbjtcblxuICAgIGNvbnN0IG1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgZG9tYWluTmFtZTogZG1uLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBtYXBwaW5nO1xuXG4gICAgaWYgKGRvbWFpbk9wdHMuaG9zdGVkWm9uZSkge1xuICAgICAgY29uc3QgcmVjb3JkTmFtZSA9IHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluT3B0cy5kb21haW5OYW1lLCBkb21haW5PcHRzLmhvc3RlZFpvbmUpO1xuICAgICAgY29uc3QgcmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IGRvbWFpbk9wdHMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZSxcbiAgICAgICAgZG9tYWluTmFtZTogZG1uLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSByZWNvcmQ7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogQ29udmVydCBhIGRvbWFpbiBuYW1lIHRvIGEgUm91dGU1MyByZWNvcmQgbmFtZSByZWxhdGl2ZSB0byB0aGUgem9uZS5cbiAqL1xuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICByZXR1cm4gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGZxZG47XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZVBhdGgodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHBhdGhgKTtcbiAgfVxuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIik7XG4gIC8vIExpdGVyYWwgTUNQIHJvdXRlIHBhdGhzIHVzZSBvbmx5IFJGQyAzOTg2IHBhdGggY2hhcmFjdGVycywgd2l0aCBwZXJjZW50LWVuY29kaW5nIHJlcXVpcmVkIGZvciB3aGl0ZXNwYWNlIGFuZCBvdGhlciBjaGFyYWN0ZXJzIG91dHNpZGUgdGhhdCBzZXQuXG4gIGNvbnN0IGxpdGVyYWxSb3V0ZVBhdGhQYXR0ZXJuID0gL15cXC8oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrKD86XFwvKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKykqJC87XG4gIGlmIChcbiAgICAhbGl0ZXJhbFJvdXRlUGF0aFBhdHRlcm4udGVzdChyb3V0ZVBhdGgpXG4gICAgfHwgcm91dGVQYXRoLnNwbGl0KFwiL1wiKS5zb21lKChzZWdtZW50KSA9PiBzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgbGl0ZXJhbCBhYnNvbHV0ZSByb3V0ZSBwYXRoYCk7XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQXV0aENvbmZpZyhcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuKTogeyBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyOiBzdHJpbmc7IGp3a3NVcmk6IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3QgYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgLy8gTGl0ZXJhbCBPQXV0aCBjb25maWd1cmF0aW9uIFVSTHMgbXVzdCBiZSBhYnNvbHV0ZSBIVFRQUyBVUkxzIHdpdGhvdXQgdXNlcmluZm8gb3IgZnJhZ21lbnRzLlxuICAvLyBJc3N1ZXIgVVJMcyBtdXN0IGFsc28gb21pdCBxdWVyaWVzLlxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChhdXRob3JpemF0aW9uU2VydmVySXNzdWVyKSkge1xuICAgIGNvbnN0IGxpdGVyYWxJc3N1ZXIgPSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyLnRyaW0oKTtcbiAgICBsZXQgcGFyc2VkSXNzdWVyOiBVUkwgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZElzc3VlciA9IG5ldyBVUkwobGl0ZXJhbElzc3Vlcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gICAgfVxuICAgIGlmIChcbiAgICAgICFwYXJzZWRJc3N1ZXJcbiAgICAgIHx8IHBhcnNlZElzc3Vlci5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgICAgfHwgIXBhcnNlZElzc3Vlci5ob3N0bmFtZVxuICAgICAgfHwgcGFyc2VkSXNzdWVyLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWRJc3N1ZXIucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyhsaXRlcmFsSXNzdWVyKVxuICAgICAgfHwgbGl0ZXJhbElzc3Vlci5pbmNsdWRlcyhcIj9cIilcbiAgICAgIHx8IGxpdGVyYWxJc3N1ZXIuaW5jbHVkZXMoXCIjXCIpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgY29uc3QgbGl0ZXJhbEp3a3NVcmkgPSBqd2tzVXJpLnRyaW0oKTtcbiAgICBsZXQgcGFyc2VkSndrc1VyaTogVVJMIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWRKd2tzVXJpID0gbmV3IFVSTChsaXRlcmFsSndrc1VyaSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gICAgfVxuICAgIGlmIChcbiAgICAgICFwYXJzZWRKd2tzVXJpXG4gICAgICB8fCBwYXJzZWRKd2tzVXJpLnByb3RvY29sICE9PSBcImh0dHBzOlwiXG4gICAgICB8fCAhcGFyc2VkSndrc1VyaS5ob3N0bmFtZVxuICAgICAgfHwgcGFyc2VkSndrc1VyaS51c2VybmFtZSAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkSndrc1VyaS5wYXNzd29yZCAhPT0gXCJcIlxuICAgICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWxKd2tzVXJpKVxuICAgICAgfHwgbGl0ZXJhbEp3a3NVcmkuaW5jbHVkZXMoXCIjXCIpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIsIGp3a3NVcmkgfTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==