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
exports.AppTheoryMcpServer = exports.AppTheoryMcpOriginReachability = exports.AppTheoryMcpTransportPosture = exports.AppTheoryMcpRouteIdMode = exports.AppTheoryMcpRouteModel = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const node_crypto_1 = require("node:crypto");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const constructs_1 = require("constructs");
const mcp_route_algebra_1 = require("./mcp-route-algebra");
const cors_1 = require("./cors");
const route_ids_1 = require("./route-ids");
const CONSOLIDATED_ROOT_ROUTE_ID = "RouteAnyRoot";
const CONSOLIDATED_PROXY_ROUTE_ID = "RouteAnyProxy";
const DEFAULT_THROTTLING_RATE_LIMIT = 100;
const DEFAULT_THROTTLING_BURST_LIMIT = 200;
const DEFAULT_SESSION_TTL_MINUTES = 60;
const MCP_TRANSPORT_AUTHORIZER_ID = "McpTransportAuthorizer";
const MCP_TRANSPORT_POSTURE_METADATA_KEY = "apptheory:mcp-transport-posture";
const MCP_TRANSPORT_POSTURE_CONTRACT_ID = "m17.mcp-transport-posture/v1";
const MCP_DENIAL_METRIC_NAME = "apptheory.mcp.auth_denied";
const MCP_DENIAL_DIMENSIONS = ["outcome", "route_family"];
/** The front-door header name alphabet. */
const FRONT_DOOR_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** The front-door secret alphabet: header-value-safe, no whitespace or controls. */
const FRONT_DOOR_SECRET_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;
/**
 * Request headers a front door can never carry the verification in: they either
 * rewrite the origin request contract or are platform-managed, so a declared
 * value could not be verified the way the runtime reads it.
 */
