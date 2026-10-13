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
        this.transportPosture = posture;
        this.mcpPaths = [...routeFamily.patterns];
        this.routeInventory = buildRouteInventory(this.mcpPaths, authorizationRoutesAttached, routeFamily.rootAuthorizationServerDiscovery);
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
            registerPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(mcpPattern),
            authorizationRoutesAttached,
        })),
        rootAuthorizationServerPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
        rootAuthorizationServerAttached,
        callbackPattern: mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUUvRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBQzdELE1BQU0sa0NBQWtDLEdBQUcsaUNBQWlDLENBQUM7QUFDN0UsTUFBTSxpQ0FBaUMsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RSxNQUFNLHNCQUFzQixHQUFHLDJCQUEyQixDQUFDO0FBQzNELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFFMUQsb0VBQW9FO0FBQ3BFLElBQVksNEJBU1g7QUFURCxXQUFZLDRCQUE0QjtJQUN0QyxtR0FBbUc7SUFDbkcsMkNBQVcsQ0FBQTtJQUNYLDJFQUEyRTtJQUMzRSwyQ0FBVyxDQUFBO0lBQ1gsbUlBQW1JO0lBQ25JLGlFQUFpQyxDQUFBO0lBQ2pDLHdGQUF3RjtJQUN4RiwyREFBMkIsQ0FBQTtBQUM3QixDQUFDLEVBVFcsNEJBQTRCLDRDQUE1Qiw0QkFBNEIsUUFTdkM7QUFjRCw2RkFBNkY7QUFDN0YsSUFBWSw4QkFLWDtBQUxELFdBQVksOEJBQThCO0lBQ3hDLG9EQUFvRDtJQUNwRCx1REFBcUIsQ0FBQTtJQUNyQiwwRkFBMEY7SUFDMUYsbURBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQUxXLDhCQUE4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LENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDNUUsT0FBTyxTQUFTLEVBQUUsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQztBQUMzQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5cbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiBUaGUgZGVmYXVsdCBmb3IgYSBzZXJ2ZXIgd2l0aCBubyBmYWNhZGUgYXR0YWNobWVudC4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIEEgc3RhdGljIEpXVCBhdXRob3JpemVyIChpc3N1ZXIgKyBhdWRpZW5jZSkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuICovXG4gIEpXVCA9IFwiand0XCIsXG4gIC8qKiBUaGUgZ2F0ZXdheSBhdXRob3JpemVyIGlzIE5PTkUgYW5kIHRoZSBydW50aW1lIHZhbGlkYXRlcyBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zLiBUaGUgZGVmYXVsdCBmb3IgYSBmYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXIuICovXG4gIFJVTlRJTUVfQkVBUkVSID0gXCJydW50aW1lLWJlYXJlclwiLFxuICAvKiogRGVsaWJlcmF0ZWx5IHB1YmxpYyBNQ1Agc2VydmVyOiBldmVyeSB0cmFuc3BvcnQgcm91dGUgaXMgcHVibGljLiBOZXZlciBhIGRlZmF1bHQuICovXG4gIE5PTkVfUFVCTElDID0gXCJub25lLXB1YmxpY1wiLFxufVxuXG4vKiogUHJlc2VuY2Utb25seSBza2VsZXRvbiBvZiB0aGUgdXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IHNlbGVjdHMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCB7XG4gIC8qKiBJZGVudGlmaWVzIHRoZSB1cHN0cmVhbSBhdXRob3JpemF0aW9uIHByb3ZpZGVyIHRoaXMgc2VydmVyIGZyb250cyAoZm9yIGV4YW1wbGUgYGF1dGhlb3J5YCkuIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlIGFuZCB1c2VzIGl0cyBwcmVzZW5jZSB0byBzZWxlY3QgdGhlIGBydW50aW1lLWJlYXJlcmAgZGVmYXVsdC4gKi9cbiAgcmVhZG9ubHkgcHJvdmlkZXJJZDogc3RyaW5nO1xufVxuXG4vKiogUnVudGltZS1zaWRlIGRlY2xhcmF0aW9uIHRoYXQgdGhlIHRyYW5zcG9ydCByb3V0ZXMgdmFsaWRhdGUgUkZDIDk3MjggYmVhcmVyIHRva2VucyBhdCBydW50aW1lLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnMge1xuICAvKiogQXNzZXJ0IHRoZSBydW50aW1lIHJlZ2lzdGVycyB0aGUgdHJhbnNwb3J0IHJvdXRlcyB3aXRoIHRoZSBydW50aW1lLXZhbGlkYXRlZCBiZWFyZXIgcG9zdHVyZSAoR28gYEZhY2FkZUNvbmZpZy5SZXF1aXJlQmVhcmVyVG9rZW5gLCBUUyBgcmVxdWlyZUJlYXJlclRva2VuTWlkZGxld2FyZWAsIFB5dGhvbiBgcmVxdWlyZV9iZWFyZXJfdG9rZW5fbWlkZGxld2FyZWApLiBNdXN0IGJlIGB0cnVlYC4gKi9cbiAgcmVhZG9ubHkgcmVxdWlyZUJlYXJlclRva2VuOiBib29sZWFuO1xufVxuXG4vKiogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB7XG4gIC8qKiBUaGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZC4gKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKiBUaGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggYSBsb2NrZWQgZnJvbnQgZG9vciAoQ2xvdWRGcm9udCAvIFZQQyBvcmlnaW4pLiAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxufVxuXG4vKiogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zIHtcbiAgLyoqIERlbmlhbCBtZXRyaWMgbmFtZS4gTXVzdCBiZSBgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZGAuIEBkZWZhdWx0IGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWQgKi9cbiAgcmVhZG9ubHkgbWV0cmljTmFtZT86IHN0cmluZztcbiAgLyoqIEJvdW5kZWQgbWV0cmljIGRpbWVuc2lvbnMuIE11c3QgYmUgZXhhY3RseSBgb3V0Y29tZWAgYW5kIGByb3V0ZV9mYW1pbHlgLiBAZGVmYXVsdCBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdICovXG4gIHJlYWRvbmx5IGRpbWVuc2lvbnM/OiBzdHJpbmdbXTtcbn1cblxuLyoqIE93bmluZy1BUEkgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnMge1xuICAvKiogU3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLiAqL1xuICByZWFkb25seSByYXRlTGltaXQ6IG51bWJlcjtcbiAgLyoqIFN0YWdlIGJ1cnN0IGxpbWl0LiAqL1xuICByZWFkb25seSBidXJzdExpbWl0OiBudW1iZXI7XG59XG5cbi8qKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyBkZWZlbnNlLWluLWRlcHRoIGRlY2lzaW9ucyAocmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHtcbiAgLyoqIFdoZXRoZXIgdGhlIG93bmluZyBBUEkncyBzdGFnZSBoYXMgYWNjZXNzIGxvZ2dpbmcgZW5hYmxlZC4gTXVzdCBiZSB0cnVlLiAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICAvKiogVGhlIG93bmluZyBBUEkncyBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucztcbn1cblxuLyoqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIEhUVFBTIEpXVCBpc3N1ZXIgVVJMLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGlzc3Vlcj86IHN0cmluZztcbiAgLyoqIEFjY2VwdGVkIEpXVCBhdWRpZW5jZXMuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgYXVkaWVuY2U/OiBzdHJpbmdbXTtcbiAgLyoqIElkZW50aXR5IHNvdXJjZXMgZm9yIHRoZSBKV1QgYXV0aG9yaXplci4gQGRlZmF1bHQgW1wiJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb25cIl0gKi9cbiAgcmVhZG9ubHkgaWRlbnRpdHlTb3VyY2U/OiBzdHJpbmdbXTtcbiAgLyoqIEpXVCBhdXRob3JpemVyIHJlc291cmNlIG5hbWUuIEBkZWZhdWx0IHRoZSBhdXRob3JpemVyIGNvbnN0cnVjdCBpZCAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcbn1cblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZWZlbnNpdmUgc25hcHNob3Qgb2YgdGhlIGNvbnN0cnVjdCdzIGRlcml2ZWQgZmFjYWRlIGludmVudG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcm91dGVzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZVtdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclByb3BzIHtcbiAgLyoqIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyB0aGUgcnVudGltZS1jb21wb3NlZCBNQ1AgZmFjYWRlLiAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBNQ1AgZmFjYWRlIGZhbWlsaWVzIHRoYXRcbiAgICogc2hhcmUgb25lIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeVxuICAgKiBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogU3RhZ2UgbmFtZSB1c2VkIHdoZW4gZGVyaXZpbmcgYXR0YWNoLW1vZGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgdGVtcGxhdGVzLlxuICAgKiBVc2UgYCRkZWZhdWx0YCBmb3IgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHQgc3RhZ2UuIFdoZW4gb21pdHRlZCwgdGhlIHN0YWdlXG4gICAqIGlzIG5vdCBkZXRlcm1pbmFibGUgYW5kIHRoZSB0ZW1wbGF0ZXMgcmV0YWluIHRoZSBiYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbi5cbiAgICogVGhpcyBwcm9wIGRvZXMgbm90IGNyZWF0ZSwgaW1wb3J0LCBvciBtdXRhdGUgYSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdHRhY2hlZEFwaVN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBBbiBleHBsaWNpdCBzZWxlY3Rpb24gb3ZlcnJpZGVzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuIFdoZW4gaXQgaXNcbiAgICogb21pdHRlZCwgYSBzZXJ2ZXIgdGhhdCBhdHRhY2hlcyBgZmFjYWRlYCByZXNvbHZlcyB0byBgcnVudGltZS1iZWFyZXJgIGFuZCBhXG4gICAqIHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXIgcmVzb2x2ZXMgdG8gYGlhbWAuIGBub25lLXB1YmxpY2AgaXMgbmV2ZXIgYSBkZWZhdWx0XG4gICAqIGFuZCBjYXJyaWVzIHRoZSBkZWZlbnNlLWluLWRlcHRoIGZsb29yLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSIHdoZW4gYGZhY2FkZWAgaXMgYXR0YWNoZWQsIG90aGVyd2lzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZT86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG5cbiAgLyoqXG4gICAqIFVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBtYXJrcyB0aGlzIHNlcnZlciBhcyBmYWNhZGUtY29uZmlndXJlZC5cbiAgICpcbiAgICogVGhlIGF0dGFjaG1lbnQncyBwcmVzZW5jZSBzZWxlY3RzIHRoZSBgcnVudGltZS1iZWFyZXJgIHBvc3R1cmUgZGVmYXVsdC5cbiAgICogUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudDtcblxuICAvKipcbiAgICogUnVudGltZS1zaWRlIFJGQyA5NzI4IGJlYXJlciB2YWxpZGF0aW9uIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZCBieSBgdHJhbnNwb3J0UG9zdHVyZTogUlVOVElNRV9CRUFSRVJgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5XG4gICAqIG90aGVyIHBvc3R1cmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBvc3R1cmU/OiBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZFxuICAgKiBOT05FX1BVQkxJQy4gQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIGlzIHJlZnVzZWQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5PzogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5O1xuXG4gIC8qKlxuICAgKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIG9ubHkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVuaWFsU2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucztcblxuICAvKipcbiAgICogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgdGhyb3R0bGluZyBhbmQgYWNjZXNzLWxvZ2dpbmdcbiAgICogZGVjaXNpb25zLCByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmQgTk9ORV9QVUJMSUMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3duaW5nQXBpRGVmZW5zZT86IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICpcbiAgICogVHJhbnNwb3J0IHJvdXRlcyBhcmUgdGhlIFBPU1QsIEdFVCwgYW5kIERFTEVURSByb3V0ZXMgb24gZXZlcnkgTUNQIHBhdHRlcm4uXG4gICAqIFRoaXMgcHJvcCBpcyBvbmx5IHZhbGlkIHdpdGggYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAsIHdoaWNoIHJlcXVpcmVzIGFuXG4gICAqIGlzc3VlciBhbmQgYSBub24tZW1wdHkgYXVkaWVuY2UuIERpc2NvdmVyeSwgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhLFxuICAgKiBhdXRob3JpemUsIGFuZCB0b2tlbiByb3V0ZXMgcmVtYWluIGV4cGxpY2l0bHkgcHVibGljIChgTk9ORWApIGJlY2F1c2UgT0F1dGhcbiAgICogY2xpZW50cyBtdXN0IGZldGNoIHRoZW0gYmVmb3JlIHRoZXkgaG9sZCBhIHRva2VuLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydEF1dGhvcml6ZXI/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucztcblxuICAvKipcbiAgICogU2Vzc2lvbi1zdGF0ZSB0YWJsZSBjb25maWd1cmF0aW9uLiBUaGUgdGFibGUgZGVmYXVsdHMgb24uXG4gICAqIEBkZWZhdWx0IGVuYWJsZWQgd2l0aCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uU3RhdGU/OiBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPd25lZC1BUEkgY29uZmlndXJhdGlvbiBmb3Igc3RhbmRhbG9uZSBtb2RlLiBJbnZhbGlkIHdpdGggYGFwaWAuXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24tb3duZWQgQVBJIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBvd25lZEFwaT86IEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucztcblxuICAvKipcbiAgICogU2luZ2xlIE1DUCByb3V0ZSBwYXRoIGZyb20gdGhlIHYzLjEueCBBNiBzdXJmYWNlLlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHJvdXRlRmFtaWx5LnBhdHRlcm5zYC4gVGhlIG5ldyBkZWZhdWx0IGlzIHRoZSBjYW5vbmljYWxcbiAgICogZm91ci1wYXR0ZXJuIGZhbWlseTsgdXNlIGB7IHBhdHRlcm5zOiBbJy9tY3AnXSB9YCBmb3IgdGhlIG9sZCBzaW5nbGV0b24uXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBdXRob3JpemF0aW9uLXNlcnZlciBpc3N1ZXIgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5Jc3N1ZXJVUkxgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBpc3N1ZXIgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcj86IHN0cmluZztcblxuICAvKipcbiAgICogSldLUyBVUkkgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5KV0tTVVJJYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgSldLUyBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBqd2tzVXJpPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmFwaU5hbWVgLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS5lbmFibGVkYC4gU2Vzc2lvbiBzdGF0ZSBub3cgZGVmYXVsdHMgb24uXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50YWJsZU5hbWVgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50dGxNaW51dGVzYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuZG9tYWluYC4gRG9tYWlucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuc3RhZ2VgLiBTdGFnZSBvcHRpb25zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogQ29udHJhY3QtZmlyc3QgTUNQIGZhY2FkZSBkZXBsb3ltZW50IGNvbnN0cnVjdC5cbiAqXG4gKiBUaGUgcHJpbWFyeSBtb2RlIGF0dGFjaGVzIHRoZSBjb21wbGV0ZSByb3V0ZS1hbGdlYnJhIGZhbWlseSB0byBhIHN1cHBsaWVkXG4gKiBIVFRQIEFQSS4gT21pdHRpbmcgYGFwaWAgc3BlY2lhbGl6ZXMgdGhlIHNhbWUgcGF0aCBpbnRvIGEgc3RhbmRhbG9uZSBvd25lZFxuICogQVBJLiBUaGUgY29uc3RydWN0IHJvdXRlcyBvbmx5OiBPQXV0aCBtZXRhZGF0YSwgc2NvcGVzLCBjYXBhYmlsaXRpZXMsIGFuZFxuICogYXV0aG9yaXplL3Rva2VuIGJlaGF2aW9yIHJlbWFpbiBhcHBsaWNhdGlvbi1vd25lZCB0aHJvdWdoIEdvXG4gKiBgbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHByaXZhdGUgcm91dGVTZXF1ZW5jZSA9IDA7XG5cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICAvKipcbiAgICogUmVzb2x2ZWQgdHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogRmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVycyByZXNvbHZlIHRvIGBydW50aW1lLWJlYXJlcmAgdW5sZXNzXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlYCBvdmVycmlkZXMgdGhlIGRlZmF1bHQ7IHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXJzIHJlc29sdmVcbiAgICogdG8gYGlhbWAuIERlbGliZXJhdGVseSBwdWJsaWMgc2VydmVycyBtdXN0IHNlbGVjdCBgbm9uZS1wdWJsaWNgIGV4cGxpY2l0bHkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcbiAgLyoqXG4gICAqIERlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGVzIGZvciB0aGUgb3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSB0aGVzZSBhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlcywgbm90IGRlY2xhcmF0aW9ucyBvZlxuICAgKiBwdWJsaWMgYXV0aG9yaXR5LiBBbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQ7IHRoZSBvcmlnaW4gaXMgZGVyaXZlZFxuICAgKiBmcm9tIGBhcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIHBsdXNcbiAgICogYGF0dGFjaGVkQXBpU3RhZ2VOYW1lYCB3aGVuIHN1cHBsaWVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKlxuICAgKiBGaXJzdCBkZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlLlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSBhbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQuIFRoaXMgdmFsdWUgaXMgYW5cbiAgICogZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlIGRlcml2ZWQgYnkgdGhlIHNhbWUgcnVsZXMgYXMgYGVuZHBvaW50c2AsIG5vdFxuICAgKiB0aGUgZnJvbnQgZG9vcidzIHB1YmxpYyBhdXRob3JpdHkuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgZW5kcG9pbnRzYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG5cbiAgICBjb25zdCBwb3N0dXJlID0gcHJvcHMudHJhbnNwb3J0UG9zdHVyZVxuICAgICAgPz8gKHByb3BzLmZhY2FkZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICAgICA6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNKTtcbiAgICB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZSk7XG4gICAgdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KHByb3BzLmZhY2FkZSk7XG4gICAgdmFsaWRhdGVQb3N0dXJlR3VhcmRzKHByb3BzLCByb3V0ZUZhbWlseSwgcG9zdHVyZSk7XG4gICAgdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChwcm9wcywgcG9zdHVyZSk7XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkID0gcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQztcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBvd25lZE9wdGlvbnMuYXBpTmFtZSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzLCBwb3N0dXJlKTtcbiAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgbGV0IGZpcnN0VHJhbnNwb3J0Um91dGU6IGFwaWd3djIuSHR0cFJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMpIHtcbiAgICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIHtcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHJvdXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICAgdG9IdHRwTWV0aG9kKG1ldGhvZCksXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICAgKTtcbiAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgIH1cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucmVnaXN0ZXJQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBUaGUgdXBzdHJlYW0gY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBub3QgcGVyIGtpbmQ6IHdpcmUgaXQgZXhhY3RseSBvbmNlLlxuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybixcbiAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAodGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4sXG4gICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBwb3N0dXJlTWFya2VyVGFyZ2V0ID0gKHRoaXMub3duZWRBcGk/Lm5vZGUuZGVmYXVsdENoaWxkXG4gICAgICA/PyBmaXJzdFRyYW5zcG9ydFJvdXRlPy5ub2RlLmRlZmF1bHRDaGlsZCkgYXMgYXBpZ3d2Mi5DZm5BcGkgfCBhcGlnd3YyLkNmblJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIHBvc3R1cmVNYXJrZXJUYXJnZXQ/LmFkZE1ldGFkYXRhKE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVksIHtcbiAgICAgIHBvc3R1cmUsXG4gICAgICBjb250cmFjdF9pZDogTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lELFxuICAgICAgcm91dGVfY291bnQ6IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLmxlbmd0aCxcbiAgICAgIHJ1bnRpbWVfcG9zdHVyZV9kZWNsYXJlZDogcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlc3Npb25TdGF0ZSA9IG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wcyk7XG4gICAgaWYgKHNlc3Npb25TdGF0ZS5lbmFibGVkKSB7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogc2Vzc2lvblN0YXRlLnRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwic2Vzc2lvbklkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHNlc3Npb25TdGF0ZS5yZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjogeyBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGFibGU7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVEFCTEVcIiwgdGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UVExfTUlOVVRFU1wiLCBTdHJpbmcoc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXMpKTtcbiAgICB9XG5cbiAgICBsZXQgZW5kcG9pbnRCYXNlOiBzdHJpbmc7XG4gICAgaWYgKG93bmVkT3B0aW9ucy5kb21haW4pIHtcbiAgICAgIGlmICghb3duZWRTdGFnZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiBjb25maWd1cmF0aW9uIHJlcXVpcmVzIGNvbnN0cnVjdC1vd25lZCBBUEkgbW9kZVwiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ob3duZWRPcHRpb25zLmRvbWFpbiwgb3duZWRTdGFnZSk7XG4gICAgICBlbmRwb2ludEJhc2UgPSBgaHR0cHM6Ly8ke293bmVkT3B0aW9ucy5kb21haW4uZG9tYWluTmFtZX1gO1xuICAgIH0gZWxzZSBpZiAocHJvcHMuYXBpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgICAgY29uc3QgZXhlY3V0ZUFwaU9yaWdpbiA9IGBodHRwczovLyR7dGhpcy5hcGkuYXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH1gO1xuICAgICAgZW5kcG9pbnRCYXNlID0gcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gZXhlY3V0ZUFwaU9yaWdpblxuICAgICAgICA6IGAke2V4ZWN1dGVBcGlPcmlnaW59LyR7cHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWV9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgZW5kcG9pbnRCYXNlID0gb3duZWRTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7b3duZWRTdGFnZU5hbWV9YDtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludHMgPSB0aGlzLm1jcFBhdGhzLm1hcChcbiAgICAgIChwYXR0ZXJuKSA9PiBgJHtzdHJpcFRyYWlsaW5nU2xhc2goZW5kcG9pbnRCYXNlKX0ke3BhdHRlcm59YCxcbiAgICApO1xuICAgIHRoaXMuZW5kcG9pbnQgPSB0aGlzLmVuZHBvaW50c1swXTtcblxuICAgIC8vIEF0dGFjaC1tb2RlIHB1YmxpYyBhdXRob3JpdHkgYmVsb25ncyB0byB0aGUgZnJvbnQgZG9vci4gRG8gbm90IHNtdWdnbGVcbiAgICAvLyBpdCBpbnRvIHRoaXMgY29uc3RydWN0IGFzIGFuIG9yaWdpbiBwcm9wLlxuICAgIGlmICghcHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX0VORFBPSU5UXCIsIHRoaXMuZW5kcG9pbnQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkUnVudGltZVJvdXRlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIG1ldGhvZCksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJldHVybiB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQ09OVFJBQ1RfVkVSU0lPTixcbiAgICByb3V0ZXM6IHBhdHRlcm5zLm1hcCgobWNwUGF0dGVybikgPT4gKHtcbiAgICAgIG1jcFBhdHRlcm4sXG4gICAgICBtY3BNZXRob2RzOiBbXCJQT1NUXCIsIFwiR0VUXCIsIFwiREVMRVRFXCJdLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5U3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgdG9rZW5QYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHJlZ2lzdGVyUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25SZWdpc3RlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgfSkpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjpcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcIi9cIiksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCxcbiAgICBjYWxsYmFja1BhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEgsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkoXG4gIGludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnksXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbik6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFkZCA9IChtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7bWV0aG9kfSAke3BhdGh9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlcml2ZWQgcm91dGUgZmFtaWx5IGNvbGxpZGVzIGF0ICR7a2V5fWApO1xuICAgIH1cbiAgICBzZWVuLmFkZChrZXkpO1xuICB9O1xuICBmb3IgKGNvbnN0IHJvdXRlIG9mIGludmVudG9yeS5yb3V0ZXMpIHtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSBhZGQobWV0aG9kLCByb3V0ZS5tY3BQYXR0ZXJuKTtcbiAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5hdXRob3JpemVQYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUudG9rZW5QYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUucmVnaXN0ZXJQYXR0ZXJuKTtcbiAgICB9XG4gIH1cbiAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuKTtcbiAgfVxuICBpZiAoaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybik7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBpZiAoIXByb3BzLmFwaSkge1xuICAgIGlmIChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSByZXF1aXJlcyBhdHRhY2ggbW9kZSB3aXRoIGFwaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgJiYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSlcbiAgICAgIHx8ICEvXig/OlxcJGRlZmF1bHR8W0EtWmEtejAtOV8tXXsxLDEyOH0pJC8udGVzdChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSkpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBBUEkgR2F0ZXdheSBzdGFnZSBuYW1lXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocHJvcHMub3duZWRBcGkgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwib3duZWRBcGlcIik7XG4gIGlmIChwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImFwaU5hbWVcIik7XG4gIGlmIChwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiZG9tYWluXCIpO1xuICBpZiAocHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwic3RhZ2VcIik7XG4gIGlmIChpbnZhbGlkLmxlbmd0aCAhPT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaCBtb2RlIHdpdGggYXBpIGNhbm5vdCBjb25maWd1cmUgb3duZWQtQVBJIHByb3BzOiAke2ludmFsaWQuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5hcGlOYW1lIGFuZCBkZXByZWNhdGVkIGFwaU5hbWUgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LmRvbWFpbiAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiBhbmQgZGVwcmVjYXRlZCBkb21haW4gY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSBhbmQgZGVwcmVjYXRlZCBzdGFnZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYXBpTmFtZTogcHJvcHMub3duZWRBcGk/LmFwaU5hbWUgPz8gcHJvcHMuYXBpTmFtZSxcbiAgICBkb21haW46IHByb3BzLm93bmVkQXBpPy5kb21haW4gPz8gcHJvcHMuZG9tYWluLFxuICAgIHN0YWdlOiBwcm9wcy5vd25lZEFwaT8uc3RhZ2UgPz8gcHJvcHMuc3RhZ2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvcHRpb25zPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zKTogTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIGNvbnN0IGFjY2Vzc0xvZ2dpbmcgPSBvcHRpb25zPy5hY2Nlc3NMb2dnaW5nID8/IHRydWU7XG4gIGlmICghYWNjZXNzTG9nZ2luZyAmJiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dSZXRlbnRpb24gcmVxdWlyZXMgYWNjZXNzTG9nZ2luZyB0byBiZSBlbmFibGVkXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nRW5hYmxlZCA9IG9wdGlvbnM/LnRocm90dGxpbmdFbmFibGVkID8/IHRydWU7XG4gIGlmIChcbiAgICAhdGhyb3R0bGluZ0VuYWJsZWRcbiAgICAmJiAob3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSB0aHJvdHRsaW5nIGxpbWl0cyByZXF1aXJlIHRocm90dGxpbmdFbmFibGVkIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhdGVMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQ7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIocmF0ZUxpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdSYXRlTGltaXRcIik7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIoYnVyc3RMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nQnVyc3RMaW1pdFwiKTtcbiAgcmV0dXJuIHtcbiAgICBzdGFnZU5hbWU6IG9wdGlvbnM/LnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIsXG4gICAgYWNjZXNzTG9nZ2luZyxcbiAgICBhY2Nlc3NMb2dSZXRlbnRpb246IG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIHRocm90dGxpbmdFbmFibGVkLFxuICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHJhdGVMaW1pdCxcbiAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogYnVyc3RMaW1pdCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICBjb25zdCBoYXNMZWdhY3kgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQ7XG4gIGlmIChwcm9wcy5zZXNzaW9uU3RhdGUgIT09IHVuZGVmaW5lZCAmJiBoYXNMZWdhY3kpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogc2Vzc2lvblN0YXRlIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGRlcHJlY2F0ZWQgc2Vzc2lvbi10YWJsZSBwcm9wc1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW5hYmxlZCA9IHByb3BzLnNlc3Npb25TdGF0ZT8uZW5hYmxlZCA/PyBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgPz8gdHJ1ZTtcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgPz8gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZTtcbiAgY29uc3QgdHRsTWludXRlcyA9IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlc1xuICAgID8/IHByb3BzLnNlc3Npb25UdGxNaW51dGVzXG4gICAgPz8gREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTO1xuICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICBpZiAoXG4gICAgIWVuYWJsZWRcbiAgICAmJiAodGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlcyAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZGlzYWJsZWQgc2Vzc2lvbiBzdGF0ZSBjYW5ub3QgY29uZmlndXJlIHRhYmxlTmFtZSwgdHRsTWludXRlcywgb3IgcmVtb3ZhbFBvbGljeVwiLFxuICAgICk7XG4gIH1cbiAgdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodHRsTWludXRlcywgXCJzZXNzaW9uU3RhdGUudHRsTWludXRlc1wiKTtcbiAgcmV0dXJuIHsgZW5hYmxlZCwgdGFibGVOYW1lLCB0dGxNaW51dGVzLCByZW1vdmFsUG9saWN5IH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSByZXR1cm47XG4gIGNvbnN0IGlzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgaXNzdWVyLFxuICAgICAgZmFsc2UsXG4gICAgICBcImF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoandrc1VyaSkpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGp3a3NVcmksXG4gICAgICB0cnVlLFxuICAgICAgXCJqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnRyYW5zcG9ydEF1dGhvcml6ZXI7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzoge1xuICAgICAgaWYgKGNvbmZpZ3VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIgaXMgb25seSB2YWxpZCB3aXRoIHRyYW5zcG9ydFBvc3R1cmUgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICAgICAgPyBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKClcbiAgICAgICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICB9XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDoge1xuICAgICAgY29uc3QgaXNzdWVyID0gU3RyaW5nKGNvbmZpZ3VyZWQ/Lmlzc3VlciA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoaXNzdWVyID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgaXMgcmVxdWlyZWQgd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgICAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgICAgICBpc3N1ZXIsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgXCJ0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBhdWRpZW5jZSA9IChjb25maWd1cmVkPy5hdWRpZW5jZSA/PyBbXSlcbiAgICAgICAgLm1hcCgodmFsdWUpID0+IFN0cmluZyh2YWx1ZSkudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgIT09IFwiXCIpO1xuICAgICAgaWYgKGF1ZGllbmNlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuYXVkaWVuY2UgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGFjY2VwdGVkIGF1ZGllbmNlIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBKd3RBdXRob3JpemVyKFxuICAgICAgICBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQsXG4gICAgICAgIGlzc3VlcixcbiAgICAgICAge1xuICAgICAgICAgIGp3dEF1ZGllbmNlOiBhdWRpZW5jZSxcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogY29uZmlndXJlZD8uaWRlbnRpdHlTb3VyY2UsXG4gICAgICAgICAgYXV0aG9yaXplck5hbWU6IGNvbmZpZ3VyZWQ/LmF1dGhvcml6ZXJOYW1lLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcG9zdHVyZUxhYmVsKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOiByZXR1cm4gXCJJQU1cIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiByZXR1cm4gXCJKV1RcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6IHJldHVybiBcIlJVTlRJTUVfQkVBUkVSXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiByZXR1cm4gXCJOT05FX1BVQkxJQ1wiO1xuICAgIGRlZmF1bHQ6IHJldHVybiBTdHJpbmcocG9zdHVyZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiB2b2lkIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6XG4gICAgICByZXR1cm47XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQpOiB2b2lkIHtcbiAgaWYgKGZhY2FkZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIGNvbnN0IHByb3ZpZGVySWQgPSAoZmFjYWRlIGFzIHsgcHJvdmlkZXJJZD86IHVua25vd24gfSk/LnByb3ZpZGVySWQ7XG4gIGlmIChcbiAgICB0eXBlb2YgcHJvdmlkZXJJZCAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHByb3ZpZGVySWQudHJpbSgpID09PSBcIlwiXG4gICAgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHByb3ZpZGVySWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmYWNhZGUucHJvdmlkZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcm91dGVGYW1pbHk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQykge1xuICAgIGlmIChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgb3Igandrc1VyaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBlbmFibGUgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGxhYmVsID0gcG9zdHVyZUxhYmVsKHBvc3R1cmUpO1xuICBpZiAoXG4gICAgcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIChwcm9wcy5ydW50aW1lUG9zdHVyZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLnJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiAhPT0gdHJ1ZSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgcnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICYmIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG9yaWdpblJlYWNoYWJpbGl0eSB0byBiZSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQgb3IgLkxPQ0tFRGAsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UocHJvcHMub3duaW5nQXBpRGVmZW5zZSwgbGFiZWwpO1xuICB9IGVsc2Uge1xuICAgIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2U/LnRocm90dGxpbmdFbmFibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYW4gZXhwbGljaXQgb3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0VuYWJsZWQ6IHRydWUgdGhyb3R0bGluZyBkZWNpc2lvbmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlPy5hY2Nlc3NMb2dnaW5nID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFjY2VzcyBsb2dnaW5nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSKSB7XG4gICAgdmFsaWRhdGVEZW5pYWxTaWduYWwocHJvcHMuZGVuaWFsU2lnbmFsKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UoXG4gIGRlZmVuc2U6IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHwgdW5kZWZpbmVkLFxuICBsYWJlbDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChkZWZlbnNlID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UgdG8gcmVjb3JkIHRoZSBvd25pbmcgQVBJJ3MgYWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVjaXNpb25zYCxcbiAgICApO1xuICB9XG4gIGlmIChkZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgIT09IHRydWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UuYWNjZXNzTG9nZ2luZyB0byBiZSB0cnVlYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmc6IFBhcnRpYWw8QXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM+IHwgdW5kZWZpbmVkID0gZGVmZW5zZS50aHJvdHRsaW5nO1xuICBjb25zdCByYXRlTGltaXQgPSB0aHJvdHRsaW5nPy5yYXRlTGltaXQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSB0aHJvdHRsaW5nPy5idXJzdExpbWl0O1xuICBpZiAoXG4gICAgIU51bWJlci5pc0Zpbml0ZShyYXRlTGltaXQpXG4gICAgfHwgKHJhdGVMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgICB8fCAhTnVtYmVyLmlzRmluaXRlKGJ1cnN0TGltaXQpXG4gICAgfHwgKGJ1cnN0TGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS50aHJvdHRsaW5nIHJhdGVMaW1pdCBhbmQgYnVyc3RMaW1pdCB0byBiZSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyc2AsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlbmlhbFNpZ25hbChzaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zKTogdm9pZCB7XG4gIGlmIChzaWduYWwgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIGRlbmlhbFNpZ25hbFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5tZXRyaWNOYW1lICE9PSB1bmRlZmluZWQgJiYgc2lnbmFsLm1ldHJpY05hbWUgIT09IE1DUF9ERU5JQUxfTUVUUklDX05BTUUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwubWV0cmljTmFtZSBtdXN0IGJlICR7TUNQX0RFTklBTF9NRVRSSUNfTkFNRX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5kaW1lbnNpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBkaW1lbnNpb25zID0gQXJyYXkuaXNBcnJheShzaWduYWwuZGltZW5zaW9ucykgPyBzaWduYWwuZGltZW5zaW9ucyA6IFtdO1xuICAgIGNvbnN0IGJvdW5kZWQgPSBkaW1lbnNpb25zLmxlbmd0aCA9PT0gTUNQX0RFTklBTF9ESU1FTlNJT05TLmxlbmd0aFxuICAgICAgJiYgTUNQX0RFTklBTF9ESU1FTlNJT05TLmV2ZXJ5KFxuICAgICAgICAoZGltZW5zaW9uKSA9PiBkaW1lbnNpb25zLmZpbHRlcigodmFsdWUpID0+IHZhbHVlID09PSBkaW1lbnNpb24pLmxlbmd0aCA9PT0gMSxcbiAgICAgICk7XG4gICAgaWYgKCFib3VuZGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5kaW1lbnNpb25zIG11c3QgYmUgZXhhY3RseSAke0pTT04uc3RyaW5naWZ5KE1DUF9ERU5JQUxfRElNRU5TSU9OUyl9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKHZhbHVlOiBzdHJpbmcsIGFsbG93UXVlcnk6IGJvb2xlYW4sIG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBsaXRlcmFsID0gdmFsdWUudHJpbSgpO1xuICBsZXQgcGFyc2VkOiBVUkwgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChsaXRlcmFsKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIHNoYXJlZCB2YWxpZGF0aW9uIGVycm9yIGJlbG93IGlzIHRoZSBwdWJsaWMgc3ludGhlc2lzIGNvbnRyYWN0LlxuICB9XG4gIGlmIChcbiAgICAhcGFyc2VkXG4gICAgfHwgIWxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KGxpdGVyYWwpXG4gICAgfHwgcGFyc2VkLnByb3RvY29sICE9PSBcImh0dHBzOlwiXG4gICAgfHwgIXBhcnNlZC5ob3N0bmFtZVxuICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgIHx8IHBhcnNlZC5wYXNzd29yZCAhPT0gXCJcIlxuICAgIHx8IGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyhsaXRlcmFsKVxuICAgIHx8ICghYWxsb3dRdWVyeSAmJiBsaXRlcmFsLmluY2x1ZGVzKFwiP1wiKSlcbiAgICB8fCBsaXRlcmFsLmluY2x1ZGVzKFwiI1wiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHttZXNzYWdlfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRvSHR0cE1ldGhvZChtZXRob2Q6IHN0cmluZyk6IGFwaWd3djIuSHR0cE1ldGhvZCB7XG4gIHN3aXRjaCAobWV0aG9kKSB7XG4gICAgY2FzZSBcIlBPU1RcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NUO1xuICAgIGNhc2UgXCJHRVRcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQ7XG4gICAgY2FzZSBcIkRFTEVURVwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkRFTEVURTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVuc3VwcG9ydGVkIHJ1bnRpbWUgTUNQIG1ldGhvZCAke21ldGhvZH1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBncmVhdGVyIHRoYW4gemVyb2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIHJldHVybiBmcWRuLmVuZHNXaXRoKHN1ZmZpeCkgPyBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKSA6IGZxZG47XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eaHR0cHM6XFwvXFwvKFteLz8jXSspKD86Wy8/I118JCkvaS5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5ICE9PSB1bmRlZmluZWQgJiYgIWF1dGhvcml0eS5pbmNsdWRlcyhcIiVcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eW0EtWmEtel1bQS1aYS16MC05Ky4tXSo6XFwvXFwvKFteLz8jXSopLy5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5Py5pbmNsdWRlcyhcIkBcIikgPz8gZmFsc2U7XG59XG4iXX0=