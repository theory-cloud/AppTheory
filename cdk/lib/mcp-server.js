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
const mcp_route_algebra_1 = require("./mcp-route-algebra");
const DEFAULT_THROTTLING_RATE_LIMIT = 100;
const DEFAULT_THROTTLING_BURST_LIMIT = 200;
const DEFAULT_SESSION_TTL_MINUTES = 60;
/**
 * Contract-first MCP facade deployment construct.
 *
 * The primary mode attaches the complete route-algebra family to a supplied
 * HTTP API. Omitting `api` specializes the same path into a standalone owned
 * API. The construct routes only: OAuth metadata, scopes, capabilities, and
 * authorize/token behavior remain application-owned through Go
 * `mcpfacade.RegisterMCPFacade`.
 */
class AppTheoryMcpServer extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        this.routeSequence = 0;
        validateOwningMode(props);
        normalizeLegacyAuthConfig(props);
        const routeFamily = normalizeRouteFamily(props);
        const unauthenticatedMcp = props.unauthenticatedMcp ?? false;
        if (unauthenticatedMcp
            && (props.authorizationServerIssuer !== undefined || props.jwksUri !== undefined)) {
            throw new Error("AppTheoryMcpServer: unauthenticatedMcp cannot be combined with authorizationServerIssuer or jwksUri");
        }
        if (unauthenticatedMcp && routeFamily.rootAuthorizationServerDiscovery) {
            throw new Error("AppTheoryMcpServer: unauthenticatedMcp cannot enable rootAuthorizationServerDiscovery");
        }
        this.mcpPaths = [...routeFamily.patterns];
        this.routeInventory = buildRouteInventory(this.mcpPaths, !unauthenticatedMcp, routeFamily.rootAuthorizationServerDiscovery);
        validateRouteInventory(this.routeInventory, unauthenticatedMcp);
        this.protectedResourceMetadataPaths = this.routeInventory.routes.map((route) => route.protectedResourcePattern);
        this.mcpPath = this.mcpPaths[0];
        this.protectedResourceMetadataPath = this.protectedResourceMetadataPaths[0];
        const ownedOptions = normalizeOwnedApiOptions(props);
        let ownedStage;
        let ownedStageName = "$default";
        if (props.api) {
            this.api = props.api;
        }
        else {
            const stageOptions = normalizeStageOptions(ownedOptions.stage);
            ownedStageName = stageOptions.stageName;
            const api = new apigwv2.HttpApi(this, "Api", {
                apiName: ownedOptions.apiName,
                createDefaultStage: false,
            });
            this.ownedApi = api;
            this.api = api;
            const stage = new apigwv2.HttpStage(this, "Stage", {
                httpApi: api,
                stageName: stageOptions.stageName,
                autoDeploy: true,
                throttle: stageOptions.throttlingEnabled
                    ? {
                        rateLimit: stageOptions.throttlingRateLimit,
                        burstLimit: stageOptions.throttlingBurstLimit,
                    }
                    : undefined,
            });
            ownedStage = stage;
            if (stageOptions.accessLogging) {
                const logGroup = new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOptions.accessLogRetention,
                });
                this.accessLogGroup = logGroup;
                const cfnStage = stage.node.defaultChild;
                cfnStage.accessLogSettings = {
                    destinationArn: logGroup.logGroupArn,
                    format: accessLogFormat(),
                };
            }
        }
        const integration = new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 });
        const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
        for (const route of this.routeInventory.routes) {
            for (const method of route.mcpMethods) {
                this.addRuntimeRoute(route.mcpPattern, toHttpMethod(method), integration, runtimeOwnedAuth);
            }
            if (!unauthenticatedMcp) {
                this.addRuntimeRoute(route.protectedResourcePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.discoveryCanonicalPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.discoverySuffixPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.authorizePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.tokenPattern, apigwv2.HttpMethod.POST, integration, runtimeOwnedAuth);
            }
        }
        if (this.routeInventory.rootAuthorizationServerAttached) {
            this.addRuntimeRoute(this.routeInventory.rootAuthorizationServerPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        }
        const sessionState = normalizeSessionState(props);
        if (sessionState.enabled) {
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: sessionState.tableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: sessionState.removalPolicy,
                pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.sessionTable = table;
            this.addEnvironment(props.handler, "MCP_SESSION_TABLE", table.tableName);
            this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(sessionState.ttlMinutes));
        }
        let endpointBase;
        if (ownedOptions.domain) {
            if (!ownedStage) {
                throw new Error("AppTheoryMcpServer: domain configuration requires construct-owned API mode");
            }
            this.setupCustomDomain(ownedOptions.domain, ownedStage);
            endpointBase = `https://${ownedOptions.domain.domainName}`;
        }
        else if (props.api) {
            const stack = aws_cdk_lib_1.Stack.of(this);
            endpointBase = `https://${this.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
        }
        else {
            endpointBase = ownedStageName === "$default"
                ? this.api.apiEndpoint
                : `${this.api.apiEndpoint}/${ownedStageName}`;
        }
        this.endpoints = this.mcpPaths.map((pattern) => `${stripTrailingSlash(endpointBase)}${pattern}`);
        this.endpoint = this.endpoints[0];
        // Attach-mode public authority belongs to the front door. Do not smuggle
        // it into this construct as an origin prop.
        if (!props.api) {
            this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
        }
    }
    addRuntimeRoute(path, method, integration, authorizer) {
        new apigwv2.HttpRoute(this, `Route${this.routeSequence++}`, {
            httpApi: this.api,
            routeKey: apigwv2.HttpRouteKey.with(path, method),
            integration,
            authorizer,
        });
    }
    addEnvironment(handler, key, value) {
        if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
            handler.addEnvironment(key, value);
        }
    }
    setupCustomDomain(options, stage) {
        const certificate = options.certificate ?? (options.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCert", options.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryMcpServer: ownedApi.domain requires either certificate or certificateArn");
        }
        const domainName = new apigwv2.DomainName(this, "DomainName", {
            domainName: options.domainName,
            certificate,
        });
        this.domainName = domainName;
        const apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
            api: this.api,
            domainName,
            stage,
        });
        this.apiMapping = apiMapping;
        if (options.hostedZone) {
            const cnameRecord = new route53.CnameRecord(this, "CnameRecord", {
                zone: options.hostedZone,
                recordName: toRoute53RecordName(options.domainName, options.hostedZone),
                domainName: domainName.regionalDomainName,
            });
            this.cnameRecord = cnameRecord;
        }
    }
}
exports.AppTheoryMcpServer = AppTheoryMcpServer;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMcpServer[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "3.1.1" };
function normalizeRouteFamily(props) {
    if (props.routeFamily !== undefined && props.mcpPath !== undefined) {
        throw new Error("AppTheoryMcpServer: routeFamily and deprecated mcpPath cannot be supplied together");
    }
    const rawPatterns = props.routeFamily?.patterns
        ?? (props.mcpPath !== undefined
            ? [props.mcpPath]
            : mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map((template) => template.mcpPattern));
    if (rawPatterns.length === 0) {
        throw new Error("AppTheoryMcpServer: routeFamily.patterns must not be empty");
    }
    const patterns = rawPatterns.map((pattern, index) => normalizeRoutePath(pattern, `routeFamily.patterns[${index}]`));
    const seen = new Set();
    for (const pattern of patterns) {
        if (seen.has(pattern)) {
            throw new Error(`AppTheoryMcpServer: routeFamily.patterns contains duplicate pattern ${JSON.stringify(pattern)}`);
        }
        seen.add(pattern);
    }
    return {
        patterns,
        rootAuthorizationServerDiscovery: props.routeFamily?.rootAuthorizationServerDiscovery ?? false,
    };
}
function normalizeRoutePath(value, propName) {
    if (aws_cdk_lib_1.Token.isUnresolved(value)) {
        throw new Error(`AppTheoryMcpServer: ${propName} must be a synthesis-time literal route pattern`);
    }
    const routePath = String(value ?? "");
    if (!routePath.startsWith("/"))
        throw invalidRoutePattern(propName);
    const segments = routePath.slice(1).split("/");
    if (segments.length === 0 || segments.some((segment) => segment === "")) {
        throw invalidRoutePattern(propName);
    }
    const literal = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
    const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
    for (const segment of segments) {
        if (segment === "." || segment === "..")
            throw invalidRoutePattern(propName);
        if (parameter.test(segment))
            continue;
        if (!literal.test(segment) || segment.includes("{") || segment.includes("}")) {
            throw invalidRoutePattern(propName);
        }
    }
    return routePath;
}
function invalidRoutePattern(propName) {
    return new Error(`AppTheoryMcpServer: ${propName} must be an absolute synthesis-time route pattern with non-empty literal or {parameter_name} segments and no dot segments`);
}
function buildRouteInventory(patterns, authorizationRoutesAttached, rootAuthorizationServerAttached) {
    return {
        contractVersion: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.CONTRACT_VERSION,
        routes: patterns.map((mcpPattern) => ({
            mcpPattern,
            mcpMethods: ["POST", "GET", "DELETE"],
            protectedResourcePattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(mcpPattern),
            discoveryCanonicalPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(mcpPattern),
            discoverySuffixPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(mcpPattern),
            authorizePattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(mcpPattern),
            tokenPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(mcpPattern),
            authorizationRoutesAttached,
        })),
        rootAuthorizationServerPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
        rootAuthorizationServerAttached,
    };
}
function validateRouteInventory(inventory, unauthenticatedMcp) {
    const seen = new Set();
    const add = (method, path) => {
        const key = `${method} ${path}`;
        if (seen.has(key)) {
            throw new Error(`AppTheoryMcpServer: derived route family collides at ${key}`);
        }
        seen.add(key);
    };
    for (const route of inventory.routes) {
        for (const method of route.mcpMethods)
            add(method, route.mcpPattern);
        if (!unauthenticatedMcp) {
            add("GET", route.protectedResourcePattern);
            add("GET", route.discoveryCanonicalPattern);
            add("GET", route.discoverySuffixPattern);
            add("GET", route.authorizePattern);
            add("POST", route.tokenPattern);
        }
    }
    if (inventory.rootAuthorizationServerAttached) {
        add("GET", inventory.rootAuthorizationServerPattern);
    }
}
function validateOwningMode(props) {
    if (!props.api)
        return;
    const invalid = [];
    if (props.ownedApi !== undefined)
        invalid.push("ownedApi");
    if (props.apiName !== undefined)
        invalid.push("apiName");
    if (props.domain !== undefined)
        invalid.push("domain");
    if (props.stage !== undefined)
        invalid.push("stage");
    if (invalid.length !== 0) {
        throw new Error(`AppTheoryMcpServer: attach mode with api cannot configure owned-API props: ${invalid.join(", ")}`);
    }
}
function normalizeOwnedApiOptions(props) {
    if (props.ownedApi?.apiName !== undefined && props.apiName !== undefined) {
        throw new Error("AppTheoryMcpServer: ownedApi.apiName and deprecated apiName cannot be supplied together");
    }
    if (props.ownedApi?.domain !== undefined && props.domain !== undefined) {
        throw new Error("AppTheoryMcpServer: ownedApi.domain and deprecated domain cannot be supplied together");
    }
    if (props.ownedApi?.stage !== undefined && props.stage !== undefined) {
        throw new Error("AppTheoryMcpServer: ownedApi.stage and deprecated stage cannot be supplied together");
    }
    return {
        apiName: props.ownedApi?.apiName ?? props.apiName,
        domain: props.ownedApi?.domain ?? props.domain,
        stage: props.ownedApi?.stage ?? props.stage,
    };
}
function normalizeStageOptions(options) {
    const accessLogging = options?.accessLogging ?? true;
    if (!accessLogging && options?.accessLogRetention !== undefined) {
        throw new Error("AppTheoryMcpServer: ownedApi.stage.accessLogRetention requires accessLogging to be enabled");
    }
    const throttlingEnabled = options?.throttlingEnabled ?? true;
    if (!throttlingEnabled
        && (options?.throttlingRateLimit !== undefined || options?.throttlingBurstLimit !== undefined)) {
        throw new Error("AppTheoryMcpServer: ownedApi.stage throttling limits require throttlingEnabled to be true");
    }
    const rateLimit = options?.throttlingRateLimit ?? DEFAULT_THROTTLING_RATE_LIMIT;
    const burstLimit = options?.throttlingBurstLimit ?? DEFAULT_THROTTLING_BURST_LIMIT;
    validatePositiveNumber(rateLimit, "ownedApi.stage.throttlingRateLimit");
    validatePositiveNumber(burstLimit, "ownedApi.stage.throttlingBurstLimit");
    return {
        stageName: options?.stageName ?? "$default",
        accessLogging,
        accessLogRetention: options?.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
        throttlingEnabled,
        throttlingRateLimit: rateLimit,
        throttlingBurstLimit: burstLimit,
    };
}
function normalizeSessionState(props) {
    const hasLegacy = props.enableSessionTable !== undefined
        || props.sessionTableName !== undefined
        || props.sessionTtlMinutes !== undefined;
    if (props.sessionState !== undefined && hasLegacy) {
        throw new Error("AppTheoryMcpServer: sessionState cannot be combined with deprecated session-table props");
    }
    const enabled = props.sessionState?.enabled ?? props.enableSessionTable ?? true;
    const tableName = props.sessionState?.tableName ?? props.sessionTableName;
    const ttlMinutes = props.sessionState?.ttlMinutes
        ?? props.sessionTtlMinutes
        ?? DEFAULT_SESSION_TTL_MINUTES;
    const removalPolicy = props.sessionState?.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
    if (!enabled
        && (tableName !== undefined
            || props.sessionState?.ttlMinutes !== undefined
            || props.sessionState?.removalPolicy !== undefined
            || props.sessionTableName !== undefined
            || props.sessionTtlMinutes !== undefined)) {
        throw new Error("AppTheoryMcpServer: disabled session state cannot configure tableName, ttlMinutes, or removalPolicy");
    }
    validatePositiveInteger(ttlMinutes, "sessionState.ttlMinutes");
    return { enabled, tableName, ttlMinutes, removalPolicy };
}
function normalizeLegacyAuthConfig(props) {
    const hasIssuer = props.authorizationServerIssuer !== undefined;
    const hasJwksUri = props.jwksUri !== undefined;
    if (hasIssuer !== hasJwksUri) {
        throw new Error("AppTheoryMcpServer: authorizationServerIssuer and jwksUri must be supplied together");
    }
    if (!hasIssuer || !hasJwksUri)
        return;
    const issuer = String(props.authorizationServerIssuer);
    const jwksUri = String(props.jwksUri);
    if (!aws_cdk_lib_1.Token.isUnresolved(issuer)) {
        validateLiteralOAuthURL(issuer, false, "authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(jwksUri)) {
        validateLiteralOAuthURL(jwksUri, true, "jwksUri must be an absolute HTTPS URL with no userinfo or fragment");
    }
}
function validateLiteralOAuthURL(value, allowQuery, message) {
    const literal = value.trim();
    let parsed;
    try {
        parsed = new URL(literal);
    }
    catch {
        // The shared validation error below is the public synthesis contract.
    }
    if (!parsed
        || !literalURLHasRFC3986Authority(literal)
        || parsed.protocol !== "https:"
        || !parsed.hostname
        || parsed.username !== ""
        || parsed.password !== ""
        || literalURLAuthorityHasUserinfo(literal)
        || (!allowQuery && literal.includes("?"))
        || literal.includes("#")) {
        throw new Error(`AppTheoryMcpServer: ${message}`);
    }
}
function toHttpMethod(method) {
    switch (method) {
        case "POST": return apigwv2.HttpMethod.POST;
        case "GET": return apigwv2.HttpMethod.GET;
        case "DELETE": return apigwv2.HttpMethod.DELETE;
        default:
            throw new Error(`AppTheoryMcpServer: unsupported runtime MCP method ${method}`);
    }
}
function validatePositiveNumber(value, propName) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`AppTheoryMcpServer: ${propName} must be greater than zero`);
    }
}
function validatePositiveInteger(value, propName) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`AppTheoryMcpServer: ${propName} must be a positive integer`);
    }
}
function accessLogFormat() {
    return JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        protocol: "$context.protocol",
        responseLength: "$context.responseLength",
        integrationLatency: "$context.integrationLatency",
    });
}
function toRoute53RecordName(domainName, zone) {
    const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
    const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
    if (!zoneName)
        return fqdn;
    if (fqdn === zoneName)
        return "";
    const suffix = `.${zoneName}`;
    return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
}
function stripTrailingSlash(url) {
    return url.replace(/\/$/, "");
}
function literalURLHasRFC3986Authority(value) {
    const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
    return authority !== undefined && !authority.includes("%");
}
function literalURLAuthorityHasUserinfo(value) {
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
    return authority?.includes("@") ?? false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUUvRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQTROdkM7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFhLGtCQUFtQixTQUFRLHNCQUFTO0lBeUIvQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3RFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUF6Qlgsa0JBQWEsR0FBRyxDQUFDLENBQUM7UUEyQnhCLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLHlCQUF5QixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pDLE1BQU0sV0FBVyxHQUFHLG9CQUFvQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2hELE1BQU0sa0JBQWtCLEdBQUcsS0FBSyxDQUFDLGtCQUFrQixJQUFJLEtBQUssQ0FBQztRQUM3RCxJQUNFLGtCQUFrQjtlQUNmLENBQUMsS0FBSyxDQUFDLHlCQUF5QixLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxFQUNqRixDQUFDO1lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYixxR0FBcUcsQ0FDdEcsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLGtCQUFrQixJQUFJLFdBQVcsQ0FBQyxnQ0FBZ0MsRUFBRSxDQUFDO1lBQ3ZFLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUZBQXVGLENBQ3hGLENBQUM7UUFDSixD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QUMsQ0FBQyxJQUFJLENBQUM7QUFDdEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLEtBQWE7SUFDbEQsTUFBTSxTQUFTLEdBQUcsa0NBQWtDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsT0FBTyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsU0FBUyw4QkFBOEIsQ0FBQyxLQUFhO0lBQ25ELE1BQU0sU0FBUyxHQUFHLHdDQUF3QyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIH0gZnJvbSBcIi4vbWNwLXJvdXRlLWFsZ2VicmFcIjtcblxuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQgPSAxMDA7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQgPSAyMDA7XG5jb25zdCBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVMgPSA2MDtcblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xufVxuXG4vKiogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgY29uc3RydWN0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKiBMYW1iZGEgZnVuY3Rpb24gaGFuZGxpbmcgdGhlIHJ1bnRpbWUtY29tcG9zZWQgTUNQIGZhY2FkZS4gKi9cbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdGx5IG9wdCBvdXQgb2YgdGhlIE9BdXRoIGZhY2FkZSBhbmQgd2lyZSBvbmx5IE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKiBUaGlzIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGxlZ2FjeSBhdXRob3JpemF0aW9uIHByb3BzIG9yIHJvb3QgZGlzY292ZXJ5LlxuICAgKiBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIGFsd2F5cyBpbnN0YWxscyB0aGUgYXV0aGVudGljYXRlZFxuICAgKiBjYW5vbmljYWwgZmFjYWRlLCBzbyBhcHBsaWNhdGlvbnMgdXNpbmcgdGhpcyBvcHQtb3V0IG11c3Qgb3duIHJ1bnRpbWVcbiAgICogcmVnaXN0cmF0aW9uIGZvciB0aGUgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHVuYXV0aGVudGljYXRlZE1jcD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24tc3RhdGUgdGFibGUgY29uZmlndXJhdGlvbi4gVGhlIHRhYmxlIGRlZmF1bHRzIG9uLlxuICAgKiBAZGVmYXVsdCBlbmFibGVkIHdpdGggcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblN0YXRlPzogQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucztcblxuICAvKipcbiAgICogT3duZWQtQVBJIGNvbmZpZ3VyYXRpb24gZm9yIHN0YW5kYWxvbmUgbW9kZS4gSW52YWxpZCB3aXRoIGBhcGlgLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uLW93bmVkIEFQSSBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgb3duZWRBcGk/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNpbmdsZSBNQ1Agcm91dGUgcGF0aCBmcm9tIHRoZSB2My4xLnggQTYgc3VyZmFjZS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGByb3V0ZUZhbWlseS5wYXR0ZXJuc2AuIFRoZSBuZXcgZGVmYXVsdCBpcyB0aGUgY2Fub25pY2FsXG4gICAqIGZvdXItcGF0dGVybiBmYW1pbHk7IHVzZSBgeyBwYXR0ZXJuczogWycvbWNwJ10gfWAgZm9yIHRoZSBvbGQgc2luZ2xldG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogQXV0aG9yaXphdGlvbi1zZXJ2ZXIgaXNzdWVyIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSXNzdWVyVVJMYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgaXNzdWVyIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEpXS1MgVVJJIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSldLU1VSSWAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIEpXS1MgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5hcGlOYW1lYC4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUuZW5hYmxlZGAuIFNlc3Npb24gc3RhdGUgbm93IGRlZmF1bHRzIG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudGFibGVOYW1lYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudHRsTWludXRlc2AuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmRvbWFpbmAuIERvbWFpbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLnN0YWdlYC4gU3RhZ2Ugb3B0aW9ucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIENvbnRyYWN0LWZpcnN0IE1DUCBmYWNhZGUgZGVwbG95bWVudCBjb25zdHJ1Y3QuXG4gKlxuICogVGhlIHByaW1hcnkgbW9kZSBhdHRhY2hlcyB0aGUgY29tcGxldGUgcm91dGUtYWxnZWJyYSBmYW1pbHkgdG8gYSBzdXBwbGllZFxuICogSFRUUCBBUEkuIE9taXR0aW5nIGBhcGlgIHNwZWNpYWxpemVzIHRoZSBzYW1lIHBhdGggaW50byBhIHN0YW5kYWxvbmUgb3duZWRcbiAqIEFQSS4gVGhlIGNvbnN0cnVjdCByb3V0ZXMgb25seTogT0F1dGggbWV0YWRhdGEsIHNjb3BlcywgY2FwYWJpbGl0aWVzLCBhbmRcbiAqIGF1dGhvcml6ZS90b2tlbiBiZWhhdmlvciByZW1haW4gYXBwbGljYXRpb24tb3duZWQgdGhyb3VnaCBHb1xuICogYG1jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwcml2YXRlIHJvdXRlU2VxdWVuY2UgPSAwO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYGVuZHBvaW50c2AuICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG4gICAgY29uc3QgdW5hdXRoZW50aWNhdGVkTWNwID0gcHJvcHMudW5hdXRoZW50aWNhdGVkTWNwID8/IGZhbHNlO1xuICAgIGlmIChcbiAgICAgIHVuYXV0aGVudGljYXRlZE1jcFxuICAgICAgJiYgKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1bmF1dGhlbnRpY2F0ZWRNY3AgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBvciBqd2tzVXJpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAodW5hdXRoZW50aWNhdGVkTWNwICYmIHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1bmF1dGhlbnRpY2F0ZWRNY3AgY2Fubm90IGVuYWJsZSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm1jcFBhdGhzID0gWy4uLnJvdXRlRmFtaWx5LnBhdHRlcm5zXTtcbiAgICB0aGlzLnJvdXRlSW52ZW50b3J5ID0gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgICAgIHRoaXMubWNwUGF0aHMsXG4gICAgICAhdW5hdXRoZW50aWNhdGVkTWNwLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIHVuYXV0aGVudGljYXRlZE1jcCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBvd25lZE9wdGlvbnMuYXBpTmFtZSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7IHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wIH0sXG4gICAgKTtcbiAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5tY3BQYXR0ZXJuLCB0b0h0dHBNZXRob2QobWV0aG9kKSwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgfVxuICAgICAgaWYgKCF1bmF1dGhlbnRpY2F0ZWRNY3ApIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuLFxuICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGVuZHBvaW50QmFzZSA9IGBodHRwczovLyR7b3duZWRPcHRpb25zLmRvbWFpbi5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG4gICAgICBlbmRwb2ludEJhc2UgPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgZW5kcG9pbnRCYXNlID0gb3duZWRTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7b3duZWRTdGFnZU5hbWV9YDtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludHMgPSB0aGlzLm1jcFBhdGhzLm1hcChcbiAgICAgIChwYXR0ZXJuKSA9PiBgJHtzdHJpcFRyYWlsaW5nU2xhc2goZW5kcG9pbnRCYXNlKX0ke3BhdHRlcm59YCxcbiAgICApO1xuICAgIHRoaXMuZW5kcG9pbnQgPSB0aGlzLmVuZHBvaW50c1swXTtcblxuICAgIC8vIEF0dGFjaC1tb2RlIHB1YmxpYyBhdXRob3JpdHkgYmVsb25ncyB0byB0aGUgZnJvbnQgZG9vci4gRG8gbm90IHNtdWdnbGVcbiAgICAvLyBpdCBpbnRvIHRoaXMgY29uc3RydWN0IGFzIGFuIG9yaWdpbiBwcm9wLlxuICAgIGlmICghcHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX0VORFBPSU5UXCIsIHRoaXMuZW5kcG9pbnQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkUnVudGltZVJvdXRlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIsXG4gICk6IHZvaWQge1xuICAgIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBgUm91dGUke3RoaXMucm91dGVTZXF1ZW5jZSsrfWAsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG9tYWluTmFtZTtcbiAgICBjb25zdCBhcGlNYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBzdGFnZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmcgfSkuYXBpTWFwcGluZyA9IGFwaU1hcHBpbmc7XG4gICAgaWYgKG9wdGlvbnMuaG9zdGVkWm9uZSkge1xuICAgICAgY29uc3QgY25hbWVSZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNuYW1lUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiB0b1JvdXRlNTNSZWNvcmROYW1lKG9wdGlvbnMuZG9tYWluTmFtZSwgb3B0aW9ucy5ob3N0ZWRab25lKSxcbiAgICAgICAgZG9tYWluTmFtZTogZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gY25hbWVSZWNvcmQ7XG4gICAgfVxuICB9XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICByZWFkb25seSBlbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgaWYgKHByb3BzLnJvdXRlRmFtaWx5ICE9PSB1bmRlZmluZWQgJiYgcHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5IGFuZCBkZXByZWNhdGVkIG1jcFBhdGggY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXdQYXR0ZXJucyA9IHByb3BzLnJvdXRlRmFtaWx5Py5wYXR0ZXJuc1xuICAgID8/IChwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWRcbiAgICAgID8gW3Byb3BzLm1jcFBhdGhdXG4gICAgICA6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpLm1hcChcbiAgICAgICAgKHRlbXBsYXRlKSA9PiB0ZW1wbGF0ZS5tY3BQYXR0ZXJuLFxuICAgICAgKSk7XG4gIGlmIChyYXdQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICB9XG4gIGNvbnN0IHBhdHRlcm5zID0gcmF3UGF0dGVybnMubWFwKChwYXR0ZXJuLCBpbmRleCkgPT5cbiAgICBub3JtYWxpemVSb3V0ZVBhdGgocGF0dGVybiwgYHJvdXRlRmFtaWx5LnBhdHRlcm5zWyR7aW5kZXh9XWApKTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBpZiAoc2Vlbi5oYXMocGF0dGVybikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgY29udGFpbnMgZHVwbGljYXRlIHBhdHRlcm4gJHtKU09OLnN0cmluZ2lmeShwYXR0ZXJuKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQocGF0dGVybik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwYXR0ZXJucyxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTpcbiAgICAgIHByb3BzLnJvdXRlRmFtaWx5Py5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSA/PyBmYWxzZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVQYXRoKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdHRlcm5gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpO1xuICBpZiAoIXJvdXRlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSkgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIGNvbnN0IHNlZ21lbnRzID0gcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKTtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCB8fCBzZWdtZW50cy5zb21lKChzZWdtZW50KSA9PiBzZWdtZW50ID09PSBcIlwiKSkge1xuICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICB9XG4gIGNvbnN0IGxpdGVyYWwgPSAvXig/OltBLVphLXowLTkuX34hJCYnKCkqKyw7PTpALV18JVswLTlBLUZhLWZdezJ9KSskLztcbiAgY29uc3QgcGFyYW1ldGVyID0gL15cXHsoW0EtWmEtel9dW0EtWmEtejAtOV9dKilcXH0kLztcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgaWYgKHBhcmFtZXRlci50ZXN0KHNlZ21lbnQpKSBjb250aW51ZTtcbiAgICBpZiAoIWxpdGVyYWwudGVzdChzZWdtZW50KSB8fCBzZWdtZW50LmluY2x1ZGVzKFwie1wiKSB8fCBzZWdtZW50LmluY2x1ZGVzKFwifVwiKSkge1xuICAgICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWU6IHN0cmluZyk6IEVycm9yIHtcbiAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGFic29sdXRlIHN5bnRoZXNpcy10aW1lIHJvdXRlIHBhdHRlcm4gd2l0aCBub24tZW1wdHkgbGl0ZXJhbCBvciB7cGFyYW1ldGVyX25hbWV9IHNlZ21lbnRzIGFuZCBubyBkb3Qgc2VnbWVudHNgLFxuICApO1xufVxuXG5mdW5jdGlvbiBidWlsZFJvdXRlSW52ZW50b3J5KFxuICBwYXR0ZXJuczogc3RyaW5nW10sXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbiAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbixcbik6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJvdXRlczogcGF0dGVybnMubWFwKChtY3BQYXR0ZXJuKSA9PiAoe1xuICAgICAgbWNwUGF0dGVybixcbiAgICAgIG1jcE1ldGhvZHM6IFtcIlBPU1RcIiwgXCJHRVRcIiwgXCJERUxFVEVcIl0sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkoXG4gIGludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnksXG4gIHVuYXV0aGVudGljYXRlZE1jcDogYm9vbGVhbixcbik6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFkZCA9IChtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7bWV0aG9kfSAke3BhdGh9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlcml2ZWQgcm91dGUgZmFtaWx5IGNvbGxpZGVzIGF0ICR7a2V5fWApO1xuICAgIH1cbiAgICBzZWVuLmFkZChrZXkpO1xuICB9O1xuICBmb3IgKGNvbnN0IHJvdXRlIG9mIGludmVudG9yeS5yb3V0ZXMpIHtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSBhZGQobWV0aG9kLCByb3V0ZS5tY3BQYXR0ZXJuKTtcbiAgICBpZiAoIXVuYXV0aGVudGljYXRlZE1jcCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGlmICghcHJvcHMuYXBpKSByZXR1cm47XG4gIGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9wcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJvd25lZEFwaVwiKTtcbiAgaWYgKHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiYXBpTmFtZVwiKTtcbiAgaWYgKHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJkb21haW5cIik7XG4gIGlmIChwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJzdGFnZVwiKTtcbiAgaWYgKGludmFsaWQubGVuZ3RoICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoIG1vZGUgd2l0aCBhcGkgY2Fubm90IGNvbmZpZ3VyZSBvd25lZC1BUEkgcHJvcHM6ICR7aW52YWxpZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgaWYgKHByb3BzLm93bmVkQXBpPy5hcGlOYW1lICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmFwaU5hbWUgYW5kIGRlcHJlY2F0ZWQgYXBpTmFtZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uZG9tYWluICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIGFuZCBkZXByZWNhdGVkIGRvbWFpbiBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2UgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIGFuZCBkZXByZWNhdGVkIHN0YWdlIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhcGlOYW1lOiBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSA/PyBwcm9wcy5hcGlOYW1lLFxuICAgIGRvbWFpbjogcHJvcHMub3duZWRBcGk/LmRvbWFpbiA/PyBwcm9wcy5kb21haW4sXG4gICAgc3RhZ2U6IHByb3BzLm93bmVkQXBpPy5zdGFnZSA/PyBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMpOiBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgY29uc3QgYWNjZXNzTG9nZ2luZyA9IG9wdGlvbnM/LmFjY2Vzc0xvZ2dpbmcgPz8gdHJ1ZTtcbiAgaWYgKCFhY2Nlc3NMb2dnaW5nICYmIG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ1JldGVudGlvbiByZXF1aXJlcyBhY2Nlc3NMb2dnaW5nIHRvIGJlIGVuYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmdFbmFibGVkID0gb3B0aW9ucz8udGhyb3R0bGluZ0VuYWJsZWQgPz8gdHJ1ZTtcbiAgaWYgKFxuICAgICF0aHJvdHRsaW5nRW5hYmxlZFxuICAgICYmIChvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIHRocm90dGxpbmcgbGltaXRzIHJlcXVpcmUgdGhyb3R0bGluZ0VuYWJsZWQgdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF0ZUxpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVDtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihyYXRlTGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ1JhdGVMaW1pdFwiKTtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihidXJzdExpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdCdXJzdExpbWl0XCIpO1xuICByZXR1cm4ge1xuICAgIHN0YWdlTmFtZTogb3B0aW9ucz8uc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIixcbiAgICBhY2Nlc3NMb2dnaW5nLFxuICAgIGFjY2Vzc0xvZ1JldGVudGlvbjogb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgdGhyb3R0bGluZ0VuYWJsZWQsXG4gICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogcmF0ZUxpbWl0LFxuICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBidXJzdExpbWl0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIGNvbnN0IGhhc0xlZ2FjeSA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZDtcbiAgaWYgKHByb3BzLnNlc3Npb25TdGF0ZSAhPT0gdW5kZWZpbmVkICYmIGhhc0xlZ2FjeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBzZXNzaW9uU3RhdGUgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggZGVwcmVjYXRlZCBzZXNzaW9uLXRhYmxlIHByb3BzXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbmFibGVkID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5lbmFibGVkID8/IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSA/PyB0cnVlO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnRhYmxlTmFtZSA/PyBwcm9wcy5zZXNzaW9uVGFibGVOYW1lO1xuICBjb25zdCB0dGxNaW51dGVzID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzXG4gICAgPz8gcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXNcbiAgICA/PyBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVM7XG4gIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gIGlmIChcbiAgICAhZW5hYmxlZFxuICAgICYmICh0YWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkaXNhYmxlZCBzZXNzaW9uIHN0YXRlIGNhbm5vdCBjb25maWd1cmUgdGFibGVOYW1lLCB0dGxNaW51dGVzLCBvciByZW1vdmFsUG9saWN5XCIsXG4gICAgKTtcbiAgfVxuICB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih0dGxNaW51dGVzLCBcInNlc3Npb25TdGF0ZS50dGxNaW51dGVzXCIpO1xuICByZXR1cm4geyBlbmFibGVkLCB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIHJlbW92YWxQb2xpY3kgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHJldHVybjtcbiAgY29uc3QgaXNzdWVyID0gU3RyaW5nKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIpO1xuICBjb25zdCBqd2tzVXJpID0gU3RyaW5nKHByb3BzLmp3a3NVcmkpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBpc3N1ZXIsXG4gICAgICBmYWxzZSxcbiAgICAgIFwiYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChqd2tzVXJpKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgandrc1VyaSxcbiAgICAgIHRydWUsXG4gICAgICBcImp3a3NVcmkgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyB1c2VyaW5mbyBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==