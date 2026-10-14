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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "6.0.0" };
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
        // Attach-mode public authority belongs to the front door. Do not smuggle
        // it into this construct as an origin prop.
        if (!props.api) {
            this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUUvRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBQzdELE1BQU0sa0NBQWtDLEdBQUcsaUNBQWlDLENBQUM7QUFDN0UsTUFBTSxpQ0FBaUMsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RSxNQUFNLHNCQUFzQixHQUFHLDJCQUEyQixDQUFDO0FBQzNELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFFMUQsb0VBQW9FO0FBQ3BFLElBQVksNEJBU1g7QUFURCxXQUFZLDRCQUE0QjtJQUN0QyxtR0FBbUc7SUFDbkcsMkNBQVcsQ0FBQTtJQUNYLDJFQUEyRTtJQUMzRSwyQ0FBVyxDQUFBO0lBQ1gsbUlBQW1JO0lBQ25JLGlFQUFpQyxDQUFBO0lBQ2pDLHdGQUF3RjtJQUN4RiwyREFBMkIsQ0FBQTtBQUM3QixDQUFDLEVBVFcsNEJBQTRCLDRDQUE1Qiw0QkFBNEIsUUFTdkM7QUFjRCw2RkFBNkY7QUFDN0YsSUFBWSw4QkFLWDtBQUxELFdBQVksOEJBQThCO0lBQ3hDLG9EQUFvRDtJQUNwRCx1REFBcUIsQ0FBQTtJQUNyQiwwRkFBMEY7SUFDMUYsbURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLDhCQUE4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IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5cbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiBUaGUgZGVmYXVsdCBmb3IgYSBzZXJ2ZXIgd2l0aCBubyBmYWNhZGUgYXR0YWNobWVudC4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIEEgc3RhdGljIEpXVCBhdXRob3JpemVyIChpc3N1ZXIgKyBhdWRpZW5jZSkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuICovXG4gIEpXVCA9IFwiand0XCIsXG4gIC8qKiBUaGUgZ2F0ZXdheSBhdXRob3JpemVyIGlzIE5PTkUgYW5kIHRoZSBydW50aW1lIHZhbGlkYXRlcyBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zLiBUaGUgZGVmYXVsdCBmb3IgYSBmYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXIuICovXG4gIFJVTlRJTUVfQkVBUkVSID0gXCJydW50aW1lLWJlYXJlclwiLFxuICAvKiogRGVsaWJlcmF0ZWx5IHB1YmxpYyBNQ1Agc2VydmVyOiBldmVyeSB0cmFuc3BvcnQgcm91dGUgaXMgcHVibGljLiBOZXZlciBhIGRlZmF1bHQuICovXG4gIE5PTkVfUFVCTElDID0gXCJub25lLXB1YmxpY1wiLFxufVxuXG4vKiogUHJlc2VuY2Utb25seSBza2VsZXRvbiBvZiB0aGUgdXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IHNlbGVjdHMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCB7XG4gIC8qKiBJZGVudGlmaWVzIHRoZSB1cHN0cmVhbSBhdXRob3JpemF0aW9uIHByb3ZpZGVyIHRoaXMgc2VydmVyIGZyb250cyAoZm9yIGV4YW1wbGUgYGF1dGhlb3J5YCkuIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlIGFuZCB1c2VzIGl0cyBwcmVzZW5jZSB0byBzZWxlY3QgdGhlIGBydW50aW1lLWJlYXJlcmAgZGVmYXVsdC4gKi9cbiAgcmVhZG9ubHkgcHJvdmlkZXJJZDogc3RyaW5nO1xufVxuXG4vKiogUnVudGltZS1zaWRlIGRlY2xhcmF0aW9uIHRoYXQgdGhlIHRyYW5zcG9ydCByb3V0ZXMgdmFsaWRhdGUgUkZDIDk3MjggYmVhcmVyIHRva2VucyBhdCBydW50aW1lLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnMge1xuICAvKiogQXNzZXJ0IHRoZSBydW50aW1lIHJlZ2lzdGVycyB0aGUgdHJhbnNwb3J0IHJvdXRlcyB3aXRoIHRoZSBydW50aW1lLXZhbGlkYXRlZCBiZWFyZXIgcG9zdHVyZSAoR28gYEZhY2FkZUNvbmZpZy5SZXF1aXJlQmVhcmVyVG9rZW5gLCBUUyBgcmVxdWlyZUJlYXJlclRva2VuTWlkZGxld2FyZWAsIFB5dGhvbiBgcmVxdWlyZV9iZWFyZXJfdG9rZW5fbWlkZGxld2FyZWApLiBNdXN0IGJlIGB0cnVlYC4gKi9cbiAgcmVhZG9ubHkgcmVxdWlyZUJlYXJlclRva2VuOiBib29sZWFuO1xufVxuXG4vKiogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB7XG4gIC8qKiBUaGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZC4gKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKiBUaGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggYSBsb2NrZWQgZnJvbnQgZG9vciAoQ2xvdWRGcm9udCAvIFZQQyBvcmlnaW4pLiAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxufVxuXG4vKiogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zIHtcbiAgLyoqIERlbmlhbCBtZXRyaWMgbmFtZS4gTXVzdCBiZSBgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZGAuIEBkZWZhdWx0IGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWQgKi9cbiAgcmVhZG9ubHkgbWV0cmljTmFtZT86IHN0cmluZztcbiAgLyoqIEJvdW5kZWQgbWV0cmljIGRpbWVuc2lvbnMuIE11c3QgYmUgZXhhY3RseSBgb3V0Y29tZWAgYW5kIGByb3V0ZV9mYW1pbHlgLiBAZGVmYXVsdCBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdICovXG4gIHJlYWRvbmx5IGRpbWVuc2lvbnM/OiBzdHJpbmdbXTtcbn1cblxuLyoqIE93bmluZy1BUEkgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnMge1xuICAvKiogU3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLiAqL1xuICByZWFkb25seSByYXRlTGltaXQ6IG51bWJlcjtcbiAgLyoqIFN0YWdlIGJ1cnN0IGxpbWl0LiAqL1xuICByZWFkb25seSBidXJzdExpbWl0OiBudW1iZXI7XG59XG5cbi8qKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyBkZWZlbnNlLWluLWRlcHRoIGRlY2lzaW9ucyAocmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHtcbiAgLyoqIFdoZXRoZXIgdGhlIG93bmluZyBBUEkncyBzdGFnZSBoYXMgYWNjZXNzIGxvZ2dpbmcgZW5hYmxlZC4gTXVzdCBiZSB0cnVlLiAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICAvKiogVGhlIG93bmluZyBBUEkncyBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucztcbn1cblxuLyoqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIEhUVFBTIEpXVCBpc3N1ZXIgVVJMLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGlzc3Vlcj86IHN0cmluZztcbiAgLyoqIEFjY2VwdGVkIEpXVCBhdWRpZW5jZXMuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgYXVkaWVuY2U/OiBzdHJpbmdbXTtcbiAgLyoqIElkZW50aXR5IHNvdXJjZXMgZm9yIHRoZSBKV1QgYXV0aG9yaXplci4gQGRlZmF1bHQgW1wiJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb25cIl0gKi9cbiAgcmVhZG9ubHkgaWRlbnRpdHlTb3VyY2U/OiBzdHJpbmdbXTtcbiAgLyoqIEpXVCBhdXRob3JpemVyIHJlc291cmNlIG5hbWUuIEBkZWZhdWx0IHRoZSBhdXRob3JpemVyIGNvbnN0cnVjdCBpZCAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcbn1cblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZWZlbnNpdmUgc25hcHNob3Qgb2YgdGhlIGNvbnN0cnVjdCdzIGRlcml2ZWQgZmFjYWRlIGludmVudG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcm91dGVzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZVtdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclByb3BzIHtcbiAgLyoqIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyB0aGUgcnVudGltZS1jb21wb3NlZCBNQ1AgZmFjYWRlLiAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBNQ1AgZmFjYWRlIGZhbWlsaWVzIHRoYXRcbiAgICogc2hhcmUgb25lIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeVxuICAgKiBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogU3RhZ2UgbmFtZSB1c2VkIHdoZW4gZGVyaXZpbmcgYXR0YWNoLW1vZGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgdGVtcGxhdGVzLlxuICAgKiBVc2UgYCRkZWZhdWx0YCBmb3IgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHQgc3RhZ2UuIFdoZW4gb21pdHRlZCwgdGhlIHN0YWdlXG4gICAqIGlzIG5vdCBkZXRlcm1pbmFibGUgYW5kIHRoZSB0ZW1wbGF0ZXMgcmV0YWluIHRoZSBiYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbi5cbiAgICogVGhpcyBwcm9wIGRvZXMgbm90IGNyZWF0ZSwgaW1wb3J0LCBvciBtdXRhdGUgYSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdHRhY2hlZEFwaVN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBBbiBleHBsaWNpdCBzZWxlY3Rpb24gb3ZlcnJpZGVzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuIFdoZW4gaXQgaXNcbiAgICogb21pdHRlZCwgYSBzZXJ2ZXIgdGhhdCBhdHRhY2hlcyBgZmFjYWRlYCByZXNvbHZlcyB0byBgcnVudGltZS1iZWFyZXJgIGFuZCBhXG4gICAqIHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXIgcmVzb2x2ZXMgdG8gYGlhbWAuIGBub25lLXB1YmxpY2AgaXMgbmV2ZXIgYSBkZWZhdWx0XG4gICAqIGFuZCBjYXJyaWVzIHRoZSBkZWZlbnNlLWluLWRlcHRoIGZsb29yLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSIHdoZW4gYGZhY2FkZWAgaXMgYXR0YWNoZWQsIG90aGVyd2lzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZT86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG5cbiAgLyoqXG4gICAqIFVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBtYXJrcyB0aGlzIHNlcnZlciBhcyBmYWNhZGUtY29uZmlndXJlZC5cbiAgICpcbiAgICogVGhlIGF0dGFjaG1lbnQncyBwcmVzZW5jZSBzZWxlY3RzIHRoZSBgcnVudGltZS1iZWFyZXJgIHBvc3R1cmUgZGVmYXVsdC5cbiAgICogUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudDtcblxuICAvKipcbiAgICogUnVudGltZS1zaWRlIFJGQyA5NzI4IGJlYXJlciB2YWxpZGF0aW9uIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZCBieSBgdHJhbnNwb3J0UG9zdHVyZTogUlVOVElNRV9CRUFSRVJgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5XG4gICAqIG90aGVyIHBvc3R1cmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBvc3R1cmU/OiBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZFxuICAgKiBOT05FX1BVQkxJQy4gQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIGlzIHJlZnVzZWQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5PzogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5O1xuXG4gIC8qKlxuICAgKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIG9ubHkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVuaWFsU2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucztcblxuICAvKipcbiAgICogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgdGhyb3R0bGluZyBhbmQgYWNjZXNzLWxvZ2dpbmdcbiAgICogZGVjaXNpb25zLCByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmQgTk9ORV9QVUJMSUMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3duaW5nQXBpRGVmZW5zZT86IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICpcbiAgICogVHJhbnNwb3J0IHJvdXRlcyBhcmUgdGhlIFBPU1QsIEdFVCwgYW5kIERFTEVURSByb3V0ZXMgb24gZXZlcnkgTUNQIHBhdHRlcm4uXG4gICAqIFRoaXMgcHJvcCBpcyBvbmx5IHZhbGlkIHdpdGggYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAsIHdoaWNoIHJlcXVpcmVzIGFuXG4gICAqIGlzc3VlciBhbmQgYSBub24tZW1wdHkgYXVkaWVuY2UuIERpc2NvdmVyeSwgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhLFxuICAgKiBhdXRob3JpemUsIGFuZCB0b2tlbiByb3V0ZXMgcmVtYWluIGV4cGxpY2l0bHkgcHVibGljIChgTk9ORWApIGJlY2F1c2UgT0F1dGhcbiAgICogY2xpZW50cyBtdXN0IGZldGNoIHRoZW0gYmVmb3JlIHRoZXkgaG9sZCBhIHRva2VuLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydEF1dGhvcml6ZXI/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UtZ2xvYmFsIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrIHBhdGguXG4gICAqXG4gICAqIFRoZSBDREstbW91bnRlZCBjYWxsYmFjayByb3V0ZSBhbmQgdGhlIHJ1bnRpbWUtcmVnaXN0ZXJlZCBvbmUgbXVzdCBub3RcbiAgICogZGl2ZXJnZTogdGhpcyBwcm9wIGlzIHJlc29sdmVkIGJ5XG4gICAqIGBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGhgLCB0aGUgc2FtZSBhbGdlYnJhXG4gICAqIHRoZSBydW50aW1lIGFwcGxpZXMgdG8gYEZhY2FkZUNvbmZpZy5VcHN0cmVhbUNhbGxiYWNrUGF0aGAuIFN1cHBseSBhXG4gICAqIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHF1ZXJ5LCBmcmFnbWVudCwgb3IgZG90XG4gICAqIHNlZ21lbnQ7IGFuIGVtcHR5IHZhbHVlIGtlZXBzIHRoZSBjb250cmFjdCBkZWZhdWx0LCBhbmQgYSB2YWx1ZSB0aGF0XG4gICAqIGNvbGxpZGVzIHdpdGggYW5vdGhlciBkZXJpdmVkIHJvdXRlIGZhaWxzIHN5bnRoZXNpcy4gUmVmdXNlZCB1bmRlclxuICAgKiBgdHJhbnNwb3J0UG9zdHVyZTogbm9uZS1wdWJsaWNgLCB3aGljaCBhdHRhY2hlcyBubyBPQXV0aCBzdXJmYWNlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIXG4gICAqL1xuICByZWFkb25seSB1cHN0cmVhbUNhbGxiYWNrUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogU2Vzc2lvbi1zdGF0ZSB0YWJsZSBjb25maWd1cmF0aW9uLiBUaGUgdGFibGUgZGVmYXVsdHMgb24uXG4gICAqIEBkZWZhdWx0IGVuYWJsZWQgd2l0aCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uU3RhdGU/OiBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPd25lZC1BUEkgY29uZmlndXJhdGlvbiBmb3Igc3RhbmRhbG9uZSBtb2RlLiBJbnZhbGlkIHdpdGggYGFwaWAuXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24tb3duZWQgQVBJIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBvd25lZEFwaT86IEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucztcblxuICAvKipcbiAgICogU2luZ2xlIE1DUCByb3V0ZSBwYXRoIGZyb20gdGhlIHYzLjEueCBBNiBzdXJmYWNlLlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHJvdXRlRmFtaWx5LnBhdHRlcm5zYC4gVGhlIG5ldyBkZWZhdWx0IGlzIHRoZSBjYW5vbmljYWxcbiAgICogZm91ci1wYXR0ZXJuIGZhbWlseTsgdXNlIGB7IHBhdHRlcm5zOiBbJy9tY3AnXSB9YCBmb3IgdGhlIG9sZCBzaW5nbGV0b24uXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBdXRob3JpemF0aW9uLXNlcnZlciBpc3N1ZXIgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5Jc3N1ZXJVUkxgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBpc3N1ZXIgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcj86IHN0cmluZztcblxuICAvKipcbiAgICogSldLUyBVUkkgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5KV0tTVVJJYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgSldLUyBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBqd2tzVXJpPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmFwaU5hbWVgLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS5lbmFibGVkYC4gU2Vzc2lvbiBzdGF0ZSBub3cgZGVmYXVsdHMgb24uXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50YWJsZU5hbWVgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50dGxNaW51dGVzYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuZG9tYWluYC4gRG9tYWlucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuc3RhZ2VgLiBTdGFnZSBvcHRpb25zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogQ29udHJhY3QtZmlyc3QgTUNQIGZhY2FkZSBkZXBsb3ltZW50IGNvbnN0cnVjdC5cbiAqXG4gKiBUaGUgcHJpbWFyeSBtb2RlIGF0dGFjaGVzIHRoZSBjb21wbGV0ZSByb3V0ZS1hbGdlYnJhIGZhbWlseSB0byBhIHN1cHBsaWVkXG4gKiBIVFRQIEFQSS4gT21pdHRpbmcgYGFwaWAgc3BlY2lhbGl6ZXMgdGhlIHNhbWUgcGF0aCBpbnRvIGEgc3RhbmRhbG9uZSBvd25lZFxuICogQVBJLiBUaGUgY29uc3RydWN0IHJvdXRlcyBvbmx5OiBPQXV0aCBtZXRhZGF0YSwgc2NvcGVzLCBjYXBhYmlsaXRpZXMsIGFuZFxuICogYXV0aG9yaXplL3Rva2VuIGJlaGF2aW9yIHJlbWFpbiBhcHBsaWNhdGlvbi1vd25lZCB0aHJvdWdoIEdvXG4gKiBgbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHByaXZhdGUgcm91dGVTZXF1ZW5jZSA9IDA7XG5cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICAvKipcbiAgICogUmVzb2x2ZWQgdHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogRmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVycyByZXNvbHZlIHRvIGBydW50aW1lLWJlYXJlcmAgdW5sZXNzXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlYCBvdmVycmlkZXMgdGhlIGRlZmF1bHQ7IHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXJzIHJlc29sdmVcbiAgICogdG8gYGlhbWAuIERlbGliZXJhdGVseSBwdWJsaWMgc2VydmVycyBtdXN0IHNlbGVjdCBgbm9uZS1wdWJsaWNgIGV4cGxpY2l0bHkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcbiAgLyoqXG4gICAqIERlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGVzIGZvciB0aGUgb3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSB0aGVzZSBhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlcywgbm90IGRlY2xhcmF0aW9ucyBvZlxuICAgKiBwdWJsaWMgYXV0aG9yaXR5LiBBbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQ7IHRoZSBvcmlnaW4gaXMgZGVyaXZlZFxuICAgKiBmcm9tIGBhcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIHBsdXNcbiAgICogYGF0dGFjaGVkQXBpU3RhZ2VOYW1lYCB3aGVuIHN1cHBsaWVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKlxuICAgKiBGaXJzdCBkZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlLlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSBhbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQuIFRoaXMgdmFsdWUgaXMgYW5cbiAgICogZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlIGRlcml2ZWQgYnkgdGhlIHNhbWUgcnVsZXMgYXMgYGVuZHBvaW50c2AsIG5vdFxuICAgKiB0aGUgZnJvbnQgZG9vcidzIHB1YmxpYyBhdXRob3JpdHkuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgZW5kcG9pbnRzYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG5cbiAgICBjb25zdCBwb3N0dXJlID0gcHJvcHMudHJhbnNwb3J0UG9zdHVyZVxuICAgICAgPz8gKHByb3BzLmZhY2FkZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICAgICA6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNKTtcbiAgICB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZSk7XG4gICAgdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KHByb3BzLmZhY2FkZSk7XG4gICAgdmFsaWRhdGVQb3N0dXJlR3VhcmRzKHByb3BzLCByb3V0ZUZhbWlseSwgcG9zdHVyZSk7XG4gICAgdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChwcm9wcywgcG9zdHVyZSk7XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkID0gcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQztcbiAgICBjb25zdCB1cHN0cmVhbUNhbGxiYWNrUGF0aCA9IHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wcyk7XG5cbiAgICB0aGlzLnRyYW5zcG9ydFBvc3R1cmUgPSBwb3N0dXJlO1xuICAgIHRoaXMubWNwUGF0aHMgPSBbLi4ucm91dGVGYW1pbHkucGF0dGVybnNdO1xuICAgIHRoaXMucm91dGVJbnZlbnRvcnkgPSBidWlsZFJvdXRlSW52ZW50b3J5KFxuICAgICAgdGhpcy5tY3BQYXRocyxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICAgIHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5LFxuICAgICAgdXBzdHJlYW1DYWxsYmFja1BhdGgsXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBvd25lZE9wdGlvbnMuYXBpTmFtZSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzLCBwb3N0dXJlKTtcbiAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgbGV0IGZpcnN0VHJhbnNwb3J0Um91dGU6IGFwaWd3djIuSHR0cFJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMpIHtcbiAgICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIHtcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHJvdXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICAgdG9IdHRwTWV0aG9kKG1ldGhvZCksXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICAgKTtcbiAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgIH1cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucmVnaXN0ZXJQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBUaGUgdXBzdHJlYW0gY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBub3QgcGVyIGtpbmQ6IHdpcmUgaXQgZXhhY3RseSBvbmNlLlxuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybixcbiAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAodGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4sXG4gICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBwb3N0dXJlTWFya2VyVGFyZ2V0ID0gKHRoaXMub3duZWRBcGk/Lm5vZGUuZGVmYXVsdENoaWxkXG4gICAgICA/PyBmaXJzdFRyYW5zcG9ydFJvdXRlPy5ub2RlLmRlZmF1bHRDaGlsZCkgYXMgYXBpZ3d2Mi5DZm5BcGkgfCBhcGlnd3YyLkNmblJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIHBvc3R1cmVNYXJrZXJUYXJnZXQ/LmFkZE1ldGFkYXRhKE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVksIHtcbiAgICAgIHBvc3R1cmUsXG4gICAgICBjb250cmFjdF9pZDogTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lELFxuICAgICAgcm91dGVfY291bnQ6IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLmxlbmd0aCxcbiAgICAgIHJ1bnRpbWVfcG9zdHVyZV9kZWNsYXJlZDogcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlc3Npb25TdGF0ZSA9IG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wcyk7XG4gICAgaWYgKHNlc3Npb25TdGF0ZS5lbmFibGVkKSB7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogc2Vzc2lvblN0YXRlLnRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwic2Vzc2lvbklkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHNlc3Npb25TdGF0ZS5yZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjogeyBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGFibGU7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVEFCTEVcIiwgdGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UVExfTUlOVVRFU1wiLCBTdHJpbmcoc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXMpKTtcbiAgICB9XG5cbiAgICBsZXQgZW5kcG9pbnRCYXNlOiBzdHJpbmc7XG4gICAgaWYgKG93bmVkT3B0aW9ucy5kb21haW4pIHtcbiAgICAgIGlmICghb3duZWRTdGFnZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiBjb25maWd1cmF0aW9uIHJlcXVpcmVzIGNvbnN0cnVjdC1vd25lZCBBUEkgbW9kZVwiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ob3duZWRPcHRpb25zLmRvbWFpbiwgb3duZWRTdGFnZSk7XG4gICAgICBlbmRwb2ludEJhc2UgPSBgaHR0cHM6Ly8ke293bmVkT3B0aW9ucy5kb21haW4uZG9tYWluTmFtZX1gO1xuICAgIH0gZWxzZSBpZiAocHJvcHMuYXBpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgICAgY29uc3QgZXhlY3V0ZUFwaU9yaWdpbiA9IGBodHRwczovLyR7dGhpcy5hcGkuYXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH1gO1xuICAgICAgZW5kcG9pbnRCYXNlID0gcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gZXhlY3V0ZUFwaU9yaWdpblxuICAgICAgICA6IGAke2V4ZWN1dGVBcGlPcmlnaW59LyR7cHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWV9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgZW5kcG9pbnRCYXNlID0gb3duZWRTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7b3duZWRTdGFnZU5hbWV9YDtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludHMgPSB0aGlzLm1jcFBhdGhzLm1hcChcbiAgICAgIChwYXR0ZXJuKSA9PiBgJHtzdHJpcFRyYWlsaW5nU2xhc2goZW5kcG9pbnRCYXNlKX0ke3BhdHRlcm59YCxcbiAgICApO1xuICAgIHRoaXMuZW5kcG9pbnQgPSB0aGlzLmVuZHBvaW50c1swXTtcblxuICAgIC8vIEF0dGFjaC1tb2RlIHB1YmxpYyBhdXRob3JpdHkgYmVsb25ncyB0byB0aGUgZnJvbnQgZG9vci4gRG8gbm90IHNtdWdnbGVcbiAgICAvLyBpdCBpbnRvIHRoaXMgY29uc3RydWN0IGFzIGFuIG9yaWdpbiBwcm9wLlxuICAgIGlmICghcHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX0VORFBPSU5UXCIsIHRoaXMuZW5kcG9pbnQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkUnVudGltZVJvdXRlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIG1ldGhvZCksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoY29uZmlndXJlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKGNvbmZpZ3VyZWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgPyBlcnIubWVzc2FnZS5yZXBsYWNlKC9ebWNwcm91dGVzOiAvLCBcIlwiKVxuICAgICAgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBpcyBpbnZhbGlkOiAke3JlYXNvbn1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIGNhbGxiYWNrUGF0dGVybjogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkNPTlRSQUNUX1ZFUlNJT04sXG4gICAgcm91dGVzOiBwYXR0ZXJucy5tYXAoKG1jcFBhdHRlcm4pID0+ICh7XG4gICAgICBtY3BQYXR0ZXJuLFxuICAgICAgbWNwTWV0aG9kczogW1wiUE9TVFwiLCBcIkdFVFwiLCBcIkRFTEVURVwiXSxcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gICAgY2FsbGJhY2tQYXR0ZXJuLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnJlZ2lzdGVyUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybik7XG4gIH1cbiAgaWYgKGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICBpZiAocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgcmVxdWlyZXMgYXR0YWNoIG1vZGUgd2l0aCBhcGlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICYmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpXG4gICAgICB8fCAhL14oPzpcXCRkZWZhdWx0fFtBLVphLXowLTlfLV17MSwxMjh9KSQvLnRlc3QocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgQVBJIEdhdGV3YXkgc3RhZ2UgbmFtZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHByb3BzLm93bmVkQXBpICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcIm93bmVkQXBpXCIpO1xuICBpZiAocHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJhcGlOYW1lXCIpO1xuICBpZiAocHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImRvbWFpblwiKTtcbiAgaWYgKHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcInN0YWdlXCIpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggIT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2ggbW9kZSB3aXRoIGFwaSBjYW5ub3QgY29uZmlndXJlIG93bmVkLUFQSSBwcm9wczogJHtpbnZhbGlkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICBpZiAocHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuYXBpTmFtZSBhbmQgZGVwcmVjYXRlZCBhcGlOYW1lIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5kb21haW4gIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gYW5kIGRlcHJlY2F0ZWQgZG9tYWluIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgYW5kIGRlcHJlY2F0ZWQgc3RhZ2UgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFwaU5hbWU6IHByb3BzLm93bmVkQXBpPy5hcGlOYW1lID8/IHByb3BzLmFwaU5hbWUsXG4gICAgZG9tYWluOiBwcm9wcy5vd25lZEFwaT8uZG9tYWluID8/IHByb3BzLmRvbWFpbixcbiAgICBzdGFnZTogcHJvcHMub3duZWRBcGk/LnN0YWdlID8/IHByb3BzLnN0YWdlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU9wdGlvbnMob3B0aW9ucz86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyk6IE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICBjb25zdCBhY2Nlc3NMb2dnaW5nID0gb3B0aW9ucz8uYWNjZXNzTG9nZ2luZyA/PyB0cnVlO1xuICBpZiAoIWFjY2Vzc0xvZ2dpbmcgJiYgb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nUmV0ZW50aW9uIHJlcXVpcmVzIGFjY2Vzc0xvZ2dpbmcgdG8gYmUgZW5hYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZ0VuYWJsZWQgPSBvcHRpb25zPy50aHJvdHRsaW5nRW5hYmxlZCA/PyB0cnVlO1xuICBpZiAoXG4gICAgIXRocm90dGxpbmdFbmFibGVkXG4gICAgJiYgKG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgdGhyb3R0bGluZyBsaW1pdHMgcmVxdWlyZSB0aHJvdHRsaW5nRW5hYmxlZCB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXRlTGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUO1xuICBjb25zdCBidXJzdExpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHJhdGVMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nUmF0ZUxpbWl0XCIpO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKGJ1cnN0TGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0J1cnN0TGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VOYW1lOiBvcHRpb25zPy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiLFxuICAgIGFjY2Vzc0xvZ2dpbmcsXG4gICAgYWNjZXNzTG9nUmV0ZW50aW9uOiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICB0aHJvdHRsaW5nRW5hYmxlZCxcbiAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiByYXRlTGltaXQsXG4gICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IGJ1cnN0TGltaXQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgY29uc3QgaGFzTGVnYWN5ID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAocHJvcHMuc2Vzc2lvblN0YXRlICE9PSB1bmRlZmluZWQgJiYgaGFzTGVnYWN5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHNlc3Npb25TdGF0ZSBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBkZXByZWNhdGVkIHNlc3Npb24tdGFibGUgcHJvcHNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGVuYWJsZWQgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LmVuYWJsZWQgPz8gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlID8/IHRydWU7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lID8/IHByb3BzLnNlc3Npb25UYWJsZU5hbWU7XG4gIGNvbnN0IHR0bE1pbnV0ZXMgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXNcbiAgICA/PyBwcm9wcy5zZXNzaW9uVHRsTWludXRlc1xuICAgID8/IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUztcbiAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgaWYgKFxuICAgICFlbmFibGVkXG4gICAgJiYgKHRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRpc2FibGVkIHNlc3Npb24gc3RhdGUgY2Fubm90IGNvbmZpZ3VyZSB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIG9yIHJlbW92YWxQb2xpY3lcIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7IGVuYWJsZWQsIHRhYmxlTmFtZSwgdHRsTWludXRlcywgcmVtb3ZhbFBvbGljeSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkgcmV0dXJuO1xuICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGlzc3VlcixcbiAgICAgIGZhbHNlLFxuICAgICAgXCJhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBqd2tzVXJpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiandrc1VyaSBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHVzZXJpbmZvIG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy50cmFuc3BvcnRBdXRob3JpemVyO1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHtcbiAgICAgIGlmIChjb25maWd1cmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGlzIG9ubHkgdmFsaWQgd2l0aCB0cmFuc3BvcnRQb3N0dXJlIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAgICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgICAgIDogbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgfVxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBvc3R1cmVMYWJlbChwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTogcmV0dXJuIFwiSUFNXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDogcmV0dXJuIFwiSldUXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOiByZXR1cm4gXCJSVU5USU1FX0JFQVJFUlwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzogcmV0dXJuIFwiTk9ORV9QVUJMSUNcIjtcbiAgICBkZWZhdWx0OiByZXR1cm4gU3RyaW5nKHBvc3R1cmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogdm9pZCB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOlxuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50KTogdm9pZCB7XG4gIGlmIChmYWNhZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBwcm92aWRlcklkID0gKGZhY2FkZSBhcyB7IHByb3ZpZGVySWQ/OiB1bmtub3duIH0pPy5wcm92aWRlcklkO1xuICBpZiAoXG4gICAgdHlwZW9mIHByb3ZpZGVySWQgIT09IFwic3RyaW5nXCJcbiAgICB8fCBwcm92aWRlcklkLnRyaW0oKSA9PT0gXCJcIlxuICAgIHx8IFRva2VuLmlzVW5yZXNvbHZlZChwcm92aWRlcklkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZmFjYWRlLnByb3ZpZGVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHN0cmluZ1wiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3N0dXJlR3VhcmRzKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHJvdXRlRmFtaWx5OiBOb3JtYWxpemVkUm91dGVGYW1pbHksXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUMpIHtcbiAgICBpZiAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkIHx8IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG9yIGp3a3NVcmlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZW5hYmxlIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgdXBzdHJlYW1DYWxsYmFja1BhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0gY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZT8udGhyb3R0bGluZ0VuYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhbiBleHBsaWNpdCBvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nRW5hYmxlZDogdHJ1ZSB0aHJvdHRsaW5nIGRlY2lzaW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2U/LmFjY2Vzc0xvZ2dpbmcgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYWNjZXNzIGxvZ2dpbmdgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIpIHtcbiAgICB2YWxpZGF0ZURlbmlhbFNpZ25hbChwcm9wcy5kZW5pYWxTaWduYWwpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShcbiAgZGVmZW5zZTogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMgfCB1bmRlZmluZWQsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGRlZmVuc2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZSB0byByZWNvcmQgdGhlIG93bmluZyBBUEkncyBhY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWNpc2lvbnNgLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlZmVuc2UuYWNjZXNzTG9nZ2luZyAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS5hY2Nlc3NMb2dnaW5nIHRvIGJlIHRydWVgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZzogUGFydGlhbDxBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucz4gfCB1bmRlZmluZWQgPSBkZWZlbnNlLnRocm90dGxpbmc7XG4gIGNvbnN0IHJhdGVMaW1pdCA9IHRocm90dGxpbmc/LnJhdGVMaW1pdDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IHRocm90dGxpbmc/LmJ1cnN0TGltaXQ7XG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdClcbiAgICB8fCAocmF0ZUxpbWl0IGFzIG51bWJlcikgPD0gMFxuICAgIHx8ICFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdClcbiAgICB8fCAoYnVyc3RMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLnRocm90dGxpbmcgcmF0ZUxpbWl0IGFuZCBidXJzdExpbWl0IHRvIGJlIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKHNpZ25hbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgZGVuaWFsU2lnbmFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLm1ldHJpY05hbWUgIT09IHVuZGVmaW5lZCAmJiBzaWduYWwubWV0cmljTmFtZSAhPT0gTUNQX0RFTklBTF9NRVRSSUNfTkFNRSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5tZXRyaWNOYW1lIG11c3QgYmUgJHtNQ1BfREVOSUFMX01FVFJJQ19OQU1FfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLmRpbWVuc2lvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSBBcnJheS5pc0FycmF5KHNpZ25hbC5kaW1lbnNpb25zKSA/IHNpZ25hbC5kaW1lbnNpb25zIDogW107XG4gICAgY29uc3QgYm91bmRlZCA9IGRpbWVuc2lvbnMubGVuZ3RoID09PSBNQ1BfREVOSUFMX0RJTUVOU0lPTlMubGVuZ3RoXG4gICAgICAmJiBNQ1BfREVOSUFMX0RJTUVOU0lPTlMuZXZlcnkoXG4gICAgICAgIChkaW1lbnNpb24pID0+IGRpbWVuc2lvbnMuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgPT09IGRpbWVuc2lvbikubGVuZ3RoID09PSAxLFxuICAgICAgKTtcbiAgICBpZiAoIWJvdW5kZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLmRpbWVuc2lvbnMgbXVzdCBiZSBleGFjdGx5ICR7SlNPTi5zdHJpbmdpZnkoTUNQX0RFTklBTF9ESU1FTlNJT05TKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==