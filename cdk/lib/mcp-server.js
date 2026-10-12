"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpServer = exports.AppTheoryMcpTransportAuthorizerKind = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const constructs_1 = require("constructs");
const mcp_route_algebra_1 = require("./mcp-route-algebra");
const DEFAULT_THROTTLING_RATE_LIMIT = 100;
const DEFAULT_THROTTLING_BURST_LIMIT = 200;
const DEFAULT_SESSION_TTL_MINUTES = 60;
const MCP_TRANSPORT_AUTHORIZER_ID = "McpTransportAuthorizer";
/** Authorizer applied to the AppTheoryMcpServer MCP transport routes. */
var AppTheoryMcpTransportAuthorizerKind;
(function (AppTheoryMcpTransportAuthorizerKind) {
    /** AWS IAM (SigV4) authorization. The zero-configuration default. */
    AppTheoryMcpTransportAuthorizerKind["IAM"] = "iam";
    /** JSON Web Token authorization against an OIDC/Cognito issuer. */
    AppTheoryMcpTransportAuthorizerKind["JWT"] = "jwt";
})(AppTheoryMcpTransportAuthorizerKind || (exports.AppTheoryMcpTransportAuthorizerKind = AppTheoryMcpTransportAuthorizerKind = {}));
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "5.0.2" };
    routeSequence = 0;
    api;
    ownedApi;
    sessionTable;
    /**
     * Derived endpoint templates for the ordered MCP route family.
     *
     * In attach mode these are execute-api origin templates, not declarations of
     * public authority. An `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted; the origin is derived
     * from `apiId`, the stack region and URL suffix, plus
     * `attachedApiStageName` when supplied.
     */
    endpoints;
    mcpPaths;
    protectedResourceMetadataPaths;
    routeInventory;
    /**
     * First derived endpoint template.
     *
     * In attach mode an `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted. This value is an
     * execute-api origin template derived by the same rules as `endpoints`, not
     * the front door's public authority.
     * @deprecated Use `endpoints`.
     */
    endpoint;
    /** @deprecated Use `mcpPaths`. */
    mcpPath;
    /** @deprecated Use `protectedResourceMetadataPaths` or `routeInventory`. */
    protectedResourceMetadataPath;
    domainName;
    apiMapping;
    cnameRecord;
    accessLogGroup;
    constructor(scope, id, props) {
        super(scope, id);
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
        const integration = new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, {
            payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            scopePermissionToRoute: props.scopePermissionToRoute ?? true,
        });
        const transportAuthorizer = resolveTransportAuthorizer(props);
        const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
        for (const route of this.routeInventory.routes) {
            for (const method of route.mcpMethods) {
                this.addRuntimeRoute(route.mcpPattern, toHttpMethod(method), integration, transportAuthorizer);
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
            const executeApiOrigin = `https://${this.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
            endpointBase = props.attachedApiStageName === undefined || props.attachedApiStageName === "$default"
                ? executeApiOrigin
                : `${executeApiOrigin}/${props.attachedApiStageName}`;
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
    if (!props.api) {
        if (props.attachedApiStageName !== undefined) {
            throw new Error("AppTheoryMcpServer: attachedApiStageName requires attach mode with api");
        }
        return;
    }
    if (props.attachedApiStageName !== undefined
        && (aws_cdk_lib_1.Token.isUnresolved(props.attachedApiStageName)
            || !/^(?:\$default|[A-Za-z0-9_-]{1,128})$/.test(props.attachedApiStageName))) {
        throw new Error("AppTheoryMcpServer: attachedApiStageName must be a synthesis-time literal API Gateway stage name");
    }
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
function resolveTransportAuthorizer(props) {
    const configured = props.transportAuthorizer;
    if (props.unauthenticatedMcp ?? false) {
        if (configured !== undefined) {
            throw new Error("AppTheoryMcpServer: transportAuthorizer cannot be combined with unauthenticatedMcp: true");
        }
        return new apigwv2.HttpNoneAuthorizer();
    }
    const kind = configured?.kind ?? AppTheoryMcpTransportAuthorizerKind.IAM;
    switch (kind) {
        case AppTheoryMcpTransportAuthorizerKind.IAM: {
            const jwtOnly = jwtOnlyTransportFields(configured);
            if (jwtOnly.length !== 0) {
                throw new Error(`AppTheoryMcpServer: transportAuthorizer ${jwtOnly.join(", ")} can only be set when kind is AppTheoryMcpTransportAuthorizerKind.JWT`);
            }
            return new apigwv2Authorizers.HttpIamAuthorizer();
        }
        case AppTheoryMcpTransportAuthorizerKind.JWT: {
            const issuer = String(configured?.issuer ?? "").trim();
            if (issuer === "") {
                throw new Error("AppTheoryMcpServer: transportAuthorizer.issuer is required when kind is AppTheoryMcpTransportAuthorizerKind.JWT");
            }
            if (!aws_cdk_lib_1.Token.isUnresolved(issuer)) {
                validateLiteralOAuthURL(issuer, false, "transportAuthorizer.issuer must be an absolute HTTPS URL with no query or fragment");
            }
            const audience = (configured?.audience ?? [])
                .map((value) => String(value).trim())
                .filter((value) => value !== "");
            if (audience.length === 0) {
                throw new Error("AppTheoryMcpServer: transportAuthorizer.audience requires at least one accepted audience when kind is AppTheoryMcpTransportAuthorizerKind.JWT");
            }
            return new apigwv2Authorizers.HttpJwtAuthorizer(MCP_TRANSPORT_AUTHORIZER_ID, issuer, {
                jwtAudience: audience,
                identitySource: configured?.identitySource,
                authorizerName: configured?.authorizerName,
            });
        }
        default:
            throw new Error("AppTheoryMcpServer: transportAuthorizer.kind must be AppTheoryMcpTransportAuthorizerKind.IAM or AppTheoryMcpTransportAuthorizerKind.JWT");
    }
}
function jwtOnlyTransportFields(options) {
    if (options === undefined)
        return [];
    const fields = [];
    if (options.issuer !== undefined)
        fields.push("issuer");
    if (options.audience !== undefined)
        fields.push("audience");
    if (options.identitySource !== undefined)
        fields.push("identitySource");
    if (options.authorizerName !== undefined)
        fields.push("authorizerName");
    return fields;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUUvRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBRTdELHlFQUF5RTtBQUN6RSxJQUFZLG1DQUtYO0FBTEQsV0FBWSxtQ0FBbUM7SUFDN0MscUVBQXFFO0lBQ3JFLGtEQUFXLENBQUE7SUFDWCxtRUFBbUU7SUFDbkUsa0RBQVcsQ0FBQTtBQUNiLENBQUMsRUFMVyxtQ0FBbUMsbURBQW5DLG1DQUFtQyxRQUs5QztBQW9SRDs7Ozs7Ozs7R0FRRztBQUNILE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7O0lBQ3ZDLGFBQWEsR0FBRyxDQUFDLENBQUM7SUFFVixHQUFHLENBQW1CO0lBQ3RCLFFBQVEsQ0FBbUI7SUFDM0IsWUFBWSxDQUFtQjtJQUMvQzs7Ozs7Ozs7T0FRRztJQUNhLFNBQVMsQ0FBVztJQUNwQixRQUFRLENBQVc7SUFDbkIsOEJBQThCLENBQVc7SUFDekMsY0FBYyxDQUFtQztJQUVqRTs7Ozs7Ozs7T0FRRztJQUNhLFFBQVEsQ0FBUztJQUVqQyxrQ0FBa0M7SUFDbEIsT0FBTyxDQUFTO0lBRWhDLDRFQUE0RTtJQUM1RCw2QkFBNkIsQ0FBUztJQUV0QyxVQUFVLENBQXNCO0lBQ2hDLFVBQVUsQ0FBc0I7SUFDaEMsV0FBVyxDQUF1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bGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5cbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcblxuLyoqIEF1dGhvcml6ZXIgYXBwbGllZCB0byB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIE1DUCB0cmFuc3BvcnQgcm91dGVzLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIGF1dGhvcml6YXRpb24uIFRoZSB6ZXJvLWNvbmZpZ3VyYXRpb24gZGVmYXVsdC4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIEpTT04gV2ViIFRva2VuIGF1dGhvcml6YXRpb24gYWdhaW5zdCBhbiBPSURDL0NvZ25pdG8gaXNzdWVyLiAqL1xuICBKV1QgPSBcImp3dFwiLFxufVxuXG4vKiogQXV0aGVudGljYXRlZCBhdXRob3JpemVyIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQuSUFNICovXG4gIHJlYWRvbmx5IGtpbmQ/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyS2luZDtcbiAgLyoqIEFic29sdXRlIEhUVFBTIEpXVCBpc3N1ZXIgVVJMLiBSZXF1aXJlZCB3aGVuIGtpbmQgaXMgSldULiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgd2hlbiBraW5kIGlzIEpXVC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGF1ZGllbmNlPzogc3RyaW5nW107XG4gIC8qKiBJZGVudGl0eSBzb3VyY2VzIGZvciB0aGUgSldUIGF1dGhvcml6ZXIuIEpXVCBvbmx5LiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gSldUIG9ubHkuIEBkZWZhdWx0IHRoZSBhdXRob3JpemVyIGNvbnN0cnVjdCBpZCAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcbn1cblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xufVxuXG4vKiogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgY29uc3RydWN0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKiBMYW1iZGEgZnVuY3Rpb24gaGFuZGxpbmcgdGhlIHJ1bnRpbWUtY29tcG9zZWQgTUNQIGZhY2FkZS4gKi9cbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgTUNQIGZhY2FkZSBmYW1pbGllcyB0aGF0XG4gICAqIHNoYXJlIG9uZSBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3lcbiAgICogc2l6ZSBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEV4aXN0aW5nIEhUVFAgQVBJIHRvIGF0dGFjaCB0by4gQXR0YWNoIG1vZGUgaXMgdGhlIHByaW1hcnkgZnJvbnQtZG9vclxuICAgKiB0b3BvbG9neSBhbmQgbmV2ZXIgY3JlYXRlcyBhbiBgQVdTOjpBcGlHYXRld2F5VjI6OkFwaWAgcmVzb3VyY2UuXG4gICAqIEBkZWZhdWx0IGEgY29uc3RydWN0LW93bmVkIEh0dHBBcGlcbiAgICovXG4gIHJlYWRvbmx5IGFwaT86IGFwaWd3djIuSUh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUgdXNlZCB3aGVuIGRlcml2aW5nIGF0dGFjaC1tb2RlIGV4ZWN1dGUtYXBpIGVuZHBvaW50IHRlbXBsYXRlcy5cbiAgICogVXNlIGAkZGVmYXVsdGAgZm9yIHRoZSBBUEkgR2F0ZXdheSBkZWZhdWx0IHN0YWdlLiBXaGVuIG9taXR0ZWQsIHRoZSBzdGFnZVxuICAgKiBpcyBub3QgZGV0ZXJtaW5hYmxlIGFuZCB0aGUgdGVtcGxhdGVzIHJldGFpbiB0aGUgYmFyZSBleGVjdXRlLWFwaSBvcmlnaW4uXG4gICAqIFRoaXMgcHJvcCBkb2VzIG5vdCBjcmVhdGUsIGltcG9ydCwgb3IgbXV0YXRlIGEgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXR0YWNoZWRBcGlTdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogR28gYHJ1bnRpbWUvbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYCBzZXJ2ZXMgb25seSB0aGUgY2Fub25pY2FsIGRlZmF1bHRcbiAgICogZmFtaWx5LiBOb25jYW5vbmljYWwgcGF0dGVybnMgcmVxdWlyZSBhcHAtb3duZWQgcnVudGltZSByb3V0ZSByZWdpc3RyYXRpb25cbiAgICogdGhhdCBtYXRjaGVzIHRoZSBjb25zdHJ1Y3QncyBgcm91dGVJbnZlbnRvcnlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVGYW1pbHk/OiBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseTtcblxuICAvKipcbiAgICogRXhwbGljaXRseSBvcHQgb3V0IG9mIHRoZSBPQXV0aCBmYWNhZGUgYW5kIHdpcmUgb25seSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICpcbiAgICogVGhpcyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBsZWdhY3kgYXV0aG9yaXphdGlvbiBwcm9wcywgcm9vdCBkaXNjb3ZlcnksIG9yXG4gICAqIGB0cmFuc3BvcnRBdXRob3JpemVyYC4gVGhlIEdvIGhlbHBlciBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgXG4gICAqIGluc3RhbGxzIHRoZSBhdXRoZW50aWNhdGVkIGNhbm9uaWNhbCBmYWNhZGUgYnkgZGVmYXVsdCBhbmQgZXhwb3Nlc1xuICAgKiBgRmFjYWRlQ29uZmlnLlVuYXV0aGVudGljYXRlZE1jcGAgZm9yIHRoZSBzYW1lIHRyYW5zcG9ydCBvcHQtb3V0LCBzb1xuICAgKiBhcHBsaWNhdGlvbnMgdXNpbmcgdGhpcyBvcHQtb3V0IG11c3Qgb3duIHJ1bnRpbWUgcmVnaXN0cmF0aW9uIGZvciB0aGVcbiAgICogdHJhbnNwb3J0IHJvdXRlcy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHVuYXV0aGVudGljYXRlZE1jcD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6ZXIgYXBwbGllZCB0byB0aGUgTUNQIHRyYW5zcG9ydCByb3V0ZXMgb25seS5cbiAgICpcbiAgICogVHJhbnNwb3J0IHJvdXRlcyBhcmUgdGhlIFBPU1QsIEdFVCwgYW5kIERFTEVURSByb3V0ZXMgb24gZXZlcnkgTUNQIHBhdHRlcm4uXG4gICAqIFdoZW4gYHVuYXV0aGVudGljYXRlZE1jcGAgaXMgZmFsc2UgKHRoZSBkZWZhdWx0KSB0aG9zZSByb3V0ZXMgcmVxdWlyZVxuICAgKiBjcmVkZW50aWFscyBhbmQgZGVmYXVsdCB0byBJQU0sIHNvIGNyZWRlbnRpYWwtZnJlZSByZXF1ZXN0cyBhcmUgcmVqZWN0ZWQgYnlcbiAgICogQVBJIEdhdGV3YXkgd2l0aCA0MDMuIERpc2NvdmVyeSwgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhLCBhdXRob3JpemUsXG4gICAqIGFuZCB0b2tlbiByb3V0ZXMgcmVtYWluIGV4cGxpY2l0bHkgcHVibGljIChgTk9ORWApIGJlY2F1c2UgT0F1dGggY2xpZW50c1xuICAgKiBtdXN0IGZldGNoIHRoZW0gYmVmb3JlIHRoZXkgaG9sZCBhIHRva2VuLlxuICAgKlxuICAgKiBDYW5ub3QgYmUgY29tYmluZWQgd2l0aCBgdW5hdXRoZW50aWNhdGVkTWNwOiB0cnVlYC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRBdXRob3JpemVyPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24tc3RhdGUgdGFibGUgY29uZmlndXJhdGlvbi4gVGhlIHRhYmxlIGRlZmF1bHRzIG9uLlxuICAgKiBAZGVmYXVsdCBlbmFibGVkIHdpdGggcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblN0YXRlPzogQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucztcblxuICAvKipcbiAgICogT3duZWQtQVBJIGNvbmZpZ3VyYXRpb24gZm9yIHN0YW5kYWxvbmUgbW9kZS4gSW52YWxpZCB3aXRoIGBhcGlgLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uLW93bmVkIEFQSSBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgb3duZWRBcGk/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNpbmdsZSBNQ1Agcm91dGUgcGF0aCBmcm9tIHRoZSB2My4xLnggQTYgc3VyZmFjZS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGByb3V0ZUZhbWlseS5wYXR0ZXJuc2AuIFRoZSBuZXcgZGVmYXVsdCBpcyB0aGUgY2Fub25pY2FsXG4gICAqIGZvdXItcGF0dGVybiBmYW1pbHk7IHVzZSBgeyBwYXR0ZXJuczogWycvbWNwJ10gfWAgZm9yIHRoZSBvbGQgc2luZ2xldG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogQXV0aG9yaXphdGlvbi1zZXJ2ZXIgaXNzdWVyIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSXNzdWVyVVJMYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgaXNzdWVyIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEpXS1MgVVJJIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSldLU1VSSWAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIEpXS1MgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5hcGlOYW1lYC4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUuZW5hYmxlZGAuIFNlc3Npb24gc3RhdGUgbm93IGRlZmF1bHRzIG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudGFibGVOYW1lYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudHRsTWludXRlc2AuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmRvbWFpbmAuIERvbWFpbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLnN0YWdlYC4gU3RhZ2Ugb3B0aW9ucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIENvbnRyYWN0LWZpcnN0IE1DUCBmYWNhZGUgZGVwbG95bWVudCBjb25zdHJ1Y3QuXG4gKlxuICogVGhlIHByaW1hcnkgbW9kZSBhdHRhY2hlcyB0aGUgY29tcGxldGUgcm91dGUtYWxnZWJyYSBmYW1pbHkgdG8gYSBzdXBwbGllZFxuICogSFRUUCBBUEkuIE9taXR0aW5nIGBhcGlgIHNwZWNpYWxpemVzIHRoZSBzYW1lIHBhdGggaW50byBhIHN0YW5kYWxvbmUgb3duZWRcbiAqIEFQSS4gVGhlIGNvbnN0cnVjdCByb3V0ZXMgb25seTogT0F1dGggbWV0YWRhdGEsIHNjb3BlcywgY2FwYWJpbGl0aWVzLCBhbmRcbiAqIGF1dGhvcml6ZS90b2tlbiBiZWhhdmlvciByZW1haW4gYXBwbGljYXRpb24tb3duZWQgdGhyb3VnaCBHb1xuICogYG1jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwcml2YXRlIHJvdXRlU2VxdWVuY2UgPSAwO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgLyoqXG4gICAqIERlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGVzIGZvciB0aGUgb3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSB0aGVzZSBhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlcywgbm90IGRlY2xhcmF0aW9ucyBvZlxuICAgKiBwdWJsaWMgYXV0aG9yaXR5LiBBbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQ7IHRoZSBvcmlnaW4gaXMgZGVyaXZlZFxuICAgKiBmcm9tIGBhcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIHBsdXNcbiAgICogYGF0dGFjaGVkQXBpU3RhZ2VOYW1lYCB3aGVuIHN1cHBsaWVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKlxuICAgKiBGaXJzdCBkZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlLlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSBhbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQuIFRoaXMgdmFsdWUgaXMgYW5cbiAgICogZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlIGRlcml2ZWQgYnkgdGhlIHNhbWUgcnVsZXMgYXMgYGVuZHBvaW50c2AsIG5vdFxuICAgKiB0aGUgZnJvbnQgZG9vcidzIHB1YmxpYyBhdXRob3JpdHkuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgZW5kcG9pbnRzYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG4gICAgY29uc3QgdW5hdXRoZW50aWNhdGVkTWNwID0gcHJvcHMudW5hdXRoZW50aWNhdGVkTWNwID8/IGZhbHNlO1xuICAgIGlmIChcbiAgICAgIHVuYXV0aGVudGljYXRlZE1jcFxuICAgICAgJiYgKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1bmF1dGhlbnRpY2F0ZWRNY3AgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBvciBqd2tzVXJpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAodW5hdXRoZW50aWNhdGVkTWNwICYmIHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1bmF1dGhlbnRpY2F0ZWRNY3AgY2Fubm90IGVuYWJsZSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLm1jcFBhdGhzID0gWy4uLnJvdXRlRmFtaWx5LnBhdHRlcm5zXTtcbiAgICB0aGlzLnJvdXRlSW52ZW50b3J5ID0gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgICAgIHRoaXMubWNwUGF0aHMsXG4gICAgICAhdW5hdXRoZW50aWNhdGVkTWNwLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIHVuYXV0aGVudGljYXRlZE1jcCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBvd25lZE9wdGlvbnMuYXBpTmFtZSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzKTtcbiAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5tY3BQYXR0ZXJuLCB0b0h0dHBNZXRob2QobWV0aG9kKSwgaW50ZWdyYXRpb24sIHRyYW5zcG9ydEF1dGhvcml6ZXIpO1xuICAgICAgfVxuICAgICAgaWYgKCF1bmF1dGhlbnRpY2F0ZWRNY3ApIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuLFxuICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGVuZHBvaW50QmFzZSA9IGBodHRwczovLyR7b3duZWRPcHRpb25zLmRvbWFpbi5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG4gICAgICBjb25zdCBleGVjdXRlQXBpT3JpZ2luID0gYGh0dHBzOi8vJHt0aGlzLmFwaS5hcGlJZH0uZXhlY3V0ZS1hcGkuJHtzdGFjay5yZWdpb259LiR7c3RhY2sudXJsU3VmZml4fWA7XG4gICAgICBlbmRwb2ludEJhc2UgPSBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyBleGVjdXRlQXBpT3JpZ2luXG4gICAgICAgIDogYCR7ZXhlY3V0ZUFwaU9yaWdpbn0vJHtwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZX1gO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbmRwb2ludEJhc2UgPSBvd25lZFN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtvd25lZFN0YWdlTmFtZX1gO1xuICAgIH1cbiAgICB0aGlzLmVuZHBvaW50cyA9IHRoaXMubWNwUGF0aHMubWFwKFxuICAgICAgKHBhdHRlcm4pID0+IGAke3N0cmlwVHJhaWxpbmdTbGFzaChlbmRwb2ludEJhc2UpfSR7cGF0dGVybn1gLFxuICAgICk7XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuXG4gICAgLy8gQXR0YWNoLW1vZGUgcHVibGljIGF1dGhvcml0eSBiZWxvbmdzIHRvIHRoZSBmcm9udCBkb29yLiBEbyBub3Qgc211Z2dsZVxuICAgIC8vIGl0IGludG8gdGhpcyBjb25zdHJ1Y3QgYXMgYW4gb3JpZ2luIHByb3AuXG4gICAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfRU5EUE9JTlRcIiwgdGhpcy5lbmRwb2ludCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiB2b2lkIHtcbiAgICBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIG1ldGhvZCksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJldHVybiB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQ09OVFJBQ1RfVkVSU0lPTixcbiAgICByb3V0ZXM6IHBhdHRlcm5zLm1hcCgobWNwUGF0dGVybikgPT4gKHtcbiAgICAgIG1jcFBhdHRlcm4sXG4gICAgICBtY3BNZXRob2RzOiBbXCJQT1NUXCIsIFwiR0VUXCIsIFwiREVMRVRFXCJdLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5U3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgdG9rZW5QYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICB9KSksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFwiL1wiKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICB1bmF1dGhlbnRpY2F0ZWRNY3A6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKCF1bmF1dGhlbnRpY2F0ZWRNY3ApIHtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS50b2tlblBhdHRlcm4pO1xuICAgIH1cbiAgfVxuICBpZiAoaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybik7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBpZiAoIXByb3BzLmFwaSkge1xuICAgIGlmIChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSByZXF1aXJlcyBhdHRhY2ggbW9kZSB3aXRoIGFwaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgJiYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSlcbiAgICAgIHx8ICEvXig/OlxcJGRlZmF1bHR8W0EtWmEtejAtOV8tXXsxLDEyOH0pJC8udGVzdChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSkpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBBUEkgR2F0ZXdheSBzdGFnZSBuYW1lXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocHJvcHMub3duZWRBcGkgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwib3duZWRBcGlcIik7XG4gIGlmIChwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImFwaU5hbWVcIik7XG4gIGlmIChwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiZG9tYWluXCIpO1xuICBpZiAocHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwic3RhZ2VcIik7XG4gIGlmIChpbnZhbGlkLmxlbmd0aCAhPT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaCBtb2RlIHdpdGggYXBpIGNhbm5vdCBjb25maWd1cmUgb3duZWQtQVBJIHByb3BzOiAke2ludmFsaWQuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5hcGlOYW1lIGFuZCBkZXByZWNhdGVkIGFwaU5hbWUgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LmRvbWFpbiAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiBhbmQgZGVwcmVjYXRlZCBkb21haW4gY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSBhbmQgZGVwcmVjYXRlZCBzdGFnZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYXBpTmFtZTogcHJvcHMub3duZWRBcGk/LmFwaU5hbWUgPz8gcHJvcHMuYXBpTmFtZSxcbiAgICBkb21haW46IHByb3BzLm93bmVkQXBpPy5kb21haW4gPz8gcHJvcHMuZG9tYWluLFxuICAgIHN0YWdlOiBwcm9wcy5vd25lZEFwaT8uc3RhZ2UgPz8gcHJvcHMuc3RhZ2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvcHRpb25zPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zKTogTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIGNvbnN0IGFjY2Vzc0xvZ2dpbmcgPSBvcHRpb25zPy5hY2Nlc3NMb2dnaW5nID8/IHRydWU7XG4gIGlmICghYWNjZXNzTG9nZ2luZyAmJiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dSZXRlbnRpb24gcmVxdWlyZXMgYWNjZXNzTG9nZ2luZyB0byBiZSBlbmFibGVkXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nRW5hYmxlZCA9IG9wdGlvbnM/LnRocm90dGxpbmdFbmFibGVkID8/IHRydWU7XG4gIGlmIChcbiAgICAhdGhyb3R0bGluZ0VuYWJsZWRcbiAgICAmJiAob3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSB0aHJvdHRsaW5nIGxpbWl0cyByZXF1aXJlIHRocm90dGxpbmdFbmFibGVkIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhdGVMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQ7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIocmF0ZUxpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdSYXRlTGltaXRcIik7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIoYnVyc3RMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nQnVyc3RMaW1pdFwiKTtcbiAgcmV0dXJuIHtcbiAgICBzdGFnZU5hbWU6IG9wdGlvbnM/LnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIsXG4gICAgYWNjZXNzTG9nZ2luZyxcbiAgICBhY2Nlc3NMb2dSZXRlbnRpb246IG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIHRocm90dGxpbmdFbmFibGVkLFxuICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHJhdGVMaW1pdCxcbiAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogYnVyc3RMaW1pdCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICBjb25zdCBoYXNMZWdhY3kgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQ7XG4gIGlmIChwcm9wcy5zZXNzaW9uU3RhdGUgIT09IHVuZGVmaW5lZCAmJiBoYXNMZWdhY3kpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogc2Vzc2lvblN0YXRlIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGRlcHJlY2F0ZWQgc2Vzc2lvbi10YWJsZSBwcm9wc1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW5hYmxlZCA9IHByb3BzLnNlc3Npb25TdGF0ZT8uZW5hYmxlZCA/PyBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgPz8gdHJ1ZTtcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgPz8gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZTtcbiAgY29uc3QgdHRsTWludXRlcyA9IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlc1xuICAgID8/IHByb3BzLnNlc3Npb25UdGxNaW51dGVzXG4gICAgPz8gREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTO1xuICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICBpZiAoXG4gICAgIWVuYWJsZWRcbiAgICAmJiAodGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlcyAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZGlzYWJsZWQgc2Vzc2lvbiBzdGF0ZSBjYW5ub3QgY29uZmlndXJlIHRhYmxlTmFtZSwgdHRsTWludXRlcywgb3IgcmVtb3ZhbFBvbGljeVwiLFxuICAgICk7XG4gIH1cbiAgdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodHRsTWludXRlcywgXCJzZXNzaW9uU3RhdGUudHRsTWludXRlc1wiKTtcbiAgcmV0dXJuIHsgZW5hYmxlZCwgdGFibGVOYW1lLCB0dGxNaW51dGVzLCByZW1vdmFsUG9saWN5IH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSByZXR1cm47XG4gIGNvbnN0IGlzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgaXNzdWVyLFxuICAgICAgZmFsc2UsXG4gICAgICBcImF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoandrc1VyaSkpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGp3a3NVcmksXG4gICAgICB0cnVlLFxuICAgICAgXCJqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4pOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnRyYW5zcG9ydEF1dGhvcml6ZXI7XG4gIGlmIChwcm9wcy51bmF1dGhlbnRpY2F0ZWRNY3AgPz8gZmFsc2UpIHtcbiAgICBpZiAoY29uZmlndXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIHVuYXV0aGVudGljYXRlZE1jcDogdHJ1ZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICB9XG5cbiAgY29uc3Qga2luZCA9IGNvbmZpZ3VyZWQ/LmtpbmQgPz8gQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQuSUFNO1xuICBzd2l0Y2ggKGtpbmQpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJLaW5kLklBTToge1xuICAgICAgY29uc3Qgand0T25seSA9IGp3dE9ubHlUcmFuc3BvcnRGaWVsZHMoY29uZmlndXJlZCk7XG4gICAgICBpZiAoand0T25seS5sZW5ndGggIT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIgJHtqd3RPbmx5LmpvaW4oXCIsIFwiKX0gY2FuIG9ubHkgYmUgc2V0IHdoZW4ga2luZCBpcyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyS2luZC5KV1RgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cElhbUF1dGhvcml6ZXIoKTtcbiAgICB9XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyS2luZC5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4ga2luZCBpcyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyS2luZC5KV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIGtpbmQgaXMgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQuSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmtpbmQgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyS2luZC5JQU0gb3IgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplcktpbmQuSldUXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGp3dE9ubHlUcmFuc3BvcnRGaWVsZHMoXG4gIG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucyxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKG9wdGlvbnMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFtdO1xuICBjb25zdCBmaWVsZHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChvcHRpb25zLmlzc3VlciAhPT0gdW5kZWZpbmVkKSBmaWVsZHMucHVzaChcImlzc3VlclwiKTtcbiAgaWYgKG9wdGlvbnMuYXVkaWVuY2UgIT09IHVuZGVmaW5lZCkgZmllbGRzLnB1c2goXCJhdWRpZW5jZVwiKTtcbiAgaWYgKG9wdGlvbnMuaWRlbnRpdHlTb3VyY2UgIT09IHVuZGVmaW5lZCkgZmllbGRzLnB1c2goXCJpZGVudGl0eVNvdXJjZVwiKTtcbiAgaWYgKG9wdGlvbnMuYXV0aG9yaXplck5hbWUgIT09IHVuZGVmaW5lZCkgZmllbGRzLnB1c2goXCJhdXRob3JpemVyTmFtZVwiKTtcbiAgcmV0dXJuIGZpZWxkcztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==