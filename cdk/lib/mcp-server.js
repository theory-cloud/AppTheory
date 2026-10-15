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
exports.AppTheoryMcpServer = exports.AppTheoryMcpOriginReachability = exports.AppTheoryMcpTransportPosture = void 0;
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
const MCP_TRANSPORT_POSTURE_METADATA_KEY = "apptheory:mcp-transport-posture";
const MCP_TRANSPORT_POSTURE_CONTRACT_ID = "m17.mcp-transport-posture/v1";
const MCP_DENIAL_METRIC_NAME = "apptheory.mcp.auth_denied";
const MCP_DENIAL_DIMENSIONS = ["outcome", "route_family"];
/** Transport-route authorization posture for AppTheoryMcpServer. */
var AppTheoryMcpTransportPosture;
(function (AppTheoryMcpTransportPosture) {
    /** AWS IAM (SigV4) on the transport routes. The default for a server with no facade attachment. */
    AppTheoryMcpTransportPosture["IAM"] = "iam";
    /** A static JWT authorizer (issuer + audience) on the transport routes. */
    AppTheoryMcpTransportPosture["JWT"] = "jwt";
    /** The gateway authorizer is NONE and the runtime validates RFC 9728 bearer tokens. The default for a facade-configured server. */
    AppTheoryMcpTransportPosture["RUNTIME_BEARER"] = "runtime-bearer";
    /** Deliberately public MCP server: every transport route is public. Never a default. */
    AppTheoryMcpTransportPosture["NONE_PUBLIC"] = "none-public";
})(AppTheoryMcpTransportPosture || (exports.AppTheoryMcpTransportPosture = AppTheoryMcpTransportPosture = {}));
/** Direct-origin reachability decision required under `runtime-bearer` and `none-public`. */
var AppTheoryMcpOriginReachability;
(function (AppTheoryMcpOriginReachability) {
    /** The execute-api default endpoint is disabled. */
    AppTheoryMcpOriginReachability["DISABLED"] = "disabled";
    /** The origin is reachable only through a locked front door (CloudFront / VPC origin). */
    AppTheoryMcpOriginReachability["LOCKED"] = "locked";
})(AppTheoryMcpOriginReachability || (exports.AppTheoryMcpOriginReachability = AppTheoryMcpOriginReachability = {}));
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "6.1.0" };
    routeSequence = 0;
    api;
    ownedApi;
    sessionTable;
    /**
     * Resolved transport-route authorization posture.
     *
     * Facade-configured servers resolve to `runtime-bearer` unless
     * `transportPosture` overrides the default; plain transport servers resolve
     * to `iam`. Deliberately public servers must select `none-public` explicitly.
     */
    transportPosture;
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
        const posture = props.transportPosture
            ?? (props.facade !== undefined
                ? AppTheoryMcpTransportPosture.RUNTIME_BEARER
                : AppTheoryMcpTransportPosture.IAM);
        validateTransportPosture(posture);
        validateFacadeAttachment(props.facade);
        validatePostureGuards(props, routeFamily, posture);
        validateDefenseInDepth(props, posture);
        const authorizationRoutesAttached = posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC;
        const upstreamCallbackPath = resolveUpstreamCallbackPath(props);
        this.transportPosture = posture;
        this.mcpPaths = [...routeFamily.patterns];
        this.routeInventory = buildRouteInventory(this.mcpPaths, authorizationRoutesAttached, routeFamily.rootAuthorizationServerDiscovery, upstreamCallbackPath);
        validateRouteInventory(this.routeInventory, authorizationRoutesAttached);
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
        const transportAuthorizer = resolveTransportAuthorizer(props, posture);
        const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
        let firstTransportRoute;
        for (const route of this.routeInventory.routes) {
            for (const method of route.mcpMethods) {
                const created = this.addRuntimeRoute(route.mcpPattern, toHttpMethod(method), integration, transportAuthorizer);
                firstTransportRoute = firstTransportRoute ?? created;
            }
            if (authorizationRoutesAttached) {
                this.addRuntimeRoute(route.protectedResourcePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.discoveryCanonicalPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.discoverySuffixPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.authorizePattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.tokenPattern, apigwv2.HttpMethod.POST, integration, runtimeOwnedAuth);
                this.addRuntimeRoute(route.registerPattern, apigwv2.HttpMethod.POST, integration, runtimeOwnedAuth);
            }
        }
        // The upstream callback is stage-global, not per kind: wire it exactly once.
        if (authorizationRoutesAttached) {
            this.addRuntimeRoute(this.routeInventory.callbackPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        }
        if (this.routeInventory.rootAuthorizationServerAttached) {
            this.addRuntimeRoute(this.routeInventory.rootAuthorizationServerPattern, apigwv2.HttpMethod.GET, integration, runtimeOwnedAuth);
        }
        const postureMarkerTarget = (this.ownedApi?.node.defaultChild
            ?? firstTransportRoute?.node.defaultChild);
        postureMarkerTarget?.addMetadata(MCP_TRANSPORT_POSTURE_METADATA_KEY, {
            posture,
            contract_id: MCP_TRANSPORT_POSTURE_CONTRACT_ID,
            route_count: this.routeInventory.routes.length,
            runtime_posture_declared: props.runtimePosture !== undefined,
        });
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
    }
    addRuntimeRoute(path, method, integration, authorizer) {
        return new apigwv2.HttpRoute(this, `Route${this.routeSequence++}`, {
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
function resolveUpstreamCallbackPath(props) {
    const configured = props.upstreamCallbackPath;
    if (configured === undefined) {
        return mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH;
    }
    if (aws_cdk_lib_1.Token.isUnresolved(configured)) {
        throw new Error("AppTheoryMcpServer: upstreamCallbackPath must be a synthesis-time literal route path");
    }
    try {
        return mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath(configured);
    }
    catch (err) {
        const reason = err instanceof Error
            ? err.message.replace(/^mcproutes: /, "")
            : String(err);
        throw new Error(`AppTheoryMcpServer: upstreamCallbackPath is invalid: ${reason}`);
    }
}
function buildRouteInventory(patterns, authorizationRoutesAttached, rootAuthorizationServerAttached, callbackPattern) {
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
            registerPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(mcpPattern),
            authorizationRoutesAttached,
        })),
        rootAuthorizationServerPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
        rootAuthorizationServerAttached,
        callbackPattern,
    };
}
function validateRouteInventory(inventory, authorizationRoutesAttached) {
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
        if (authorizationRoutesAttached) {
            add("GET", route.protectedResourcePattern);
            add("GET", route.discoveryCanonicalPattern);
            add("GET", route.discoverySuffixPattern);
            add("GET", route.authorizePattern);
            add("POST", route.tokenPattern);
            add("POST", route.registerPattern);
        }
    }
    if (authorizationRoutesAttached) {
        add("GET", inventory.callbackPattern);
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
function resolveTransportAuthorizer(props, posture) {
    const configured = props.transportAuthorizer;
    switch (posture) {
        case AppTheoryMcpTransportPosture.IAM:
        case AppTheoryMcpTransportPosture.RUNTIME_BEARER:
        case AppTheoryMcpTransportPosture.NONE_PUBLIC: {
            if (configured !== undefined) {
                throw new Error("AppTheoryMcpServer: transportAuthorizer is only valid with transportPosture JWT");
            }
            return posture === AppTheoryMcpTransportPosture.IAM
                ? new apigwv2Authorizers.HttpIamAuthorizer()
                : new apigwv2.HttpNoneAuthorizer();
        }
        case AppTheoryMcpTransportPosture.JWT: {
            const issuer = String(configured?.issuer ?? "").trim();
            if (issuer === "") {
                throw new Error("AppTheoryMcpServer: transportAuthorizer.issuer is required when transportPosture is JWT");
            }
            if (!aws_cdk_lib_1.Token.isUnresolved(issuer)) {
                validateLiteralOAuthURL(issuer, false, "transportAuthorizer.issuer must be an absolute HTTPS URL with no query or fragment");
            }
            const audience = (configured?.audience ?? [])
                .map((value) => String(value).trim())
                .filter((value) => value !== "");
            if (audience.length === 0) {
                throw new Error("AppTheoryMcpServer: transportAuthorizer.audience requires at least one accepted audience when transportPosture is JWT");
            }
            return new apigwv2Authorizers.HttpJwtAuthorizer(MCP_TRANSPORT_AUTHORIZER_ID, issuer, {
                jwtAudience: audience,
                identitySource: configured?.identitySource,
                authorizerName: configured?.authorizerName,
            });
        }
        default:
            throw new Error("AppTheoryMcpServer: transportPosture must be AppTheoryMcpTransportPosture.IAM, .JWT, .RUNTIME_BEARER, or .NONE_PUBLIC");
    }
}
function postureLabel(posture) {
    switch (posture) {
        case AppTheoryMcpTransportPosture.IAM: return "IAM";
        case AppTheoryMcpTransportPosture.JWT: return "JWT";
        case AppTheoryMcpTransportPosture.RUNTIME_BEARER: return "RUNTIME_BEARER";
        case AppTheoryMcpTransportPosture.NONE_PUBLIC: return "NONE_PUBLIC";
        default: return String(posture);
    }
}
function validateTransportPosture(posture) {
    switch (posture) {
        case AppTheoryMcpTransportPosture.IAM:
        case AppTheoryMcpTransportPosture.JWT:
        case AppTheoryMcpTransportPosture.RUNTIME_BEARER:
        case AppTheoryMcpTransportPosture.NONE_PUBLIC:
            return;
        default:
            throw new Error("AppTheoryMcpServer: transportPosture must be AppTheoryMcpTransportPosture.IAM, .JWT, .RUNTIME_BEARER, or .NONE_PUBLIC");
    }
}
function validateFacadeAttachment(facade) {
    if (facade === undefined)
        return;
    const providerId = facade?.providerId;
    if (typeof providerId !== "string"
        || providerId.trim() === ""
        || aws_cdk_lib_1.Token.isUnresolved(providerId)) {
        throw new Error("AppTheoryMcpServer: facade.providerId must be a non-empty synthesis-time literal string");
    }
}
function validatePostureGuards(props, routeFamily, posture) {
    if (posture === AppTheoryMcpTransportPosture.NONE_PUBLIC) {
        if (props.authorizationServerIssuer !== undefined || props.jwksUri !== undefined) {
            throw new Error("AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot be combined with authorizationServerIssuer or jwksUri");
        }
        if (routeFamily.rootAuthorizationServerDiscovery) {
            throw new Error("AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot enable rootAuthorizationServerDiscovery");
        }
        if (props.runtimePosture !== undefined) {
            throw new Error("AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot declare runtimePosture");
        }
        if (props.upstreamCallbackPath !== undefined) {
            throw new Error("AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot declare upstreamCallbackPath");
        }
        return;
    }
    if (posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
        && props.runtimePosture !== undefined) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${postureLabel(posture)} cannot declare runtimePosture`);
    }
}
function validateDefenseInDepth(props, posture) {
    if (posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
        && posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC) {
        return;
    }
    const label = postureLabel(posture);
    if (posture === AppTheoryMcpTransportPosture.RUNTIME_BEARER
        && (props.runtimePosture === undefined || props.runtimePosture.requireBearerToken !== true)) {
        throw new Error("AppTheoryMcpServer: transportPosture RUNTIME_BEARER requires runtimePosture.requireBearerToken to be true");
    }
    if (props.originReachability !== AppTheoryMcpOriginReachability.DISABLED
        && props.originReachability !== AppTheoryMcpOriginReachability.LOCKED) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires originReachability to be AppTheoryMcpOriginReachability.DISABLED or .LOCKED`);
    }
    if (props.api !== undefined) {
        validateOwningApiDefense(props.owningApiDefense, label);
    }
    else {
        if (props.ownedApi?.stage?.throttlingEnabled !== true) {
            throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires an explicit ownedApi.stage.throttlingEnabled: true throttling decision`);
        }
        if (props.ownedApi?.stage?.accessLogging === false) {
            throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires access logging`);
        }
    }
    if (posture === AppTheoryMcpTransportPosture.RUNTIME_BEARER) {
        validateDenialSignal(props.denialSignal);
    }
}
function validateOwningApiDefense(defense, label) {
    if (defense === undefined) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense to record the owning API's access logging and throttling decisions`);
    }
    if (defense.accessLogging !== true) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense.accessLogging to be true`);
    }
    const throttling = defense.throttling;
    const rateLimit = throttling?.rateLimit;
    const burstLimit = throttling?.burstLimit;
    if (!Number.isFinite(rateLimit)
        || rateLimit <= 0
        || !Number.isFinite(burstLimit)
        || burstLimit <= 0) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense.throttling rateLimit and burstLimit to be positive finite numbers`);
    }
}
function validateDenialSignal(signal) {
    if (signal === undefined) {
        throw new Error("AppTheoryMcpServer: transportPosture RUNTIME_BEARER requires denialSignal");
    }
    if (signal.metricName !== undefined && signal.metricName !== MCP_DENIAL_METRIC_NAME) {
        throw new Error(`AppTheoryMcpServer: denialSignal.metricName must be ${MCP_DENIAL_METRIC_NAME}`);
    }
    if (signal.dimensions !== undefined) {
        const dimensions = Array.isArray(signal.dimensions) ? signal.dimensions : [];
        const bounded = dimensions.length === MCP_DENIAL_DIMENSIONS.length
            && MCP_DENIAL_DIMENSIONS.every((dimension) => dimensions.filter((value) => value === dimension).length === 1);
        if (!bounded) {
            throw new Error(`AppTheoryMcpServer: denialSignal.dimensions must be exactly ${JSON.stringify(MCP_DENIAL_DIMENSIONS)}`);
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUUvRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBQzdELE1BQU0sa0NBQWtDLEdBQUcsaUNBQWlDLENBQUM7QUFDN0UsTUFBTSxpQ0FBaUMsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RSxNQUFNLHNCQUFzQixHQUFHLDJCQUEyQixDQUFDO0FBQzNELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFFMUQsb0VBQW9FO0FBQ3BFLElBQVksNEJBU1g7QUFURCxXQUFZLDRCQUE0QjtJQUN0QyxtR0FBbUc7SUFDbkcsMkNBQVcsQ0FBQTtJQUNYLDJFQUEyRTtJQUMzRSwyQ0FBVyxDQUFBO0lBQ1gsbUlBQW1JO0lBQ25JLGlFQUFpQyxDQUFBO0lBQ2pDLHdGQUF3RjtJQUN4RiwyREFBMkIsQ0FBQTtBQUM3QixDQUFDLEVBVFcsNEJBQTRCLDRDQUE1Qiw0QkFBNEIsUUFTdkM7QUFjRCw2RkFBNkY7QUFDN0YsSUFBWSw4QkFLWDtBQUxELFdBQVksOEJBQThCO0lBQ3hDLG9EQUFvRDtJQUNwRCx1REFBcUIsQ0FBQTtJQUNyQiwwRkFBMEY7SUFDMUYsbURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLDhCQUE4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SUFDM0IsSUFBSSxJQUFJLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ3RFLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsQ0FBQyxLQUFhO0lBQ2xELE1BQU0sU0FBUyxHQUFHLGtDQUFrQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLE9BQU8sU0FBUyxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUVELFNBQVMsOEJBQThCLENBQUMsS0FBYTtJQUNuRCxNQUFNLFNBQVMsR0FBRyx3Q0FBd0MsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxPQUFPLFNBQVMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDO0FBQzNDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIH0gZnJvbSBcIi4vbWNwLXJvdXRlLWFsZ2VicmFcIjtcblxuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQgPSAxMDA7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQgPSAyMDA7XG5jb25zdCBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVMgPSA2MDtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCA9IFwiTWNwVHJhbnNwb3J0QXV0aG9yaXplclwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSA9IFwiYXBwdGhlb3J5Om1jcC10cmFuc3BvcnQtcG9zdHVyZVwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lEID0gXCJtMTcubWNwLXRyYW5zcG9ydC1wb3N0dXJlL3YxXCI7XG5jb25zdCBNQ1BfREVOSUFMX01FVFJJQ19OQU1FID0gXCJhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkXCI7XG5jb25zdCBNQ1BfREVOSUFMX0RJTUVOU0lPTlMgPSBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdO1xuXG4vKiogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuIFRoZSBkZWZhdWx0IGZvciBhIHNlcnZlciB3aXRoIG5vIGZhY2FkZSBhdHRhY2htZW50LiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogQSBzdGF0aWMgSldUIGF1dGhvcml6ZXIgKGlzc3VlciArIGF1ZGllbmNlKSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gKi9cbiAgSldUID0gXCJqd3RcIixcbiAgLyoqIFRoZSBnYXRld2F5IGF1dGhvcml6ZXIgaXMgTk9ORSBhbmQgdGhlIHJ1bnRpbWUgdmFsaWRhdGVzIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMuIFRoZSBkZWZhdWx0IGZvciBhIGZhY2FkZS1jb25maWd1cmVkIHNlcnZlci4gKi9cbiAgUlVOVElNRV9CRUFSRVIgPSBcInJ1bnRpbWUtYmVhcmVyXCIsXG4gIC8qKiBEZWxpYmVyYXRlbHkgcHVibGljIE1DUCBzZXJ2ZXI6IGV2ZXJ5IHRyYW5zcG9ydCByb3V0ZSBpcyBwdWJsaWMuIE5ldmVyIGEgZGVmYXVsdC4gKi9cbiAgTk9ORV9QVUJMSUMgPSBcIm5vbmUtcHVibGljXCIsXG59XG5cbi8qKiBQcmVzZW5jZS1vbmx5IHNrZWxldG9uIG9mIHRoZSB1cHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgc2VsZWN0cyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50IHtcbiAgLyoqIElkZW50aWZpZXMgdGhlIHVwc3RyZWFtIGF1dGhvcml6YXRpb24gcHJvdmlkZXIgdGhpcyBzZXJ2ZXIgZnJvbnRzIChmb3IgZXhhbXBsZSBgYXV0aGVvcnlgKS4gUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUgYW5kIHVzZXMgaXRzIHByZXNlbmNlIHRvIHNlbGVjdCB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBkZWZhdWx0LiAqL1xuICByZWFkb25seSBwcm92aWRlcklkOiBzdHJpbmc7XG59XG5cbi8qKiBSdW50aW1lLXNpZGUgZGVjbGFyYXRpb24gdGhhdCB0aGUgdHJhbnNwb3J0IHJvdXRlcyB2YWxpZGF0ZSBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zIGF0IHJ1bnRpbWUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucyB7XG4gIC8qKiBBc3NlcnQgdGhlIHJ1bnRpbWUgcmVnaXN0ZXJzIHRoZSB0cmFuc3BvcnQgcm91dGVzIHdpdGggdGhlIHJ1bnRpbWUtdmFsaWRhdGVkIGJlYXJlciBwb3N0dXJlIChHbyBgRmFjYWRlQ29uZmlnLlJlcXVpcmVCZWFyZXJUb2tlbmAsIFRTIGByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlYCwgUHl0aG9uIGByZXF1aXJlX2JlYXJlcl90b2tlbl9taWRkbGV3YXJlYCkuIE11c3QgYmUgYHRydWVgLiAqL1xuICByZWFkb25seSByZXF1aXJlQmVhcmVyVG9rZW46IGJvb2xlYW47XG59XG5cbi8qKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqIFRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGlzIGRpc2FibGVkLiAqL1xuICBESVNBQkxFRCA9IFwiZGlzYWJsZWRcIixcbiAgLyoqIFRoZSBvcmlnaW4gaXMgcmVhY2hhYmxlIG9ubHkgdGhyb3VnaCBhIGxvY2tlZCBmcm9udCBkb29yIChDbG91ZEZyb250IC8gVlBDIG9yaWdpbikuICovXG4gIExPQ0tFRCA9IFwibG9ja2VkXCIsXG59XG5cbi8qKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMge1xuICAvKiogRGVuaWFsIG1ldHJpYyBuYW1lLiBNdXN0IGJlIGBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkYC4gQGRlZmF1bHQgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZCAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lPzogc3RyaW5nO1xuICAvKiogQm91bmRlZCBtZXRyaWMgZGltZW5zaW9ucy4gTXVzdCBiZSBleGFjdGx5IGBvdXRjb21lYCBhbmQgYHJvdXRlX2ZhbWlseWAuIEBkZWZhdWx0IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl0gKi9cbiAgcmVhZG9ubHkgZGltZW5zaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vKiogT3duaW5nLUFQSSBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucyB7XG4gIC8qKiBTdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdDogbnVtYmVyO1xuICAvKiogU3RhZ2UgYnVyc3QgbGltaXQuICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuLyoqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIGRlZmVuc2UtaW4tZGVwdGggZGVjaXNpb25zIChyZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMge1xuICAvKiogV2hldGhlciB0aGUgb3duaW5nIEFQSSdzIHN0YWdlIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLiBNdXN0IGJlIHRydWUuICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIC8qKiBUaGUgb3duaW5nIEFQSSdzIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmc6IEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zO1xufVxuXG4vKiogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgSFRUUFMgSldUIGlzc3VlciBVUkwuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBhdWRpZW5jZT86IHN0cmluZ1tdO1xuICAvKiogSWRlbnRpdHkgc291cmNlcyBmb3IgdGhlIEpXVCBhdXRob3JpemVyLiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gQGRlZmF1bHQgdGhlIGF1dGhvcml6ZXIgY29uc3RydWN0IGlkICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xufVxuXG4vKiogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlLCBgbWNwLmV4YW1wbGUuY29tYCkuICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlQXJuYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGFuIGF1dG9tYXRpY2FsbHkgY3JlYXRlZCBDTkFNRSByZWNvcmQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbi8qKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgXCIkZGVmYXVsdFwiICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgdGhlIGFjY2VzcyBsb2cgZ3JvdXAuIFZhbGlkIG9ubHkgd2hlbiBhY2Nlc3MgbG9nZ2luZ1xuICAgKiBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC5cbiAgICogQGRlZmF1bHQgMTAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCAyMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKiogT3duZWQtQVBJIHNwZWNpYWxpemF0aW9uIGZvciBzdGFuZGFsb25lIE1DUCBzZXJ2ZXJzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnMge1xuICAvKiogT3B0aW9uYWwgQVBJIG5hbWUuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIE9wdGlvbmFsIGN1c3RvbSBkb21haW4gb3duZWQgYnkgdGhpcyBjb25zdHJ1Y3QuICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uIEFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlZmF1bHQgb24uXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKiogT3JkZXJlZCBNQ1Agcm91dGUtcGF0dGVybiBmYW1pbHkgd2lyZWQgYXMgb25lIGZhY2FkZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUm91dGVGYW1pbHkge1xuICAvKipcbiAgICogT3JkZXJlZCBzeW50aGVzaXMtdGltZSBNQ1Agcm91dGUgcGF0dGVybnMuXG4gICAqXG4gICAqIEVhY2ggc2VnbWVudCBpcyBlaXRoZXIgYSBsaXRlcmFsIFJGQyAzOTg2IHBhdGggc2VnbWVudCBvciBhIGNvbXBsZXRlXG4gICAqIGB7cGFyYW1ldGVyX25hbWV9YCBzZWdtZW50LiBDREsgdG9rZW5zLCBvcmlnaW5zLCBlbXB0eSBzZWdtZW50cywgZG90XG4gICAqIHNlZ21lbnRzLCBncmVlZHkgcGFyYW1ldGVycywgYW5kIGR1cGxpY2F0ZSBwYXR0ZXJucyBhcmUgcmVqZWN0ZWQuXG4gICAqL1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdpcmUgdGhlIGFsZ2VicmEtZGVyaXZlZCB1bnNjb3BlZCBhdXRob3JpemF0aW9uLXNlcnZlciBkaXNjb3Zlcnkgcm91dGUuXG4gICAqIFRoZSBydW50aW1lIG11c3Qgc3VwcGx5IGBGYWNhZGVDb25maWcuUm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJgIHRvby5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5PzogYm9vbGVhbjtcbn1cblxuLyoqIER5bmFtb0RCLWJhY2tlZCBNQ1Agc2Vzc2lvbi1zdGF0ZSBjb25maWd1cmF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgZW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgbmFtZS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgYXV0by1nZW5lcmF0ZWRcbiAgICovXG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVFRMIGluIG1pbnV0ZXMgZm9yIHNlc3Npb24gcmVjb3Jkcy4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXNcbiAgICogZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgcmVtb3ZhbCBwb2xpY3kuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbn1cblxuLyoqIE9uZSBkZXJpdmVkIE1DUCBPQXV0aCBmYWNhZGUgcm91dGUgZmFtaWx5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZSB7XG4gIHJlYWRvbmx5IG1jcFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbWNwTWV0aG9kczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSB0b2tlblBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcmVnaXN0ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xuICByZWFkb25seSBjYWxsYmFja1BhdHRlcm46IHN0cmluZztcbn1cblxuLyoqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKiogTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIHRoZSBydW50aW1lLWNvbXBvc2VkIE1DUCBmYWNhZGUuICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIE1DUCBmYWNhZGUgZmFtaWxpZXMgdGhhdFxuICAgKiBzaGFyZSBvbmUgTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5XG4gICAqIHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBFeGlzdGluZyBIVFRQIEFQSSB0byBhdHRhY2ggdG8uIEF0dGFjaCBtb2RlIGlzIHRoZSBwcmltYXJ5IGZyb250LWRvb3JcbiAgICogdG9wb2xvZ3kgYW5kIG5ldmVyIGNyZWF0ZXMgYW4gYEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlgIHJlc291cmNlLlxuICAgKiBAZGVmYXVsdCBhIGNvbnN0cnVjdC1vd25lZCBIdHRwQXBpXG4gICAqL1xuICByZWFkb25seSBhcGk/OiBhcGlnd3YyLklIdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lIHVzZWQgd2hlbiBkZXJpdmluZyBhdHRhY2gtbW9kZSBleGVjdXRlLWFwaSBlbmRwb2ludCB0ZW1wbGF0ZXMuXG4gICAqIFVzZSBgJGRlZmF1bHRgIGZvciB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdCBzdGFnZS4gV2hlbiBvbWl0dGVkLCB0aGUgc3RhZ2VcbiAgICogaXMgbm90IGRldGVybWluYWJsZSBhbmQgdGhlIHRlbXBsYXRlcyByZXRhaW4gdGhlIGJhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luLlxuICAgKiBUaGlzIHByb3AgZG9lcyBub3QgY3JlYXRlLCBpbXBvcnQsIG9yIG11dGF0ZSBhIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF0dGFjaGVkQXBpU3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEdvIGBydW50aW1lL21jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAgc2VydmVzIG9ubHkgdGhlIGNhbm9uaWNhbCBkZWZhdWx0XG4gICAqIGZhbWlseS4gTm9uY2Fub25pY2FsIHBhdHRlcm5zIHJlcXVpcmUgYXBwLW93bmVkIHJ1bnRpbWUgcm91dGUgcmVnaXN0cmF0aW9uXG4gICAqIHRoYXQgbWF0Y2hlcyB0aGUgY29uc3RydWN0J3MgYHJvdXRlSW52ZW50b3J5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKClcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlRmFtaWx5PzogQXBwVGhlb3J5TWNwUm91dGVGYW1pbHk7XG5cbiAgLyoqXG4gICAqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEFuIGV4cGxpY2l0IHNlbGVjdGlvbiBvdmVycmlkZXMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gV2hlbiBpdCBpc1xuICAgKiBvbWl0dGVkLCBhIHNlcnZlciB0aGF0IGF0dGFjaGVzIGBmYWNhZGVgIHJlc29sdmVzIHRvIGBydW50aW1lLWJlYXJlcmAgYW5kIGFcbiAgICogcGxhaW4gdHJhbnNwb3J0IHNlcnZlciByZXNvbHZlcyB0byBgaWFtYC4gYG5vbmUtcHVibGljYCBpcyBuZXZlciBhIGRlZmF1bHRcbiAgICogYW5kIGNhcnJpZXMgdGhlIGRlZmVuc2UtaW4tZGVwdGggZmxvb3IuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIgd2hlbiBgZmFjYWRlYCBpcyBhdHRhY2hlZCwgb3RoZXJ3aXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcblxuICAvKipcbiAgICogVXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IG1hcmtzIHRoaXMgc2VydmVyIGFzIGZhY2FkZS1jb25maWd1cmVkLlxuICAgKlxuICAgKiBUaGUgYXR0YWNobWVudCdzIHByZXNlbmNlIHNlbGVjdHMgdGhlIGBydW50aW1lLWJlYXJlcmAgcG9zdHVyZSBkZWZhdWx0LlxuICAgKiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50O1xuXG4gIC8qKlxuICAgKiBSdW50aW1lLXNpZGUgUkZDIDk3MjggYmVhcmVyIHZhbGlkYXRpb24gZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVkIGJ5IGB0cmFuc3BvcnRQb3N0dXJlOiBSVU5USU1FX0JFQVJFUmAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnlcbiAgICogb3RoZXIgcG9zdHVyZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBydW50aW1lUG9zdHVyZT86IEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucztcblxuICAvKipcbiAgICogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kXG4gICAqIE5PTkVfUFVCTElDLiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gaXMgcmVmdXNlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk/OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcblxuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLklIdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIC8qKlxuICAgKiBSZXNvbHZlZCB0cmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBGYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXJzIHJlc29sdmUgdG8gYHJ1bnRpbWUtYmVhcmVyYCB1bmxlc3NcbiAgICogYHRyYW5zcG9ydFBvc3R1cmVgIG92ZXJyaWRlcyB0aGUgZGVmYXVsdDsgcGxhaW4gdHJhbnNwb3J0IHNlcnZlcnMgcmVzb2x2ZVxuICAgKiB0byBgaWFtYC4gRGVsaWJlcmF0ZWx5IHB1YmxpYyBzZXJ2ZXJzIG11c3Qgc2VsZWN0IGBub25lLXB1YmxpY2AgZXhwbGljaXRseS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuICAvKipcbiAgICogRGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZXMgZm9yIHRoZSBvcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIHRoZXNlIGFyZSBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGVzLCBub3QgZGVjbGFyYXRpb25zIG9mXG4gICAqIHB1YmxpYyBhdXRob3JpdHkuIEFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZDsgdGhlIG9yaWdpbiBpcyBkZXJpdmVkXG4gICAqIGZyb20gYGFwaUlkYCwgdGhlIHN0YWNrIHJlZ2lvbiBhbmQgVVJMIHN1ZmZpeCwgcGx1c1xuICAgKiBgYXR0YWNoZWRBcGlTdGFnZU5hbWVgIHdoZW4gc3VwcGxpZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnRzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnk7XG5cbiAgLyoqXG4gICAqIEZpcnN0IGRlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGUuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIGFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZC4gVGhpcyB2YWx1ZSBpcyBhblxuICAgKiBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGUgZGVyaXZlZCBieSB0aGUgc2FtZSBydWxlcyBhcyBgZW5kcG9pbnRzYCwgbm90XG4gICAqIHRoZSBmcm9udCBkb29yJ3MgcHVibGljIGF1dGhvcml0eS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBlbmRwb2ludHNgLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgbWNwUGF0aHNgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc2Agb3IgYHJvdXRlSW52ZW50b3J5YC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzKTtcbiAgICBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCByb3V0ZUZhbWlseSA9IG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzKTtcblxuICAgIGNvbnN0IHBvc3R1cmUgPSBwcm9wcy50cmFuc3BvcnRQb3N0dXJlXG4gICAgICA/PyAocHJvcHMuZmFjYWRlICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgICAgIDogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0pO1xuICAgIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQocHJvcHMuZmFjYWRlKTtcbiAgICB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMocHJvcHMsIHJvdXRlRmFtaWx5LCBwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKHByb3BzLCBwb3N0dXJlKTtcbiAgICBjb25zdCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQgPSBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDO1xuICAgIGNvbnN0IHVwc3RyZWFtQ2FsbGJhY2tQYXRoID0gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzKTtcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgICB1cHN0cmVhbUNhbGxiYWNrUGF0aCxcbiAgICApO1xuICAgIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkodGhpcy5yb3V0ZUludmVudG9yeSwgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRocyA9IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLm1hcChcbiAgICAgIChyb3V0ZSkgPT4gcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLFxuICAgICk7XG4gICAgdGhpcy5tY3BQYXRoID0gdGhpcy5tY3BQYXRoc1swXTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNbMF07XG5cbiAgICBjb25zdCBvd25lZE9wdGlvbnMgPSBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHMpO1xuICAgIGxldCBvd25lZFN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb3duZWRTdGFnZU5hbWUgPSBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHByb3BzLmFwaSkge1xuICAgICAgdGhpcy5hcGkgPSBwcm9wcy5hcGk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHN0YWdlT3B0aW9ucyA9IG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvd25lZE9wdGlvbnMuc3RhZ2UpO1xuICAgICAgb3duZWRTdGFnZU5hbWUgPSBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lO1xuICAgICAgY29uc3QgYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgIGFwaU5hbWU6IG93bmVkT3B0aW9ucy5hcGlOYW1lLFxuICAgICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpIH0pLm93bmVkQXBpID0gYXBpO1xuICAgICAgdGhpcy5hcGkgPSBhcGk7XG5cbiAgICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICBodHRwQXBpOiBhcGksXG4gICAgICAgIHN0YWdlTmFtZTogc3RhZ2VPcHRpb25zLnN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nRW5hYmxlZFxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgIG93bmVkU3RhZ2UgPSBzdGFnZTtcblxuICAgICAgaWYgKHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dSZXRlbnRpb24sXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgICAgZm9ybWF0OiBhY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTWNwSGFuZGxlclwiLFxuICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCB0cmFuc3BvcnRBdXRob3JpemVyID0gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIocHJvcHMsIHBvc3R1cmUpO1xuICAgIGNvbnN0IHJ1bnRpbWVPd25lZEF1dGggPSBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICBsZXQgZmlyc3RUcmFuc3BvcnRSb3V0ZTogYXBpZ3d2Mi5IdHRwUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykge1xuICAgICAgICBjb25zdCBjcmVhdGVkID0gdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICB0b0h0dHBNZXRob2QobWV0aG9kKSxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICApO1xuICAgICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gZmlyc3RUcmFuc3BvcnRSb3V0ZSA/PyBjcmVhdGVkO1xuICAgICAgfVxuICAgICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5yZWdpc3RlclBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFRoZSB1cHN0cmVhbSBjYWxsYmFjayBpcyBzdGFnZS1nbG9iYWwsIG5vdCBwZXIga2luZDogd2lyZSBpdCBleGFjdGx5IG9uY2UuXG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuLFxuICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICh0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHBvc3R1cmVNYXJrZXJUYXJnZXQgPSAodGhpcy5vd25lZEFwaT8ubm9kZS5kZWZhdWx0Q2hpbGRcbiAgICAgID8/IGZpcnN0VHJhbnNwb3J0Um91dGU/Lm5vZGUuZGVmYXVsdENoaWxkKSBhcyBhcGlnd3YyLkNmbkFwaSB8IGFwaWd3djIuQ2ZuUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgcG9zdHVyZU1hcmtlclRhcmdldD8uYWRkTWV0YWRhdGEoTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSwge1xuICAgICAgcG9zdHVyZSxcbiAgICAgIGNvbnRyYWN0X2lkOiBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQsXG4gICAgICByb3V0ZV9jb3VudDogdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubGVuZ3RoLFxuICAgICAgcnVudGltZV9wb3N0dXJlX2RlY2xhcmVkOiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGVuZHBvaW50QmFzZSA9IGBodHRwczovLyR7b3duZWRPcHRpb25zLmRvbWFpbi5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG4gICAgICBjb25zdCBleGVjdXRlQXBpT3JpZ2luID0gYGh0dHBzOi8vJHt0aGlzLmFwaS5hcGlJZH0uZXhlY3V0ZS1hcGkuJHtzdGFjay5yZWdpb259LiR7c3RhY2sudXJsU3VmZml4fWA7XG4gICAgICBlbmRwb2ludEJhc2UgPSBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyBleGVjdXRlQXBpT3JpZ2luXG4gICAgICAgIDogYCR7ZXhlY3V0ZUFwaU9yaWdpbn0vJHtwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZX1gO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbmRwb2ludEJhc2UgPSBvd25lZFN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtvd25lZFN0YWdlTmFtZX1gO1xuICAgIH1cbiAgICB0aGlzLmVuZHBvaW50cyA9IHRoaXMubWNwUGF0aHMubWFwKFxuICAgICAgKHBhdHRlcm4pID0+IGAke3N0cmlwVHJhaWxpbmdTbGFzaChlbmRwb2ludEJhc2UpfSR7cGF0dGVybn1gLFxuICAgICk7XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBgUm91dGUke3RoaXMucm91dGVTZXF1ZW5jZSsrfWAsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG9tYWluTmFtZTtcbiAgICBjb25zdCBhcGlNYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBzdGFnZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmcgfSkuYXBpTWFwcGluZyA9IGFwaU1hcHBpbmc7XG4gICAgaWYgKG9wdGlvbnMuaG9zdGVkWm9uZSkge1xuICAgICAgY29uc3QgY25hbWVSZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNuYW1lUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiB0b1JvdXRlNTNSZWNvcmROYW1lKG9wdGlvbnMuZG9tYWluTmFtZSwgb3B0aW9ucy5ob3N0ZWRab25lKSxcbiAgICAgICAgZG9tYWluTmFtZTogZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gY25hbWVSZWNvcmQ7XG4gICAgfVxuICB9XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICByZWFkb25seSBlbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgaWYgKHByb3BzLnJvdXRlRmFtaWx5ICE9PSB1bmRlZmluZWQgJiYgcHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5IGFuZCBkZXByZWNhdGVkIG1jcFBhdGggY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXdQYXR0ZXJucyA9IHByb3BzLnJvdXRlRmFtaWx5Py5wYXR0ZXJuc1xuICAgID8/IChwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWRcbiAgICAgID8gW3Byb3BzLm1jcFBhdGhdXG4gICAgICA6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpLm1hcChcbiAgICAgICAgKHRlbXBsYXRlKSA9PiB0ZW1wbGF0ZS5tY3BQYXR0ZXJuLFxuICAgICAgKSk7XG4gIGlmIChyYXdQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICB9XG4gIGNvbnN0IHBhdHRlcm5zID0gcmF3UGF0dGVybnMubWFwKChwYXR0ZXJuLCBpbmRleCkgPT5cbiAgICBub3JtYWxpemVSb3V0ZVBhdGgocGF0dGVybiwgYHJvdXRlRmFtaWx5LnBhdHRlcm5zWyR7aW5kZXh9XWApKTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBpZiAoc2Vlbi5oYXMocGF0dGVybikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgY29udGFpbnMgZHVwbGljYXRlIHBhdHRlcm4gJHtKU09OLnN0cmluZ2lmeShwYXR0ZXJuKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQocGF0dGVybik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwYXR0ZXJucyxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTpcbiAgICAgIHByb3BzLnJvdXRlRmFtaWx5Py5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSA/PyBmYWxzZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVQYXRoKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdHRlcm5gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpO1xuICBpZiAoIXJvdXRlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSkgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIGNvbnN0IHNlZ21lbnRzID0gcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKTtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCB8fCBzZWdtZW50cy5zb21lKChzZWdtZW50KSA9PiBzZWdtZW50ID09PSBcIlwiKSkge1xuICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICB9XG4gIGNvbnN0IGxpdGVyYWwgPSAvXig/OltBLVphLXowLTkuX34hJCYnKCkqKyw7PTpALV18JVswLTlBLUZhLWZdezJ9KSskLztcbiAgY29uc3QgcGFyYW1ldGVyID0gL15cXHsoW0EtWmEtel9dW0EtWmEtejAtOV9dKilcXH0kLztcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgaWYgKHBhcmFtZXRlci50ZXN0KHNlZ21lbnQpKSBjb250aW51ZTtcbiAgICBpZiAoIWxpdGVyYWwudGVzdChzZWdtZW50KSB8fCBzZWdtZW50LmluY2x1ZGVzKFwie1wiKSB8fCBzZWdtZW50LmluY2x1ZGVzKFwifVwiKSkge1xuICAgICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWU6IHN0cmluZyk6IEVycm9yIHtcbiAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGFic29sdXRlIHN5bnRoZXNpcy10aW1lIHJvdXRlIHBhdHRlcm4gd2l0aCBub24tZW1wdHkgbGl0ZXJhbCBvciB7cGFyYW1ldGVyX25hbWV9IHNlZ21lbnRzIGFuZCBubyBkb3Qgc2VnbWVudHNgLFxuICApO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlVXBzdHJlYW1DYWxsYmFja1BhdGgocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogc3RyaW5nIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEg7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChjb25maWd1cmVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXRoXCIsXG4gICAgKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGgoY29uZmlndXJlZCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICA/IGVyci5tZXNzYWdlLnJlcGxhY2UoL15tY3Byb3V0ZXM6IC8sIFwiXCIpXG4gICAgICA6IFN0cmluZyhlcnIpO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIGlzIGludmFsaWQ6ICR7cmVhc29ufWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBidWlsZFJvdXRlSW52ZW50b3J5KFxuICBwYXR0ZXJuczogc3RyaW5nW10sXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbiAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbixcbiAgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmcsXG4pOiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJldHVybiB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQ09OVFJBQ1RfVkVSU0lPTixcbiAgICByb3V0ZXM6IHBhdHRlcm5zLm1hcCgobWNwUGF0dGVybikgPT4gKHtcbiAgICAgIG1jcFBhdHRlcm4sXG4gICAgICBtY3BNZXRob2RzOiBbXCJQT1NUXCIsIFwiR0VUXCIsIFwiREVMRVRFXCJdLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5U3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgdG9rZW5QYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHJlZ2lzdGVyUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25SZWdpc3RlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgfSkpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjpcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcIi9cIiksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCxcbiAgICBjYWxsYmFja1BhdHRlcm4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkoXG4gIGludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnksXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbik6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFkZCA9IChtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7bWV0aG9kfSAke3BhdGh9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlcml2ZWQgcm91dGUgZmFtaWx5IGNvbGxpZGVzIGF0ICR7a2V5fWApO1xuICAgIH1cbiAgICBzZWVuLmFkZChrZXkpO1xuICB9O1xuICBmb3IgKGNvbnN0IHJvdXRlIG9mIGludmVudG9yeS5yb3V0ZXMpIHtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSBhZGQobWV0aG9kLCByb3V0ZS5tY3BQYXR0ZXJuKTtcbiAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5hdXRob3JpemVQYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUudG9rZW5QYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUucmVnaXN0ZXJQYXR0ZXJuKTtcbiAgICB9XG4gIH1cbiAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuKTtcbiAgfVxuICBpZiAoaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybik7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBpZiAoIXByb3BzLmFwaSkge1xuICAgIGlmIChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSByZXF1aXJlcyBhdHRhY2ggbW9kZSB3aXRoIGFwaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgJiYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSlcbiAgICAgIHx8ICEvXig/OlxcJGRlZmF1bHR8W0EtWmEtejAtOV8tXXsxLDEyOH0pJC8udGVzdChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSkpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBBUEkgR2F0ZXdheSBzdGFnZSBuYW1lXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocHJvcHMub3duZWRBcGkgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwib3duZWRBcGlcIik7XG4gIGlmIChwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImFwaU5hbWVcIik7XG4gIGlmIChwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiZG9tYWluXCIpO1xuICBpZiAocHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwic3RhZ2VcIik7XG4gIGlmIChpbnZhbGlkLmxlbmd0aCAhPT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaCBtb2RlIHdpdGggYXBpIGNhbm5vdCBjb25maWd1cmUgb3duZWQtQVBJIHByb3BzOiAke2ludmFsaWQuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5hcGlOYW1lIGFuZCBkZXByZWNhdGVkIGFwaU5hbWUgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LmRvbWFpbiAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiBhbmQgZGVwcmVjYXRlZCBkb21haW4gY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSBhbmQgZGVwcmVjYXRlZCBzdGFnZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYXBpTmFtZTogcHJvcHMub3duZWRBcGk/LmFwaU5hbWUgPz8gcHJvcHMuYXBpTmFtZSxcbiAgICBkb21haW46IHByb3BzLm93bmVkQXBpPy5kb21haW4gPz8gcHJvcHMuZG9tYWluLFxuICAgIHN0YWdlOiBwcm9wcy5vd25lZEFwaT8uc3RhZ2UgPz8gcHJvcHMuc3RhZ2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvcHRpb25zPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zKTogTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIGNvbnN0IGFjY2Vzc0xvZ2dpbmcgPSBvcHRpb25zPy5hY2Nlc3NMb2dnaW5nID8/IHRydWU7XG4gIGlmICghYWNjZXNzTG9nZ2luZyAmJiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dSZXRlbnRpb24gcmVxdWlyZXMgYWNjZXNzTG9nZ2luZyB0byBiZSBlbmFibGVkXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nRW5hYmxlZCA9IG9wdGlvbnM/LnRocm90dGxpbmdFbmFibGVkID8/IHRydWU7XG4gIGlmIChcbiAgICAhdGhyb3R0bGluZ0VuYWJsZWRcbiAgICAmJiAob3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSB0aHJvdHRsaW5nIGxpbWl0cyByZXF1aXJlIHRocm90dGxpbmdFbmFibGVkIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhdGVMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQ7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIocmF0ZUxpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdSYXRlTGltaXRcIik7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIoYnVyc3RMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nQnVyc3RMaW1pdFwiKTtcbiAgcmV0dXJuIHtcbiAgICBzdGFnZU5hbWU6IG9wdGlvbnM/LnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIsXG4gICAgYWNjZXNzTG9nZ2luZyxcbiAgICBhY2Nlc3NMb2dSZXRlbnRpb246IG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIHRocm90dGxpbmdFbmFibGVkLFxuICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHJhdGVMaW1pdCxcbiAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogYnVyc3RMaW1pdCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICBjb25zdCBoYXNMZWdhY3kgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQ7XG4gIGlmIChwcm9wcy5zZXNzaW9uU3RhdGUgIT09IHVuZGVmaW5lZCAmJiBoYXNMZWdhY3kpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogc2Vzc2lvblN0YXRlIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGRlcHJlY2F0ZWQgc2Vzc2lvbi10YWJsZSBwcm9wc1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW5hYmxlZCA9IHByb3BzLnNlc3Npb25TdGF0ZT8uZW5hYmxlZCA/PyBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgPz8gdHJ1ZTtcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgPz8gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZTtcbiAgY29uc3QgdHRsTWludXRlcyA9IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlc1xuICAgID8/IHByb3BzLnNlc3Npb25UdGxNaW51dGVzXG4gICAgPz8gREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTO1xuICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICBpZiAoXG4gICAgIWVuYWJsZWRcbiAgICAmJiAodGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlcyAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZGlzYWJsZWQgc2Vzc2lvbiBzdGF0ZSBjYW5ub3QgY29uZmlndXJlIHRhYmxlTmFtZSwgdHRsTWludXRlcywgb3IgcmVtb3ZhbFBvbGljeVwiLFxuICAgICk7XG4gIH1cbiAgdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodHRsTWludXRlcywgXCJzZXNzaW9uU3RhdGUudHRsTWludXRlc1wiKTtcbiAgcmV0dXJuIHsgZW5hYmxlZCwgdGFibGVOYW1lLCB0dGxNaW51dGVzLCByZW1vdmFsUG9saWN5IH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSByZXR1cm47XG4gIGNvbnN0IGlzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgaXNzdWVyLFxuICAgICAgZmFsc2UsXG4gICAgICBcImF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoandrc1VyaSkpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGp3a3NVcmksXG4gICAgICB0cnVlLFxuICAgICAgXCJqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnRyYW5zcG9ydEF1dGhvcml6ZXI7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzoge1xuICAgICAgaWYgKGNvbmZpZ3VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIgaXMgb25seSB2YWxpZCB3aXRoIHRyYW5zcG9ydFBvc3R1cmUgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICAgICAgPyBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKClcbiAgICAgICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICB9XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDoge1xuICAgICAgY29uc3QgaXNzdWVyID0gU3RyaW5nKGNvbmZpZ3VyZWQ/Lmlzc3VlciA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoaXNzdWVyID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgaXMgcmVxdWlyZWQgd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgICAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgICAgICBpc3N1ZXIsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgXCJ0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBhdWRpZW5jZSA9IChjb25maWd1cmVkPy5hdWRpZW5jZSA/PyBbXSlcbiAgICAgICAgLm1hcCgodmFsdWUpID0+IFN0cmluZyh2YWx1ZSkudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgIT09IFwiXCIpO1xuICAgICAgaWYgKGF1ZGllbmNlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuYXVkaWVuY2UgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGFjY2VwdGVkIGF1ZGllbmNlIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBKd3RBdXRob3JpemVyKFxuICAgICAgICBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQsXG4gICAgICAgIGlzc3VlcixcbiAgICAgICAge1xuICAgICAgICAgIGp3dEF1ZGllbmNlOiBhdWRpZW5jZSxcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogY29uZmlndXJlZD8uaWRlbnRpdHlTb3VyY2UsXG4gICAgICAgICAgYXV0aG9yaXplck5hbWU6IGNvbmZpZ3VyZWQ/LmF1dGhvcml6ZXJOYW1lLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcG9zdHVyZUxhYmVsKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOiByZXR1cm4gXCJJQU1cIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiByZXR1cm4gXCJKV1RcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6IHJldHVybiBcIlJVTlRJTUVfQkVBUkVSXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiByZXR1cm4gXCJOT05FX1BVQkxJQ1wiO1xuICAgIGRlZmF1bHQ6IHJldHVybiBTdHJpbmcocG9zdHVyZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiB2b2lkIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6XG4gICAgICByZXR1cm47XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQpOiB2b2lkIHtcbiAgaWYgKGZhY2FkZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIGNvbnN0IHByb3ZpZGVySWQgPSAoZmFjYWRlIGFzIHsgcHJvdmlkZXJJZD86IHVua25vd24gfSk/LnByb3ZpZGVySWQ7XG4gIGlmIChcbiAgICB0eXBlb2YgcHJvdmlkZXJJZCAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHByb3ZpZGVySWQudHJpbSgpID09PSBcIlwiXG4gICAgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHByb3ZpZGVySWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmYWNhZGUucHJvdmlkZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcm91dGVGYW1pbHk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQykge1xuICAgIGlmIChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgb3Igandrc1VyaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBlbmFibGUgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSB1cHN0cmVhbUNhbGxiYWNrUGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsYWJlbCA9IHBvc3R1cmVMYWJlbChwb3N0dXJlKTtcbiAgaWYgKFxuICAgIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiAocHJvcHMucnVudGltZVBvc3R1cmUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5ydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gIT09IHRydWUpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIHJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAmJiBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvcmlnaW5SZWFjaGFiaWxpdHkgdG8gYmUgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEIG9yIC5MT0NLRURgLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKHByb3BzLm93bmluZ0FwaURlZmVuc2UsIGxhYmVsKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlPy50aHJvdHRsaW5nRW5hYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFuIGV4cGxpY2l0IG93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdFbmFibGVkOiB0cnVlIHRocm90dGxpbmcgZGVjaXNpb25gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZT8uYWNjZXNzTG9nZ2luZyA9PT0gZmFsc2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhY2Nlc3MgbG9nZ2luZ2AsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUikge1xuICAgIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHByb3BzLmRlbmlhbFNpZ25hbCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKFxuICBkZWZlbnNlOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB8IHVuZGVmaW5lZCxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoZGVmZW5zZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlIHRvIHJlY29yZCB0aGUgb3duaW5nIEFQSSdzIGFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlY2lzaW9uc2AsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVmZW5zZS5hY2Nlc3NMb2dnaW5nICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgdG8gYmUgdHJ1ZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nOiBQYXJ0aWFsPEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zPiB8IHVuZGVmaW5lZCA9IGRlZmVuc2UudGhyb3R0bGluZztcbiAgY29uc3QgcmF0ZUxpbWl0ID0gdGhyb3R0bGluZz8ucmF0ZUxpbWl0O1xuICBjb25zdCBidXJzdExpbWl0ID0gdGhyb3R0bGluZz8uYnVyc3RMaW1pdDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KVxuICAgIHx8IChyYXRlTGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICAgfHwgIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KVxuICAgIHx8IChidXJzdExpbWl0IGFzIG51bWJlcikgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UudGhyb3R0bGluZyByYXRlTGltaXQgYW5kIGJ1cnN0TGltaXQgdG8gYmUgcG9zaXRpdmUgZmluaXRlIG51bWJlcnNgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZW5pYWxTaWduYWwoc2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyk6IHZvaWQge1xuICBpZiAoc2lnbmFsID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBkZW5pYWxTaWduYWxcIixcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwubWV0cmljTmFtZSAhPT0gdW5kZWZpbmVkICYmIHNpZ25hbC5tZXRyaWNOYW1lICE9PSBNQ1BfREVOSUFMX01FVFJJQ19OQU1FKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLm1ldHJpY05hbWUgbXVzdCBiZSAke01DUF9ERU5JQUxfTUVUUklDX05BTUV9YCxcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwuZGltZW5zaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGltZW5zaW9ucyA9IEFycmF5LmlzQXJyYXkoc2lnbmFsLmRpbWVuc2lvbnMpID8gc2lnbmFsLmRpbWVuc2lvbnMgOiBbXTtcbiAgICBjb25zdCBib3VuZGVkID0gZGltZW5zaW9ucy5sZW5ndGggPT09IE1DUF9ERU5JQUxfRElNRU5TSU9OUy5sZW5ndGhcbiAgICAgICYmIE1DUF9ERU5JQUxfRElNRU5TSU9OUy5ldmVyeShcbiAgICAgICAgKGRpbWVuc2lvbikgPT4gZGltZW5zaW9ucy5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSA9PT0gZGltZW5zaW9uKS5sZW5ndGggPT09IDEsXG4gICAgICApO1xuICAgIGlmICghYm91bmRlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwuZGltZW5zaW9ucyBtdXN0IGJlIGV4YWN0bHkgJHtKU09OLnN0cmluZ2lmeShNQ1BfREVOSUFMX0RJTUVOU0lPTlMpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTCh2YWx1ZTogc3RyaW5nLCBhbGxvd1F1ZXJ5OiBib29sZWFuLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGl0ZXJhbCA9IHZhbHVlLnRyaW0oKTtcbiAgbGV0IHBhcnNlZDogVVJMIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwobGl0ZXJhbCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFRoZSBzaGFyZWQgdmFsaWRhdGlvbiBlcnJvciBiZWxvdyBpcyB0aGUgcHVibGljIHN5bnRoZXNpcyBjb250cmFjdC5cbiAgfVxuICBpZiAoXG4gICAgIXBhcnNlZFxuICAgIHx8ICFsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eShsaXRlcmFsKVxuICAgIHx8IHBhcnNlZC5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgIHx8ICFwYXJzZWQuaG9zdG5hbWVcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8obGl0ZXJhbClcbiAgICB8fCAoIWFsbG93UXVlcnkgJiYgbGl0ZXJhbC5pbmNsdWRlcyhcIj9cIikpXG4gICAgfHwgbGl0ZXJhbC5pbmNsdWRlcyhcIiNcIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7bWVzc2FnZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0b0h0dHBNZXRob2QobWV0aG9kOiBzdHJpbmcpOiBhcGlnd3YyLkh0dHBNZXRob2Qge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJQT1NUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVDtcbiAgICBjYXNlIFwiR0VUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuR0VUO1xuICAgIGNhc2UgXCJERUxFVEVcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEU7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiB1bnN1cHBvcnRlZCBydW50aW1lIE1DUCBtZXRob2QgJHttZXRob2R9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZU51bWJlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgZ3JlYXRlciB0aGFuIHplcm9gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICByZXR1cm4gZnFkbi5lbmRzV2l0aChzdWZmaXgpID8gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCkgOiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXmh0dHBzOlxcL1xcLyhbXi8/I10rKSg/OlsvPyNdfCQpL2kuZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmICFhdXRob3JpdHkuaW5jbHVkZXMoXCIlXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8odmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXltBLVphLXpdW0EtWmEtejAtOSsuLV0qOlxcL1xcLyhbXi8/I10qKS8uZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eT8uaW5jbHVkZXMoXCJAXCIpID8/IGZhbHNlO1xufVxuIl19