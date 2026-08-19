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
    const routePath = String(value ?? "").trim();
    if (!routePath.startsWith("/")
        || routePath === "/"
        || routePath.endsWith("/")
        || routePath.includes("//")
        || /[?#{}]/.test(routePath)) {
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
    if (!aws_cdk_lib_1.Token.isUnresolved(authorizationServerIssuer) && !authorizationServerIssuer.trim()) {
        throw new Error("AppTheoryMcpServer: authorizationServerIssuer must not be empty");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(jwksUri) && !jwksUri.trim()) {
        throw new Error("AppTheoryMcpServer: jwksUri must not be empty");
    }
    return { authorizationServerIssuer, jwksUri };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUQ7QUFDbkQsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJDQUFnRDtBQThJaEQ7Ozs7Ozs7Ozs7Ozs7OztHQWVHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxzQkFBUztJQThDL0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLE9BQU8sSUFBSSw2QkFBaUIsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDckYsSUFBSSxDQUFDLDZCQUE2QixHQUFHLEdBQUcsNkJBQWlCLENBQUMsd0JBQXdCLEdBQUcsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BHLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzlDLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3BDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxTQUFTLElBQUksVUFBVSxDQUFDO1FBRXBELE1BQU0sa0JBQWtCLEdBQUcsU0FBUyxLQUFLLFVBQVU7ZUFDOUMsU0FBUyxDQUFDLGFBQWE7ZUFDdkIsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVM7ZUFDM0MsU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztRQUVsRCxxQ0FBcUM7UUFDckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZ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SUFBSSxDQUFDLFNBQVMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQzlCLE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7SUFFRCxNQUFNLHlCQUF5QixHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztJQUMxRSxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyx5QkFBeUIsQ0FBQyxJQUFJLENBQUMseUJBQXlCLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQztRQUN4RixNQUFNLElBQUksS0FBSyxDQUFDLGlFQUFpRSxDQUFDLENBQUM7SUFDckYsQ0FBQztJQUNELElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ3BELE1BQU0sSUFBSSxLQUFLLENBQUMsK0NBQStDLENBQUMsQ0FBQztJQUNuRSxDQUFDO0lBQ0QsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQ2hELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUGF0aHMgfSBmcm9tIFwiLi9tY3AtcGF0aHNcIjtcblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1Agc2VydmVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZS5nLiwgXCJtY3AuZXhhbXBsZS5jb21cIikuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBJZiBwcm92aWRlZCwgYSBDTkFNRSByZWNvcmQgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCBzZXJ2ZXIgQVBJIEdhdGV3YXkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIE1DUCByZXF1ZXN0cy5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIExpdGVyYWwgcm91dGUgcGF0aCBmb3IgdGhlIE1DUCBlbmRwb2ludC5cbiAgICpcbiAgICogVGhpcyBpcyBhIHN5bnRoZXNpcy10aW1lIHBhdGgsIG5ldmVyIGFuIG9yaWdpbiBvciBmdWxsIHJlc291cmNlIFVSTC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUGF0aHMuTUNQXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPQXV0aCBhdXRob3JpemF0aW9uIHNlcnZlciBpc3N1ZXIgcGFzc2VkIHRvIHRoZSBMYW1iZGEgcnVudGltZSBjb25maWcuXG4gICAqXG4gICAqIEFwcFRoZW9yeSBkb2VzIG5vdCBwYXJzZSB0aGlzIHZhbHVlIG9yIHVzZSBpdCB0byBzeW50aGVzaXplIHJlc291cmNlIFVSTHMuXG4gICAqIFN1cHBseSBgandrc1VyaWAgd2l0aCB0aGlzIHByb3AgdG8gZW5hYmxlIHRoZSBydW50aW1lLXNlcnZlZCBSRkMgOTcyOFxuICAgKiBkaXNjb3Zlcnkgcm91dGVzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGxlZ2FjeSBQT1NULW9ubHkgTUNQIHJvdXRlKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcj86IHN0cmluZztcblxuICAvKipcbiAgICogT0F1dGggSlNPTiBXZWIgS2V5IFNldCBVUkwgcGFzc2VkIHRvIHRoZSBMYW1iZGEgcnVudGltZSBjb25maWcuXG4gICAqXG4gICAqIFN1cHBseSBgYXV0aG9yaXphdGlvblNlcnZlcklzc3VlcmAgd2l0aCB0aGlzIHByb3AuIENESyB0b2tlbnMgYXJlIGFjY2VwdGVkXG4gICAqIGJlY2F1c2UgdGhlIHZhbHVlIGlzIGZvcndhcmRlZCwgbm90IHBhcnNlZCBkdXJpbmcgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGxlZ2FjeSBQT1NULW9ubHkgTUNQIHJvdXRlKVxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQ3JlYXRlIGEgRHluYW1vREIgdGFibGUgZm9yIHNlc3Npb24gc3RhdGUgc3RvcmFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE5hbWUgZm9yIHRoZSBzZXNzaW9uIER5bmFtb0RCIHRhYmxlLlxuICAgKiBPbmx5IHVzZWQgd2hlbiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChhdXRvLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuXG4gICAqIE9ubHkgdXNlZCB3aGVuIGVuYWJsZVNlc3Npb25UYWJsZSBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCA2MFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBjdXN0b20gZG9tYWluKVxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChkZWZhdWx0cyBhcHBsaWVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogVW1icmVsbGEgZGVwbG95bWVudCBjb250cmFjdCBmb3IgYSBuYW1lc3BhY2UgTUNQIHNlcnZlci5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgYW4gSFRUUCBBUEkgR2F0ZXdheSB2MiB3aXRoIGEgTGFtYmRhIGludGVncmF0aW9uXG4gKiBvbiB0aGUgY29udmVudGlvbmFsIFBPU1QgL21jcCBwYXRoLCBvcHRpb25hbCBydW50aW1lLXNlcnZlZCBSRkMgOTcyOFxuICogZGlzY292ZXJ5IHJvdXRlcywgb3B0aW9uYWwgRHluYW1vREIgc2Vzc2lvbiBzdGF0ZSwgYW5kIGFuIG9wdGlvbmFsIGN1c3RvbVxuICogZG9tYWluLiBSZXNvdXJjZSBvcmlnaW5zIGFyZSBpbnRlbnRpb25hbGx5IGFic2VudCBmcm9tIHRoZSBwcm9wIHN1cmZhY2U6XG4gKiB0aGUgR28gcnVudGltZSBkZXJpdmVzIHRoZSBwcm90ZWN0ZWQgcmVzb3VyY2UgaG9zdCBmcm9tIGVhY2ggcmVxdWVzdC5cbiAqXG4gKiBAZXhhbXBsZVxuICogY29uc3Qgc2VydmVyID0gbmV3IEFwcFRoZW9yeU1jcFNlcnZlcih0aGlzLCAnTWNwU2VydmVyJywge1xuICogICBoYW5kbGVyOiBtY3BGbixcbiAqICAgZW5hYmxlU2Vzc2lvblRhYmxlOiB0cnVlLFxuICogICBzZXNzaW9uVHRsTWludXRlczogMTIwLFxuICogfSk7XG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgSFRUUCBBUEkgR2F0ZXdheSB2Mi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSHR0cEFwaTtcblxuICAvKipcbiAgICogVGhlIER5bmFtb0RCIHNlc3Npb24gdGFibGUgKGlmIGVuYWJsZVNlc3Npb25UYWJsZSBpcyB0cnVlKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBNQ1AgZW5kcG9pbnQgVVJMLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExpdGVyYWwgTUNQIGVuZHBvaW50IHJvdXRlIHBhdGguXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBQYXRoLXNjb3BlZCBSRkMgOTcyOCBkaXNjb3Zlcnkgcm91dGUgZm9yIHRoaXMgTUNQIGVuZHBvaW50LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgcmVzb3VyY2UgKGlmIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIG1hcHBpbmcgZm9yIHRoZSBjdXN0b20gZG9tYWluIChpZiBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcblxuICAvKipcbiAgICogVGhlIFJvdXRlNTMgQ05BTUUgcmVjb3JkIChpZiBkb21haW4gYW5kIGhvc3RlZFpvbmUgYXJlIGNvbmZpZ3VyZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMubWNwUGF0aCA9IG5vcm1hbGl6ZVJvdXRlUGF0aChwcm9wcy5tY3BQYXRoID8/IEFwcFRoZW9yeU1jcFBhdGhzLk1DUCwgXCJtY3BQYXRoXCIpO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGggPSBgJHtBcHBUaGVvcnlNY3BQYXRocy5PQVVUSF9QUk9URUNURURfUkVTT1VSQ0V9JHt0aGlzLm1jcFBhdGh9YDtcbiAgICBjb25zdCBhdXRoQ29uZmlnID0gbm9ybWFsaXplQXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG5cbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgLy8gQ3JlYXRlIEhUVFAgQVBJIHdpdGggZGVmYXVsdCBzdGFnZVxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgIH0pO1xuXG4gICAgLy8gSWYgY3VzdG9tIHN0YWdlIG9wdGlvbnMsIGNyZWF0ZSB0aGUgc3RhZ2UgZXhwbGljaXRseVxuICAgIGxldCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgaWYgKG5lZWRzRXhwbGljaXRTdGFnZSkge1xuICAgICAgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNldCB1cCBhY2Nlc3MgbG9nZ2luZyBpZiBlbmFibGVkXG4gICAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgICAgZm9ybWF0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgICAgICAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgICAgICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgICAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgICAgICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICAgICAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgICAgICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgICAgICAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdGFnZSA9IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGVySW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJNY3BIYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgIH0pO1xuXG4gICAgLy8gUm91dGUgTUNQIHByb3RvY29sIHRyYWZmaWMgdG8gdGhlIGFwcGxpY2F0aW9uIHJ1bnRpbWUuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IHRoaXMubWNwUGF0aCxcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogaGFuZGxlckludGVncmF0aW9uLFxuICAgIH0pO1xuXG4gICAgaWYgKGF1dGhDb25maWcpIHtcbiAgICAgIC8vIERpc2NvdmVyeSBzdGF5cyB1bmF1dGhlbnRpY2F0ZWQgYXQgQVBJIEdhdGV3YXkuIFRoZSBtYXRjaGluZyBHbyBoZWxwZXJcbiAgICAgIC8vIHJlZ2lzdGVycyB0aGVzZSByb3V0ZXMgd2l0aCBTZWN1cmVBcHAgUHVibGljIHBvc3R1cmUgd2hpbGUgcmVnaXN0ZXJpbmdcbiAgICAgIC8vIHRoZSBNQ1Agcm91dGUgYXMgQXV0aGVudGljYXRlZC5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IEFwcFRoZW9yeU1jcFBhdGhzLk9BVVRIX1BST1RFQ1RFRF9SRVNPVVJDRSxcbiAgICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogaGFuZGxlckludGVncmF0aW9uLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICBwYXRoOiB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICAgIGludGVncmF0aW9uOiBoYW5kbGVySW50ZWdyYXRpb24sXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIkFQUFRIRU9SWV9NQ1BfUEFUSFwiLCB0aGlzLm1jcFBhdGgpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgICAgXCJBUFBUSEVPUllfTUNQX1BST1RFQ1RFRF9SRVNPVVJDRV9QQVRIXCIsXG4gICAgICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGgsXG4gICAgICApO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChcbiAgICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgICAgXCJBUFBUSEVPUllfTUNQX0FVVEhPUklaQVRJT05fU0VSVkVSX0lTU1VFUlwiLFxuICAgICAgICBhdXRoQ29uZmlnLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIsXG4gICAgICApO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIkFQUFRIRU9SWV9NQ1BfSldLU19VUklcIiwgYXV0aENvbmZpZy5qd2tzVXJpKTtcbiAgICB9XG5cbiAgICAvLyBPcHRpb25hbCBzZXNzaW9uIHRhYmxlXG4gICAgaWYgKHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLnNlc3Npb25UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnNlc3Npb25UYWJsZSkge1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHByb3BzLnNlc3Npb25UdGxNaW51dGVzID8/IDYwKSk7XG4gICAgfVxuXG4gICAgLy8gT3B0aW9uYWwgY3VzdG9tIGRvbWFpblxuICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgIGlmICghc3RhZ2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBubyBzdGFnZSBhdmFpbGFibGUgZm9yIGRvbWFpbiBtYXBwaW5nXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4sIHN0YWdlKTtcbiAgICAgIHRoaXMuZW5kcG9pbnQgPSBgJHtzdHJpcFRyYWlsaW5nU2xhc2goYGh0dHBzOi8vJHtwcm9wcy5kb21haW4uZG9tYWluTmFtZX1gKX0ke3RoaXMubWNwUGF0aH1gO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDb21wdXRlIGV4ZWN1dGUtYXBpIGVuZHBvaW50IFVSTCAoaW5jbHVkZSBzdGFnZSBwYXRoIHVubGVzcyB1c2luZyAkZGVmYXVsdCkuXG4gICAgICBjb25zdCBiYXNlVXJsID0gKHN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiKVxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7c3RhZ2VOYW1lfWA7XG4gICAgICB0aGlzLmVuZHBvaW50ID0gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGJhc2VVcmwpfSR7dGhpcy5tY3BQYXRofWA7XG4gICAgfVxuXG4gICAgLy8gSW5qZWN0IGVudmlyb25tZW50IHZhcmlhYmxlcyBpbnRvIHRoZSBMYW1iZGEgaGFuZGxlclxuICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfRU5EUE9JTlRcIiwgdGhpcy5lbmRwb2ludCk7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGFuIGVudmlyb25tZW50IHZhcmlhYmxlIHRvIHRoZSBMYW1iZGEgZnVuY3Rpb24uXG4gICAqIFVzZXMgYWRkRW52aXJvbm1lbnQgaWYgYXZhaWxhYmxlIChGdW5jdGlvbiksIG90aGVyd2lzZSB1c2VzIEwxIG92ZXJyaWRlLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdXAgY3VzdG9tIGRvbWFpbiB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkLlxuICAgKi9cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG1uID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkbW47XG5cbiAgICBjb25zdCBtYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gbWFwcGluZztcblxuICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgIGRvbWFpbk5hbWU6IGRtbi5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gcmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVQYXRoKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBwYXRoYCk7XG4gIH1cbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKFxuICAgICFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIilcbiAgICB8fCByb3V0ZVBhdGggPT09IFwiL1wiXG4gICAgfHwgcm91dGVQYXRoLmVuZHNXaXRoKFwiL1wiKVxuICAgIHx8IHJvdXRlUGF0aC5pbmNsdWRlcyhcIi8vXCIpXG4gICAgfHwgL1s/I3t9XS8udGVzdChyb3V0ZVBhdGgpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgbGl0ZXJhbCBhYnNvbHV0ZSByb3V0ZSBwYXRoYCk7XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQXV0aENvbmZpZyhcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuKTogeyBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyOiBzdHJpbmc7IGp3a3NVcmk6IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3QgYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoYXV0aG9yaXphdGlvblNlcnZlcklzc3VlcikgJiYgIWF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIudHJpbSgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpICYmICFqd2tzVXJpLnRyaW0oKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogandrc1VyaSBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICByZXR1cm4geyBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyLCBqd2tzVXJpIH07XG59XG4iXX0=