const RESERVED_FRONT_DOOR_HEADERS = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "transfer-encoding",
    "www-authenticate",
    "x-forwarded-for",
]);
/** Route-emission model for AppTheoryMcpServer. */
var AppTheoryMcpRouteModel;
(function (AppTheoryMcpRouteModel) {
    /**
     * One API Gateway HTTP API v2 route per derived route key. This is the
     * construct's historical inventory and stays byte-identical for deployed
     * stacks, so a `routeModel: explicit` upgrade deploys in place. The default.
     */
    AppTheoryMcpRouteModel["EXPLICIT"] = "explicit";
    /**
     * Two greedy routes, `ANY /` and `ANY /{proxy+}`, backed by one shared
     * integration. The AppTheory runtime router performs method and path
     * dispatch, path-parameter capture, and denial. Consolidation never changes
     * gateway admission, so it is valid only when every gateway route is `NONE`:
     * the `runtime-bearer` and `none-public` transport postures. `iam` and `jwt`
     * are refused at synthesis time.
     */
    AppTheoryMcpRouteModel["CONSOLIDATED"] = "consolidated";
})(AppTheoryMcpRouteModel || (exports.AppTheoryMcpRouteModel = AppTheoryMcpRouteModel = {}));
/** Construct-id derivation for the explicit route model. */
var AppTheoryMcpRouteIdMode;
(function (AppTheoryMcpRouteIdMode) {
    /**
     * Positional ids (`Route0`, `Route1`, ...) assigned in emission order. This
     * is the construct's historical inventory and stays byte-identical for
     * deployed stacks. The default.
     */
    AppTheoryMcpRouteIdMode["LEGACY"] = "legacy";
    /**
     * Ids derived from the route method and pattern, so inserting, removing, or
     * reordering a route family never renames an unrelated route. Intended for
     * newly created explicit APIs: switching an existing deployed explicit API
     * from `legacy` to `semantic` in place renames every route, which is itself a
     * create-before-delete collision. Adopt it on an existing stack only through
     * the new-API swap described in `UPGRADING.md`.
     */
    AppTheoryMcpRouteIdMode["SEMANTIC"] = "semantic";
})(AppTheoryMcpRouteIdMode || (exports.AppTheoryMcpRouteIdMode = AppTheoryMcpRouteIdMode = {}));
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
    /**
     * Disable the execute-api default endpoint and advertise an owned ordinary
     * custom domain as the only MCP authority.
     */
    AppTheoryMcpOriginReachability["DISABLED"] = "disabled";
    /**
     * Disable the execute-api default endpoint and require mutual TLS on every
     * custom domain mapped to the construct-owned API. The owned domain's
     * `mutualTlsAuthentication` is the concrete lock; an enum alone or an
     * external/attached front door never satisfies it.
     */
    AppTheoryMcpOriginReachability["LOCKED"] = "locked";
    /**
     * The origin stays directly reachable at its execute-api endpoint and is
     * served only through an application-owned front door that injects
     * `frontDoorVerification` on every origin request.
     *
     * This is the posture for an app-owned distribution whose origin is the
     * execute-api hostname: the construct sees neither the distribution nor the
     * API's endpoint configuration, so it cannot produce in-stack evidence the
     * way `DISABLED` and `LOCKED` do. Valid only in attach mode, accepted with
     * `RUNTIME_BEARER` and `NONE_PUBLIC` like the other decisions, and it
     * requires the mandatory `frontDoorVerification` declaration.
     *
     * `FRONTED` is a defense-in-depth declaration with runtime enforcement, not
     * mutual-TLS assurance and not origin unreachability. The enforcement is the
     * runtime's front-door header check (`mcpfacade.FacadeConfig`
     * `FrontDoorVerification` in Go, `frontDoorVerification` in TypeScript,
     * `front_door_verification` in Python): it refuses every derived route when
     * the declared header is absent or wrong, and fails registration when
     * `FRONTED` is declared without it. An unwired runtime enforces nothing.
     */
    AppTheoryMcpOriginReachability["FRONTED"] = "fronted";
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "7.1.0" };
    routeSequence = 0;
    routeIdMode = AppTheoryMcpRouteIdMode.LEGACY;
    routeIds = new Set();
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
        const ownedOptions = normalizeOwnedApiOptions(props);
        const posture = props.transportPosture
            ?? (props.facade !== undefined
                ? AppTheoryMcpTransportPosture.RUNTIME_BEARER
                : AppTheoryMcpTransportPosture.IAM);
        validateTransportPosture(posture);
        validateFacadeAttachment(props.facade);
        validatePostureGuards(props, routeFamily, posture);
        validateDefenseInDepth(props, posture, ownedOptions);
        const originReachability = resolveOriginReachability(this, props, ownedOptions);
        const routeModel = resolveRouteModel(props);
        validateRouteModelPosture(routeModel, posture);
        const routeIdMode = resolveRouteIdMode(props);
        this.routeIdMode = routeIdMode;
        if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED && props.api !== undefined) {
            assertConsolidatedAttachAllowed(this, props.api);
        }
        const authorizationRoutesAttached = posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC;
        const upstreamCallbackPath = resolveUpstreamCallbackPath(props);
        this.transportPosture = posture;
        this.mcpPaths = [...routeFamily.patterns];
        this.routeInventory = buildRouteInventory(this.mcpPaths, authorizationRoutesAttached, routeFamily.rootAuthorizationServerDiscovery, upstreamCallbackPath);
        validateRouteInventory(this.routeInventory, authorizationRoutesAttached);
        this.protectedResourceMetadataPaths = this.routeInventory.routes.map((route) => route.protectedResourcePattern);
        this.mcpPath = this.mcpPaths[0];
        this.protectedResourceMetadataPath = this.protectedResourceMetadataPaths[0];
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
                corsPreflight: (0, cors_1.buildCorsPreflight)(props.cors),
                createDefaultStage: false,
                disableExecuteApiEndpoint: originReachability === AppTheoryMcpOriginReachability.DISABLED
                    || originReachability === AppTheoryMcpOriginReachability.LOCKED
                    ? true
                    : undefined,
            });
            this.ownedApi = api;
            this.api = api;
            if (originReachability === AppTheoryMcpOriginReachability.DISABLED) {
                registerOwnedDisabledOriginValidation(this, api);
            }
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
        let firstTransportRoute;
        if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED) {
            firstTransportRoute = this.addConsolidatedRoute(CONSOLIDATED_ROOT_ROUTE_ID, "/", integration, transportAuthorizer);
            const proxyRoute = this.addConsolidatedRoute(CONSOLIDATED_PROXY_ROUTE_ID, "/{proxy+}", integration, transportAuthorizer);
            registerConsolidatedAttachValidation(this, this.api, [firstTransportRoute, proxyRoute]);
        }
        else {
            const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
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
        }
        const postureMarkerTarget = (this.ownedApi?.node.defaultChild
            ?? firstTransportRoute?.node.defaultChild);
        postureMarkerTarget?.addMetadata(MCP_TRANSPORT_POSTURE_METADATA_KEY, {
            posture,
            contract_id: MCP_TRANSPORT_POSTURE_CONTRACT_ID,
            route_count: this.routeInventory.routes.length,
            runtime_posture_declared: props.runtimePosture !== undefined,
            // Only a FRONTED decision extends the marker, so DISABLED and LOCKED
            // templates stay byte-identical. The literal secret is consumed here for
            // its digest and never emitted.
            ...(originReachability === AppTheoryMcpOriginReachability.FRONTED
                ? frontDoorPostureMetadata(props.frontDoorVerification)
                : {}),
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
            if (originReachability === AppTheoryMcpOriginReachability.LOCKED
                && this.ownedApi !== undefined) {
                registerOwnedLockedOriginValidation(this, this.ownedApi);
            }
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
        if (props.api === undefined
            && (originReachability === AppTheoryMcpOriginReachability.DISABLED
                || originReachability === AppTheoryMcpOriginReachability.LOCKED)
            && this.endpoints.some((endpoint) => endpoint.includes(".execute-api."))) {
            throw new Error("AppTheoryMcpServer: originReachability DISABLED must advertise the owned custom domain, never the disabled execute-api endpoint");
        }
        this.endpoint = this.endpoints[0];
    }
    addRuntimeRoute(path, method, integration, authorizer) {
        return new apigwv2.HttpRoute(this, this.nextRouteConstructId(method, path), {
            httpApi: this.api,
            routeKey: apigwv2.HttpRouteKey.with(path, method),
            integration,
            authorizer,
        });
    }
    nextRouteConstructId(method, path) {
        if (this.routeIdMode !== AppTheoryMcpRouteIdMode.SEMANTIC) {
            return `Route${this.routeSequence++}`;
        }
        const id = (0, route_ids_1.semanticRouteConstructId)(method, path);
        if (this.routeIds.has(id)) {
            throw new Error(`AppTheoryMcpServer: routeIdMode semantic derives the duplicate route construct id ${id} for route key ${method} ${path}`);
        }
        this.routeIds.add(id);
        return id;
    }
    addConsolidatedRoute(id, path, integration, authorizer) {
        return new apigwv2.HttpRoute(this, id, {
            httpApi: this.api,
            routeKey: apigwv2.HttpRouteKey.with(path, apigwv2.HttpMethod.ANY),
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
            mtls: options.mutualTlsAuthentication,
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
    if (props.cors !== undefined)
        invalid.push("cors");
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
function resolveRouteModel(props) {
    const configured = props.routeModel;
    if (configured === undefined) {
        return AppTheoryMcpRouteModel.EXPLICIT;
    }
    if (configured === AppTheoryMcpRouteModel.EXPLICIT
        || configured === AppTheoryMcpRouteModel.CONSOLIDATED) {
        return configured;
    }
    throw new Error("AppTheoryMcpServer: routeModel must be AppTheoryMcpRouteModel.EXPLICIT or .CONSOLIDATED");
}
function validateRouteModelPosture(routeModel, posture) {
    if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED
        && posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
        && posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC) {
        throw new Error(`AppTheoryMcpServer: routeModel consolidated is only valid for transportPosture RUNTIME_BEARER or NONE_PUBLIC; transportPosture ${postureLabel(posture)} keeps the explicit route model because consolidation must never change gateway admission`);
    }
}
function resolveRouteIdMode(props) {
    const configured = props.routeIdMode;
    if (configured === undefined) {
        return AppTheoryMcpRouteIdMode.LEGACY;
    }
    if (configured === AppTheoryMcpRouteIdMode.LEGACY
        || configured === AppTheoryMcpRouteIdMode.SEMANTIC) {
        return configured;
    }
    throw new Error("AppTheoryMcpServer: routeIdMode must be AppTheoryMcpRouteIdMode.LEGACY or .SEMANTIC");
}
/**
 * The two greedy route keys a consolidated model owns. A consumer route that
 * redeclares one of them would make the API reject the update.
 */
const CONSOLIDATED_GREEDY_ROUTE_KEYS = new Set(["ANY /", "ANY /{proxy+}"]);
/**
 * Resolve an `ApiId` (or any template value) to a comparable string, so a
 * `Ref` token and its logical id compare equal across two templates of the same
 * stack.
 */
function comparableApiId(scope, value) {
    return JSON.stringify(aws_cdk_lib_1.Stack.of(scope).resolve(value));
}
/**
 * Every API Gateway v2 route bound to `api`, regardless of which construct
 * scope created it.
 *
 * `api.node.children` only sees routes the API itself (or a child scope)
 * created, which misses the common pattern of a stack-level construct wiring a
 * route onto an attached API. Walking the stack and resolving each `CfnRoute`'s
 * `ApiId` sees both.
 */
function routesBoundToApi(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const apiKey = comparableApiId(scope, api.apiId);
    const found = [];
    const visit = (node) => {
        if (node instanceof apigwv2.HttpRoute) {
            if (comparableApiId(scope, node.httpApi.apiId) === apiKey) {
                found.push(node.node.defaultChild);
            }
            // The route's own CfnRoute child is the same route; do not double count.
            return;
        }
        if (node instanceof apigwv2.CfnRoute && comparableApiId(scope, node.apiId) === apiKey) {
            found.push(node);
        }
        for (const child of node.node.children) {
            visit(child);
        }
    };
    visit(stack);
    return found.filter((route) => route !== undefined);
}
/**
 * Refuse a consolidated attach onto an API that already carries routes.
 *
 * The check deliberately walks the whole stack: a route bound to the attached
 * API from a sibling construct scope is just as much a route key the
 * consolidated greedy routes would collide with as one created under the API
 * itself.
 */
function assertConsolidatedAttachAllowed(scope, api) {
    const existingRoutes = routesBoundToApi(scope, api);
    if (existingRoutes.length > 0) {
        throw new Error("AppTheoryMcpServer: routeModel consolidated may attach only to an API that has no routes at attach time; "
            + `the API already carries ${existingRoutes.length} route(s): ${existingRoutes.map((route) => route.node.path).join(", ")}; `
            + "attach to a new or empty API, or use routeModel explicit");
    }
}
/**
 * Register the synth-time rule for routes added to a consolidated API after
 * the construct created its greedy routes.
 *
 * The rule applies in both consolidated modes: an API the construct attached
 * to, and one the construct owns. The documented exception is what makes
 * consolidated routes usable in a real front door: a consumer may add
 * explicit, more specific routes afterwards. It is allowed only when the
 * route carries a non-NONE authorizer (so the greedy routes never silently
 * widen a stricter posture) and does not redeclare a greedy route key (which
 * API Gateway would reject as a duplicate).
 */
function registerConsolidatedAttachValidation(scope, api, ownedRoutes) {
    const owned = new Set(ownedRoutes.map((route) => route.node.defaultChild));
    aws_cdk_lib_1.Stack.of(scope).node.addValidation({
        validate: () => {
            const errors = [];
            for (const route of routesBoundToApi(scope, api)) {
                if (owned.has(route)) {
                    continue;
                }
                const routeKey = route.routeKey;
                if (CONSOLIDATED_GREEDY_ROUTE_KEYS.has(routeKey)) {
                    errors.push(`AppTheoryMcpServer: routeModel consolidated already owns the greedy API Gateway route key ${JSON.stringify(routeKey)} on this API; a route added after construction must not redeclare it (${route.node.path})`);
                    continue;
                }
                const authorizationType = String(route.authorizationType ?? "NONE").toUpperCase();
                if (authorizationType === "NONE") {
                    errors.push(`AppTheoryMcpServer: a route added to a consolidated API after construction must carry a non-NONE authorizer, because the greedy routes admit every method and path at the gateway (${routeKey} from ${route.node.path})`);
                }
            }
            return errors;
        },
    });
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
function validateDefenseInDepth(props, posture, owned) {
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
        && props.originReachability !== AppTheoryMcpOriginReachability.LOCKED
        && props.originReachability !== AppTheoryMcpOriginReachability.FRONTED) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires originReachability to be AppTheoryMcpOriginReachability.DISABLED, .LOCKED, or .FRONTED`);
    }
    if (props.api !== undefined) {
        validateOwningApiDefense(props.owningApiDefense, label);
    }
    else {
        if (owned.stage?.throttlingEnabled !== true) {
            throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires an explicit ownedApi.stage.throttlingEnabled: true throttling decision`);
        }
        if (owned.stage?.accessLogging === false) {
            throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires access logging`);
        }
    }
    if (posture === AppTheoryMcpTransportPosture.RUNTIME_BEARER) {
        validateDenialSignal(props.denialSignal);
    }
}
/**
 * Resolve the declared direct-origin decision to a proven posture.
 *
 * Every supplied value is checked, not only the postures that require the
 * decision. DISABLED needs the owned ordinary domain that replaces the disabled
 * execute-api authority (or a provable concrete attach), and LOCKED
 * additionally needs mutual TLS on every domain mapped to the owned API.
 * Attach-mode LOCKED is unsupported because an external API carries no in-stack
 * truststore or mapping evidence. FRONTED is the attach-mode counterpart for an
 * application-owned front door: it produces no in-stack evidence, so it is
 * accepted only with an explicit, validated `frontDoorVerification` declaration
 * and only in attach mode.
 */
function resolveOriginReachability(scope, props, owned) {
    const decision = props.originReachability;
    const mutualTls = owned.domain?.mutualTlsAuthentication;
    if (decision === undefined) {
        if (mutualTls !== undefined) {
            throw new Error("AppTheoryMcpServer: ownedApi.domain.mutualTlsAuthentication is only valid with originReachability LOCKED");
        }
        if (props.frontDoorVerification !== undefined) {
            throw new Error("AppTheoryMcpServer: frontDoorVerification is only valid with originReachability FRONTED");
        }
        return undefined;
    }
    if (decision !== AppTheoryMcpOriginReachability.DISABLED
        && decision !== AppTheoryMcpOriginReachability.LOCKED
        && decision !== AppTheoryMcpOriginReachability.FRONTED) {
        throw new Error("AppTheoryMcpServer: originReachability must be AppTheoryMcpOriginReachability.DISABLED, .LOCKED, or .FRONTED");
    }
    if (mutualTls !== undefined && decision !== AppTheoryMcpOriginReachability.LOCKED) {
        throw new Error("AppTheoryMcpServer: ownedApi.domain.mutualTlsAuthentication is only valid with originReachability LOCKED");
    }
    if (decision !== AppTheoryMcpOriginReachability.FRONTED
        && props.frontDoorVerification !== undefined) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification is only valid with originReachability FRONTED");
    }
    if (decision === AppTheoryMcpOriginReachability.FRONTED) {
        if (props.api === undefined) {
            throw new Error("AppTheoryMcpServer: originReachability FRONTED is unsupported in owned mode; an owned front door is wired by the DISABLED or LOCKED posture");
        }
        validateFrontDoorVerification(props.frontDoorVerification);
        return decision;
    }
    if (decision === AppTheoryMcpOriginReachability.LOCKED) {
        if (props.api !== undefined) {
            throw new Error("AppTheoryMcpServer: originReachability LOCKED is unsupported in attach mode; an API owned outside the construct carries no in-stack mutual-TLS mapping evidence");
        }
        if (owned.domain === undefined) {
            throw new Error("AppTheoryMcpServer: originReachability LOCKED requires an effective ownedApi.domain with mutualTlsAuthentication");
        }
        if (mutualTls === undefined) {
            throw new Error("AppTheoryMcpServer: originReachability LOCKED requires ownedApi.domain.mutualTlsAuthentication; disablement alone is the DISABLED posture");
        }
        return decision;
    }
    if (props.api !== undefined) {
        if (!(props.api instanceof apigwv2.HttpApi)) {
            throw new Error("AppTheoryMcpServer: originReachability DISABLED in attach mode requires a same-stack concrete HttpApi; an imported API exposes no DisableExecuteApiEndpoint evidence");
        }
        registerAttachDisabledOriginValidation(scope, props.api);
        return decision;
    }
    if (owned.domain === undefined) {
        throw new Error("AppTheoryMcpServer: originReachability DISABLED requires an effective ownedApi.domain; the disabled execute-api endpoint is never a public authority");
    }
    return decision;
}
/**
 * Validate the `frontDoorVerification` declaration for `originReachability:
 * FRONTED`.
 *
 * The declaration is mandatory and every field is checked: an absent
 * declaration, a missing or reserved header name, a secret outside the
 * header-value-safe alphabet, and a missing `asserted: true` all fail synthesis
 * rather than producing a declaration the runtime could not honor.
 */
function validateFrontDoorVerification(verification) {
    if (verification === undefined) {
        throw new Error("AppTheoryMcpServer: originReachability FRONTED requires frontDoorVerification; the runtime cannot enforce an undeclared front door");
    }
    const headerName = verification.headerName;
    if (typeof headerName !== "string" || !FRONT_DOOR_HEADER_NAME_PATTERN.test(headerName)) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.headerName must be 1 to 64 characters of [A-Za-z0-9-]");
    }
    const normalizedHeader = headerName.toLowerCase();
    if (RESERVED_FRONT_DOOR_HEADERS.has(normalizedHeader)
        || normalizedHeader.startsWith("x-amz-")
        || normalizedHeader.startsWith("x-amzn-")
        || normalizedHeader.startsWith("cloudfront-")) {
        throw new Error(`AppTheoryMcpServer: frontDoorVerification.headerName ${headerName} is a reserved or platform-managed request header and cannot carry the front-door verification`);
    }
    const secretValue = verification.secretValue;
    if (typeof secretValue !== "string" || !FRONT_DOOR_SECRET_PATTERN.test(secretValue)) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.secretValue must be 32 to 128 characters of [A-Za-z0-9._~-]");
    }
    if (verification.asserted !== true) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification requires asserted: true — the caller must record that the runtime verifies the front-door header on every derived route");
    }
}
/**
 * The FRONTED fields of the `apptheory:mcp-transport-posture` marker.
 *
 * The marker records the posture and the header name and a SHA-256 digest of the
 * declared secret. The literal secret is consumed here for validation (already
 * performed) and its digest only: it never lands in the synthesized template or
 * in CloudFormation, so it cannot be read back out of a stack.
 */
function frontDoorPostureMetadata(verification) {
    if (verification === undefined) {
        throw new Error("AppTheoryMcpServer: originReachability FRONTED requires frontDoorVerification; the runtime cannot enforce an undeclared front door");
    }
    return {
        origin_reachability: AppTheoryMcpOriginReachability.FRONTED,
        front_door_header_name: verification.headerName,
        front_door_secret_sha256: (0, node_crypto_1.createHash)("sha256").update(verification.secretValue, "utf8").digest("hex"),
    };
}
/**
 * Final synthesis proof for an owned DISABLED API: the default execute-api
 * endpoint must still be disabled in the emitted template, even if a later L1
 * override tries to re-enable it.
 */
function registerOwnedDisabledOriginValidation(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const cfnApi = api.node.defaultChild;
    stack.node.addValidation({
        validate: () => {
            if (stack.resolve(cfnApi.disableExecuteApiEndpoint) === true) {
                return [];
            }
            return [
                "AppTheoryMcpServer: originReachability DISABLED requires AWS::ApiGatewayV2::Api.Properties.DisableExecuteApiEndpoint to resolve to true",
            ];
        },
    });
}
/**
 * Final whole-stack proof for an owned LOCKED API.
 *
 * LOCKED is not an alias of DISABLED: at final synthesis the default endpoint
 * must still be disabled and every `CfnApiMapping` bound to the owned API,
 * including mappings another scope adds after construction, must resolve to an
 * in-stack `CfnDomainName` whose `MutualTlsAuthentication` carries a truststore
 * URI. An unresolvable mapping or domain fails closed instead of counting as
 * evidence.
 */
function registerOwnedLockedOriginValidation(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const cfnApi = api.node.defaultChild;
    stack.node.addValidation({
        validate: () => {
            const errors = [];
            if (stack.resolve(cfnApi.disableExecuteApiEndpoint) !== true) {
                errors.push("AppTheoryMcpServer: originReachability LOCKED requires AWS::ApiGatewayV2::Api.Properties.DisableExecuteApiEndpoint to resolve to true");
            }
            const mappings = cfnApiMappingsBoundToApi(scope, api);
            if (mappings.length === 0) {
                errors.push("AppTheoryMcpServer: originReachability LOCKED requires at least one AWS::ApiGatewayV2::ApiMapping bound to the owned API");
            }
            const domains = cfnDomainNames(scope);
            for (const mapping of mappings) {
                const domain = domains.find((candidate) => comparableApiId(scope, candidate.ref)
                    === comparableApiId(scope, mapping.domainName));
                if (domain === undefined) {
                    errors.push(`AppTheoryMcpServer: originReachability LOCKED cannot resolve mapping ${mapping.node.path} to an in-stack AWS::ApiGatewayV2::DomainName; mutual-TLS evidence is unverifiable`);
                    continue;
                }
                if (!hasTruststoreUri(stack, domain)) {
                    errors.push(`AppTheoryMcpServer: originReachability LOCKED requires every mapping to target a domain with MutualTlsAuthentication.TruststoreUri (${mapping.node.path} -> ${domain.node.path})`);
                }
            }
            return errors;
        },
    });
}
function hasTruststoreUri(stack, domain) {
    const resolved = stack.resolve(domain.mutualTlsAuthentication);
    if (resolved === undefined || resolved === null || typeof resolved !== "object") {
        return false;
    }
    const authentication = resolved;
    const truststoreUri = authentication.truststoreUri ?? authentication.TruststoreUri;
    return truststoreUri !== undefined && truststoreUri !== null && truststoreUri !== "";
}
/** Every in-stack `CfnApiMapping` whose resolved `ApiId` is the supplied API. */
function cfnApiMappingsBoundToApi(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const apiKey = comparableApiId(scope, api.apiId);
    const found = [];
    const visit = (node) => {
        if (node instanceof apigwv2.CfnApiMapping && comparableApiId(scope, node.apiId) === apiKey) {
            found.push(node);
        }
        for (const child of node.node.children) {
            visit(child);
        }
    };
    visit(stack);
    return found;
}
function cfnDomainNames(scope) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const found = [];
    const visit = (node) => {
        if (node instanceof apigwv2.CfnDomainName) {
            found.push(node);
        }
        for (const child of node.node.children) {
            visit(child);
        }
    };
    visit(stack);
    return found;
}
/**
 * Final synthesis proof for an attach DISABLED declaration: the concrete API
 * must bind to exactly one in-stack CfnApi whose DisableExecuteApiEndpoint
 * resolves to literal true. The construct never mutates the attached API.
 */
function registerAttachDisabledOriginValidation(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    stack.node.addValidation({
        validate: () => {
            const cfnApis = cfnApisBoundToApi(scope, api);
            if (cfnApis.length !== 1) {
                return [
                    "AppTheoryMcpServer: originReachability DISABLED in attach mode requires exactly one same-stack AWS::ApiGatewayV2::Api; the attached API's DisableExecuteApiEndpoint cannot be proven",
                ];
            }
            if (stack.resolve(cfnApis[0].disableExecuteApiEndpoint) !== true) {
                return [
                    "AppTheoryMcpServer: originReachability DISABLED in attach mode requires the attached AWS::ApiGatewayV2::Api to set DisableExecuteApiEndpoint=true",
                ];
            }
            return [];
        },
    });
}
/** Every in-stack `CfnApi` whose `Ref` is the supplied API's id. */
function cfnApisBoundToApi(scope, api) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const apiKey = comparableApiId(scope, api.apiId);
    const found = [];
    const visit = (node) => {
        if (node instanceof apigwv2.CfnApi && comparableApiId(scope, node.ref) === apiKey) {
            found.push(node);
        }
        for (const child of node.node.children) {
            visit(child);
        }
    };
    visit(stack);
    return found;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUVyRCwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELDJDQUF1QztBQUV2QywyREFBK0Q7QUFDL0QsaUNBQTRDO0FBRTVDLDJDQUF1RDtBQUV2RCxNQUFNLDBCQUEwQixHQUFHLGNBQWMsQ0FBQztBQUNsRCxNQUFNLDJCQUEyQixHQUFHLGVBQWUsQ0FBQztBQUNwRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBQzdELE1BQU0sa0NBQWtDLEdBQUcsaUNBQWlDLENBQUM7QUFDN0UsTUFBTSxpQ0FBaUMsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RSxNQUFNLHNCQUFzQixHQUFHLDJCQUEyQixDQUFDO0FBQzNELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFFMUQsMkNBQTJDO0FBQzNDLE1BQU0sOEJBQThCLEdBQUcsc0JBQXNCLENBQUM7QUFFOUQsb0ZBQW9GO0FBQ3BGLE1BQU0seUJBQXlCLEdBQUcsMkJBQTJCLENBQUM7QUFFOUQ7Ozs7R0FJRztBQUNILE1BQU0sMkJBQTJCLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDMUMsZUFBZTtJQUNmLFlBQVk7SUFDWixnQkFBZ0I7SUFDaEIsUUFBUTtJQUNSLE1BQU07SUFDTixtQkFBbUI7SUFDbkIsa0JBQWtCO0lBQ2xCLGlC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QUFJLEtBQUssQ0FBQztBQUMzQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyB9IGZyb20gXCIuL2h0dHAtYXBpXCI7XG5pbXBvcnQgeyBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQgfSBmcm9tIFwiLi9yb3V0ZS1pZHNcIjtcblxuY29uc3QgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQgPSBcIlJvdXRlQW55Um9vdFwiO1xuY29uc3QgQ09OU09MSURBVEVEX1BST1hZX1JPVVRFX0lEID0gXCJSb3V0ZUFueVByb3h5XCI7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVCA9IDEwMDtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVCA9IDIwMDtcbmNvbnN0IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUyA9IDYwO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lEID0gXCJNY3BUcmFuc3BvcnRBdXRob3JpemVyXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZID0gXCJhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQgPSBcIm0xNy5tY3AtdHJhbnNwb3J0LXBvc3R1cmUvdjFcIjtcbmNvbnN0IE1DUF9ERU5JQUxfTUVUUklDX05BTUUgPSBcImFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRcIjtcbmNvbnN0IE1DUF9ERU5JQUxfRElNRU5TSU9OUyA9IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl07XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IEZST05UX0RPT1JfSEVBREVSX05BTUVfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS1dezEsNjR9JC87XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBzZWNyZXQgYWxwaGFiZXQ6IGhlYWRlci12YWx1ZS1zYWZlLCBubyB3aGl0ZXNwYWNlIG9yIGNvbnRyb2xzLiAqL1xuY29uc3QgRlJPTlRfRE9PUl9TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqXG4gKiBSZXF1ZXN0IGhlYWRlcnMgYSBmcm9udCBkb29yIGNhbiBuZXZlciBjYXJyeSB0aGUgdmVyaWZpY2F0aW9uIGluOiB0aGV5IGVpdGhlclxuICogcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3Qgb3IgYXJlIHBsYXRmb3JtLW1hbmFnZWQsIHNvIGEgZGVjbGFyZWRcbiAqIHZhbHVlIGNvdWxkIG5vdCBiZSB2ZXJpZmllZCB0aGUgd2F5IHRoZSBydW50aW1lIHJlYWRzIGl0LlxuICovXG5jb25zdCBSRVNFUlZFRF9GUk9OVF9ET09SX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cblxuLyoqIFJvdXRlLWVtaXNzaW9uIG1vZGVsIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgLyoqXG4gICAqIE9uZSBBUEkgR2F0ZXdheSBIVFRQIEFQSSB2MiByb3V0ZSBwZXIgZGVyaXZlZCByb3V0ZSBrZXkuIFRoaXMgaXMgdGhlXG4gICAqIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3IgZGVwbG95ZWRcbiAgICogc3RhY2tzLCBzbyBhIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgdXBncmFkZSBkZXBsb3lzIGluIHBsYWNlLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIEVYUExJQ0lUID0gXCJleHBsaWNpdFwiLFxuICAvKipcbiAgICogVHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCwgYmFja2VkIGJ5IG9uZSBzaGFyZWRcbiAgICogaW50ZWdyYXRpb24uIFRoZSBBcHBUaGVvcnkgcnVudGltZSByb3V0ZXIgcGVyZm9ybXMgbWV0aG9kIGFuZCBwYXRoXG4gICAqIGRpc3BhdGNoLCBwYXRoLXBhcmFtZXRlciBjYXB0dXJlLCBhbmQgZGVuaWFsLiBDb25zb2xpZGF0aW9uIG5ldmVyIGNoYW5nZXNcbiAgICogZ2F0ZXdheSBhZG1pc3Npb24sIHNvIGl0IGlzIHZhbGlkIG9ubHkgd2hlbiBldmVyeSBnYXRld2F5IHJvdXRlIGlzIGBOT05FYDpcbiAgICogdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0IHBvc3R1cmVzLiBgaWFtYCBhbmQgYGp3dGBcbiAgICogYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzIHRpbWUuXG4gICAqL1xuICBDT05TT0xJREFURUQgPSBcImNvbnNvbGlkYXRlZFwiLFxufVxuXG4vKiogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgLyoqXG4gICAqIFBvc2l0aW9uYWwgaWRzIChgUm91dGUwYCwgYFJvdXRlMWAsIC4uLikgYXNzaWduZWQgaW4gZW1pc3Npb24gb3JkZXIuIFRoaXNcbiAgICogaXMgdGhlIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3JcbiAgICogZGVwbG95ZWQgc3RhY2tzLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG4gIC8qKlxuICAgKiBJZHMgZGVyaXZlZCBmcm9tIHRoZSByb3V0ZSBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yXG4gICAqIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHkgbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGUuIEludGVuZGVkIGZvclxuICAgKiBuZXdseSBjcmVhdGVkIGV4cGxpY2l0IEFQSXM6IHN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUElcbiAgICogZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUsIHdoaWNoIGlzIGl0c2VsZiBhXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIGNvbGxpc2lvbi4gQWRvcHQgaXQgb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoXG4gICAqIHRoZSBuZXctQVBJIHN3YXAgZGVzY3JpYmVkIGluIGBVUEdSQURJTkcubWRgLlxuICAgKi9cbiAgU0VNQU5USUMgPSBcInNlbWFudGljXCIsXG59XG5cbi8qKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gVGhlIGRlZmF1bHQgZm9yIGEgc2VydmVyIHdpdGggbm8gZmFjYWRlIGF0dGFjaG1lbnQuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBBIHN0YXRpYyBKV1QgYXV0aG9yaXplciAoaXNzdWVyICsgYXVkaWVuY2UpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiAqL1xuICBKV1QgPSBcImp3dFwiLFxuICAvKiogVGhlIGdhdGV3YXkgYXV0aG9yaXplciBpcyBOT05FIGFuZCB0aGUgcnVudGltZSB2YWxpZGF0ZXMgUkZDIDk3MjggYmVhcmVyIHRva2Vucy4gVGhlIGRlZmF1bHQgZm9yIGEgZmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVyLiAqL1xuICBSVU5USU1FX0JFQVJFUiA9IFwicnVudGltZS1iZWFyZXJcIixcbiAgLyoqIERlbGliZXJhdGVseSBwdWJsaWMgTUNQIHNlcnZlcjogZXZlcnkgdHJhbnNwb3J0IHJvdXRlIGlzIHB1YmxpYy4gTmV2ZXIgYSBkZWZhdWx0LiAqL1xuICBOT05FX1BVQkxJQyA9IFwibm9uZS1wdWJsaWNcIixcbn1cblxuLyoqIFByZXNlbmNlLW9ubHkgc2tlbGV0b24gb2YgdGhlIHVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBzZWxlY3RzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQge1xuICAvKiogSWRlbnRpZmllcyB0aGUgdXBzdHJlYW0gYXV0aG9yaXphdGlvbiBwcm92aWRlciB0aGlzIHNlcnZlciBmcm9udHMgKGZvciBleGFtcGxlIGBhdXRoZW9yeWApLiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZSBhbmQgdXNlcyBpdHMgcHJlc2VuY2UgdG8gc2VsZWN0IHRoZSBgcnVudGltZS1iZWFyZXJgIGRlZmF1bHQuICovXG4gIHJlYWRvbmx5IHByb3ZpZGVySWQ6IHN0cmluZztcbn1cblxuLyoqIFJ1bnRpbWUtc2lkZSBkZWNsYXJhdGlvbiB0aGF0IHRoZSB0cmFuc3BvcnQgcm91dGVzIHZhbGlkYXRlIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMgYXQgcnVudGltZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zIHtcbiAgLyoqIEFzc2VydCB0aGUgcnVudGltZSByZWdpc3RlcnMgdGhlIHRyYW5zcG9ydCByb3V0ZXMgd2l0aCB0aGUgcnVudGltZS12YWxpZGF0ZWQgYmVhcmVyIHBvc3R1cmUgKEdvIGBGYWNhZGVDb25maWcuUmVxdWlyZUJlYXJlclRva2VuYCwgVFMgYHJlcXVpcmVCZWFyZXJUb2tlbk1pZGRsZXdhcmVgLCBQeXRob24gYHJlcXVpcmVfYmVhcmVyX3Rva2VuX21pZGRsZXdhcmVgKS4gTXVzdCBiZSBgdHJ1ZWAuICovXG4gIHJlYWRvbmx5IHJlcXVpcmVCZWFyZXJUb2tlbjogYm9vbGVhbjtcbn1cblxuLyoqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkge1xuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgYWR2ZXJ0aXNlIGFuIG93bmVkIG9yZGluYXJ5XG4gICAqIGN1c3RvbSBkb21haW4gYXMgdGhlIG9ubHkgTUNQIGF1dGhvcml0eS5cbiAgICovXG4gIERJU0FCTEVEID0gXCJkaXNhYmxlZFwiLFxuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgcmVxdWlyZSBtdXR1YWwgVExTIG9uIGV2ZXJ5XG4gICAqIGN1c3RvbSBkb21haW4gbWFwcGVkIHRvIHRoZSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBUaGUgb3duZWQgZG9tYWluJ3NcbiAgICogYG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyB0aGUgY29uY3JldGUgbG9jazsgYW4gZW51bSBhbG9uZSBvciBhblxuICAgKiBleHRlcm5hbC9hdHRhY2hlZCBmcm9udCBkb29yIG5ldmVyIHNhdGlzZmllcyBpdC5cbiAgICovXG4gIExPQ0tFRCA9IFwibG9ja2VkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIHN0YXlzIGRpcmVjdGx5IHJlYWNoYWJsZSBhdCBpdHMgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kIGlzXG4gICAqIHNlcnZlZCBvbmx5IHRocm91Z2ggYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnQgZG9vciB0aGF0IGluamVjdHNcbiAgICogYGZyb250RG9vclZlcmlmaWNhdGlvbmAgb24gZXZlcnkgb3JpZ2luIHJlcXVlc3QuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIHBvc3R1cmUgZm9yIGFuIGFwcC1vd25lZCBkaXN0cmlidXRpb24gd2hvc2Ugb3JpZ2luIGlzIHRoZVxuICAgKiBleGVjdXRlLWFwaSBob3N0bmFtZTogdGhlIGNvbnN0cnVjdCBzZWVzIG5laXRoZXIgdGhlIGRpc3RyaWJ1dGlvbiBub3IgdGhlXG4gICAqIEFQSSdzIGVuZHBvaW50IGNvbmZpZ3VyYXRpb24sIHNvIGl0IGNhbm5vdCBwcm9kdWNlIGluLXN0YWNrIGV2aWRlbmNlIHRoZVxuICAgKiB3YXkgYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgZG8uIFZhbGlkIG9ubHkgaW4gYXR0YWNoIG1vZGUsIGFjY2VwdGVkIHdpdGhcbiAgICogYFJVTlRJTUVfQkVBUkVSYCBhbmQgYE5PTkVfUFVCTElDYCBsaWtlIHRoZSBvdGhlciBkZWNpc2lvbnMsIGFuZCBpdFxuICAgKiByZXF1aXJlcyB0aGUgbWFuZGF0b3J5IGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBgRlJPTlRFRGAgaXMgYSBkZWZlbnNlLWluLWRlcHRoIGRlY2xhcmF0aW9uIHdpdGggcnVudGltZSBlbmZvcmNlbWVudCwgbm90XG4gICAqIG11dHVhbC1UTFMgYXNzdXJhbmNlIGFuZCBub3Qgb3JpZ2luIHVucmVhY2hhYmlsaXR5LiBUaGUgZW5mb3JjZW1lbnQgaXMgdGhlXG4gICAqIHJ1bnRpbWUncyBmcm9udC1kb29yIGhlYWRlciBjaGVjayAoYG1jcGZhY2FkZS5GYWNhZGVDb25maWdgXG4gICAqIGBGcm9udERvb3JWZXJpZmljYXRpb25gIGluIEdvLCBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBpbiBUeXBlU2NyaXB0LFxuICAgKiBgZnJvbnRfZG9vcl92ZXJpZmljYXRpb25gIGluIFB5dGhvbik6IGl0IHJlZnVzZXMgZXZlcnkgZGVyaXZlZCByb3V0ZSB3aGVuXG4gICAqIHRoZSBkZWNsYXJlZCBoZWFkZXIgaXMgYWJzZW50IG9yIHdyb25nLCBhbmQgZmFpbHMgcmVnaXN0cmF0aW9uIHdoZW5cbiAgICogYEZST05URURgIGlzIGRlY2xhcmVkIHdpdGhvdXQgaXQuIEFuIHVud2lyZWQgcnVudGltZSBlbmZvcmNlcyBub3RoaW5nLlxuICAgKi9cbiAgRlJPTlRFRCA9IFwiZnJvbnRlZFwiLFxufVxuXG4vKipcbiAqIEZyb250LWRvb3IgdmVyaWZpY2F0aW9uIGZvciBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYC5cbiAqXG4gKiBBdHRhY2ggbW9kZSBtZWFucyB0aGUgZnJvbnQgZG9vciBpcyBhcHBsaWNhdGlvbi1vd25lZCwgc28gdGhlIGNvbnN0cnVjdFxuICogY2Fubm90IGluamVjdCB0aGUgaGVhZGVyIGl0c2VsZiBhbmQgY2Fubm90IG9ic2VydmUgdGhlIGRpc3RyaWJ1dGlvbi4gVGhlXG4gKiBkZWNsYXJhdGlvbiB0aGVyZWZvcmUgY2FycmllcyB0aHJlZSBpbmRlcGVuZGVudGx5IHdpcmVkIGNvcGllcyB0aGF0IG11c3QgY29tZVxuICogZnJvbSBvbmUgYXBwbGljYXRpb24tb3duZWQgY29uc3RhbnQ6IHRoaXMgcHJvcCwgdGhlIGRpc3RyaWJ1dGlvbidzIG9yaWdpblxuICogY3VzdG9tLWhlYWRlciBjb25maWd1cmF0aW9uLCBhbmQgdGhlIHJ1bnRpbWUncyBmcm9udC1kb29yIHZlcmlmaWNhdGlvblxuICogY29uZmlnLiBUaGUgY29uc3RydWN0IHByb3ZlcyBvbmx5IGl0cyBvd24gY29weSwgYW5kIHRoZSBsaXRlcmFsIHNlY3JldCBpc1xuICogY29uc3VtZWQgYXQgc3ludGhlc2lzIGZvciB2YWxpZGF0aW9uIGFuZCB0aGUgU0hBLTI1NiBkaWdlc3Qgb25seS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gcmVxdWVzdCBoZWFkZXIgdGhlIGZyb250IGRvb3IgaW5qZWN0cyBvbiBldmVyeSByZXF1ZXN0IGl0IHNlbmRzXG4gICAqIHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDEgdG8gNjQgY2hhcmFjdGVycyBvZiBgW0EtWmEtejAtOS1dYCwgYW5kIG5ldmVyIGEgcmVxdWVzdCBoZWFkZXIgdGhhdFxuICAgKiByZXdyaXRlcyB0aGUgb3JpZ2luIGNvbnRyYWN0IChgSG9zdGAsIGBBdXRob3JpemF0aW9uYCwgYENvb2tpZWAsXG4gICAqIGBDb250ZW50LUxlbmd0aGAsIGBUcmFuc2Zlci1FbmNvZGluZ2AsIGBDb25uZWN0aW9uYCwgYFdXVy1BdXRoZW50aWNhdGVgLFxuICAgKiBgWC1Gb3J3YXJkZWQtRm9yYCksIGFueSBgeC1hbXotKmAvYHgtYW16bi0qYC9gY2xvdWRmcm9udC0qYCBuYW1lLCBvciBhXG4gICAqIGhvcC1ieS1ob3AgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGhlYWRlck5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBmcm9udC1kb29yIGhlYWRlciB2YWx1ZS5cbiAgICpcbiAgICogMzIgdG8gMTI4IGNoYXJhY3RlcnMgb2YgYFtBLVphLXowLTkuX34tXWA6IGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXRcbiAgICogd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBubyBjb250cm9sIGNoYXJhY3RlcnMuIFRoZSB2YWx1ZSBpcyBjb25zdW1lZCBhdFxuICAgKiBzeW50aGVzaXMgZm9yIHZhbGlkYXRpb24gYW5kIHRoZSByZWNvcmRlZCBTSEEtMjU2IGRpZ2VzdCBvbmx5IOKAlCB0aGUgbGl0ZXJhbFxuICAgKiBuZXZlciBsYW5kcyBpbiB0aGUgc3ludGhlc2l6ZWQgdGVtcGxhdGUgb3IgaW4gQ2xvdWRGb3JtYXRpb24uIEl0IGlzIG5vdCBhXG4gICAqIGNyZWRlbnRpYWwgc3RvcmU7IHJvdGF0aW9uIG1lYW5zIGNoYW5naW5nIHRoZSB2YWx1ZSBhbmQgcmVkZXBsb3lpbmcsIGFuZCBpdFxuICAgKiBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBzZWNyZXQgdGhhdCBwcm90ZWN0cyBhbnl0aGluZyBlbHNlLlxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0VmFsdWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFzc2VydGlvbiB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeVxuICAgKiBkZXJpdmVkIHJvdXRlLlxuICAgKlxuICAgKiBUaGUgY29uc3RydWN0IGNhbm5vdCBhdHRhY2ggdGhhdCB2ZXJpZmljYXRpb24gdG8gYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnRcbiAgICogZG9vciBvciBhIHJ1bnRpbWUgaXQgZG9lcyBub3Qgb3duLCBzbyBpdCByZWZ1c2VzIHRvIHN5bnRoZXNpemUgdW50aWwgdGhlXG4gICAqIGNhbGxlciByZWNvcmRzIHRoYXQgdGhlIHZlcmlmaWNhdGlvbiBleGlzdHMuIE11c3QgYmUgYHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgYXNzZXJ0ZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMge1xuICAvKiogRGVuaWFsIG1ldHJpYyBuYW1lLiBNdXN0IGJlIGBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkYC4gQGRlZmF1bHQgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZCAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lPzogc3RyaW5nO1xuICAvKiogQm91bmRlZCBtZXRyaWMgZGltZW5zaW9ucy4gTXVzdCBiZSBleGFjdGx5IGBvdXRjb21lYCBhbmQgYHJvdXRlX2ZhbWlseWAuIEBkZWZhdWx0IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl0gKi9cbiAgcmVhZG9ubHkgZGltZW5zaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vKiogT3duaW5nLUFQSSBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucyB7XG4gIC8qKiBTdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdDogbnVtYmVyO1xuICAvKiogU3RhZ2UgYnVyc3QgbGltaXQuICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuLyoqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIGRlZmVuc2UtaW4tZGVwdGggZGVjaXNpb25zIChyZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMge1xuICAvKiogV2hldGhlciB0aGUgb3duaW5nIEFQSSdzIHN0YWdlIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLiBNdXN0IGJlIHRydWUuICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIC8qKiBUaGUgb3duaW5nIEFQSSdzIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmc6IEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zO1xufVxuXG4vKiogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgSFRUUFMgSldUIGlzc3VlciBVUkwuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBhdWRpZW5jZT86IHN0cmluZ1tdO1xuICAvKiogSWRlbnRpdHkgc291cmNlcyBmb3IgdGhlIEpXVCBhdXRob3JpemVyLiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gQGRlZmF1bHQgdGhlIGF1dGhvcml6ZXIgY29uc3RydWN0IGlkICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xufVxuXG4vKiogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlLCBgbWNwLmV4YW1wbGUuY29tYCkuICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlQXJuYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGFuIGF1dG9tYXRpY2FsbHkgY3JlYXRlZCBDTkFNRSByZWNvcmQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgdHJ1c3RzdG9yZSBmb3IgdGhlIG93bmVkIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFN1cHBseWluZyB0aGlzIGlzIHRoZSBjb25jcmV0ZSBgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRGBcbiAgICogZXZpZGVuY2U6IHRoZSBjb25zdHJ1Y3QgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kXG4gICAqIHJlcXVpcmVzIGV2ZXJ5IEFQSSBtYXBwaW5nIGJvdW5kIHRvIHRoZSBvd25lZCBBUEkgdG8gdGFyZ2V0IGEgZG9tYWluIHdob3NlXG4gICAqIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmUgVVJJLiBTdXBwbHlpbmcgaXQgd2l0aCBhbnlcbiAgICogb3RoZXIgb3JpZ2luIGRlY2lzaW9uLCBvciBzZWxlY3RpbmcgYExPQ0tFRGAgd2l0aG91dCBpdCwgZmFpbHMgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZWZlbnNpdmUgc25hcHNob3Qgb2YgdGhlIGNvbnN0cnVjdCdzIGRlcml2ZWQgZmFjYWRlIGludmVudG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcm91dGVzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZVtdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclByb3BzIHtcbiAgLyoqIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyB0aGUgcnVudGltZS1jb21wb3NlZCBNQ1AgZmFjYWRlLiAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBNQ1AgZmFjYWRlIGZhbWlsaWVzIHRoYXRcbiAgICogc2hhcmUgb25lIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeVxuICAgKiBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUm91dGUtZW1pc3Npb24gbW9kZWwuXG4gICAqXG4gICAqIGBleHBsaWNpdGAgKHRoZSBkZWZhdWx0KSB3aXJlcyB0aGUgZnVsbCBkZXJpdmVkIHJvdXRlIGludmVudG9yeSBhcyBvbmUgSFRUUFxuICAgKiBBUEkgdjIgcm91dGUgcGVyIHJvdXRlIGtleSBhbmQgaXMgYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy5cbiAgICogYGNvbnNvbGlkYXRlZGAgd2lyZXMgZXhhY3RseSB0d28gZ3JlZWR5IHJvdXRlcywgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gLFxuICAgKiBhbmQgaXMgdmFsaWQgb25seSBmb3IgdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0XG4gICAqIHBvc3R1cmVzOyBgaWFtYCBhbmQgYGp3dGAgYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzLlxuICAgKlxuICAgKiBDb25zb2xpZGF0ZWQgbW9kZSBpcyBhbGxvd2VkIG9uIGEgY29uc3RydWN0LW93bmVkIEFQSSwgb3Igb24gYW4gYXR0YWNoZWRcbiAgICogQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZS4gXCJObyByb3V0ZXNcIiBpcyBlbmZvcmNlZCBvdmVyIHRoZVxuICAgKiB3aG9sZSBzdGFjaywgbm90IGp1c3QgdGhlIEFQSSdzIG93biBjaGlsZHJlbjogYSByb3V0ZSB3aXJlZCBvbnRvIHRoZVxuICAgKiBhdHRhY2hlZCBBUEkgZnJvbSBhbnkgc2libGluZyBjb25zdHJ1Y3Qgc2NvcGUgaXMgcmVmdXNlZCwgYmVjYXVzZSBpdCBob2xkc1xuICAgKiBhIHJvdXRlIGtleSB0aGUgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGguXG4gICAqXG4gICAqIEEgY29uc3VtZXIgbWF5IHN0aWxsIGFkZCBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgdG8gdGhlIGNvbnNvbGlkYXRlZFxuICAgKiBBUEkgYWZ0ZXJ3YXJkcywgaW4gZWl0aGVyIHRoZSBhdHRhY2hlZCBvciB0aGUgY29uc3RydWN0LW93bmVkIG1vZGUuIFRoYXRcbiAgICogZXhjZXB0aW9uIGlzIGVuZm9yY2VkIGF0IHN5bnRoZXNpcyB0aW1lIGFuZCBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGUgYWRkZWRcbiAgICogcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSB0aGUgZ3JlZWR5XG4gICAqIGBBTlkgL2Agb3IgYEFOWSAve3Byb3h5K31gIGtleS4gV2l0aGluIGl0LCBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggYmVhdHMgdGhlXG4gICAqIGdyZWVkeSByb3V0ZXMgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSwgYW5kIGEgd3JvbmctbWV0aG9kIGhpdCBvbiBzdWNoIGFcbiAgICogcGF0aCBmYWxscyB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkIDQwNC80MDUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlTW9kZWw/OiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsO1xuXG4gIC8qKlxuICAgKiBDb25zdHJ1Y3QtaWQgZGVyaXZhdGlvbiBmb3IgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsLlxuICAgKlxuICAgKiBgbGVnYWN5YCAodGhlIGRlZmF1bHQpIGFzc2lnbnMgcG9zaXRpb25hbCBpZHMgaW4gZW1pc3Npb24gb3JkZXIgYW5kIGlzXG4gICAqIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuIGBzZW1hbnRpY2AgZGVyaXZlcyBlYWNoIGlkIGZyb20gaXRzIHJvdXRlXG4gICAqIG1ldGhvZCBhbmQgcGF0dGVybiwgc28gaW5zZXJ0aW5nLCByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhIHJvdXRlIGZhbWlseVxuICAgKiBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZTsgaXQgaXMgaW50ZW5kZWQgZm9yIG5ld2x5IGNyZWF0ZWQgZXhwbGljaXRcbiAgICogQVBJcy5cbiAgICpcbiAgICogU3dpdGNoaW5nIGFuIGV4aXN0aW5nIGRlcGxveWVkIGV4cGxpY2l0IEFQSSBmcm9tIGBsZWdhY3lgIHRvIGBzZW1hbnRpY2AgaW5cbiAgICogcGxhY2UgcmVuYW1lcyBldmVyeSByb3V0ZSBpbiBvbmUgdXBkYXRlLCB3aGljaCBpcyBleGFjdGx5IHRoZVxuICAgKiBjcmVhdGUtYmVmb3JlLWRlbGV0ZSByb3V0ZS1rZXkgY29sbGlzaW9uIHRoZSBtaWdyYXRpb24gY2hlY2sgcmVmdXNlcy4gQWRvcHRcbiAgICogYHNlbWFudGljYCBvbiBhbiBleGlzdGluZyBzdGFjayBvbmx5IHRocm91Z2ggdGhlIG5ldy1BUEkgc3dhcCBkb2N1bWVudGVkIGluXG4gICAqIGBVUEdSQURJTkcubWRgLlxuICAgKlxuICAgKiBUaGlzIHByb3AgYXBwbGllcyB0byBgcm91dGVNb2RlbDogZXhwbGljaXRgIG9ubHkuIFRoZSBgY29uc29saWRhdGVkYCBtb2RlbFxuICAgKiBhbHJlYWR5IGVtaXRzIHRoZSB0d28gZml4ZWQgc2VtYW50aWMgaWRzIGBSb3V0ZUFueVJvb3RgIGFuZCBgUm91dGVBbnlQcm94eWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVJZE1vZGU/OiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZTtcblxuICAvKipcbiAgICogQ09SUyBwcmVmbGlnaHQgZm9yIGEgY29uc3RydWN0LW93bmVkIEFQSS4gU2V0IHRvIGB0cnVlYCBmb3IgQXBwVGhlb3J5XG4gICAqIGRlZmF1bHRzIG9yIHN1cHBseSBhbiBgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zYCBvYmplY3QuIEludmFsaWQgaW5cbiAgICogYXR0YWNoIG1vZGUsIHdoZXJlIHRoZSBvd25pbmcgQVBJIGNvbmZpZ3VyZXMgQ09SUy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogU3RhZ2UgbmFtZSB1c2VkIHdoZW4gZGVyaXZpbmcgYXR0YWNoLW1vZGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgdGVtcGxhdGVzLlxuICAgKiBVc2UgYCRkZWZhdWx0YCBmb3IgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHQgc3RhZ2UuIFdoZW4gb21pdHRlZCwgdGhlIHN0YWdlXG4gICAqIGlzIG5vdCBkZXRlcm1pbmFibGUgYW5kIHRoZSB0ZW1wbGF0ZXMgcmV0YWluIHRoZSBiYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbi5cbiAgICogVGhpcyBwcm9wIGRvZXMgbm90IGNyZWF0ZSwgaW1wb3J0LCBvciBtdXRhdGUgYSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdHRhY2hlZEFwaVN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBBbiBleHBsaWNpdCBzZWxlY3Rpb24gb3ZlcnJpZGVzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuIFdoZW4gaXQgaXNcbiAgICogb21pdHRlZCwgYSBzZXJ2ZXIgdGhhdCBhdHRhY2hlcyBgZmFjYWRlYCByZXNvbHZlcyB0byBgcnVudGltZS1iZWFyZXJgIGFuZCBhXG4gICAqIHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXIgcmVzb2x2ZXMgdG8gYGlhbWAuIGBub25lLXB1YmxpY2AgaXMgbmV2ZXIgYSBkZWZhdWx0XG4gICAqIGFuZCBjYXJyaWVzIHRoZSBkZWZlbnNlLWluLWRlcHRoIGZsb29yLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSIHdoZW4gYGZhY2FkZWAgaXMgYXR0YWNoZWQsIG90aGVyd2lzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZT86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG5cbiAgLyoqXG4gICAqIFVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBtYXJrcyB0aGlzIHNlcnZlciBhcyBmYWNhZGUtY29uZmlndXJlZC5cbiAgICpcbiAgICogVGhlIGF0dGFjaG1lbnQncyBwcmVzZW5jZSBzZWxlY3RzIHRoZSBgcnVudGltZS1iZWFyZXJgIHBvc3R1cmUgZGVmYXVsdC5cbiAgICogUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudDtcblxuICAvKipcbiAgICogUnVudGltZS1zaWRlIFJGQyA5NzI4IGJlYXJlciB2YWxpZGF0aW9uIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZCBieSBgdHJhbnNwb3J0UG9zdHVyZTogUlVOVElNRV9CRUFSRVJgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5XG4gICAqIG90aGVyIHBvc3R1cmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBvc3R1cmU/OiBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZFxuICAgKiBOT05FX1BVQkxJQy4gQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIGlzIHJlZnVzZWQgdW5sZXNzIGl0IGlzIGRlY2xhcmVkXG4gICAqIGBGUk9OVEVEYCwgd2hpY2ggcmVxdWlyZXMgYGZyb250RG9vclZlcmlmaWNhdGlvbmAuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5PzogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5O1xuXG4gIC8qKlxuICAgKiBGcm9udC1kb29yIHZlcmlmaWNhdGlvbiBkZWNsYXJhdGlvbiwgcmVxdWlyZWQgd2l0aFxuICAgKiBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYCBhbmQgcmVmdXNlZCB1bmRlciBldmVyeSBvdGhlciBkZWNpc2lvbi5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCByZWNvcmRzIHRoZSBwb3N0dXJlLCB0aGUgaGVhZGVyIG5hbWUsIGFuZCBhIFNIQS0yNTYgZGlnZXN0IG9mXG4gICAqIHRoZSBkZWNsYXJlZCBzZWNyZXQgaW4gdGhlIGBhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlYCBtZXRhZGF0YTsgaXRcbiAgICogbmV2ZXIgZW1pdHMgdGhlIGxpdGVyYWwgc2VjcmV0LiBFbmZvcmNlbWVudCBpcyB0aGUgcnVudGltZSdzIGZyb250LWRvb3JcbiAgICogaGVhZGVyIGNoZWNrLCBzbyBhbiB1bndpcmVkIHJ1bnRpbWUgZW5mb3JjZXMgbm90aGluZy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmcm9udERvb3JWZXJpZmljYXRpb24/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIG9ubHkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVuaWFsU2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucztcblxuICAvKipcbiAgICogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgdGhyb3R0bGluZyBhbmQgYWNjZXNzLWxvZ2dpbmdcbiAgICogZGVjaXNpb25zLCByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmQgTk9ORV9QVUJMSUMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3duaW5nQXBpRGVmZW5zZT86IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICpcbiAgICogVHJhbnNwb3J0IHJvdXRlcyBhcmUgdGhlIFBPU1QsIEdFVCwgYW5kIERFTEVURSByb3V0ZXMgb24gZXZlcnkgTUNQIHBhdHRlcm4uXG4gICAqIFRoaXMgcHJvcCBpcyBvbmx5IHZhbGlkIHdpdGggYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAsIHdoaWNoIHJlcXVpcmVzIGFuXG4gICAqIGlzc3VlciBhbmQgYSBub24tZW1wdHkgYXVkaWVuY2UuIERpc2NvdmVyeSwgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhLFxuICAgKiBhdXRob3JpemUsIGFuZCB0b2tlbiByb3V0ZXMgcmVtYWluIGV4cGxpY2l0bHkgcHVibGljIChgTk9ORWApIGJlY2F1c2UgT0F1dGhcbiAgICogY2xpZW50cyBtdXN0IGZldGNoIHRoZW0gYmVmb3JlIHRoZXkgaG9sZCBhIHRva2VuLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydEF1dGhvcml6ZXI/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UtZ2xvYmFsIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrIHBhdGguXG4gICAqXG4gICAqIFRoZSBDREstbW91bnRlZCBjYWxsYmFjayByb3V0ZSBhbmQgdGhlIHJ1bnRpbWUtcmVnaXN0ZXJlZCBvbmUgbXVzdCBub3RcbiAgICogZGl2ZXJnZTogdGhpcyBwcm9wIGlzIHJlc29sdmVkIGJ5XG4gICAqIGBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGhgLCB0aGUgc2FtZSBhbGdlYnJhXG4gICAqIHRoZSBydW50aW1lIGFwcGxpZXMgdG8gYEZhY2FkZUNvbmZpZy5VcHN0cmVhbUNhbGxiYWNrUGF0aGAuIFN1cHBseSBhXG4gICAqIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHF1ZXJ5LCBmcmFnbWVudCwgb3IgZG90XG4gICAqIHNlZ21lbnQ7IGFuIGVtcHR5IHZhbHVlIGtlZXBzIHRoZSBjb250cmFjdCBkZWZhdWx0LCBhbmQgYSB2YWx1ZSB0aGF0XG4gICAqIGNvbGxpZGVzIHdpdGggYW5vdGhlciBkZXJpdmVkIHJvdXRlIGZhaWxzIHN5bnRoZXNpcy4gUmVmdXNlZCB1bmRlclxuICAgKiBgdHJhbnNwb3J0UG9zdHVyZTogbm9uZS1wdWJsaWNgLCB3aGljaCBhdHRhY2hlcyBubyBPQXV0aCBzdXJmYWNlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIXG4gICAqL1xuICByZWFkb25seSB1cHN0cmVhbUNhbGxiYWNrUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogU2Vzc2lvbi1zdGF0ZSB0YWJsZSBjb25maWd1cmF0aW9uLiBUaGUgdGFibGUgZGVmYXVsdHMgb24uXG4gICAqIEBkZWZhdWx0IGVuYWJsZWQgd2l0aCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uU3RhdGU/OiBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPd25lZC1BUEkgY29uZmlndXJhdGlvbiBmb3Igc3RhbmRhbG9uZSBtb2RlLiBJbnZhbGlkIHdpdGggYGFwaWAuXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24tb3duZWQgQVBJIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBvd25lZEFwaT86IEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucztcblxuICAvKipcbiAgICogU2luZ2xlIE1DUCByb3V0ZSBwYXRoIGZyb20gdGhlIHYzLjEueCBBNiBzdXJmYWNlLlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHJvdXRlRmFtaWx5LnBhdHRlcm5zYC4gVGhlIG5ldyBkZWZhdWx0IGlzIHRoZSBjYW5vbmljYWxcbiAgICogZm91ci1wYXR0ZXJuIGZhbWlseTsgdXNlIGB7IHBhdHRlcm5zOiBbJy9tY3AnXSB9YCBmb3IgdGhlIG9sZCBzaW5nbGV0b24uXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBdXRob3JpemF0aW9uLXNlcnZlciBpc3N1ZXIgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5Jc3N1ZXJVUkxgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBpc3N1ZXIgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcj86IHN0cmluZztcblxuICAvKipcbiAgICogSldLUyBVUkkgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5KV0tTVVJJYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgSldLUyBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBqd2tzVXJpPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmFwaU5hbWVgLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS5lbmFibGVkYC4gU2Vzc2lvbiBzdGF0ZSBub3cgZGVmYXVsdHMgb24uXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50YWJsZU5hbWVgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50dGxNaW51dGVzYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuZG9tYWluYC4gRG9tYWlucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuc3RhZ2VgLiBTdGFnZSBvcHRpb25zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogQ29udHJhY3QtZmlyc3QgTUNQIGZhY2FkZSBkZXBsb3ltZW50IGNvbnN0cnVjdC5cbiAqXG4gKiBUaGUgcHJpbWFyeSBtb2RlIGF0dGFjaGVzIHRoZSBjb21wbGV0ZSByb3V0ZS1hbGdlYnJhIGZhbWlseSB0byBhIHN1cHBsaWVkXG4gKiBIVFRQIEFQSS4gT21pdHRpbmcgYGFwaWAgc3BlY2lhbGl6ZXMgdGhlIHNhbWUgcGF0aCBpbnRvIGEgc3RhbmRhbG9uZSBvd25lZFxuICogQVBJLiBUaGUgY29uc3RydWN0IHJvdXRlcyBvbmx5OiBPQXV0aCBtZXRhZGF0YSwgc2NvcGVzLCBjYXBhYmlsaXRpZXMsIGFuZFxuICogYXV0aG9yaXplL3Rva2VuIGJlaGF2aW9yIHJlbWFpbiBhcHBsaWNhdGlvbi1vd25lZCB0aHJvdWdoIEdvXG4gKiBgbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHByaXZhdGUgcm91dGVTZXF1ZW5jZSA9IDA7XG4gIHByaXZhdGUgcm91dGVJZE1vZGUgPSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1k7XG4gIHByaXZhdGUgcmVhZG9ubHkgcm91dGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLklIdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIC8qKlxuICAgKiBSZXNvbHZlZCB0cmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBGYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXJzIHJlc29sdmUgdG8gYHJ1bnRpbWUtYmVhcmVyYCB1bmxlc3NcbiAgICogYHRyYW5zcG9ydFBvc3R1cmVgIG92ZXJyaWRlcyB0aGUgZGVmYXVsdDsgcGxhaW4gdHJhbnNwb3J0IHNlcnZlcnMgcmVzb2x2ZVxuICAgKiB0byBgaWFtYC4gRGVsaWJlcmF0ZWx5IHB1YmxpYyBzZXJ2ZXJzIG11c3Qgc2VsZWN0IGBub25lLXB1YmxpY2AgZXhwbGljaXRseS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuICAvKipcbiAgICogRGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZXMgZm9yIHRoZSBvcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIHRoZXNlIGFyZSBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGVzLCBub3QgZGVjbGFyYXRpb25zIG9mXG4gICAqIHB1YmxpYyBhdXRob3JpdHkuIEFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZDsgdGhlIG9yaWdpbiBpcyBkZXJpdmVkXG4gICAqIGZyb20gYGFwaUlkYCwgdGhlIHN0YWNrIHJlZ2lvbiBhbmQgVVJMIHN1ZmZpeCwgcGx1c1xuICAgKiBgYXR0YWNoZWRBcGlTdGFnZU5hbWVgIHdoZW4gc3VwcGxpZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnRzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnk7XG5cbiAgLyoqXG4gICAqIEZpcnN0IGRlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGUuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIGFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZC4gVGhpcyB2YWx1ZSBpcyBhblxuICAgKiBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGUgZGVyaXZlZCBieSB0aGUgc2FtZSBydWxlcyBhcyBgZW5kcG9pbnRzYCwgbm90XG4gICAqIHRoZSBmcm9udCBkb29yJ3MgcHVibGljIGF1dGhvcml0eS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBlbmRwb2ludHNgLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgbWNwUGF0aHNgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc2Agb3IgYHJvdXRlSW52ZW50b3J5YC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzKTtcbiAgICBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCByb3V0ZUZhbWlseSA9IG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzKTtcbiAgICBjb25zdCBvd25lZE9wdGlvbnMgPSBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHMpO1xuXG4gICAgY29uc3QgcG9zdHVyZSA9IHByb3BzLnRyYW5zcG9ydFBvc3R1cmVcbiAgICAgID8/IChwcm9wcy5mYWNhZGUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAgICAgOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSk7XG4gICAgdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChwcm9wcy5mYWNhZGUpO1xuICAgIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhwcm9wcywgcm91dGVGYW1pbHksIHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgocHJvcHMsIHBvc3R1cmUsIG93bmVkT3B0aW9ucyk7XG4gICAgY29uc3Qgb3JpZ2luUmVhY2hhYmlsaXR5ID0gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eSh0aGlzLCBwcm9wcywgb3duZWRPcHRpb25zKTtcbiAgICBjb25zdCByb3V0ZU1vZGVsID0gcmVzb2x2ZVJvdXRlTW9kZWwocHJvcHMpO1xuICAgIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUocm91dGVNb2RlbCwgcG9zdHVyZSk7XG4gICAgY29uc3Qgcm91dGVJZE1vZGUgPSByZXNvbHZlUm91dGVJZE1vZGUocHJvcHMpO1xuICAgIHRoaXMucm91dGVJZE1vZGUgPSByb3V0ZUlkTW9kZTtcbiAgICBpZiAocm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURUQgJiYgcHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFzc2VydENvbnNvbGlkYXRlZEF0dGFjaEFsbG93ZWQodGhpcywgcHJvcHMuYXBpKTtcbiAgICB9XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkID0gcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQztcbiAgICBjb25zdCB1cHN0cmVhbUNhbGxiYWNrUGF0aCA9IHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wcyk7XG5cbiAgICB0aGlzLnRyYW5zcG9ydFBvc3R1cmUgPSBwb3N0dXJlO1xuICAgIHRoaXMubWNwUGF0aHMgPSBbLi4ucm91dGVGYW1pbHkucGF0dGVybnNdO1xuICAgIHRoaXMucm91dGVJbnZlbnRvcnkgPSBidWlsZFJvdXRlSW52ZW50b3J5KFxuICAgICAgdGhpcy5tY3BQYXRocyxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICAgIHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5LFxuICAgICAgdXBzdHJlYW1DYWxsYmFja1BhdGgsXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgbGV0IG93bmVkU3RhZ2U6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBvd25lZFN0YWdlTmFtZSA9IFwiJGRlZmF1bHRcIjtcbiAgICBpZiAocHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFwaSA9IHByb3BzLmFwaTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3RhZ2VPcHRpb25zID0gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG93bmVkT3B0aW9ucy5zdGFnZSk7XG4gICAgICBvd25lZFN0YWdlTmFtZSA9IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWU7XG4gICAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgYXBpTmFtZTogb3duZWRPcHRpb25zLmFwaU5hbWUsXG4gICAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAgICAgICA/IHRydWVcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuICAgICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24odGhpcywgYXBpKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IGFwaSxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdFbmFibGVkXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgb3duZWRTdGFnZSA9IHN0YWdlO1xuXG4gICAgICBpZiAoc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ1JldGVudGlvbixcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IGFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgXCJNY3BIYW5kbGVyXCIsXG4gICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSxcbiAgICApO1xuICAgIGNvbnN0IHRyYW5zcG9ydEF1dGhvcml6ZXIgPSByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihwcm9wcywgcG9zdHVyZSk7XG4gICAgbGV0IGZpcnN0VHJhbnNwb3J0Um91dGU6IGFwaWd3djIuSHR0cFJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCkge1xuICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9ST09UX1JPVVRFX0lELFxuICAgICAgICBcIi9cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgcHJveHlSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9QUk9YWV9ST1VURV9JRCxcbiAgICAgICAgXCIve3Byb3h5K31cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgcmVnaXN0ZXJDb25zb2xpZGF0ZWRBdHRhY2hWYWxpZGF0aW9uKHRoaXMsIHRoaXMuYXBpLCBbZmlyc3RUcmFuc3BvcnRSb3V0ZSwgcHJveHlSb3V0ZV0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzKSB7XG4gICAgICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIHtcbiAgICAgICAgICBjb25zdCBjcmVhdGVkID0gdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgICByb3V0ZS5tY3BQYXR0ZXJuLFxuICAgICAgICAgICAgdG9IdHRwTWV0aG9kKG1ldGhvZCksXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gZmlyc3RUcmFuc3BvcnRSb3V0ZSA/PyBjcmVhdGVkO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5kaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS50b2tlblBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucmVnaXN0ZXJQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBUaGUgdXBzdHJlYW0gY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBub3QgcGVyIGtpbmQ6IHdpcmUgaXQgZXhhY3RseSBvbmNlLlxuICAgICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuLFxuICAgICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwb3N0dXJlTWFya2VyVGFyZ2V0ID0gKHRoaXMub3duZWRBcGk/Lm5vZGUuZGVmYXVsdENoaWxkXG4gICAgICA/PyBmaXJzdFRyYW5zcG9ydFJvdXRlPy5ub2RlLmRlZmF1bHRDaGlsZCkgYXMgYXBpZ3d2Mi5DZm5BcGkgfCBhcGlnd3YyLkNmblJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIHBvc3R1cmVNYXJrZXJUYXJnZXQ/LmFkZE1ldGFkYXRhKE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVksIHtcbiAgICAgIHBvc3R1cmUsXG4gICAgICBjb250cmFjdF9pZDogTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lELFxuICAgICAgcm91dGVfY291bnQ6IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLmxlbmd0aCxcbiAgICAgIHJ1bnRpbWVfcG9zdHVyZV9kZWNsYXJlZDogcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCxcbiAgICAgIC8vIE9ubHkgYSBGUk9OVEVEIGRlY2lzaW9uIGV4dGVuZHMgdGhlIG1hcmtlciwgc28gRElTQUJMRUQgYW5kIExPQ0tFRFxuICAgICAgLy8gdGVtcGxhdGVzIHN0YXkgYnl0ZS1pZGVudGljYWwuIFRoZSBsaXRlcmFsIHNlY3JldCBpcyBjb25zdW1lZCBoZXJlIGZvclxuICAgICAgLy8gaXRzIGRpZ2VzdCBhbmQgbmV2ZXIgZW1pdHRlZC5cbiAgICAgIC4uLihvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICAgICAgID8gZnJvbnREb29yUG9zdHVyZU1ldGFkYXRhKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbilcbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHMpO1xuICAgIGlmIChzZXNzaW9uU3RhdGUuZW5hYmxlZCkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHNlc3Npb25TdGF0ZS50YWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBzZXNzaW9uU3RhdGUucmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHsgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHNlc3Npb25TdGF0ZS50dGxNaW51dGVzKSk7XG4gICAgfVxuXG4gICAgbGV0IGVuZHBvaW50QmFzZTogc3RyaW5nO1xuICAgIGlmIChvd25lZE9wdGlvbnMuZG9tYWluKSB7XG4gICAgICBpZiAoIW93bmVkU3RhZ2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkb21haW4gY29uZmlndXJhdGlvbiByZXF1aXJlcyBjb25zdHJ1Y3Qtb3duZWQgQVBJIG1vZGVcIik7XG4gICAgICB9XG4gICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKG93bmVkT3B0aW9ucy5kb21haW4sIG93bmVkU3RhZ2UpO1xuICAgICAgaWYgKFxuICAgICAgICBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAgICAgJiYgdGhpcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkXG4gICAgICApIHtcbiAgICAgICAgcmVnaXN0ZXJPd25lZExvY2tlZE9yaWdpblZhbGlkYXRpb24odGhpcywgdGhpcy5vd25lZEFwaSk7XG4gICAgICB9XG4gICAgICBlbmRwb2ludEJhc2UgPSBgaHR0cHM6Ly8ke293bmVkT3B0aW9ucy5kb21haW4uZG9tYWluTmFtZX1gO1xuICAgIH0gZWxzZSBpZiAocHJvcHMuYXBpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgICAgY29uc3QgZXhlY3V0ZUFwaU9yaWdpbiA9IGBodHRwczovLyR7dGhpcy5hcGkuYXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH1gO1xuICAgICAgZW5kcG9pbnRCYXNlID0gcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gZXhlY3V0ZUFwaU9yaWdpblxuICAgICAgICA6IGAke2V4ZWN1dGVBcGlPcmlnaW59LyR7cHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWV9YDtcbiAgICB9IGVsc2Uge1xuICAgICAgZW5kcG9pbnRCYXNlID0gb3duZWRTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7b3duZWRTdGFnZU5hbWV9YDtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludHMgPSB0aGlzLm1jcFBhdGhzLm1hcChcbiAgICAgIChwYXR0ZXJuKSA9PiBgJHtzdHJpcFRyYWlsaW5nU2xhc2goZW5kcG9pbnRCYXNlKX0ke3BhdHRlcm59YCxcbiAgICApO1xuICAgIGlmIChcbiAgICAgIHByb3BzLmFwaSA9PT0gdW5kZWZpbmVkXG4gICAgICAmJiAob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAgICAgfHwgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEKVxuICAgICAgJiYgdGhpcy5lbmRwb2ludHMuc29tZSgoZW5kcG9pbnQpID0+IGVuZHBvaW50LmluY2x1ZGVzKFwiLmV4ZWN1dGUtYXBpLlwiKSlcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBtdXN0IGFkdmVydGlzZSB0aGUgb3duZWQgY3VzdG9tIGRvbWFpbiwgbmV2ZXIgdGhlIGRpc2FibGVkIGV4ZWN1dGUtYXBpIGVuZHBvaW50XCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmVuZHBvaW50ID0gdGhpcy5lbmRwb2ludHNbMF07XG4gIH1cblxuICBwcml2YXRlIGFkZFJ1bnRpbWVSb3V0ZShcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsXG4gICAgaW50ZWdyYXRpb246IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uLFxuICAgIGF1dGhvcml6ZXI6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIsXG4gICk6IGFwaWd3djIuSHR0cFJvdXRlIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHRoaXMubmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kLCBwYXRoKSwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBtZXRob2QpLFxuICAgICAgaW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBuZXh0Um91dGVDb25zdHJ1Y3RJZChtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCwgcGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5yb3V0ZUlkTW9kZSAhPT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuU0VNQU5USUMpIHtcbiAgICAgIHJldHVybiBgUm91dGUke3RoaXMucm91dGVTZXF1ZW5jZSsrfWA7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCk7XG4gICAgaWYgKHRoaXMucm91dGVJZHMuaGFzKGlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUlkTW9kZSBzZW1hbnRpYyBkZXJpdmVzIHRoZSBkdXBsaWNhdGUgcm91dGUgY29uc3RydWN0IGlkICR7aWR9IGZvciByb3V0ZSBrZXkgJHttZXRob2R9ICR7cGF0aH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5yb3V0ZUlkcy5hZGQoaWQpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIHByaXZhdGUgYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgaW50ZWdyYXRpb246IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uLFxuICAgIGF1dGhvcml6ZXI6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIsXG4gICk6IGFwaWd3djIuSHR0cFJvdXRlIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIGlkLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIGFwaWd3djIuSHR0cE1ldGhvZC5BTlkpLFxuICAgICAgaW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oXG4gICAgb3B0aW9uczogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyxcbiAgICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gb3B0aW9ucy5jZXJ0aWZpY2F0ZSA/PyAob3B0aW9ucy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGVcbiAgICAgIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBkb21haW5OYW1lID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgICBtdGxzOiBvcHRpb25zLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZSB9KS5kb21haW5OYW1lID0gZG9tYWluTmFtZTtcbiAgICBjb25zdCBhcGlNYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBzdGFnZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmcgfSkuYXBpTWFwcGluZyA9IGFwaU1hcHBpbmc7XG4gICAgaWYgKG9wdGlvbnMuaG9zdGVkWm9uZSkge1xuICAgICAgY29uc3QgY25hbWVSZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNuYW1lUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiB0b1JvdXRlNTNSZWNvcmROYW1lKG9wdGlvbnMuZG9tYWluTmFtZSwgb3B0aW9ucy5ob3N0ZWRab25lKSxcbiAgICAgICAgZG9tYWluTmFtZTogZG9tYWluTmFtZS5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gY25hbWVSZWNvcmQ7XG4gICAgfVxuICB9XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICByZWFkb25seSBlbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgaWYgKHByb3BzLnJvdXRlRmFtaWx5ICE9PSB1bmRlZmluZWQgJiYgcHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5IGFuZCBkZXByZWNhdGVkIG1jcFBhdGggY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXdQYXR0ZXJucyA9IHByb3BzLnJvdXRlRmFtaWx5Py5wYXR0ZXJuc1xuICAgID8/IChwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWRcbiAgICAgID8gW3Byb3BzLm1jcFBhdGhdXG4gICAgICA6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpLm1hcChcbiAgICAgICAgKHRlbXBsYXRlKSA9PiB0ZW1wbGF0ZS5tY3BQYXR0ZXJuLFxuICAgICAgKSk7XG4gIGlmIChyYXdQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICB9XG4gIGNvbnN0IHBhdHRlcm5zID0gcmF3UGF0dGVybnMubWFwKChwYXR0ZXJuLCBpbmRleCkgPT5cbiAgICBub3JtYWxpemVSb3V0ZVBhdGgocGF0dGVybiwgYHJvdXRlRmFtaWx5LnBhdHRlcm5zWyR7aW5kZXh9XWApKTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBpZiAoc2Vlbi5oYXMocGF0dGVybikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgY29udGFpbnMgZHVwbGljYXRlIHBhdHRlcm4gJHtKU09OLnN0cmluZ2lmeShwYXR0ZXJuKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQocGF0dGVybik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwYXR0ZXJucyxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTpcbiAgICAgIHByb3BzLnJvdXRlRmFtaWx5Py5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSA/PyBmYWxzZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUm91dGVQYXRoKHZhbHVlOiBzdHJpbmcsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdHRlcm5gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpO1xuICBpZiAoIXJvdXRlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSkgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIGNvbnN0IHNlZ21lbnRzID0gcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKTtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMCB8fCBzZWdtZW50cy5zb21lKChzZWdtZW50KSA9PiBzZWdtZW50ID09PSBcIlwiKSkge1xuICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICB9XG4gIGNvbnN0IGxpdGVyYWwgPSAvXig/OltBLVphLXowLTkuX34hJCYnKCkqKyw7PTpALV18JVswLTlBLUZhLWZdezJ9KSskLztcbiAgY29uc3QgcGFyYW1ldGVyID0gL15cXHsoW0EtWmEtel9dW0EtWmEtejAtOV9dKilcXH0kLztcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgaWYgKHBhcmFtZXRlci50ZXN0KHNlZ21lbnQpKSBjb250aW51ZTtcbiAgICBpZiAoIWxpdGVyYWwudGVzdChzZWdtZW50KSB8fCBzZWdtZW50LmluY2x1ZGVzKFwie1wiKSB8fCBzZWdtZW50LmluY2x1ZGVzKFwifVwiKSkge1xuICAgICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWU6IHN0cmluZyk6IEVycm9yIHtcbiAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGFuIGFic29sdXRlIHN5bnRoZXNpcy10aW1lIHJvdXRlIHBhdHRlcm4gd2l0aCBub24tZW1wdHkgbGl0ZXJhbCBvciB7cGFyYW1ldGVyX25hbWV9IHNlZ21lbnRzIGFuZCBubyBkb3Qgc2VnbWVudHNgLFxuICApO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlVXBzdHJlYW1DYWxsYmFja1BhdGgocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogc3RyaW5nIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEg7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChjb25maWd1cmVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXRoXCIsXG4gICAgKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGgoY29uZmlndXJlZCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICA/IGVyci5tZXNzYWdlLnJlcGxhY2UoL15tY3Byb3V0ZXM6IC8sIFwiXCIpXG4gICAgICA6IFN0cmluZyhlcnIpO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIGlzIGludmFsaWQ6ICR7cmVhc29ufWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBidWlsZFJvdXRlSW52ZW50b3J5KFxuICBwYXR0ZXJuczogc3RyaW5nW10sXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbiAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbixcbiAgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmcsXG4pOiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJldHVybiB7XG4gICAgY29udHJhY3RWZXJzaW9uOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQ09OVFJBQ1RfVkVSU0lPTixcbiAgICByb3V0ZXM6IHBhdHRlcm5zLm1hcCgobWNwUGF0dGVybikgPT4gKHtcbiAgICAgIG1jcFBhdHRlcm4sXG4gICAgICBtY3BNZXRob2RzOiBbXCJQT1NUXCIsIFwiR0VUXCIsIFwiREVMRVRFXCJdLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgZGlzY292ZXJ5U3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgdG9rZW5QYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHJlZ2lzdGVyUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25SZWdpc3RlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgfSkpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjpcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcIi9cIiksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCxcbiAgICBjYWxsYmFja1BhdHRlcm4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkoXG4gIGludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnksXG4gIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbixcbik6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGFkZCA9IChtZXRob2Q6IHN0cmluZywgcGF0aDogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7bWV0aG9kfSAke3BhdGh9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlcml2ZWQgcm91dGUgZmFtaWx5IGNvbGxpZGVzIGF0ICR7a2V5fWApO1xuICAgIH1cbiAgICBzZWVuLmFkZChrZXkpO1xuICB9O1xuICBmb3IgKGNvbnN0IHJvdXRlIG9mIGludmVudG9yeS5yb3V0ZXMpIHtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSBhZGQobWV0aG9kLCByb3V0ZS5tY3BQYXR0ZXJuKTtcbiAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuKTtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5hdXRob3JpemVQYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUudG9rZW5QYXR0ZXJuKTtcbiAgICAgIGFkZChcIlBPU1RcIiwgcm91dGUucmVnaXN0ZXJQYXR0ZXJuKTtcbiAgICB9XG4gIH1cbiAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuKTtcbiAgfVxuICBpZiAoaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybik7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBpZiAoIXByb3BzLmFwaSkge1xuICAgIGlmIChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSByZXF1aXJlcyBhdHRhY2ggbW9kZSB3aXRoIGFwaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgJiYgKFRva2VuLmlzVW5yZXNvbHZlZChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSlcbiAgICAgIHx8ICEvXig/OlxcJGRlZmF1bHR8W0EtWmEtejAtOV8tXXsxLDEyOH0pJC8udGVzdChwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSkpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2hlZEFwaVN0YWdlTmFtZSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBBUEkgR2F0ZXdheSBzdGFnZSBuYW1lXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAocHJvcHMub3duZWRBcGkgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwib3duZWRBcGlcIik7XG4gIGlmIChwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImFwaU5hbWVcIik7XG4gIGlmIChwcm9wcy5jb3JzICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImNvcnNcIik7XG4gIGlmIChwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiZG9tYWluXCIpO1xuICBpZiAocHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwic3RhZ2VcIik7XG4gIGlmIChpbnZhbGlkLmxlbmd0aCAhPT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaCBtb2RlIHdpdGggYXBpIGNhbm5vdCBjb25maWd1cmUgb3duZWQtQVBJIHByb3BzOiAke2ludmFsaWQuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyB7XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5hcGlOYW1lIGFuZCBkZXByZWNhdGVkIGFwaU5hbWUgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LmRvbWFpbiAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiBhbmQgZGVwcmVjYXRlZCBkb21haW4gY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMub3duZWRBcGk/LnN0YWdlICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuc3RhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSBhbmQgZGVwcmVjYXRlZCBzdGFnZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYXBpTmFtZTogcHJvcHMub3duZWRBcGk/LmFwaU5hbWUgPz8gcHJvcHMuYXBpTmFtZSxcbiAgICBkb21haW46IHByb3BzLm93bmVkQXBpPy5kb21haW4gPz8gcHJvcHMuZG9tYWluLFxuICAgIHN0YWdlOiBwcm9wcy5vd25lZEFwaT8uc3RhZ2UgPz8gcHJvcHMuc3RhZ2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvcHRpb25zPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zKTogTm9ybWFsaXplZFN0YWdlT3B0aW9ucyB7XG4gIGNvbnN0IGFjY2Vzc0xvZ2dpbmcgPSBvcHRpb25zPy5hY2Nlc3NMb2dnaW5nID8/IHRydWU7XG4gIGlmICghYWNjZXNzTG9nZ2luZyAmJiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dSZXRlbnRpb24gcmVxdWlyZXMgYWNjZXNzTG9nZ2luZyB0byBiZSBlbmFibGVkXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nRW5hYmxlZCA9IG9wdGlvbnM/LnRocm90dGxpbmdFbmFibGVkID8/IHRydWU7XG4gIGlmIChcbiAgICAhdGhyb3R0bGluZ0VuYWJsZWRcbiAgICAmJiAob3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5zdGFnZSB0aHJvdHRsaW5nIGxpbWl0cyByZXF1aXJlIHRocm90dGxpbmdFbmFibGVkIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhdGVMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQ7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIocmF0ZUxpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdSYXRlTGltaXRcIik7XG4gIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIoYnVyc3RMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nQnVyc3RMaW1pdFwiKTtcbiAgcmV0dXJuIHtcbiAgICBzdGFnZU5hbWU6IG9wdGlvbnM/LnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIsXG4gICAgYWNjZXNzTG9nZ2luZyxcbiAgICBhY2Nlc3NMb2dSZXRlbnRpb246IG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIHRocm90dGxpbmdFbmFibGVkLFxuICAgIHRocm90dGxpbmdSYXRlTGltaXQ6IHJhdGVMaW1pdCxcbiAgICB0aHJvdHRsaW5nQnVyc3RMaW1pdDogYnVyc3RMaW1pdCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRTZXNzaW9uU3RhdGUge1xuICBjb25zdCBoYXNMZWdhY3kgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQ7XG4gIGlmIChwcm9wcy5zZXNzaW9uU3RhdGUgIT09IHVuZGVmaW5lZCAmJiBoYXNMZWdhY3kpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogc2Vzc2lvblN0YXRlIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGRlcHJlY2F0ZWQgc2Vzc2lvbi10YWJsZSBwcm9wc1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW5hYmxlZCA9IHByb3BzLnNlc3Npb25TdGF0ZT8uZW5hYmxlZCA/PyBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUgPz8gdHJ1ZTtcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgPz8gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZTtcbiAgY29uc3QgdHRsTWludXRlcyA9IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlc1xuICAgID8/IHByb3BzLnNlc3Npb25UdGxNaW51dGVzXG4gICAgPz8gREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTO1xuICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICBpZiAoXG4gICAgIWVuYWJsZWRcbiAgICAmJiAodGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8udHRsTWludXRlcyAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZGlzYWJsZWQgc2Vzc2lvbiBzdGF0ZSBjYW5ub3QgY29uZmlndXJlIHRhYmxlTmFtZSwgdHRsTWludXRlcywgb3IgcmVtb3ZhbFBvbGljeVwiLFxuICAgICk7XG4gIH1cbiAgdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodHRsTWludXRlcywgXCJzZXNzaW9uU3RhdGUudHRsTWludXRlc1wiKTtcbiAgcmV0dXJuIHsgZW5hYmxlZCwgdGFibGVOYW1lLCB0dGxNaW51dGVzLCByZW1vdmFsUG9saWN5IH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSByZXR1cm47XG4gIGNvbnN0IGlzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgaXNzdWVyLFxuICAgICAgZmFsc2UsXG4gICAgICBcImF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoandrc1VyaSkpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGp3a3NVcmksXG4gICAgICB0cnVlLFxuICAgICAgXCJqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnRyYW5zcG9ydEF1dGhvcml6ZXI7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzoge1xuICAgICAgaWYgKGNvbmZpZ3VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIgaXMgb25seSB2YWxpZCB3aXRoIHRyYW5zcG9ydFBvc3R1cmUgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICAgICAgPyBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKClcbiAgICAgICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICB9XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDoge1xuICAgICAgY29uc3QgaXNzdWVyID0gU3RyaW5nKGNvbmZpZ3VyZWQ/Lmlzc3VlciA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoaXNzdWVyID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgaXMgcmVxdWlyZWQgd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgICAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgICAgICBpc3N1ZXIsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgXCJ0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBhdWRpZW5jZSA9IChjb25maWd1cmVkPy5hdWRpZW5jZSA/PyBbXSlcbiAgICAgICAgLm1hcCgodmFsdWUpID0+IFN0cmluZyh2YWx1ZSkudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgIT09IFwiXCIpO1xuICAgICAgaWYgKGF1ZGllbmNlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuYXVkaWVuY2UgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGFjY2VwdGVkIGF1ZGllbmNlIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBKd3RBdXRob3JpemVyKFxuICAgICAgICBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQsXG4gICAgICAgIGlzc3VlcixcbiAgICAgICAge1xuICAgICAgICAgIGp3dEF1ZGllbmNlOiBhdWRpZW5jZSxcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogY29uZmlndXJlZD8uaWRlbnRpdHlTb3VyY2UsXG4gICAgICAgICAgYXV0aG9yaXplck5hbWU6IGNvbmZpZ3VyZWQ/LmF1dGhvcml6ZXJOYW1lLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcG9zdHVyZUxhYmVsKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOiByZXR1cm4gXCJJQU1cIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiByZXR1cm4gXCJKV1RcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6IHJldHVybiBcIlJVTlRJTUVfQkVBUkVSXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiByZXR1cm4gXCJOT05FX1BVQkxJQ1wiO1xuICAgIGRlZmF1bHQ6IHJldHVybiBTdHJpbmcocG9zdHVyZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiB2b2lkIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6XG4gICAgICByZXR1cm47XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJvdXRlTW9kZWwocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogQXBwVGhlb3J5TWNwUm91dGVNb2RlbCB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy5yb3V0ZU1vZGVsO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVQ7XG4gIH1cbiAgaWYgKFxuICAgIGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICB8fCBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRFxuICApIHtcbiAgICByZXR1cm4gY29uZmlndXJlZDtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgbXVzdCBiZSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUIG9yIC5DT05TT0xJREFURURcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShcbiAgcm91dGVNb2RlbDogQXBwVGhlb3J5TWNwUm91dGVNb2RlbCxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAoXG4gICAgcm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBpcyBvbmx5IHZhbGlkIGZvciB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIG9yIE5PTkVfUFVCTElDOyB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBrZWVwcyB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwgYmVjYXVzZSBjb25zb2xpZGF0aW9uIG11c3QgbmV2ZXIgY2hhbmdlIGdhdGV3YXkgYWRtaXNzaW9uYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZSB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy5yb3V0ZUlkTW9kZTtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1k7XG4gIH1cbiAgaWYgKFxuICAgIGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWVxuICAgIHx8IGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDXG4gICkge1xuICAgIHJldHVybiBjb25maWd1cmVkO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgbXVzdCBiZSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1kgb3IgLlNFTUFOVElDXCIsXG4gICk7XG59XG5cbi8qKlxuICogVGhlIHR3byBncmVlZHkgcm91dGUga2V5cyBhIGNvbnNvbGlkYXRlZCBtb2RlbCBvd25zLiBBIGNvbnN1bWVyIHJvdXRlIHRoYXRcbiAqIHJlZGVjbGFyZXMgb25lIG9mIHRoZW0gd291bGQgbWFrZSB0aGUgQVBJIHJlamVjdCB0aGUgdXBkYXRlLlxuICovXG5jb25zdCBDT05TT0xJREFURURfR1JFRURZX1JPVVRFX0tFWVMgPSBuZXcgU2V0KFtcIkFOWSAvXCIsIFwiQU5ZIC97cHJveHkrfVwiXSk7XG5cbi8qKlxuICogUmVzb2x2ZSBhbiBgQXBpSWRgIChvciBhbnkgdGVtcGxhdGUgdmFsdWUpIHRvIGEgY29tcGFyYWJsZSBzdHJpbmcsIHNvIGFcbiAqIGBSZWZgIHRva2VuIGFuZCBpdHMgbG9naWNhbCBpZCBjb21wYXJlIGVxdWFsIGFjcm9zcyB0d28gdGVtcGxhdGVzIG9mIHRoZSBzYW1lXG4gKiBzdGFjay5cbiAqL1xuZnVuY3Rpb24gY29tcGFyYWJsZUFwaUlkKHNjb3BlOiBDb25zdHJ1Y3QsIHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFN0YWNrLm9mKHNjb3BlKS5yZXNvbHZlKHZhbHVlKSk7XG59XG5cbi8qKlxuICogRXZlcnkgQVBJIEdhdGV3YXkgdjIgcm91dGUgYm91bmQgdG8gYGFwaWAsIHJlZ2FyZGxlc3Mgb2Ygd2hpY2ggY29uc3RydWN0XG4gKiBzY29wZSBjcmVhdGVkIGl0LlxuICpcbiAqIGBhcGkubm9kZS5jaGlsZHJlbmAgb25seSBzZWVzIHJvdXRlcyB0aGUgQVBJIGl0c2VsZiAob3IgYSBjaGlsZCBzY29wZSlcbiAqIGNyZWF0ZWQsIHdoaWNoIG1pc3NlcyB0aGUgY29tbW9uIHBhdHRlcm4gb2YgYSBzdGFjay1sZXZlbCBjb25zdHJ1Y3Qgd2lyaW5nIGFcbiAqIHJvdXRlIG9udG8gYW4gYXR0YWNoZWQgQVBJLiBXYWxraW5nIHRoZSBzdGFjayBhbmQgcmVzb2x2aW5nIGVhY2ggYENmblJvdXRlYCdzXG4gKiBgQXBpSWRgIHNlZXMgYm90aC5cbiAqL1xuZnVuY3Rpb24gcm91dGVzQm91bmRUb0FwaShzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiBhcGlnd3YyLkNmblJvdXRlW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5Sb3V0ZVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwUm91dGUpIHtcbiAgICAgIGlmIChjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuaHR0cEFwaS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgICBmb3VuZC5wdXNoKG5vZGUubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5Sb3V0ZSk7XG4gICAgICB9XG4gICAgICAvLyBUaGUgcm91dGUncyBvd24gQ2ZuUm91dGUgY2hpbGQgaXMgdGhlIHNhbWUgcm91dGU7IGRvIG5vdCBkb3VibGUgY291bnQuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5Sb3V0ZSAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZC5maWx0ZXIoKHJvdXRlKSA9PiByb3V0ZSAhPT0gdW5kZWZpbmVkKTtcbn1cblxuLyoqXG4gKiBSZWZ1c2UgYSBjb25zb2xpZGF0ZWQgYXR0YWNoIG9udG8gYW4gQVBJIHRoYXQgYWxyZWFkeSBjYXJyaWVzIHJvdXRlcy5cbiAqXG4gKiBUaGUgY2hlY2sgZGVsaWJlcmF0ZWx5IHdhbGtzIHRoZSB3aG9sZSBzdGFjazogYSByb3V0ZSBib3VuZCB0byB0aGUgYXR0YWNoZWRcbiAqIEFQSSBmcm9tIGEgc2libGluZyBjb25zdHJ1Y3Qgc2NvcGUgaXMganVzdCBhcyBtdWNoIGEgcm91dGUga2V5IHRoZVxuICogY29uc29saWRhdGVkIGdyZWVkeSByb3V0ZXMgd291bGQgY29sbGlkZSB3aXRoIGFzIG9uZSBjcmVhdGVkIHVuZGVyIHRoZSBBUElcbiAqIGl0c2VsZi5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZChzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiB2b2lkIHtcbiAgY29uc3QgZXhpc3RpbmdSb3V0ZXMgPSByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICBpZiAoZXhpc3RpbmdSb3V0ZXMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBtYXkgYXR0YWNoIG9ubHkgdG8gYW4gQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZTsgXCJcbiAgICAgICsgYHRoZSBBUEkgYWxyZWFkeSBjYXJyaWVzICR7ZXhpc3RpbmdSb3V0ZXMubGVuZ3RofSByb3V0ZShzKTogJHtleGlzdGluZ1JvdXRlcy5tYXAoKHJvdXRlKSA9PiByb3V0ZS5ub2RlLnBhdGgpLmpvaW4oXCIsIFwiKX07IGBcbiAgICAgICsgXCJhdHRhY2ggdG8gYSBuZXcgb3IgZW1wdHkgQVBJLCBvciB1c2Ugcm91dGVNb2RlbCBleHBsaWNpdFwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWdpc3RlciB0aGUgc3ludGgtdGltZSBydWxlIGZvciByb3V0ZXMgYWRkZWQgdG8gYSBjb25zb2xpZGF0ZWQgQVBJIGFmdGVyXG4gKiB0aGUgY29uc3RydWN0IGNyZWF0ZWQgaXRzIGdyZWVkeSByb3V0ZXMuXG4gKlxuICogVGhlIHJ1bGUgYXBwbGllcyBpbiBib3RoIGNvbnNvbGlkYXRlZCBtb2RlczogYW4gQVBJIHRoZSBjb25zdHJ1Y3QgYXR0YWNoZWRcbiAqIHRvLCBhbmQgb25lIHRoZSBjb25zdHJ1Y3Qgb3ducy4gVGhlIGRvY3VtZW50ZWQgZXhjZXB0aW9uIGlzIHdoYXQgbWFrZXNcbiAqIGNvbnNvbGlkYXRlZCByb3V0ZXMgdXNhYmxlIGluIGEgcmVhbCBmcm9udCBkb29yOiBhIGNvbnN1bWVyIG1heSBhZGRcbiAqIGV4cGxpY2l0LCBtb3JlIHNwZWNpZmljIHJvdXRlcyBhZnRlcndhcmRzLiBJdCBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGVcbiAqIHJvdXRlIGNhcnJpZXMgYSBub24tTk9ORSBhdXRob3JpemVyIChzbyB0aGUgZ3JlZWR5IHJvdXRlcyBuZXZlciBzaWxlbnRseVxuICogd2lkZW4gYSBzdHJpY3RlciBwb3N0dXJlKSBhbmQgZG9lcyBub3QgcmVkZWNsYXJlIGEgZ3JlZWR5IHJvdXRlIGtleSAod2hpY2hcbiAqIEFQSSBHYXRld2F5IHdvdWxkIHJlamVjdCBhcyBhIGR1cGxpY2F0ZSkuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuICBvd25lZFJvdXRlczogYXBpZ3d2Mi5IdHRwUm91dGVbXSxcbik6IHZvaWQge1xuICBjb25zdCBvd25lZCA9IG5ldyBTZXQoXG4gICAgb3duZWRSb3V0ZXMubWFwKChyb3V0ZSkgPT4gcm91dGUubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5Sb3V0ZSksXG4gICk7XG4gIFN0YWNrLm9mKHNjb3BlKS5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHJvdXRlc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSkpIHtcbiAgICAgICAgaWYgKG93bmVkLmhhcyhyb3V0ZSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3V0ZUtleSA9IHJvdXRlLnJvdXRlS2V5O1xuICAgICAgICBpZiAoQ09OU09MSURBVEVEX0dSRUVEWV9ST1VURV9LRVlTLmhhcyhyb3V0ZUtleSkpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIGFscmVhZHkgb3ducyB0aGUgZ3JlZWR5IEFQSSBHYXRld2F5IHJvdXRlIGtleSAke0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX0gb24gdGhpcyBBUEk7IGEgcm91dGUgYWRkZWQgYWZ0ZXIgY29uc3RydWN0aW9uIG11c3Qgbm90IHJlZGVjbGFyZSBpdCAoJHtyb3V0ZS5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBhdXRob3JpemF0aW9uVHlwZSA9IFN0cmluZyhyb3V0ZS5hdXRob3JpemF0aW9uVHlwZSA/PyBcIk5PTkVcIikudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKGF1dGhvcml6YXRpb25UeXBlID09PSBcIk5PTkVcIikge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYSByb3V0ZSBhZGRlZCB0byBhIGNvbnNvbGlkYXRlZCBBUEkgYWZ0ZXIgY29uc3RydWN0aW9uIG11c3QgY2FycnkgYSBub24tTk9ORSBhdXRob3JpemVyLCBiZWNhdXNlIHRoZSBncmVlZHkgcm91dGVzIGFkbWl0IGV2ZXJ5IG1ldGhvZCBhbmQgcGF0aCBhdCB0aGUgZ2F0ZXdheSAoJHtyb3V0ZUtleX0gZnJvbSAke3JvdXRlLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZXJyb3JzO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQoZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCk6IHZvaWQge1xuICBpZiAoZmFjYWRlID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgY29uc3QgcHJvdmlkZXJJZCA9IChmYWNhZGUgYXMgeyBwcm92aWRlcklkPzogdW5rbm93biB9KT8ucHJvdmlkZXJJZDtcbiAgaWYgKFxuICAgIHR5cGVvZiBwcm92aWRlcklkICE9PSBcInN0cmluZ1wiXG4gICAgfHwgcHJvdmlkZXJJZC50cmltKCkgPT09IFwiXCJcbiAgICB8fCBUb2tlbi5pc1VucmVzb2x2ZWQocHJvdmlkZXJJZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZhY2FkZS5wcm92aWRlcklkIG11c3QgYmUgYSBub24tZW1wdHkgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBzdHJpbmdcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICByb3V0ZUZhbWlseTogTm9ybWFsaXplZFJvdXRlRmFtaWx5LFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDKSB7XG4gICAgaWYgKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBvciBqd2tzVXJpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGVuYWJsZSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHVwc3RyZWFtQ2FsbGJhY2tQYXRoXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbiAgb3duZWQ6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsYWJlbCA9IHBvc3R1cmVMYWJlbChwb3N0dXJlKTtcbiAgaWYgKFxuICAgIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiAocHJvcHMucnVudGltZVBvc3R1cmUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5ydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gIT09IHRydWUpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIHJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAmJiBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAmJiBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCwgLkxPQ0tFRCwgb3IgLkZST05URURgLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKHByb3BzLm93bmluZ0FwaURlZmVuc2UsIGxhYmVsKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAob3duZWQuc3RhZ2U/LnRocm90dGxpbmdFbmFibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYW4gZXhwbGljaXQgb3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0VuYWJsZWQ6IHRydWUgdGhyb3R0bGluZyBkZWNpc2lvbmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3duZWQuc3RhZ2U/LmFjY2Vzc0xvZ2dpbmcgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYWNjZXNzIGxvZ2dpbmdgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIpIHtcbiAgICB2YWxpZGF0ZURlbmlhbFNpZ25hbChwcm9wcy5kZW5pYWxTaWduYWwpO1xuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVjbGFyZWQgZGlyZWN0LW9yaWdpbiBkZWNpc2lvbiB0byBhIHByb3ZlbiBwb3N0dXJlLlxuICpcbiAqIEV2ZXJ5IHN1cHBsaWVkIHZhbHVlIGlzIGNoZWNrZWQsIG5vdCBvbmx5IHRoZSBwb3N0dXJlcyB0aGF0IHJlcXVpcmUgdGhlXG4gKiBkZWNpc2lvbi4gRElTQUJMRUQgbmVlZHMgdGhlIG93bmVkIG9yZGluYXJ5IGRvbWFpbiB0aGF0IHJlcGxhY2VzIHRoZSBkaXNhYmxlZFxuICogZXhlY3V0ZS1hcGkgYXV0aG9yaXR5IChvciBhIHByb3ZhYmxlIGNvbmNyZXRlIGF0dGFjaCksIGFuZCBMT0NLRURcbiAqIGFkZGl0aW9uYWxseSBuZWVkcyBtdXR1YWwgVExTIG9uIGV2ZXJ5IGRvbWFpbiBtYXBwZWQgdG8gdGhlIG93bmVkIEFQSS5cbiAqIEF0dGFjaC1tb2RlIExPQ0tFRCBpcyB1bnN1cHBvcnRlZCBiZWNhdXNlIGFuIGV4dGVybmFsIEFQSSBjYXJyaWVzIG5vIGluLXN0YWNrXG4gKiB0cnVzdHN0b3JlIG9yIG1hcHBpbmcgZXZpZGVuY2UuIEZST05URUQgaXMgdGhlIGF0dGFjaC1tb2RlIGNvdW50ZXJwYXJ0IGZvciBhblxuICogYXBwbGljYXRpb24tb3duZWQgZnJvbnQgZG9vcjogaXQgcHJvZHVjZXMgbm8gaW4tc3RhY2sgZXZpZGVuY2UsIHNvIGl0IGlzXG4gKiBhY2NlcHRlZCBvbmx5IHdpdGggYW4gZXhwbGljaXQsIHZhbGlkYXRlZCBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvblxuICogYW5kIG9ubHkgaW4gYXR0YWNoIG1vZGUuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgb3duZWQ6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMsXG4pOiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkgfCB1bmRlZmluZWQge1xuICBjb25zdCBkZWNpc2lvbiA9IHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eTtcbiAgY29uc3QgbXV0dWFsVGxzID0gb3duZWQuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbjtcbiAgaWYgKGRlY2lzaW9uID09PSB1bmRlZmluZWQpIHtcbiAgICBpZiAobXV0dWFsVGxzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBtdXN0IGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCwgLkxPQ0tFRCwgb3IgLkZST05URURcIixcbiAgICApO1xuICB9XG4gIGlmIChtdXR1YWxUbHMgIT09IHVuZGVmaW5lZCAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRURcIixcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgICAmJiBwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24gIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlY2lzaW9uID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCkge1xuICAgIGlmIChwcm9wcy5hcGkgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgaXMgdW5zdXBwb3J0ZWQgaW4gb3duZWQgbW9kZTsgYW4gb3duZWQgZnJvbnQgZG9vciBpcyB3aXJlZCBieSB0aGUgRElTQUJMRUQgb3IgTE9DS0VEIHBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHZhbGlkYXRlRnJvbnREb29yVmVyaWZpY2F0aW9uKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChkZWNpc2lvbiA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRCkge1xuICAgIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCBpcyB1bnN1cHBvcnRlZCBpbiBhdHRhY2ggbW9kZTsgYW4gQVBJIG93bmVkIG91dHNpZGUgdGhlIGNvbnN0cnVjdCBjYXJyaWVzIG5vIGluLXN0YWNrIG11dHVhbC1UTFMgbWFwcGluZyBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG93bmVkLmRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGFuIGVmZmVjdGl2ZSBvd25lZEFwaS5kb21haW4gd2l0aCBtdXR1YWxUbHNBdXRoZW50aWNhdGlvblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG11dHVhbFRscyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbjsgZGlzYWJsZW1lbnQgYWxvbmUgaXMgdGhlIERJU0FCTEVEIHBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIShwcm9wcy5hcGkgaW5zdGFuY2VvZiBhcGlnd3YyLkh0dHBBcGkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgYSBzYW1lLXN0YWNrIGNvbmNyZXRlIEh0dHBBcGk7IGFuIGltcG9ydGVkIEFQSSBleHBvc2VzIG5vIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgZXZpZGVuY2VcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJlZ2lzdGVyQXR0YWNoRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKHNjb3BlLCBwcm9wcy5hcGkpO1xuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAob3duZWQuZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIGFuIGVmZmVjdGl2ZSBvd25lZEFwaS5kb21haW47IHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludCBpcyBuZXZlciBhIHB1YmxpYyBhdXRob3JpdHlcIixcbiAgICApO1xuICB9XG4gIHJldHVybiBkZWNpc2lvbjtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGUgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgZGVjbGFyYXRpb24gZm9yIGBvcmlnaW5SZWFjaGFiaWxpdHk6XG4gKiBGUk9OVEVEYC5cbiAqXG4gKiBUaGUgZGVjbGFyYXRpb24gaXMgbWFuZGF0b3J5IGFuZCBldmVyeSBmaWVsZCBpcyBjaGVja2VkOiBhbiBhYnNlbnRcbiAqIGRlY2xhcmF0aW9uLCBhIG1pc3Npbmcgb3IgcmVzZXJ2ZWQgaGVhZGVyIG5hbWUsIGEgc2VjcmV0IG91dHNpZGUgdGhlXG4gKiBoZWFkZXItdmFsdWUtc2FmZSBhbHBoYWJldCwgYW5kIGEgbWlzc2luZyBgYXNzZXJ0ZWQ6IHRydWVgIGFsbCBmYWlsIHN5bnRoZXNpc1xuICogcmF0aGVyIHRoYW4gcHJvZHVjaW5nIGEgZGVjbGFyYXRpb24gdGhlIHJ1bnRpbWUgY291bGQgbm90IGhvbm9yLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUZyb250RG9vclZlcmlmaWNhdGlvbihcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogdm9pZCB7XG4gIGlmICh2ZXJpZmljYXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCByZXF1aXJlcyBmcm9udERvb3JWZXJpZmljYXRpb247IHRoZSBydW50aW1lIGNhbm5vdCBlbmZvcmNlIGFuIHVuZGVjbGFyZWQgZnJvbnQgZG9vclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGVhZGVyTmFtZSA9IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lO1xuICBpZiAodHlwZW9mIGhlYWRlck5hbWUgIT09IFwic3RyaW5nXCIgfHwgIUZST05UX0RPT1JfSEVBREVSX05BTUVfUEFUVEVSTi50ZXN0KGhlYWRlck5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lIG11c3QgYmUgMSB0byA2NCBjaGFyYWN0ZXJzIG9mIFtBLVphLXowLTktXVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZEhlYWRlciA9IGhlYWRlck5hbWUudG9Mb3dlckNhc2UoKTtcbiAgaWYgKFxuICAgIFJFU0VSVkVEX0ZST05UX0RPT1JfSEVBREVSUy5oYXMobm9ybWFsaXplZEhlYWRlcilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJ4LWFtei1cIilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJ4LWFtem4tXCIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwiY2xvdWRmcm9udC1cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLmhlYWRlck5hbWUgJHtoZWFkZXJOYW1lfSBpcyBhIHJlc2VydmVkIG9yIHBsYXRmb3JtLW1hbmFnZWQgcmVxdWVzdCBoZWFkZXIgYW5kIGNhbm5vdCBjYXJyeSB0aGUgZnJvbnQtZG9vciB2ZXJpZmljYXRpb25gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc2VjcmV0VmFsdWUgPSB2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWU7XG4gIGlmICh0eXBlb2Ygc2VjcmV0VmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIUZST05UX0RPT1JfU0VDUkVUX1BBVFRFUk4udGVzdChzZWNyZXRWYWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlIG11c3QgYmUgMzIgdG8gMTI4IGNoYXJhY3RlcnMgb2YgW0EtWmEtejAtOS5ffi1dXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLmFzc2VydGVkICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiByZXF1aXJlcyBhc3NlcnRlZDogdHJ1ZSDigJQgdGhlIGNhbGxlciBtdXN0IHJlY29yZCB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeSBkZXJpdmVkIHJvdXRlXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBGUk9OVEVEIGZpZWxkcyBvZiB0aGUgYGFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVgIG1hcmtlci5cbiAqXG4gKiBUaGUgbWFya2VyIHJlY29yZHMgdGhlIHBvc3R1cmUgYW5kIHRoZSBoZWFkZXIgbmFtZSBhbmQgYSBTSEEtMjU2IGRpZ2VzdCBvZiB0aGVcbiAqIGRlY2xhcmVkIHNlY3JldC4gVGhlIGxpdGVyYWwgc2VjcmV0IGlzIGNvbnN1bWVkIGhlcmUgZm9yIHZhbGlkYXRpb24gKGFscmVhZHlcbiAqIHBlcmZvcm1lZCkgYW5kIGl0cyBkaWdlc3Qgb25seTogaXQgbmV2ZXIgbGFuZHMgaW4gdGhlIHN5bnRoZXNpemVkIHRlbXBsYXRlIG9yXG4gKiBpbiBDbG91ZEZvcm1hdGlvbiwgc28gaXQgY2Fubm90IGJlIHJlYWQgYmFjayBvdXQgb2YgYSBzdGFjay5cbiAqL1xuZnVuY3Rpb24gZnJvbnREb29yUG9zdHVyZU1ldGFkYXRhKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9yaWdpbl9yZWFjaGFiaWxpdHk6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVELFxuICAgIGZyb250X2Rvb3JfaGVhZGVyX25hbWU6IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lLFxuICAgIGZyb250X2Rvb3Jfc2VjcmV0X3NoYTI1NjogY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlLCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpLFxuICB9O1xufVxuXG4vKipcbiAqIEZpbmFsIHN5bnRoZXNpcyBwcm9vZiBmb3IgYW4gb3duZWQgRElTQUJMRUQgQVBJOiB0aGUgZGVmYXVsdCBleGVjdXRlLWFwaVxuICogZW5kcG9pbnQgbXVzdCBzdGlsbCBiZSBkaXNhYmxlZCBpbiB0aGUgZW1pdHRlZCB0ZW1wbGF0ZSwgZXZlbiBpZiBhIGxhdGVyIEwxXG4gKiBvdmVycmlkZSB0cmllcyB0byByZS1lbmFibGUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSA9PT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gW107XG4gICAgICB9XG4gICAgICByZXR1cm4gW1xuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkuUHJvcGVydGllcy5EaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IHRvIHJlc29sdmUgdG8gdHJ1ZVwiLFxuICAgICAgXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqXG4gKiBGaW5hbCB3aG9sZS1zdGFjayBwcm9vZiBmb3IgYW4gb3duZWQgTE9DS0VEIEFQSS5cbiAqXG4gKiBMT0NLRUQgaXMgbm90IGFuIGFsaWFzIG9mIERJU0FCTEVEOiBhdCBmaW5hbCBzeW50aGVzaXMgdGhlIGRlZmF1bHQgZW5kcG9pbnRcbiAqIG11c3Qgc3RpbGwgYmUgZGlzYWJsZWQgYW5kIGV2ZXJ5IGBDZm5BcGlNYXBwaW5nYCBib3VuZCB0byB0aGUgb3duZWQgQVBJLFxuICogaW5jbHVkaW5nIG1hcHBpbmdzIGFub3RoZXIgc2NvcGUgYWRkcyBhZnRlciBjb25zdHJ1Y3Rpb24sIG11c3QgcmVzb2x2ZSB0byBhblxuICogaW4tc3RhY2sgYENmbkRvbWFpbk5hbWVgIHdob3NlIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmVcbiAqIFVSSS4gQW4gdW5yZXNvbHZhYmxlIG1hcHBpbmcgb3IgZG9tYWluIGZhaWxzIGNsb3NlZCBpbnN0ZWFkIG9mIGNvdW50aW5nIGFzXG4gKiBldmlkZW5jZS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJPd25lZExvY2tlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSAhPT0gdHJ1ZSkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpLlByb3BlcnRpZXMuRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCB0byByZXNvbHZlIHRvIHRydWVcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1hcHBpbmdzID0gY2ZuQXBpTWFwcGluZ3NCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKG1hcHBpbmdzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhdCBsZWFzdCBvbmUgQVdTOjpBcGlHYXRld2F5VjI6OkFwaU1hcHBpbmcgYm91bmQgdG8gdGhlIG93bmVkIEFQSVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgZG9tYWlucyA9IGNmbkRvbWFpbk5hbWVzKHNjb3BlKTtcbiAgICAgIGZvciAoY29uc3QgbWFwcGluZyBvZiBtYXBwaW5ncykge1xuICAgICAgICBjb25zdCBkb21haW4gPSBkb21haW5zLmZpbmQoXG4gICAgICAgICAgKGNhbmRpZGF0ZSkgPT4gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBjYW5kaWRhdGUucmVmKVxuICAgICAgICAgICAgPT09IGNvbXBhcmFibGVBcGlJZChzY29wZSwgbWFwcGluZy5kb21haW5OYW1lKSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIGNhbm5vdCByZXNvbHZlIG1hcHBpbmcgJHttYXBwaW5nLm5vZGUucGF0aH0gdG8gYW4gaW4tc3RhY2sgQVdTOjpBcGlHYXRld2F5VjI6OkRvbWFpbk5hbWU7IG11dHVhbC1UTFMgZXZpZGVuY2UgaXMgdW52ZXJpZmlhYmxlYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaGFzVHJ1c3RzdG9yZVVyaShzdGFjaywgZG9tYWluKSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBldmVyeSBtYXBwaW5nIHRvIHRhcmdldCBhIGRvbWFpbiB3aXRoIE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLlRydXN0c3RvcmVVcmkgKCR7bWFwcGluZy5ub2RlLnBhdGh9IC0+ICR7ZG9tYWluLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZXJyb3JzO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBoYXNUcnVzdHN0b3JlVXJpKHN0YWNrOiBTdGFjaywgZG9tYWluOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWUpOiBib29sZWFuIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBzdGFjay5yZXNvbHZlKGRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbik7XG4gIGlmIChyZXNvbHZlZCA9PT0gdW5kZWZpbmVkIHx8IHJlc29sdmVkID09PSBudWxsIHx8IHR5cGVvZiByZXNvbHZlZCAhPT0gXCJvYmplY3RcIikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBhdXRoZW50aWNhdGlvbiA9IHJlc29sdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCB0cnVzdHN0b3JlVXJpID0gYXV0aGVudGljYXRpb24udHJ1c3RzdG9yZVVyaSA/PyBhdXRoZW50aWNhdGlvbi5UcnVzdHN0b3JlVXJpO1xuICByZXR1cm4gdHJ1c3RzdG9yZVVyaSAhPT0gdW5kZWZpbmVkICYmIHRydXN0c3RvcmVVcmkgIT09IG51bGwgJiYgdHJ1c3RzdG9yZVVyaSAhPT0gXCJcIjtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlNYXBwaW5nYCB3aG9zZSByZXNvbHZlZCBgQXBpSWRgIGlzIHRoZSBzdXBwbGllZCBBUEkuICovXG5mdW5jdGlvbiBjZm5BcGlNYXBwaW5nc0JvdW5kVG9BcGkoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG5mdW5jdGlvbiBjZm5Eb21haW5OYW1lcyhzY29wZTogQ29uc3RydWN0KTogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuRG9tYWluTmFtZVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5Eb21haW5OYW1lKSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogRmluYWwgc3ludGhlc2lzIHByb29mIGZvciBhbiBhdHRhY2ggRElTQUJMRUQgZGVjbGFyYXRpb246IHRoZSBjb25jcmV0ZSBBUElcbiAqIG11c3QgYmluZCB0byBleGFjdGx5IG9uZSBpbi1zdGFjayBDZm5BcGkgd2hvc2UgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludFxuICogcmVzb2x2ZXMgdG8gbGl0ZXJhbCB0cnVlLiBUaGUgY29uc3RydWN0IG5ldmVyIG11dGF0ZXMgdGhlIGF0dGFjaGVkIEFQSS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJBdHRhY2hEaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgY2ZuQXBpcyA9IGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKGNmbkFwaXMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyBleGFjdGx5IG9uZSBzYW1lLXN0YWNrIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGk7IHRoZSBhdHRhY2hlZCBBUEkncyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGNhbm5vdCBiZSBwcm92ZW5cIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaXNbMF0uZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIHRoZSBhdHRhY2hlZCBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpIHRvIHNldCBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50PXRydWVcIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlgIHdob3NlIGBSZWZgIGlzIHRoZSBzdXBwbGllZCBBUEkncyBpZC4gKi9cbmZ1bmN0aW9uIGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuQXBpW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5BcGlbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuQXBpICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5yZWYpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKFxuICBkZWZlbnNlOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB8IHVuZGVmaW5lZCxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoZGVmZW5zZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlIHRvIHJlY29yZCB0aGUgb3duaW5nIEFQSSdzIGFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlY2lzaW9uc2AsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVmZW5zZS5hY2Nlc3NMb2dnaW5nICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgdG8gYmUgdHJ1ZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nOiBQYXJ0aWFsPEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zPiB8IHVuZGVmaW5lZCA9IGRlZmVuc2UudGhyb3R0bGluZztcbiAgY29uc3QgcmF0ZUxpbWl0ID0gdGhyb3R0bGluZz8ucmF0ZUxpbWl0O1xuICBjb25zdCBidXJzdExpbWl0ID0gdGhyb3R0bGluZz8uYnVyc3RMaW1pdDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KVxuICAgIHx8IChyYXRlTGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICAgfHwgIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KVxuICAgIHx8IChidXJzdExpbWl0IGFzIG51bWJlcikgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UudGhyb3R0bGluZyByYXRlTGltaXQgYW5kIGJ1cnN0TGltaXQgdG8gYmUgcG9zaXRpdmUgZmluaXRlIG51bWJlcnNgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZW5pYWxTaWduYWwoc2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyk6IHZvaWQge1xuICBpZiAoc2lnbmFsID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBkZW5pYWxTaWduYWxcIixcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwubWV0cmljTmFtZSAhPT0gdW5kZWZpbmVkICYmIHNpZ25hbC5tZXRyaWNOYW1lICE9PSBNQ1BfREVOSUFMX01FVFJJQ19OQU1FKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLm1ldHJpY05hbWUgbXVzdCBiZSAke01DUF9ERU5JQUxfTUVUUklDX05BTUV9YCxcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwuZGltZW5zaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGltZW5zaW9ucyA9IEFycmF5LmlzQXJyYXkoc2lnbmFsLmRpbWVuc2lvbnMpID8gc2lnbmFsLmRpbWVuc2lvbnMgOiBbXTtcbiAgICBjb25zdCBib3VuZGVkID0gZGltZW5zaW9ucy5sZW5ndGggPT09IE1DUF9ERU5JQUxfRElNRU5TSU9OUy5sZW5ndGhcbiAgICAgICYmIE1DUF9ERU5JQUxfRElNRU5TSU9OUy5ldmVyeShcbiAgICAgICAgKGRpbWVuc2lvbikgPT4gZGltZW5zaW9ucy5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSA9PT0gZGltZW5zaW9uKS5sZW5ndGggPT09IDEsXG4gICAgICApO1xuICAgIGlmICghYm91bmRlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwuZGltZW5zaW9ucyBtdXN0IGJlIGV4YWN0bHkgJHtKU09OLnN0cmluZ2lmeShNQ1BfREVOSUFMX0RJTUVOU0lPTlMpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTCh2YWx1ZTogc3RyaW5nLCBhbGxvd1F1ZXJ5OiBib29sZWFuLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGl0ZXJhbCA9IHZhbHVlLnRyaW0oKTtcbiAgbGV0IHBhcnNlZDogVVJMIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwobGl0ZXJhbCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFRoZSBzaGFyZWQgdmFsaWRhdGlvbiBlcnJvciBiZWxvdyBpcyB0aGUgcHVibGljIHN5bnRoZXNpcyBjb250cmFjdC5cbiAgfVxuICBpZiAoXG4gICAgIXBhcnNlZFxuICAgIHx8ICFsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eShsaXRlcmFsKVxuICAgIHx8IHBhcnNlZC5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgIHx8ICFwYXJzZWQuaG9zdG5hbWVcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8obGl0ZXJhbClcbiAgICB8fCAoIWFsbG93UXVlcnkgJiYgbGl0ZXJhbC5pbmNsdWRlcyhcIj9cIikpXG4gICAgfHwgbGl0ZXJhbC5pbmNsdWRlcyhcIiNcIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7bWVzc2FnZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0b0h0dHBNZXRob2QobWV0aG9kOiBzdHJpbmcpOiBhcGlnd3YyLkh0dHBNZXRob2Qge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJQT1NUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVDtcbiAgICBjYXNlIFwiR0VUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuR0VUO1xuICAgIGNhc2UgXCJERUxFVEVcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEU7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiB1bnN1cHBvcnRlZCBydW50aW1lIE1DUCBtZXRob2QgJHttZXRob2R9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZU51bWJlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgZ3JlYXRlciB0aGFuIHplcm9gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICByZXR1cm4gZnFkbi5lbmRzV2l0aChzdWZmaXgpID8gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCkgOiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXmh0dHBzOlxcL1xcLyhbXi8/I10rKSg/OlsvPyNdfCQpL2kuZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmICFhdXRob3JpdHkuaW5jbHVkZXMoXCIlXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8odmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXltBLVphLXpdW0EtWmEtejAtOSsuLV0qOlxcL1xcLyhbXi8/I10qKS8uZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eT8uaW5jbHVkZXMoXCJAXCIpID8/IGZhbHNlO1xufVxuIl19