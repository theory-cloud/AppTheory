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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "6.4.0" };
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
        && props.originReachability !== AppTheoryMcpOriginReachability.LOCKED) {
        throw new Error(`AppTheoryMcpServer: transportPosture ${label} requires originReachability to be AppTheoryMcpOriginReachability.DISABLED or .LOCKED`);
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
 * Every supplied value is checked, not only the two postures that require the
 * decision. Neither value is ever accepted as an assertion: DISABLED needs the
 * owned ordinary domain that replaces the disabled execute-api authority (or a
 * provable concrete attach), and LOCKED additionally needs mutual TLS on every
 * domain mapped to the owned API. Attach-mode LOCKED is unsupported because an
 * external API carries no in-stack truststore or mapping evidence.
 */
function resolveOriginReachability(scope, props, owned) {
    const decision = props.originReachability;
    const mutualTls = owned.domain?.mutualTlsAuthentication;
    if (decision === undefined) {
        if (mutualTls !== undefined) {
            throw new Error("AppTheoryMcpServer: ownedApi.domain.mutualTlsAuthentication is only valid with originReachability LOCKED");
        }
        return undefined;
    }
    if (decision !== AppTheoryMcpOriginReachability.DISABLED
        && decision !== AppTheoryMcpOriginReachability.LOCKED) {
        throw new Error("AppTheoryMcpServer: originReachability must be AppTheoryMcpOriginReachability.DISABLED or .LOCKED");
    }
    if (mutualTls !== undefined && decision !== AppTheoryMcpOriginReachability.LOCKED) {
        throw new Error("AppTheoryMcpServer: ownedApi.domain.mutualTlsAuthentication is only valid with originReachability LOCKED");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUMvRCxpQ0FBNEM7QUFFNUMsMkNBQXVEO0FBRXZELE1BQU0sMEJBQTBCLEdBQUcsY0FBYyxDQUFDO0FBQ2xELE1BQU0sMkJBQTJCLEdBQUcsZUFBZSxDQUFDO0FBQ3BELE1BQU0sNkJBQTZCLEdBQUcsR0FBRyxDQUFDO0FBQzFDLE1BQU0sOEJBQThCLEdBQUcsR0FBRyxDQUFDO0FBQzNDLE1BQU0sMkJBQTJCLEdBQUcsRUFBRSxDQUFDO0FBQ3ZDLE1BQU0sMkJBQTJCLEdBQUcsd0JBQXdCLENBQUM7QUFDN0QsTUFBTSxrQ0FBa0MsR0FBRyxpQ0FBaUMsQ0FBQztBQUM3RSxNQUFNLGlDQUFpQyxHQUFHLDhCQUE4QixDQUFDO0FBQ3pFLE1BQU0sc0JBQXNCLEdBQUcsMkJBQTJCLENBQUM7QUFDM0QsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLFNBQVMsRUFBRSxjQUFjLENBQUMsQ0FBQztBQUUxRCxtREFBbUQ7QUFDbkQsSUFBWSxzQkFnQlg7QUFoQkQsV0FBWSxzQkFBc0I7SUFDaEM7Ozs7T0FJRztJQUNILCtDQUFxQixDQUFBO0lBQ3JCOzs7Ozs7O09BT0c7SUFDSCx1REFBNkIsQ0FBQTtBQUMvQixDQUFDLEVBaEJXLHNCQUFzQixzQ0FBdEIsc0JBQXNCLFFBZ0JqQztBQUVELDREQUE0RDtBQUM1RCxJQUFZLHVCQWdCWDtBQWhCRCxXQUFZLHVCQUF1QjtJQUNqQzs7OztPQUlHO0lBQ0gsNENBQWlCLENBQUE7SUFDakI7Ozs7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Q0FBQyxJQUFJLENBQUM7QUFDdEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLEtBQWE7SUFDbEQsTUFBTSxTQUFTLEdBQUcsa0NBQWtDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsT0FBTyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsU0FBUyw4QkFBOEIsQ0FBQyxLQUFhO0lBQ25ELE1BQU0sU0FBUyxHQUFHLHdDQUF3QyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMgfSBmcm9tIFwiLi9odHRwLWFwaVwiO1xuaW1wb3J0IHsgc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkIH0gZnJvbSBcIi4vcm91dGUtaWRzXCI7XG5cbmNvbnN0IENPTlNPTElEQVRFRF9ST09UX1JPVVRFX0lEID0gXCJSb3V0ZUFueVJvb3RcIjtcbmNvbnN0IENPTlNPTElEQVRFRF9QUk9YWV9ST1VURV9JRCA9IFwiUm91dGVBbnlQcm94eVwiO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQgPSAxMDA7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQgPSAyMDA7XG5jb25zdCBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVMgPSA2MDtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCA9IFwiTWNwVHJhbnNwb3J0QXV0aG9yaXplclwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSA9IFwiYXBwdGhlb3J5Om1jcC10cmFuc3BvcnQtcG9zdHVyZVwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lEID0gXCJtMTcubWNwLXRyYW5zcG9ydC1wb3N0dXJlL3YxXCI7XG5jb25zdCBNQ1BfREVOSUFMX01FVFJJQ19OQU1FID0gXCJhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkXCI7XG5jb25zdCBNQ1BfREVOSUFMX0RJTUVOU0lPTlMgPSBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdO1xuXG4vKiogUm91dGUtZW1pc3Npb24gbW9kZWwgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICAvKipcbiAgICogT25lIEFQSSBHYXRld2F5IEhUVFAgQVBJIHYyIHJvdXRlIHBlciBkZXJpdmVkIHJvdXRlIGtleS4gVGhpcyBpcyB0aGVcbiAgICogY29uc3RydWN0J3MgaGlzdG9yaWNhbCBpbnZlbnRvcnkgYW5kIHN0YXlzIGJ5dGUtaWRlbnRpY2FsIGZvciBkZXBsb3llZFxuICAgKiBzdGFja3MsIHNvIGEgYHJvdXRlTW9kZWw6IGV4cGxpY2l0YCB1cGdyYWRlIGRlcGxveXMgaW4gcGxhY2UuIFRoZSBkZWZhdWx0LlxuICAgKi9cbiAgRVhQTElDSVQgPSBcImV4cGxpY2l0XCIsXG4gIC8qKlxuICAgKiBUd28gZ3JlZWR5IHJvdXRlcywgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gLCBiYWNrZWQgYnkgb25lIHNoYXJlZFxuICAgKiBpbnRlZ3JhdGlvbi4gVGhlIEFwcFRoZW9yeSBydW50aW1lIHJvdXRlciBwZXJmb3JtcyBtZXRob2QgYW5kIHBhdGhcbiAgICogZGlzcGF0Y2gsIHBhdGgtcGFyYW1ldGVyIGNhcHR1cmUsIGFuZCBkZW5pYWwuIENvbnNvbGlkYXRpb24gbmV2ZXIgY2hhbmdlc1xuICAgKiBnYXRld2F5IGFkbWlzc2lvbiwgc28gaXQgaXMgdmFsaWQgb25seSB3aGVuIGV2ZXJ5IGdhdGV3YXkgcm91dGUgaXMgYE5PTkVgOlxuICAgKiB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCB0cmFuc3BvcnQgcG9zdHVyZXMuIGBpYW1gIGFuZCBgand0YFxuICAgKiBhcmUgcmVmdXNlZCBhdCBzeW50aGVzaXMgdGltZS5cbiAgICovXG4gIENPTlNPTElEQVRFRCA9IFwiY29uc29saWRhdGVkXCIsXG59XG5cbi8qKiBDb25zdHJ1Y3QtaWQgZGVyaXZhdGlvbiBmb3IgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUge1xuICAvKipcbiAgICogUG9zaXRpb25hbCBpZHMgKGBSb3V0ZTBgLCBgUm91dGUxYCwgLi4uKSBhc3NpZ25lZCBpbiBlbWlzc2lvbiBvcmRlci4gVGhpc1xuICAgKiBpcyB0aGUgY29uc3RydWN0J3MgaGlzdG9yaWNhbCBpbnZlbnRvcnkgYW5kIHN0YXlzIGJ5dGUtaWRlbnRpY2FsIGZvclxuICAgKiBkZXBsb3llZCBzdGFja3MuIFRoZSBkZWZhdWx0LlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbiAgLyoqXG4gICAqIElkcyBkZXJpdmVkIGZyb20gdGhlIHJvdXRlIG1ldGhvZCBhbmQgcGF0dGVybiwgc28gaW5zZXJ0aW5nLCByZW1vdmluZywgb3JcbiAgICogcmVvcmRlcmluZyBhIHJvdXRlIGZhbWlseSBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZS4gSW50ZW5kZWQgZm9yXG4gICAqIG5ld2x5IGNyZWF0ZWQgZXhwbGljaXQgQVBJczogc3dpdGNoaW5nIGFuIGV4aXN0aW5nIGRlcGxveWVkIGV4cGxpY2l0IEFQSVxuICAgKiBmcm9tIGBsZWdhY3lgIHRvIGBzZW1hbnRpY2AgaW4gcGxhY2UgcmVuYW1lcyBldmVyeSByb3V0ZSwgd2hpY2ggaXMgaXRzZWxmIGFcbiAgICogY3JlYXRlLWJlZm9yZS1kZWxldGUgY29sbGlzaW9uLiBBZG9wdCBpdCBvbiBhbiBleGlzdGluZyBzdGFjayBvbmx5IHRocm91Z2hcbiAgICogdGhlIG5ldy1BUEkgc3dhcCBkZXNjcmliZWQgaW4gYFVQR1JBRElORy5tZGAuXG4gICAqL1xuICBTRU1BTlRJQyA9IFwic2VtYW50aWNcIixcbn1cblxuLyoqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiBUaGUgZGVmYXVsdCBmb3IgYSBzZXJ2ZXIgd2l0aCBubyBmYWNhZGUgYXR0YWNobWVudC4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIEEgc3RhdGljIEpXVCBhdXRob3JpemVyIChpc3N1ZXIgKyBhdWRpZW5jZSkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuICovXG4gIEpXVCA9IFwiand0XCIsXG4gIC8qKiBUaGUgZ2F0ZXdheSBhdXRob3JpemVyIGlzIE5PTkUgYW5kIHRoZSBydW50aW1lIHZhbGlkYXRlcyBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zLiBUaGUgZGVmYXVsdCBmb3IgYSBmYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXIuICovXG4gIFJVTlRJTUVfQkVBUkVSID0gXCJydW50aW1lLWJlYXJlclwiLFxuICAvKiogRGVsaWJlcmF0ZWx5IHB1YmxpYyBNQ1Agc2VydmVyOiBldmVyeSB0cmFuc3BvcnQgcm91dGUgaXMgcHVibGljLiBOZXZlciBhIGRlZmF1bHQuICovXG4gIE5PTkVfUFVCTElDID0gXCJub25lLXB1YmxpY1wiLFxufVxuXG4vKiogUHJlc2VuY2Utb25seSBza2VsZXRvbiBvZiB0aGUgdXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IHNlbGVjdHMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCB7XG4gIC8qKiBJZGVudGlmaWVzIHRoZSB1cHN0cmVhbSBhdXRob3JpemF0aW9uIHByb3ZpZGVyIHRoaXMgc2VydmVyIGZyb250cyAoZm9yIGV4YW1wbGUgYGF1dGhlb3J5YCkuIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlIGFuZCB1c2VzIGl0cyBwcmVzZW5jZSB0byBzZWxlY3QgdGhlIGBydW50aW1lLWJlYXJlcmAgZGVmYXVsdC4gKi9cbiAgcmVhZG9ubHkgcHJvdmlkZXJJZDogc3RyaW5nO1xufVxuXG4vKiogUnVudGltZS1zaWRlIGRlY2xhcmF0aW9uIHRoYXQgdGhlIHRyYW5zcG9ydCByb3V0ZXMgdmFsaWRhdGUgUkZDIDk3MjggYmVhcmVyIHRva2VucyBhdCBydW50aW1lLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnMge1xuICAvKiogQXNzZXJ0IHRoZSBydW50aW1lIHJlZ2lzdGVycyB0aGUgdHJhbnNwb3J0IHJvdXRlcyB3aXRoIHRoZSBydW50aW1lLXZhbGlkYXRlZCBiZWFyZXIgcG9zdHVyZSAoR28gYEZhY2FkZUNvbmZpZy5SZXF1aXJlQmVhcmVyVG9rZW5gLCBUUyBgcmVxdWlyZUJlYXJlclRva2VuTWlkZGxld2FyZWAsIFB5dGhvbiBgcmVxdWlyZV9iZWFyZXJfdG9rZW5fbWlkZGxld2FyZWApLiBNdXN0IGJlIGB0cnVlYC4gKi9cbiAgcmVhZG9ubHkgcmVxdWlyZUJlYXJlclRva2VuOiBib29sZWFuO1xufVxuXG4vKiogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB7XG4gIC8qKlxuICAgKiBEaXNhYmxlIHRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGFuZCBhZHZlcnRpc2UgYW4gb3duZWQgb3JkaW5hcnlcbiAgICogY3VzdG9tIGRvbWFpbiBhcyB0aGUgb25seSBNQ1AgYXV0aG9yaXR5LlxuICAgKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKlxuICAgKiBEaXNhYmxlIHRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGFuZCByZXF1aXJlIG11dHVhbCBUTFMgb24gZXZlcnlcbiAgICogY3VzdG9tIGRvbWFpbiBtYXBwZWQgdG8gdGhlIGNvbnN0cnVjdC1vd25lZCBBUEkuIFRoZSBvd25lZCBkb21haW4nc1xuICAgKiBgbXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHRoZSBjb25jcmV0ZSBsb2NrOyBhbiBlbnVtIGFsb25lIG9yIGFuXG4gICAqIGV4dGVybmFsL2F0dGFjaGVkIGZyb250IGRvb3IgbmV2ZXIgc2F0aXNmaWVzIGl0LlxuICAgKi9cbiAgTE9DS0VEID0gXCJsb2NrZWRcIixcbn1cblxuLyoqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyB7XG4gIC8qKiBEZW5pYWwgbWV0cmljIG5hbWUuIE11c3QgYmUgYGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRgLiBAZGVmYXVsdCBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkICovXG4gIHJlYWRvbmx5IG1ldHJpY05hbWU/OiBzdHJpbmc7XG4gIC8qKiBCb3VuZGVkIG1ldHJpYyBkaW1lbnNpb25zLiBNdXN0IGJlIGV4YWN0bHkgYG91dGNvbWVgIGFuZCBgcm91dGVfZmFtaWx5YC4gQGRlZmF1bHQgW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXSAqL1xuICByZWFkb25seSBkaW1lbnNpb25zPzogc3RyaW5nW107XG59XG5cbi8qKiBPd25pbmctQVBJIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zIHtcbiAgLyoqIFN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC4gKi9cbiAgcmVhZG9ubHkgcmF0ZUxpbWl0OiBudW1iZXI7XG4gIC8qKiBTdGFnZSBidXJzdCBsaW1pdC4gKi9cbiAgcmVhZG9ubHkgYnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG4vKiogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgZGVmZW5zZS1pbi1kZXB0aCBkZWNpc2lvbnMgKHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2ApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB7XG4gIC8qKiBXaGV0aGVyIHRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgaGFzIGFjY2VzcyBsb2dnaW5nIGVuYWJsZWQuIE11c3QgYmUgdHJ1ZS4gKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgLyoqIFRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZzogQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM7XG59XG5cbi8qKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSBIVFRQUyBKV1QgaXNzdWVyIFVSTC4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBpc3N1ZXI/OiBzdHJpbmc7XG4gIC8qKiBBY2NlcHRlZCBKV1QgYXVkaWVuY2VzLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGF1ZGllbmNlPzogc3RyaW5nW107XG4gIC8qKiBJZGVudGl0eSBzb3VyY2VzIGZvciB0aGUgSldUIGF1dGhvcml6ZXIuIEBkZWZhdWx0IFtcIiRyZXF1ZXN0LmhlYWRlci5BdXRob3JpemF0aW9uXCJdICovXG4gIHJlYWRvbmx5IGlkZW50aXR5U291cmNlPzogc3RyaW5nW107XG4gIC8qKiBKV1QgYXV0aG9yaXplciByZXNvdXJjZSBuYW1lLiBAZGVmYXVsdCB0aGUgYXV0aG9yaXplciBjb25zdHJ1Y3QgaWQgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKiogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZm9yIGV4YW1wbGUsIGBtY3AuZXhhbXBsZS5jb21gKS4gKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVBcm5gLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVgLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYW4gYXV0b21hdGljYWxseSBjcmVhdGVkIENOQU1FIHJlY29yZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyB0cnVzdHN0b3JlIGZvciB0aGUgb3duZWQgY3VzdG9tIGRvbWFpbi5cbiAgICpcbiAgICogU3VwcGx5aW5nIHRoaXMgaXMgdGhlIGNvbmNyZXRlIGBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEYFxuICAgKiBldmlkZW5jZTogdGhlIGNvbnN0cnVjdCBkaXNhYmxlcyB0aGUgZGVmYXVsdCBleGVjdXRlLWFwaSBlbmRwb2ludCBhbmRcbiAgICogcmVxdWlyZXMgZXZlcnkgQVBJIG1hcHBpbmcgYm91bmQgdG8gdGhlIG93bmVkIEFQSSB0byB0YXJnZXQgYSBkb21haW4gd2hvc2VcbiAgICogYE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBjYXJyaWVzIGEgdHJ1c3RzdG9yZSBVUkkuIFN1cHBseWluZyBpdCB3aXRoIGFueVxuICAgKiBvdGhlciBvcmlnaW4gZGVjaXNpb24sIG9yIHNlbGVjdGluZyBgTE9DS0VEYCB3aXRob3V0IGl0LCBmYWlscyBzeW50aGVzaXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbXV0dWFsVGxzQXV0aGVudGljYXRpb24/OiBhcGlnd3YyLk1UTFNDb25maWc7XG59XG5cbi8qKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgXCIkZGVmYXVsdFwiICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgdGhlIGFjY2VzcyBsb2cgZ3JvdXAuIFZhbGlkIG9ubHkgd2hlbiBhY2Nlc3MgbG9nZ2luZ1xuICAgKiBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC5cbiAgICogQGRlZmF1bHQgMTAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCAyMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKiogT3duZWQtQVBJIHNwZWNpYWxpemF0aW9uIGZvciBzdGFuZGFsb25lIE1DUCBzZXJ2ZXJzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnMge1xuICAvKiogT3B0aW9uYWwgQVBJIG5hbWUuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIE9wdGlvbmFsIGN1c3RvbSBkb21haW4gb3duZWQgYnkgdGhpcyBjb25zdHJ1Y3QuICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uIEFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlZmF1bHQgb24uXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKiogT3JkZXJlZCBNQ1Agcm91dGUtcGF0dGVybiBmYW1pbHkgd2lyZWQgYXMgb25lIGZhY2FkZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUm91dGVGYW1pbHkge1xuICAvKipcbiAgICogT3JkZXJlZCBzeW50aGVzaXMtdGltZSBNQ1Agcm91dGUgcGF0dGVybnMuXG4gICAqXG4gICAqIEVhY2ggc2VnbWVudCBpcyBlaXRoZXIgYSBsaXRlcmFsIFJGQyAzOTg2IHBhdGggc2VnbWVudCBvciBhIGNvbXBsZXRlXG4gICAqIGB7cGFyYW1ldGVyX25hbWV9YCBzZWdtZW50LiBDREsgdG9rZW5zLCBvcmlnaW5zLCBlbXB0eSBzZWdtZW50cywgZG90XG4gICAqIHNlZ21lbnRzLCBncmVlZHkgcGFyYW1ldGVycywgYW5kIGR1cGxpY2F0ZSBwYXR0ZXJucyBhcmUgcmVqZWN0ZWQuXG4gICAqL1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdpcmUgdGhlIGFsZ2VicmEtZGVyaXZlZCB1bnNjb3BlZCBhdXRob3JpemF0aW9uLXNlcnZlciBkaXNjb3Zlcnkgcm91dGUuXG4gICAqIFRoZSBydW50aW1lIG11c3Qgc3VwcGx5IGBGYWNhZGVDb25maWcuUm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJgIHRvby5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5PzogYm9vbGVhbjtcbn1cblxuLyoqIER5bmFtb0RCLWJhY2tlZCBNQ1Agc2Vzc2lvbi1zdGF0ZSBjb25maWd1cmF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgZW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgbmFtZS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgYXV0by1nZW5lcmF0ZWRcbiAgICovXG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVFRMIGluIG1pbnV0ZXMgZm9yIHNlc3Npb24gcmVjb3Jkcy4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXNcbiAgICogZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgcmVtb3ZhbCBwb2xpY3kuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbn1cblxuLyoqIE9uZSBkZXJpdmVkIE1DUCBPQXV0aCBmYWNhZGUgcm91dGUgZmFtaWx5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZSB7XG4gIHJlYWRvbmx5IG1jcFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbWNwTWV0aG9kczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSB0b2tlblBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcmVnaXN0ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xuICByZWFkb25seSBjYWxsYmFja1BhdHRlcm46IHN0cmluZztcbn1cblxuLyoqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKiogTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIHRoZSBydW50aW1lLWNvbXBvc2VkIE1DUCBmYWNhZGUuICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIE1DUCBmYWNhZGUgZmFtaWxpZXMgdGhhdFxuICAgKiBzaGFyZSBvbmUgTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5XG4gICAqIHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSb3V0ZS1lbWlzc2lvbiBtb2RlbC5cbiAgICpcbiAgICogYGV4cGxpY2l0YCAodGhlIGRlZmF1bHQpIHdpcmVzIHRoZSBmdWxsIGRlcml2ZWQgcm91dGUgaW52ZW50b3J5IGFzIG9uZSBIVFRQXG4gICAqIEFQSSB2MiByb3V0ZSBwZXIgcm91dGUga2V5IGFuZCBpcyBieXRlLXN0YWJsZSBmb3IgZGVwbG95ZWQgc3RhY2tzLlxuICAgKiBgY29uc29saWRhdGVkYCB3aXJlcyBleGFjdGx5IHR3byBncmVlZHkgcm91dGVzLCBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAsXG4gICAqIGFuZCBpcyB2YWxpZCBvbmx5IGZvciB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCB0cmFuc3BvcnRcbiAgICogcG9zdHVyZXM7IGBpYW1gIGFuZCBgand0YCBhcmUgcmVmdXNlZCBhdCBzeW50aGVzaXMuXG4gICAqXG4gICAqIENvbnNvbGlkYXRlZCBtb2RlIGlzIGFsbG93ZWQgb24gYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLCBvciBvbiBhbiBhdHRhY2hlZFxuICAgKiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lLiBcIk5vIHJvdXRlc1wiIGlzIGVuZm9yY2VkIG92ZXIgdGhlXG4gICAqIHdob2xlIHN0YWNrLCBub3QganVzdCB0aGUgQVBJJ3Mgb3duIGNoaWxkcmVuOiBhIHJvdXRlIHdpcmVkIG9udG8gdGhlXG4gICAqIGF0dGFjaGVkIEFQSSBmcm9tIGFueSBzaWJsaW5nIGNvbnN0cnVjdCBzY29wZSBpcyByZWZ1c2VkLCBiZWNhdXNlIGl0IGhvbGRzXG4gICAqIGEgcm91dGUga2V5IHRoZSBncmVlZHkgcm91dGVzIHdvdWxkIGNvbGxpZGUgd2l0aC5cbiAgICpcbiAgICogQSBjb25zdW1lciBtYXkgc3RpbGwgYWRkIGV4cGxpY2l0LCBtb3JlIHNwZWNpZmljIHJvdXRlcyB0byB0aGUgY29uc29saWRhdGVkXG4gICAqIEFQSSBhZnRlcndhcmRzLCBpbiBlaXRoZXIgdGhlIGF0dGFjaGVkIG9yIHRoZSBjb25zdHJ1Y3Qtb3duZWQgbW9kZS4gVGhhdFxuICAgKiBleGNlcHRpb24gaXMgZW5mb3JjZWQgYXQgc3ludGhlc2lzIHRpbWUgYW5kIGlzIGFsbG93ZWQgb25seSB3aGVuIHRoZSBhZGRlZFxuICAgKiByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciBhbmQgZG9lcyBub3QgcmVkZWNsYXJlIHRoZSBncmVlZHlcbiAgICogYEFOWSAvYCBvciBgQU5ZIC97cHJveHkrfWAga2V5LiBXaXRoaW4gaXQsIGEgZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBiZWF0cyB0aGVcbiAgICogZ3JlZWR5IHJvdXRlcyBieSBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlLCBhbmQgYSB3cm9uZy1tZXRob2QgaGl0IG9uIHN1Y2ggYVxuICAgKiBwYXRoIGZhbGxzIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVNb2RlbD86IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWw7XG5cbiAgLyoqXG4gICAqIENvbnN0cnVjdC1pZCBkZXJpdmF0aW9uIGZvciB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwuXG4gICAqXG4gICAqIGBsZWdhY3lgICh0aGUgZGVmYXVsdCkgYXNzaWducyBwb3NpdGlvbmFsIGlkcyBpbiBlbWlzc2lvbiBvcmRlciBhbmQgaXNcbiAgICogYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy4gYHNlbWFudGljYCBkZXJpdmVzIGVhY2ggaWQgZnJvbSBpdHMgcm91dGVcbiAgICogbWV0aG9kIGFuZCBwYXR0ZXJuLCBzbyBpbnNlcnRpbmcsIHJlbW92aW5nLCBvciByZW9yZGVyaW5nIGEgcm91dGUgZmFtaWx5XG4gICAqIG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlOyBpdCBpcyBpbnRlbmRlZCBmb3IgbmV3bHkgY3JlYXRlZCBleHBsaWNpdFxuICAgKiBBUElzLlxuICAgKlxuICAgKiBTd2l0Y2hpbmcgYW4gZXhpc3RpbmcgZGVwbG95ZWQgZXhwbGljaXQgQVBJIGZyb20gYGxlZ2FjeWAgdG8gYHNlbWFudGljYCBpblxuICAgKiBwbGFjZSByZW5hbWVzIGV2ZXJ5IHJvdXRlIGluIG9uZSB1cGRhdGUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIHJvdXRlLWtleSBjb2xsaXNpb24gdGhlIG1pZ3JhdGlvbiBjaGVjayByZWZ1c2VzLiBBZG9wdFxuICAgKiBgc2VtYW50aWNgIG9uIGFuIGV4aXN0aW5nIHN0YWNrIG9ubHkgdGhyb3VnaCB0aGUgbmV3LUFQSSBzd2FwIGRvY3VtZW50ZWQgaW5cbiAgICogYFVQR1JBRElORy5tZGAuXG4gICAqXG4gICAqIFRoaXMgcHJvcCBhcHBsaWVzIHRvIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgb25seS4gVGhlIGBjb25zb2xpZGF0ZWRgIG1vZGVsXG4gICAqIGFscmVhZHkgZW1pdHMgdGhlIHR3byBmaXhlZCBzZW1hbnRpYyBpZHMgYFJvdXRlQW55Um9vdGAgYW5kIGBSb3V0ZUFueVByb3h5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSByb3V0ZUlkTW9kZT86IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlO1xuXG4gIC8qKlxuICAgKiBDT1JTIHByZWZsaWdodCBmb3IgYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBTZXQgdG8gYHRydWVgIGZvciBBcHBUaGVvcnlcbiAgICogZGVmYXVsdHMgb3Igc3VwcGx5IGFuIGBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnNgIG9iamVjdC4gSW52YWxpZCBpblxuICAgKiBhdHRhY2ggbW9kZSwgd2hlcmUgdGhlIG93bmluZyBBUEkgY29uZmlndXJlcyBDT1JTLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeGlzdGluZyBIVFRQIEFQSSB0byBhdHRhY2ggdG8uIEF0dGFjaCBtb2RlIGlzIHRoZSBwcmltYXJ5IGZyb250LWRvb3JcbiAgICogdG9wb2xvZ3kgYW5kIG5ldmVyIGNyZWF0ZXMgYW4gYEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlgIHJlc291cmNlLlxuICAgKiBAZGVmYXVsdCBhIGNvbnN0cnVjdC1vd25lZCBIdHRwQXBpXG4gICAqL1xuICByZWFkb25seSBhcGk/OiBhcGlnd3YyLklIdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lIHVzZWQgd2hlbiBkZXJpdmluZyBhdHRhY2gtbW9kZSBleGVjdXRlLWFwaSBlbmRwb2ludCB0ZW1wbGF0ZXMuXG4gICAqIFVzZSBgJGRlZmF1bHRgIGZvciB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdCBzdGFnZS4gV2hlbiBvbWl0dGVkLCB0aGUgc3RhZ2VcbiAgICogaXMgbm90IGRldGVybWluYWJsZSBhbmQgdGhlIHRlbXBsYXRlcyByZXRhaW4gdGhlIGJhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luLlxuICAgKiBUaGlzIHByb3AgZG9lcyBub3QgY3JlYXRlLCBpbXBvcnQsIG9yIG11dGF0ZSBhIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF0dGFjaGVkQXBpU3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEdvIGBydW50aW1lL21jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAgc2VydmVzIG9ubHkgdGhlIGNhbm9uaWNhbCBkZWZhdWx0XG4gICAqIGZhbWlseS4gTm9uY2Fub25pY2FsIHBhdHRlcm5zIHJlcXVpcmUgYXBwLW93bmVkIHJ1bnRpbWUgcm91dGUgcmVnaXN0cmF0aW9uXG4gICAqIHRoYXQgbWF0Y2hlcyB0aGUgY29uc3RydWN0J3MgYHJvdXRlSW52ZW50b3J5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKClcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlRmFtaWx5PzogQXBwVGhlb3J5TWNwUm91dGVGYW1pbHk7XG5cbiAgLyoqXG4gICAqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEFuIGV4cGxpY2l0IHNlbGVjdGlvbiBvdmVycmlkZXMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gV2hlbiBpdCBpc1xuICAgKiBvbWl0dGVkLCBhIHNlcnZlciB0aGF0IGF0dGFjaGVzIGBmYWNhZGVgIHJlc29sdmVzIHRvIGBydW50aW1lLWJlYXJlcmAgYW5kIGFcbiAgICogcGxhaW4gdHJhbnNwb3J0IHNlcnZlciByZXNvbHZlcyB0byBgaWFtYC4gYG5vbmUtcHVibGljYCBpcyBuZXZlciBhIGRlZmF1bHRcbiAgICogYW5kIGNhcnJpZXMgdGhlIGRlZmVuc2UtaW4tZGVwdGggZmxvb3IuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIgd2hlbiBgZmFjYWRlYCBpcyBhdHRhY2hlZCwgb3RoZXJ3aXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcblxuICAvKipcbiAgICogVXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IG1hcmtzIHRoaXMgc2VydmVyIGFzIGZhY2FkZS1jb25maWd1cmVkLlxuICAgKlxuICAgKiBUaGUgYXR0YWNobWVudCdzIHByZXNlbmNlIHNlbGVjdHMgdGhlIGBydW50aW1lLWJlYXJlcmAgcG9zdHVyZSBkZWZhdWx0LlxuICAgKiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50O1xuXG4gIC8qKlxuICAgKiBSdW50aW1lLXNpZGUgUkZDIDk3MjggYmVhcmVyIHZhbGlkYXRpb24gZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVkIGJ5IGB0cmFuc3BvcnRQb3N0dXJlOiBSVU5USU1FX0JFQVJFUmAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnlcbiAgICogb3RoZXIgcG9zdHVyZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBydW50aW1lUG9zdHVyZT86IEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucztcblxuICAvKipcbiAgICogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kXG4gICAqIE5PTkVfUFVCTElDLiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gaXMgcmVmdXNlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk/OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcbiAgcHJpdmF0ZSByb3V0ZUlkTW9kZSA9IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgcHJpdmF0ZSByZWFkb25seSByb3V0ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgLyoqXG4gICAqIFJlc29sdmVkIHRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEZhY2FkZS1jb25maWd1cmVkIHNlcnZlcnMgcmVzb2x2ZSB0byBgcnVudGltZS1iZWFyZXJgIHVubGVzc1xuICAgKiBgdHJhbnNwb3J0UG9zdHVyZWAgb3ZlcnJpZGVzIHRoZSBkZWZhdWx0OyBwbGFpbiB0cmFuc3BvcnQgc2VydmVycyByZXNvbHZlXG4gICAqIHRvIGBpYW1gLiBEZWxpYmVyYXRlbHkgcHVibGljIHNlcnZlcnMgbXVzdCBzZWxlY3QgYG5vbmUtcHVibGljYCBleHBsaWNpdGx5LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG4gIC8qKlxuICAgKiBEZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlcyBmb3IgdGhlIG9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgdGhlc2UgYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZXMsIG5vdCBkZWNsYXJhdGlvbnMgb2ZcbiAgICogcHVibGljIGF1dGhvcml0eS4gQW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkOyB0aGUgb3JpZ2luIGlzIGRlcml2ZWRcbiAgICogZnJvbSBgYXBpSWRgLCB0aGUgc3RhY2sgcmVnaW9uIGFuZCBVUkwgc3VmZml4LCBwbHVzXG4gICAqIGBhdHRhY2hlZEFwaVN0YWdlTmFtZWAgd2hlbiBzdXBwbGllZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlSW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeTtcblxuICAvKipcbiAgICogRmlyc3QgZGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgYW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkLiBUaGlzIHZhbHVlIGlzIGFuXG4gICAqIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZSBkZXJpdmVkIGJ5IHRoZSBzYW1lIHJ1bGVzIGFzIGBlbmRwb2ludHNgLCBub3RcbiAgICogdGhlIGZyb250IGRvb3IncyBwdWJsaWMgYXV0aG9yaXR5LlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYGVuZHBvaW50c2AuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBtY3BQYXRoc2AuICovXG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoOiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzYCBvciBgcm91dGVJbnZlbnRvcnlgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGg6IHN0cmluZztcblxuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHMpO1xuICAgIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHMpO1xuICAgIGNvbnN0IHJvdXRlRmFtaWx5ID0gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHMpO1xuICAgIGNvbnN0IG93bmVkT3B0aW9ucyA9IG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wcyk7XG5cbiAgICBjb25zdCBwb3N0dXJlID0gcHJvcHMudHJhbnNwb3J0UG9zdHVyZVxuICAgICAgPz8gKHByb3BzLmZhY2FkZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICAgICA6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNKTtcbiAgICB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZSk7XG4gICAgdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KHByb3BzLmZhY2FkZSk7XG4gICAgdmFsaWRhdGVQb3N0dXJlR3VhcmRzKHByb3BzLCByb3V0ZUZhbWlseSwgcG9zdHVyZSk7XG4gICAgdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChwcm9wcywgcG9zdHVyZSwgb3duZWRPcHRpb25zKTtcbiAgICBjb25zdCBvcmlnaW5SZWFjaGFiaWxpdHkgPSByZXNvbHZlT3JpZ2luUmVhY2hhYmlsaXR5KHRoaXMsIHByb3BzLCBvd25lZE9wdGlvbnMpO1xuICAgIGNvbnN0IHJvdXRlTW9kZWwgPSByZXNvbHZlUm91dGVNb2RlbChwcm9wcyk7XG4gICAgdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShyb3V0ZU1vZGVsLCBwb3N0dXJlKTtcbiAgICBjb25zdCByb3V0ZUlkTW9kZSA9IHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wcyk7XG4gICAgdGhpcy5yb3V0ZUlkTW9kZSA9IHJvdXRlSWRNb2RlO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCAmJiBwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZCh0aGlzLCBwcm9wcy5hcGkpO1xuICAgIH1cbiAgICBjb25zdCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQgPSBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDO1xuICAgIGNvbnN0IHVwc3RyZWFtQ2FsbGJhY2tQYXRoID0gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzKTtcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgICB1cHN0cmVhbUNhbGxiYWNrUGF0aCxcbiAgICApO1xuICAgIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkodGhpcy5yb3V0ZUludmVudG9yeSwgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRocyA9IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLm1hcChcbiAgICAgIChyb3V0ZSkgPT4gcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLFxuICAgICk7XG4gICAgdGhpcy5tY3BQYXRoID0gdGhpcy5tY3BQYXRoc1swXTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNbMF07XG5cbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBvd25lZE9wdGlvbnMuYXBpTmFtZSxcbiAgICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6IGZhbHNlLFxuICAgICAgICBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50OiBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICAgICAgIHx8IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICAgICAgID8gdHJ1ZVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpIH0pLm93bmVkQXBpID0gYXBpO1xuICAgICAgdGhpcy5hcGkgPSBhcGk7XG4gICAgICBpZiAob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQpIHtcbiAgICAgICAgcmVnaXN0ZXJPd25lZERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbih0aGlzLCBhcGkpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzLCBwb3N0dXJlKTtcbiAgICBsZXQgZmlyc3RUcmFuc3BvcnRSb3V0ZTogYXBpZ3d2Mi5IdHRwUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEKSB7XG4gICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gdGhpcy5hZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICAgICAgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQsXG4gICAgICAgIFwiL1wiLFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICk7XG4gICAgICBjb25zdCBwcm94eVJvdXRlID0gdGhpcy5hZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICAgICAgQ09OU09MSURBVEVEX1BST1hZX1JPVVRFX0lELFxuICAgICAgICBcIi97cHJveHkrfVwiLFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICk7XG4gICAgICByZWdpc3RlckNvbnNvbGlkYXRlZEF0dGFjaFZhbGlkYXRpb24odGhpcywgdGhpcy5hcGksIFtmaXJzdFRyYW5zcG9ydFJvdXRlLCBwcm94eVJvdXRlXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHJ1bnRpbWVPd25lZEF1dGggPSBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2YgdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMpIHtcbiAgICAgICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykge1xuICAgICAgICAgIGNvbnN0IGNyZWF0ZWQgPSB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICAgIHJvdXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICAgICB0b0h0dHBNZXRob2QobWV0aG9kKSxcbiAgICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICAgICApO1xuICAgICAgICAgIGZpcnN0VHJhbnNwb3J0Um91dGUgPSBmaXJzdFRyYW5zcG9ydFJvdXRlID8/IGNyZWF0ZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuYXV0aG9yaXplUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5yZWdpc3RlclBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIFRoZSB1cHN0cmVhbSBjYWxsYmFjayBpcyBzdGFnZS1nbG9iYWwsIG5vdCBwZXIga2luZDogd2lyZSBpdCBleGFjdGx5IG9uY2UuXG4gICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuLFxuICAgICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHBvc3R1cmVNYXJrZXJUYXJnZXQgPSAodGhpcy5vd25lZEFwaT8ubm9kZS5kZWZhdWx0Q2hpbGRcbiAgICAgID8/IGZpcnN0VHJhbnNwb3J0Um91dGU/Lm5vZGUuZGVmYXVsdENoaWxkKSBhcyBhcGlnd3YyLkNmbkFwaSB8IGFwaWd3djIuQ2ZuUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgcG9zdHVyZU1hcmtlclRhcmdldD8uYWRkTWV0YWRhdGEoTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSwge1xuICAgICAgcG9zdHVyZSxcbiAgICAgIGNvbnRyYWN0X2lkOiBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQsXG4gICAgICByb3V0ZV9jb3VudDogdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubGVuZ3RoLFxuICAgICAgcnVudGltZV9wb3N0dXJlX2RlY2xhcmVkOiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGlmIChcbiAgICAgICAgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICYmIHRoaXMub3duZWRBcGkgIT09IHVuZGVmaW5lZFxuICAgICAgKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIHRoaXMub3duZWRBcGkpO1xuICAgICAgfVxuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICBwcm9wcy5hcGkgPT09IHVuZGVmaW5lZFxuICAgICAgJiYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgIHx8IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRClcbiAgICAgICYmIHRoaXMuZW5kcG9pbnRzLnNvbWUoKGVuZHBvaW50KSA9PiBlbmRwb2ludC5pbmNsdWRlcyhcIi5leGVjdXRlLWFwaS5cIikpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgbXVzdCBhZHZlcnRpc2UgdGhlIG93bmVkIGN1c3RvbSBkb21haW4sIG5ldmVyIHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCB0aGlzLm5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCksIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgbmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMucm91dGVJZE1vZGUgIT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDKSB7XG4gICAgICByZXR1cm4gYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpO1xuICAgIGlmICh0aGlzLnJvdXRlSWRzLmhhcyhpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgc2VtYW50aWMgZGVyaXZlcyB0aGUgZHVwbGljYXRlIHJvdXRlIGNvbnN0cnVjdCBpZCAke2lkfSBmb3Igcm91dGUga2V5ICR7bWV0aG9kfSAke3BhdGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMucm91dGVJZHMuYWRkKGlkKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBpZCwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgbXRsczogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoY29uZmlndXJlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKGNvbmZpZ3VyZWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgPyBlcnIubWVzc2FnZS5yZXBsYWNlKC9ebWNwcm91dGVzOiAvLCBcIlwiKVxuICAgICAgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBpcyBpbnZhbGlkOiAke3JlYXNvbn1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIGNhbGxiYWNrUGF0dGVybjogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkNPTlRSQUNUX1ZFUlNJT04sXG4gICAgcm91dGVzOiBwYXR0ZXJucy5tYXAoKG1jcFBhdHRlcm4pID0+ICh7XG4gICAgICBtY3BQYXR0ZXJuLFxuICAgICAgbWNwTWV0aG9kczogW1wiUE9TVFwiLCBcIkdFVFwiLCBcIkRFTEVURVwiXSxcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gICAgY2FsbGJhY2tQYXR0ZXJuLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnJlZ2lzdGVyUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybik7XG4gIH1cbiAgaWYgKGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICBpZiAocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgcmVxdWlyZXMgYXR0YWNoIG1vZGUgd2l0aCBhcGlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICYmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpXG4gICAgICB8fCAhL14oPzpcXCRkZWZhdWx0fFtBLVphLXowLTlfLV17MSwxMjh9KSQvLnRlc3QocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgQVBJIEdhdGV3YXkgc3RhZ2UgbmFtZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHByb3BzLm93bmVkQXBpICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcIm93bmVkQXBpXCIpO1xuICBpZiAocHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJhcGlOYW1lXCIpO1xuICBpZiAocHJvcHMuY29ycyAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJjb3JzXCIpO1xuICBpZiAocHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImRvbWFpblwiKTtcbiAgaWYgKHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcInN0YWdlXCIpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggIT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2ggbW9kZSB3aXRoIGFwaSBjYW5ub3QgY29uZmlndXJlIG93bmVkLUFQSSBwcm9wczogJHtpbnZhbGlkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICBpZiAocHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuYXBpTmFtZSBhbmQgZGVwcmVjYXRlZCBhcGlOYW1lIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5kb21haW4gIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gYW5kIGRlcHJlY2F0ZWQgZG9tYWluIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgYW5kIGRlcHJlY2F0ZWQgc3RhZ2UgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFwaU5hbWU6IHByb3BzLm93bmVkQXBpPy5hcGlOYW1lID8/IHByb3BzLmFwaU5hbWUsXG4gICAgZG9tYWluOiBwcm9wcy5vd25lZEFwaT8uZG9tYWluID8/IHByb3BzLmRvbWFpbixcbiAgICBzdGFnZTogcHJvcHMub3duZWRBcGk/LnN0YWdlID8/IHByb3BzLnN0YWdlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU9wdGlvbnMob3B0aW9ucz86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyk6IE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICBjb25zdCBhY2Nlc3NMb2dnaW5nID0gb3B0aW9ucz8uYWNjZXNzTG9nZ2luZyA/PyB0cnVlO1xuICBpZiAoIWFjY2Vzc0xvZ2dpbmcgJiYgb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nUmV0ZW50aW9uIHJlcXVpcmVzIGFjY2Vzc0xvZ2dpbmcgdG8gYmUgZW5hYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZ0VuYWJsZWQgPSBvcHRpb25zPy50aHJvdHRsaW5nRW5hYmxlZCA/PyB0cnVlO1xuICBpZiAoXG4gICAgIXRocm90dGxpbmdFbmFibGVkXG4gICAgJiYgKG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgdGhyb3R0bGluZyBsaW1pdHMgcmVxdWlyZSB0aHJvdHRsaW5nRW5hYmxlZCB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXRlTGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUO1xuICBjb25zdCBidXJzdExpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHJhdGVMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nUmF0ZUxpbWl0XCIpO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKGJ1cnN0TGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0J1cnN0TGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VOYW1lOiBvcHRpb25zPy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiLFxuICAgIGFjY2Vzc0xvZ2dpbmcsXG4gICAgYWNjZXNzTG9nUmV0ZW50aW9uOiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICB0aHJvdHRsaW5nRW5hYmxlZCxcbiAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiByYXRlTGltaXQsXG4gICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IGJ1cnN0TGltaXQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgY29uc3QgaGFzTGVnYWN5ID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAocHJvcHMuc2Vzc2lvblN0YXRlICE9PSB1bmRlZmluZWQgJiYgaGFzTGVnYWN5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHNlc3Npb25TdGF0ZSBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBkZXByZWNhdGVkIHNlc3Npb24tdGFibGUgcHJvcHNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGVuYWJsZWQgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LmVuYWJsZWQgPz8gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlID8/IHRydWU7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lID8/IHByb3BzLnNlc3Npb25UYWJsZU5hbWU7XG4gIGNvbnN0IHR0bE1pbnV0ZXMgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXNcbiAgICA/PyBwcm9wcy5zZXNzaW9uVHRsTWludXRlc1xuICAgID8/IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUztcbiAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgaWYgKFxuICAgICFlbmFibGVkXG4gICAgJiYgKHRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRpc2FibGVkIHNlc3Npb24gc3RhdGUgY2Fubm90IGNvbmZpZ3VyZSB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIG9yIHJlbW92YWxQb2xpY3lcIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7IGVuYWJsZWQsIHRhYmxlTmFtZSwgdHRsTWludXRlcywgcmVtb3ZhbFBvbGljeSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkgcmV0dXJuO1xuICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGlzc3VlcixcbiAgICAgIGZhbHNlLFxuICAgICAgXCJhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBqd2tzVXJpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiandrc1VyaSBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHVzZXJpbmZvIG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy50cmFuc3BvcnRBdXRob3JpemVyO1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHtcbiAgICAgIGlmIChjb25maWd1cmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGlzIG9ubHkgdmFsaWQgd2l0aCB0cmFuc3BvcnRQb3N0dXJlIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAgICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgICAgIDogbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgfVxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBvc3R1cmVMYWJlbChwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTogcmV0dXJuIFwiSUFNXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDogcmV0dXJuIFwiSldUXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOiByZXR1cm4gXCJSVU5USU1FX0JFQVJFUlwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzogcmV0dXJuIFwiTk9ORV9QVUJMSUNcIjtcbiAgICBkZWZhdWx0OiByZXR1cm4gU3RyaW5nKHBvc3R1cmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogdm9pZCB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOlxuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVNb2RlbDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVCBvciAuQ09OU09MSURBVEVEXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUoXG4gIHJvdXRlTW9kZWw6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgaXMgb25seSB2YWxpZCBmb3IgdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiBvciBOT05FX1BVQkxJQzsgdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0ga2VlcHMgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsIGJlY2F1c2UgY29uc29saWRhdGlvbiBtdXN0IG5ldmVyIGNoYW5nZSBnYXRld2F5IGFkbWlzc2lvbmAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVJZE1vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVJZE1vZGU7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1lcbiAgICB8fCBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5TRU1BTlRJQ1xuICApIHtcbiAgICByZXR1cm4gY29uZmlndXJlZDtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlSWRNb2RlIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZIG9yIC5TRU1BTlRJQ1wiLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSB0d28gZ3JlZWR5IHJvdXRlIGtleXMgYSBjb25zb2xpZGF0ZWQgbW9kZWwgb3ducy4gQSBjb25zdW1lciByb3V0ZSB0aGF0XG4gKiByZWRlY2xhcmVzIG9uZSBvZiB0aGVtIHdvdWxkIG1ha2UgdGhlIEFQSSByZWplY3QgdGhlIHVwZGF0ZS5cbiAqL1xuY29uc3QgQ09OU09MSURBVEVEX0dSRUVEWV9ST1VURV9LRVlTID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4vKipcbiAqIFJlc29sdmUgYW4gYEFwaUlkYCAob3IgYW55IHRlbXBsYXRlIHZhbHVlKSB0byBhIGNvbXBhcmFibGUgc3RyaW5nLCBzbyBhXG4gKiBgUmVmYCB0b2tlbiBhbmQgaXRzIGxvZ2ljYWwgaWQgY29tcGFyZSBlcXVhbCBhY3Jvc3MgdHdvIHRlbXBsYXRlcyBvZiB0aGUgc2FtZVxuICogc3RhY2suXG4gKi9cbmZ1bmN0aW9uIGNvbXBhcmFibGVBcGlJZChzY29wZTogQ29uc3RydWN0LCB2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShTdGFjay5vZihzY29wZSkucmVzb2x2ZSh2YWx1ZSkpO1xufVxuXG4vKipcbiAqIEV2ZXJ5IEFQSSBHYXRld2F5IHYyIHJvdXRlIGJvdW5kIHRvIGBhcGlgLCByZWdhcmRsZXNzIG9mIHdoaWNoIGNvbnN0cnVjdFxuICogc2NvcGUgY3JlYXRlZCBpdC5cbiAqXG4gKiBgYXBpLm5vZGUuY2hpbGRyZW5gIG9ubHkgc2VlcyByb3V0ZXMgdGhlIEFQSSBpdHNlbGYgKG9yIGEgY2hpbGQgc2NvcGUpXG4gKiBjcmVhdGVkLCB3aGljaCBtaXNzZXMgdGhlIGNvbW1vbiBwYXR0ZXJuIG9mIGEgc3RhY2stbGV2ZWwgY29uc3RydWN0IHdpcmluZyBhXG4gKiByb3V0ZSBvbnRvIGFuIGF0dGFjaGVkIEFQSS4gV2Fsa2luZyB0aGUgc3RhY2sgYW5kIHJlc29sdmluZyBlYWNoIGBDZm5Sb3V0ZWAnc1xuICogYEFwaUlkYCBzZWVzIGJvdGguXG4gKi9cbmZ1bmN0aW9uIHJvdXRlc0JvdW5kVG9BcGkoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogYXBpZ3d2Mi5DZm5Sb3V0ZVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuUm91dGVbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuSHR0cFJvdXRlKSB7XG4gICAgICBpZiAoY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmh0dHBBcGkuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgICAgZm91bmQucHVzaChub2RlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpO1xuICAgICAgfVxuICAgICAgLy8gVGhlIHJvdXRlJ3Mgb3duIENmblJvdXRlIGNoaWxkIGlzIHRoZSBzYW1lIHJvdXRlOyBkbyBub3QgZG91YmxlIGNvdW50LlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuUm91dGUgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQuZmlsdGVyKChyb3V0ZSkgPT4gcm91dGUgIT09IHVuZGVmaW5lZCk7XG59XG5cbi8qKlxuICogUmVmdXNlIGEgY29uc29saWRhdGVkIGF0dGFjaCBvbnRvIGFuIEFQSSB0aGF0IGFscmVhZHkgY2FycmllcyByb3V0ZXMuXG4gKlxuICogVGhlIGNoZWNrIGRlbGliZXJhdGVseSB3YWxrcyB0aGUgd2hvbGUgc3RhY2s6IGEgcm91dGUgYm91bmQgdG8gdGhlIGF0dGFjaGVkXG4gKiBBUEkgZnJvbSBhIHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIGp1c3QgYXMgbXVjaCBhIHJvdXRlIGtleSB0aGVcbiAqIGNvbnNvbGlkYXRlZCBncmVlZHkgcm91dGVzIHdvdWxkIGNvbGxpZGUgd2l0aCBhcyBvbmUgY3JlYXRlZCB1bmRlciB0aGUgQVBJXG4gKiBpdHNlbGYuXG4gKi9cbmZ1bmN0aW9uIGFzc2VydENvbnNvbGlkYXRlZEF0dGFjaEFsbG93ZWQoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nUm91dGVzID0gcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgaWYgKGV4aXN0aW5nUm91dGVzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgbWF5IGF0dGFjaCBvbmx5IHRvIGFuIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWU7IFwiXG4gICAgICArIGB0aGUgQVBJIGFscmVhZHkgY2FycmllcyAke2V4aXN0aW5nUm91dGVzLmxlbmd0aH0gcm91dGUocyk6ICR7ZXhpc3RpbmdSb3V0ZXMubWFwKChyb3V0ZSkgPT4gcm91dGUubm9kZS5wYXRoKS5qb2luKFwiLCBcIil9OyBgXG4gICAgICArIFwiYXR0YWNoIHRvIGEgbmV3IG9yIGVtcHR5IEFQSSwgb3IgdXNlIHJvdXRlTW9kZWwgZXhwbGljaXRcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogUmVnaXN0ZXIgdGhlIHN5bnRoLXRpbWUgcnVsZSBmb3Igcm91dGVzIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlclxuICogdGhlIGNvbnN0cnVjdCBjcmVhdGVkIGl0cyBncmVlZHkgcm91dGVzLlxuICpcbiAqIFRoZSBydWxlIGFwcGxpZXMgaW4gYm90aCBjb25zb2xpZGF0ZWQgbW9kZXM6IGFuIEFQSSB0aGUgY29uc3RydWN0IGF0dGFjaGVkXG4gKiB0bywgYW5kIG9uZSB0aGUgY29uc3RydWN0IG93bnMuIFRoZSBkb2N1bWVudGVkIGV4Y2VwdGlvbiBpcyB3aGF0IG1ha2VzXG4gKiBjb25zb2xpZGF0ZWQgcm91dGVzIHVzYWJsZSBpbiBhIHJlYWwgZnJvbnQgZG9vcjogYSBjb25zdW1lciBtYXkgYWRkXG4gKiBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgYWZ0ZXJ3YXJkcy4gSXQgaXMgYWxsb3dlZCBvbmx5IHdoZW4gdGhlXG4gKiByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciAoc28gdGhlIGdyZWVkeSByb3V0ZXMgbmV2ZXIgc2lsZW50bHlcbiAqIHdpZGVuIGEgc3RyaWN0ZXIgcG9zdHVyZSkgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSBhIGdyZWVkeSByb3V0ZSBrZXkgKHdoaWNoXG4gKiBBUEkgR2F0ZXdheSB3b3VsZCByZWplY3QgYXMgYSBkdXBsaWNhdGUpLlxuICovXG5mdW5jdGlvbiByZWdpc3RlckNvbnNvbGlkYXRlZEF0dGFjaFZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbiAgb3duZWRSb3V0ZXM6IGFwaWd3djIuSHR0cFJvdXRlW10sXG4pOiB2b2lkIHtcbiAgY29uc3Qgb3duZWQgPSBuZXcgU2V0KFxuICAgIG93bmVkUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpLFxuICApO1xuICBTdGFjay5vZihzY29wZSkubm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpKSB7XG4gICAgICAgIGlmIChvd25lZC5oYXMocm91dGUpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm91dGVLZXkgPSByb3V0ZS5yb3V0ZUtleTtcbiAgICAgICAgaWYgKENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUy5oYXMocm91dGVLZXkpKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBhbHJlYWR5IG93bnMgdGhlIGdyZWVkeSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9IG9uIHRoaXMgQVBJOyBhIHJvdXRlIGFkZGVkIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IG5vdCByZWRlY2xhcmUgaXQgKCR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYXV0aG9yaXphdGlvblR5cGUgPSBTdHJpbmcocm91dGUuYXV0aG9yaXphdGlvblR5cGUgPz8gXCJOT05FXCIpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIGlmIChhdXRob3JpemF0aW9uVHlwZSA9PT0gXCJOT05FXCIpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGEgcm91dGUgYWRkZWQgdG8gYSBjb25zb2xpZGF0ZWQgQVBJIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IGNhcnJ5IGEgbm9uLU5PTkUgYXV0aG9yaXplciwgYmVjYXVzZSB0aGUgZ3JlZWR5IHJvdXRlcyBhZG1pdCBldmVyeSBtZXRob2QgYW5kIHBhdGggYXQgdGhlIGdhdGV3YXkgKCR7cm91dGVLZXl9IGZyb20gJHtyb3V0ZS5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGVycm9ycztcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQpOiB2b2lkIHtcbiAgaWYgKGZhY2FkZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIGNvbnN0IHByb3ZpZGVySWQgPSAoZmFjYWRlIGFzIHsgcHJvdmlkZXJJZD86IHVua25vd24gfSk/LnByb3ZpZGVySWQ7XG4gIGlmIChcbiAgICB0eXBlb2YgcHJvdmlkZXJJZCAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHByb3ZpZGVySWQudHJpbSgpID09PSBcIlwiXG4gICAgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHByb3ZpZGVySWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmYWNhZGUucHJvdmlkZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcm91dGVGYW1pbHk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQykge1xuICAgIGlmIChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgb3Igandrc1VyaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBlbmFibGUgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSB1cHN0cmVhbUNhbGxiYWNrUGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4gIG93bmVkOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKG93bmVkLnN0YWdlPy50aHJvdHRsaW5nRW5hYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFuIGV4cGxpY2l0IG93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdFbmFibGVkOiB0cnVlIHRocm90dGxpbmcgZGVjaXNpb25gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG93bmVkLnN0YWdlPy5hY2Nlc3NMb2dnaW5nID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFjY2VzcyBsb2dnaW5nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSKSB7XG4gICAgdmFsaWRhdGVEZW5pYWxTaWduYWwocHJvcHMuZGVuaWFsU2lnbmFsKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGRlY2xhcmVkIGRpcmVjdC1vcmlnaW4gZGVjaXNpb24gdG8gYSBwcm92ZW4gcG9zdHVyZS5cbiAqXG4gKiBFdmVyeSBzdXBwbGllZCB2YWx1ZSBpcyBjaGVja2VkLCBub3Qgb25seSB0aGUgdHdvIHBvc3R1cmVzIHRoYXQgcmVxdWlyZSB0aGVcbiAqIGRlY2lzaW9uLiBOZWl0aGVyIHZhbHVlIGlzIGV2ZXIgYWNjZXB0ZWQgYXMgYW4gYXNzZXJ0aW9uOiBESVNBQkxFRCBuZWVkcyB0aGVcbiAqIG93bmVkIG9yZGluYXJ5IGRvbWFpbiB0aGF0IHJlcGxhY2VzIHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBhdXRob3JpdHkgKG9yIGFcbiAqIHByb3ZhYmxlIGNvbmNyZXRlIGF0dGFjaCksIGFuZCBMT0NLRUQgYWRkaXRpb25hbGx5IG5lZWRzIG11dHVhbCBUTFMgb24gZXZlcnlcbiAqIGRvbWFpbiBtYXBwZWQgdG8gdGhlIG93bmVkIEFQSS4gQXR0YWNoLW1vZGUgTE9DS0VEIGlzIHVuc3VwcG9ydGVkIGJlY2F1c2UgYW5cbiAqIGV4dGVybmFsIEFQSSBjYXJyaWVzIG5vIGluLXN0YWNrIHRydXN0c3RvcmUgb3IgbWFwcGluZyBldmlkZW5jZS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBvd25lZDogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyxcbik6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGRlY2lzaW9uID0gcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5O1xuICBjb25zdCBtdXR1YWxUbHMgPSBvd25lZC5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uO1xuICBpZiAoZGVjaXNpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChtdXR1YWxUbHMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBtdXN0IGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAobXV0dWFsVGxzICE9PSB1bmRlZmluZWQgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgaXMgdW5zdXBwb3J0ZWQgaW4gYXR0YWNoIG1vZGU7IGFuIEFQSSBvd25lZCBvdXRzaWRlIHRoZSBjb25zdHJ1Y3QgY2FycmllcyBubyBpbi1zdGFjayBtdXR1YWwtVExTIG1hcHBpbmcgZXZpZGVuY2VcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvd25lZC5kb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluIHdpdGggbXV0dWFsVGxzQXV0aGVudGljYXRpb25cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChtdXR1YWxUbHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb247IGRpc2FibGVtZW50IGFsb25lIGlzIHRoZSBESVNBQkxFRCBwb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCEocHJvcHMuYXBpIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwQXBpKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIGEgc2FtZS1zdGFjayBjb25jcmV0ZSBIdHRwQXBpOyBhbiBpbXBvcnRlZCBBUEkgZXhwb3NlcyBubyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGV2aWRlbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZWdpc3RlckF0dGFjaERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihzY29wZSwgcHJvcHMuYXBpKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKG93bmVkLmRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluOyB0aGUgZGlzYWJsZWQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgaXMgbmV2ZXIgYSBwdWJsaWMgYXV0aG9yaXR5XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gZGVjaXNpb247XG59XG5cbi8qKlxuICogRmluYWwgc3ludGhlc2lzIHByb29mIGZvciBhbiBvd25lZCBESVNBQkxFRCBBUEk6IHRoZSBkZWZhdWx0IGV4ZWN1dGUtYXBpXG4gKiBlbmRwb2ludCBtdXN0IHN0aWxsIGJlIGRpc2FibGVkIGluIHRoZSBlbWl0dGVkIHRlbXBsYXRlLCBldmVuIGlmIGEgbGF0ZXIgTDFcbiAqIG92ZXJyaWRlIHRyaWVzIHRvIHJlLWVuYWJsZSBpdC5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJPd25lZERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLkh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGNmbkFwaSA9IGFwaS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmbkFwaTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpID09PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgcmVxdWlyZXMgQVdTOjpBcGlHYXRld2F5VjI6OkFwaS5Qcm9wZXJ0aWVzLkRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgdG8gcmVzb2x2ZSB0byB0cnVlXCIsXG4gICAgICBdO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKipcbiAqIEZpbmFsIHdob2xlLXN0YWNrIHByb29mIGZvciBhbiBvd25lZCBMT0NLRUQgQVBJLlxuICpcbiAqIExPQ0tFRCBpcyBub3QgYW4gYWxpYXMgb2YgRElTQUJMRUQ6IGF0IGZpbmFsIHN5bnRoZXNpcyB0aGUgZGVmYXVsdCBlbmRwb2ludFxuICogbXVzdCBzdGlsbCBiZSBkaXNhYmxlZCBhbmQgZXZlcnkgYENmbkFwaU1hcHBpbmdgIGJvdW5kIHRvIHRoZSBvd25lZCBBUEksXG4gKiBpbmNsdWRpbmcgbWFwcGluZ3MgYW5vdGhlciBzY29wZSBhZGRzIGFmdGVyIGNvbnN0cnVjdGlvbiwgbXVzdCByZXNvbHZlIHRvIGFuXG4gKiBpbi1zdGFjayBgQ2ZuRG9tYWluTmFtZWAgd2hvc2UgYE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBjYXJyaWVzIGEgdHJ1c3RzdG9yZVxuICogVVJJLiBBbiB1bnJlc29sdmFibGUgbWFwcGluZyBvciBkb21haW4gZmFpbHMgY2xvc2VkIGluc3RlYWQgb2YgY291bnRpbmcgYXNcbiAqIGV2aWRlbmNlLlxuICovXG5mdW5jdGlvbiByZWdpc3Rlck93bmVkTG9ja2VkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLkh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGNmbkFwaSA9IGFwaS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmbkFwaTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpICE9PSB0cnVlKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkuUHJvcGVydGllcy5EaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IHRvIHJlc29sdmUgdG8gdHJ1ZVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgbWFwcGluZ3MgPSBjZm5BcGlNYXBwaW5nc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gICAgICBpZiAobWFwcGluZ3MubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpTWFwcGluZyBib3VuZCB0byB0aGUgb3duZWQgQVBJXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBkb21haW5zID0gY2ZuRG9tYWluTmFtZXMoc2NvcGUpO1xuICAgICAgZm9yIChjb25zdCBtYXBwaW5nIG9mIG1hcHBpbmdzKSB7XG4gICAgICAgIGNvbnN0IGRvbWFpbiA9IGRvbWFpbnMuZmluZChcbiAgICAgICAgICAoY2FuZGlkYXRlKSA9PiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGNhbmRpZGF0ZS5yZWYpXG4gICAgICAgICAgICA9PT0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBtYXBwaW5nLmRvbWFpbk5hbWUpLFxuICAgICAgICApO1xuICAgICAgICBpZiAoZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgY2Fubm90IHJlc29sdmUgbWFwcGluZyAke21hcHBpbmcubm9kZS5wYXRofSB0byBhbiBpbi1zdGFjayBBV1M6OkFwaUdhdGV3YXlWMjo6RG9tYWluTmFtZTsgbXV0dWFsLVRMUyBldmlkZW5jZSBpcyB1bnZlcmlmaWFibGVgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFoYXNUcnVzdHN0b3JlVXJpKHN0YWNrLCBkb21haW4pKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGV2ZXJ5IG1hcHBpbmcgdG8gdGFyZ2V0IGEgZG9tYWluIHdpdGggTXV0dWFsVGxzQXV0aGVudGljYXRpb24uVHJ1c3RzdG9yZVVyaSAoJHttYXBwaW5nLm5vZGUucGF0aH0gLT4gJHtkb21haW4ubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBlcnJvcnM7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhc1RydXN0c3RvcmVVcmkoc3RhY2s6IFN0YWNrLCBkb21haW46IGFwaWd3djIuQ2ZuRG9tYWluTmFtZSk6IGJvb2xlYW4ge1xuICBjb25zdCByZXNvbHZlZCA9IHN0YWNrLnJlc29sdmUoZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uKTtcbiAgaWYgKHJlc29sdmVkID09PSB1bmRlZmluZWQgfHwgcmVzb2x2ZWQgPT09IG51bGwgfHwgdHlwZW9mIHJlc29sdmVkICE9PSBcIm9iamVjdFwiKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IGF1dGhlbnRpY2F0aW9uID0gcmVzb2x2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IHRydXN0c3RvcmVVcmkgPSBhdXRoZW50aWNhdGlvbi50cnVzdHN0b3JlVXJpID8/IGF1dGhlbnRpY2F0aW9uLlRydXN0c3RvcmVVcmk7XG4gIHJldHVybiB0cnVzdHN0b3JlVXJpICE9PSB1bmRlZmluZWQgJiYgdHJ1c3RzdG9yZVVyaSAhPT0gbnVsbCAmJiB0cnVzdHN0b3JlVXJpICE9PSBcIlwiO1xufVxuXG4vKiogRXZlcnkgaW4tc3RhY2sgYENmbkFwaU1hcHBpbmdgIHdob3NlIHJlc29sdmVkIGBBcGlJZGAgaXMgdGhlIHN1cHBsaWVkIEFQSS4gKi9cbmZ1bmN0aW9uIGNmbkFwaU1hcHBpbmdzQm91bmRUb0FwaShcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuKTogYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkFwaU1hcHBpbmcgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmZ1bmN0aW9uIGNmbkRvbWFpbk5hbWVzKHNjb3BlOiBDb25zdHJ1Y3QpOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWVbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkRvbWFpbk5hbWUpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBGaW5hbCBzeW50aGVzaXMgcHJvb2YgZm9yIGFuIGF0dGFjaCBESVNBQkxFRCBkZWNsYXJhdGlvbjogdGhlIGNvbmNyZXRlIEFQSVxuICogbXVzdCBiaW5kIHRvIGV4YWN0bHkgb25lIGluLXN0YWNrIENmbkFwaSB3aG9zZSBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50XG4gKiByZXNvbHZlcyB0byBsaXRlcmFsIHRydWUuIFRoZSBjb25zdHJ1Y3QgbmV2ZXIgbXV0YXRlcyB0aGUgYXR0YWNoZWQgQVBJLlxuICovXG5mdW5jdGlvbiByZWdpc3RlckF0dGFjaERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBjZm5BcGlzID0gY2ZuQXBpc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gICAgICBpZiAoY2ZuQXBpcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIGV4YWN0bHkgb25lIHNhbWUtc3RhY2sgQVdTOjpBcGlHYXRld2F5VjI6OkFwaTsgdGhlIGF0dGFjaGVkIEFQSSdzIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgY2Fubm90IGJlIHByb3ZlblwiLFxuICAgICAgICBdO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpc1swXS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgdGhlIGF0dGFjaGVkIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkgdG8gc2V0IERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQ9dHJ1ZVwiLFxuICAgICAgICBdO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtdO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKiogRXZlcnkgaW4tc3RhY2sgYENmbkFwaWAgd2hvc2UgYFJlZmAgaXMgdGhlIHN1cHBsaWVkIEFQSSdzIGlkLiAqL1xuZnVuY3Rpb24gY2ZuQXBpc0JvdW5kVG9BcGkoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogYXBpZ3d2Mi5DZm5BcGlbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkFwaVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5BcGkgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLnJlZikgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UoXG4gIGRlZmVuc2U6IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHwgdW5kZWZpbmVkLFxuICBsYWJlbDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChkZWZlbnNlID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UgdG8gcmVjb3JkIHRoZSBvd25pbmcgQVBJJ3MgYWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVjaXNpb25zYCxcbiAgICApO1xuICB9XG4gIGlmIChkZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgIT09IHRydWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UuYWNjZXNzTG9nZ2luZyB0byBiZSB0cnVlYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmc6IFBhcnRpYWw8QXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM+IHwgdW5kZWZpbmVkID0gZGVmZW5zZS50aHJvdHRsaW5nO1xuICBjb25zdCByYXRlTGltaXQgPSB0aHJvdHRsaW5nPy5yYXRlTGltaXQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSB0aHJvdHRsaW5nPy5idXJzdExpbWl0O1xuICBpZiAoXG4gICAgIU51bWJlci5pc0Zpbml0ZShyYXRlTGltaXQpXG4gICAgfHwgKHJhdGVMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgICB8fCAhTnVtYmVyLmlzRmluaXRlKGJ1cnN0TGltaXQpXG4gICAgfHwgKGJ1cnN0TGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS50aHJvdHRsaW5nIHJhdGVMaW1pdCBhbmQgYnVyc3RMaW1pdCB0byBiZSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyc2AsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlbmlhbFNpZ25hbChzaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zKTogdm9pZCB7XG4gIGlmIChzaWduYWwgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIGRlbmlhbFNpZ25hbFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5tZXRyaWNOYW1lICE9PSB1bmRlZmluZWQgJiYgc2lnbmFsLm1ldHJpY05hbWUgIT09IE1DUF9ERU5JQUxfTUVUUklDX05BTUUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwubWV0cmljTmFtZSBtdXN0IGJlICR7TUNQX0RFTklBTF9NRVRSSUNfTkFNRX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5kaW1lbnNpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBkaW1lbnNpb25zID0gQXJyYXkuaXNBcnJheShzaWduYWwuZGltZW5zaW9ucykgPyBzaWduYWwuZGltZW5zaW9ucyA6IFtdO1xuICAgIGNvbnN0IGJvdW5kZWQgPSBkaW1lbnNpb25zLmxlbmd0aCA9PT0gTUNQX0RFTklBTF9ESU1FTlNJT05TLmxlbmd0aFxuICAgICAgJiYgTUNQX0RFTklBTF9ESU1FTlNJT05TLmV2ZXJ5KFxuICAgICAgICAoZGltZW5zaW9uKSA9PiBkaW1lbnNpb25zLmZpbHRlcigodmFsdWUpID0+IHZhbHVlID09PSBkaW1lbnNpb24pLmxlbmd0aCA9PT0gMSxcbiAgICAgICk7XG4gICAgaWYgKCFib3VuZGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5kaW1lbnNpb25zIG11c3QgYmUgZXhhY3RseSAke0pTT04uc3RyaW5naWZ5KE1DUF9ERU5JQUxfRElNRU5TSU9OUyl9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKHZhbHVlOiBzdHJpbmcsIGFsbG93UXVlcnk6IGJvb2xlYW4sIG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBsaXRlcmFsID0gdmFsdWUudHJpbSgpO1xuICBsZXQgcGFyc2VkOiBVUkwgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChsaXRlcmFsKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIHNoYXJlZCB2YWxpZGF0aW9uIGVycm9yIGJlbG93IGlzIHRoZSBwdWJsaWMgc3ludGhlc2lzIGNvbnRyYWN0LlxuICB9XG4gIGlmIChcbiAgICAhcGFyc2VkXG4gICAgfHwgIWxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KGxpdGVyYWwpXG4gICAgfHwgcGFyc2VkLnByb3RvY29sICE9PSBcImh0dHBzOlwiXG4gICAgfHwgIXBhcnNlZC5ob3N0bmFtZVxuICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgIHx8IHBhcnNlZC5wYXNzd29yZCAhPT0gXCJcIlxuICAgIHx8IGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyhsaXRlcmFsKVxuICAgIHx8ICghYWxsb3dRdWVyeSAmJiBsaXRlcmFsLmluY2x1ZGVzKFwiP1wiKSlcbiAgICB8fCBsaXRlcmFsLmluY2x1ZGVzKFwiI1wiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHttZXNzYWdlfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRvSHR0cE1ldGhvZChtZXRob2Q6IHN0cmluZyk6IGFwaWd3djIuSHR0cE1ldGhvZCB7XG4gIHN3aXRjaCAobWV0aG9kKSB7XG4gICAgY2FzZSBcIlBPU1RcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NUO1xuICAgIGNhc2UgXCJHRVRcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQ7XG4gICAgY2FzZSBcIkRFTEVURVwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkRFTEVURTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVuc3VwcG9ydGVkIHJ1bnRpbWUgTUNQIG1ldGhvZCAke21ldGhvZH1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBncmVhdGVyIHRoYW4gemVyb2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIHJldHVybiBmcWRuLmVuZHNXaXRoKHN1ZmZpeCkgPyBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKSA6IGZxZG47XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eaHR0cHM6XFwvXFwvKFteLz8jXSspKD86Wy8/I118JCkvaS5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5ICE9PSB1bmRlZmluZWQgJiYgIWF1dGhvcml0eS5pbmNsdWRlcyhcIiVcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eW0EtWmEtel1bQS1aYS16MC05Ky4tXSo6XFwvXFwvKFteLz8jXSopLy5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5Py5pbmNsdWRlcyhcIkBcIikgPz8gZmFsc2U7XG59XG4iXX0=