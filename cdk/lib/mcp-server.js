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
        const posture = props.transportPosture
            ?? (props.facade !== undefined
                ? AppTheoryMcpTransportPosture.RUNTIME_BEARER
                : AppTheoryMcpTransportPosture.IAM);
        validateTransportPosture(posture);
        validateFacadeAttachment(props.facade);
        validatePostureGuards(props, routeFamily, posture);
        validateDefenseInDepth(props, posture);
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
                corsPreflight: (0, cors_1.buildCorsPreflight)(props.cors),
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
        let firstTransportRoute;
        if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED) {
            firstTransportRoute = this.addConsolidatedRoute(CONSOLIDATED_ROOT_ROUTE_ID, "/", integration, transportAuthorizer);
            const proxyRoute = this.addConsolidatedRoute(CONSOLIDATED_PROXY_ROUTE_ID, "/{proxy+}", integration, transportAuthorizer);
            if (props.api !== undefined) {
                registerConsolidatedAttachValidation(this, this.api, [firstTransportRoute, proxyRoute]);
            }
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
 * Register the synth-time rule for routes added to a consolidated API AFTER
 * the construct attached.
 *
 * The documented exception is what makes consolidated attach usable in a real
 * front door: a consumer may add explicit, more specific routes afterwards. It
 * is allowed only when the route carries a non-NONE authorizer (so the greedy
 * routes never silently widen a stricter posture) and does not redeclare a
 * greedy route key (which API Gateway would reject as a duplicate).
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
                    errors.push(`AppTheoryMcpServer: routeModel consolidated already owns the greedy API Gateway route key ${JSON.stringify(routeKey)} on this API; a consumer route added after attach must not redeclare it (${route.node.path})`);
                    continue;
                }
                const authorizationType = String(route.authorizationType ?? "NONE").toUpperCase();
                if (authorizationType === "NONE") {
                    errors.push(`AppTheoryMcpServer: a route added to a consolidated API after attach must carry a non-NONE authorizer, because the greedy routes admit every method and path at the gateway (${routeKey} from ${route.node.path})`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUMvRCxpQ0FBNEM7QUFFNUMsMkNBQXVEO0FBRXZELE1BQU0sMEJBQTBCLEdBQUcsY0FBYyxDQUFDO0FBQ2xELE1BQU0sMkJBQTJCLEdBQUcsZUFBZSxDQUFDO0FBQ3BELE1BQU0sNkJBQTZCLEdBQUcsR0FBRyxDQUFDO0FBQzFDLE1BQU0sOEJBQThCLEdBQUcsR0FBRyxDQUFDO0FBQzNDLE1BQU0sMkJBQTJCLEdBQUcsRUFBRSxDQUFDO0FBQ3ZDLE1BQU0sMkJBQTJCLEdBQUcsd0JBQXdCLENBQUM7QUFDN0QsTUFBTSxrQ0FBa0MsR0FBRyxpQ0FBaUMsQ0FBQztBQUM3RSxNQUFNLGlDQUFpQyxHQUFHLDhCQUE4QixDQUFDO0FBQ3pFLE1BQU0sc0JBQXNCLEdBQUcsMkJBQTJCLENBQUM7QUFDM0QsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLFNBQVMsRUFBRSxjQUFjLENBQUMsQ0FBQztBQUUxRCxtREFBbUQ7QUFDbkQsSUFBWSxzQkFnQlg7QUFoQkQsV0FBWSxzQkFBc0I7SUFDaEM7Ozs7T0FJRztJQUNILCtDQUFxQixDQUFBO0lBQ3JCOzs7Ozs7O09BT0c7SUFDSCx1REFBNkIsQ0FBQTtBQUMvQixDQUFDLEVBaEJXLHNCQUFzQixzQ0FBdEIsc0JBQXNCLFFBZ0JqQztBQUVELDREQUE0RDtBQUM1RCxJQUFZLHVCQWdCWDtBQWhCRCxXQUFZLHVCQUF1QjtJQUNqQzs7OztPQUlHO0lBQ0gsNENBQWlCLENBQUE7SUFDakI7Ozs7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SUFDM0IsSUFBSSxJQUFJLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ3RFLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsQ0FBQyxLQUFhO0lBQ2xELE1BQU0sU0FBUyxHQUFHLGtDQUFrQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLE9BQU8sU0FBUyxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUVELFNBQVMsOEJBQThCLENBQUMsS0FBYTtJQUNuRCxNQUFNLFNBQVMsR0FBRyx3Q0FBd0MsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxPQUFPLFNBQVMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDO0FBQzNDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIH0gZnJvbSBcIi4vbWNwLXJvdXRlLWFsZ2VicmFcIjtcbmltcG9ydCB7IGJ1aWxkQ29yc1ByZWZsaWdodCB9IGZyb20gXCIuL2NvcnNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIH0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB7IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZCB9IGZyb20gXCIuL3JvdXRlLWlkc1wiO1xuXG5jb25zdCBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCA9IFwiUm91dGVBbnlSb290XCI7XG5jb25zdCBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQgPSBcIlJvdXRlQW55UHJveHlcIjtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFJvdXRlLWVtaXNzaW9uIG1vZGVsIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgLyoqXG4gICAqIE9uZSBBUEkgR2F0ZXdheSBIVFRQIEFQSSB2MiByb3V0ZSBwZXIgZGVyaXZlZCByb3V0ZSBrZXkuIFRoaXMgaXMgdGhlXG4gICAqIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3IgZGVwbG95ZWRcbiAgICogc3RhY2tzLCBzbyBhIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgdXBncmFkZSBkZXBsb3lzIGluIHBsYWNlLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIEVYUExJQ0lUID0gXCJleHBsaWNpdFwiLFxuICAvKipcbiAgICogVHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCwgYmFja2VkIGJ5IG9uZSBzaGFyZWRcbiAgICogaW50ZWdyYXRpb24uIFRoZSBBcHBUaGVvcnkgcnVudGltZSByb3V0ZXIgcGVyZm9ybXMgbWV0aG9kIGFuZCBwYXRoXG4gICAqIGRpc3BhdGNoLCBwYXRoLXBhcmFtZXRlciBjYXB0dXJlLCBhbmQgZGVuaWFsLiBDb25zb2xpZGF0aW9uIG5ldmVyIGNoYW5nZXNcbiAgICogZ2F0ZXdheSBhZG1pc3Npb24sIHNvIGl0IGlzIHZhbGlkIG9ubHkgd2hlbiBldmVyeSBnYXRld2F5IHJvdXRlIGlzIGBOT05FYDpcbiAgICogdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0IHBvc3R1cmVzLiBgaWFtYCBhbmQgYGp3dGBcbiAgICogYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzIHRpbWUuXG4gICAqL1xuICBDT05TT0xJREFURUQgPSBcImNvbnNvbGlkYXRlZFwiLFxufVxuXG4vKiogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgLyoqXG4gICAqIFBvc2l0aW9uYWwgaWRzIChgUm91dGUwYCwgYFJvdXRlMWAsIC4uLikgYXNzaWduZWQgaW4gZW1pc3Npb24gb3JkZXIuIFRoaXNcbiAgICogaXMgdGhlIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3JcbiAgICogZGVwbG95ZWQgc3RhY2tzLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG4gIC8qKlxuICAgKiBJZHMgZGVyaXZlZCBmcm9tIHRoZSByb3V0ZSBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yXG4gICAqIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHkgbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGUuIEludGVuZGVkIGZvclxuICAgKiBuZXdseSBjcmVhdGVkIGV4cGxpY2l0IEFQSXM6IHN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUElcbiAgICogZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUsIHdoaWNoIGlzIGl0c2VsZiBhXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIGNvbGxpc2lvbi4gQWRvcHQgaXQgb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoXG4gICAqIHRoZSBuZXctQVBJIHN3YXAgZGVzY3JpYmVkIGluIGBVUEdSQURJTkcubWRgLlxuICAgKi9cbiAgU0VNQU5USUMgPSBcInNlbWFudGljXCIsXG59XG5cbi8qKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gVGhlIGRlZmF1bHQgZm9yIGEgc2VydmVyIHdpdGggbm8gZmFjYWRlIGF0dGFjaG1lbnQuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBBIHN0YXRpYyBKV1QgYXV0aG9yaXplciAoaXNzdWVyICsgYXVkaWVuY2UpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiAqL1xuICBKV1QgPSBcImp3dFwiLFxuICAvKiogVGhlIGdhdGV3YXkgYXV0aG9yaXplciBpcyBOT05FIGFuZCB0aGUgcnVudGltZSB2YWxpZGF0ZXMgUkZDIDk3MjggYmVhcmVyIHRva2Vucy4gVGhlIGRlZmF1bHQgZm9yIGEgZmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVyLiAqL1xuICBSVU5USU1FX0JFQVJFUiA9IFwicnVudGltZS1iZWFyZXJcIixcbiAgLyoqIERlbGliZXJhdGVseSBwdWJsaWMgTUNQIHNlcnZlcjogZXZlcnkgdHJhbnNwb3J0IHJvdXRlIGlzIHB1YmxpYy4gTmV2ZXIgYSBkZWZhdWx0LiAqL1xuICBOT05FX1BVQkxJQyA9IFwibm9uZS1wdWJsaWNcIixcbn1cblxuLyoqIFByZXNlbmNlLW9ubHkgc2tlbGV0b24gb2YgdGhlIHVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBzZWxlY3RzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQge1xuICAvKiogSWRlbnRpZmllcyB0aGUgdXBzdHJlYW0gYXV0aG9yaXphdGlvbiBwcm92aWRlciB0aGlzIHNlcnZlciBmcm9udHMgKGZvciBleGFtcGxlIGBhdXRoZW9yeWApLiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZSBhbmQgdXNlcyBpdHMgcHJlc2VuY2UgdG8gc2VsZWN0IHRoZSBgcnVudGltZS1iZWFyZXJgIGRlZmF1bHQuICovXG4gIHJlYWRvbmx5IHByb3ZpZGVySWQ6IHN0cmluZztcbn1cblxuLyoqIFJ1bnRpbWUtc2lkZSBkZWNsYXJhdGlvbiB0aGF0IHRoZSB0cmFuc3BvcnQgcm91dGVzIHZhbGlkYXRlIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMgYXQgcnVudGltZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zIHtcbiAgLyoqIEFzc2VydCB0aGUgcnVudGltZSByZWdpc3RlcnMgdGhlIHRyYW5zcG9ydCByb3V0ZXMgd2l0aCB0aGUgcnVudGltZS12YWxpZGF0ZWQgYmVhcmVyIHBvc3R1cmUgKEdvIGBGYWNhZGVDb25maWcuUmVxdWlyZUJlYXJlclRva2VuYCwgVFMgYHJlcXVpcmVCZWFyZXJUb2tlbk1pZGRsZXdhcmVgLCBQeXRob24gYHJlcXVpcmVfYmVhcmVyX3Rva2VuX21pZGRsZXdhcmVgKS4gTXVzdCBiZSBgdHJ1ZWAuICovXG4gIHJlYWRvbmx5IHJlcXVpcmVCZWFyZXJUb2tlbjogYm9vbGVhbjtcbn1cblxuLyoqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkge1xuICAvKiogVGhlIGV4ZWN1dGUtYXBpIGRlZmF1bHQgZW5kcG9pbnQgaXMgZGlzYWJsZWQuICovXG4gIERJU0FCTEVEID0gXCJkaXNhYmxlZFwiLFxuICAvKiogVGhlIG9yaWdpbiBpcyByZWFjaGFibGUgb25seSB0aHJvdWdoIGEgbG9ja2VkIGZyb250IGRvb3IgKENsb3VkRnJvbnQgLyBWUEMgb3JpZ2luKS4gKi9cbiAgTE9DS0VEID0gXCJsb2NrZWRcIixcbn1cblxuLyoqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyB7XG4gIC8qKiBEZW5pYWwgbWV0cmljIG5hbWUuIE11c3QgYmUgYGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRgLiBAZGVmYXVsdCBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkICovXG4gIHJlYWRvbmx5IG1ldHJpY05hbWU/OiBzdHJpbmc7XG4gIC8qKiBCb3VuZGVkIG1ldHJpYyBkaW1lbnNpb25zLiBNdXN0IGJlIGV4YWN0bHkgYG91dGNvbWVgIGFuZCBgcm91dGVfZmFtaWx5YC4gQGRlZmF1bHQgW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXSAqL1xuICByZWFkb25seSBkaW1lbnNpb25zPzogc3RyaW5nW107XG59XG5cbi8qKiBPd25pbmctQVBJIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zIHtcbiAgLyoqIFN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC4gKi9cbiAgcmVhZG9ubHkgcmF0ZUxpbWl0OiBudW1iZXI7XG4gIC8qKiBTdGFnZSBidXJzdCBsaW1pdC4gKi9cbiAgcmVhZG9ubHkgYnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG4vKiogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgZGVmZW5zZS1pbi1kZXB0aCBkZWNpc2lvbnMgKHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2ApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB7XG4gIC8qKiBXaGV0aGVyIHRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgaGFzIGFjY2VzcyBsb2dnaW5nIGVuYWJsZWQuIE11c3QgYmUgdHJ1ZS4gKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgLyoqIFRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZzogQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM7XG59XG5cbi8qKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSBIVFRQUyBKV1QgaXNzdWVyIFVSTC4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBpc3N1ZXI/OiBzdHJpbmc7XG4gIC8qKiBBY2NlcHRlZCBKV1QgYXVkaWVuY2VzLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGF1ZGllbmNlPzogc3RyaW5nW107XG4gIC8qKiBJZGVudGl0eSBzb3VyY2VzIGZvciB0aGUgSldUIGF1dGhvcml6ZXIuIEBkZWZhdWx0IFtcIiRyZXF1ZXN0LmhlYWRlci5BdXRob3JpemF0aW9uXCJdICovXG4gIHJlYWRvbmx5IGlkZW50aXR5U291cmNlPzogc3RyaW5nW107XG4gIC8qKiBKV1QgYXV0aG9yaXplciByZXNvdXJjZSBuYW1lLiBAZGVmYXVsdCB0aGUgYXV0aG9yaXplciBjb25zdHJ1Y3QgaWQgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKiogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZm9yIGV4YW1wbGUsIGBtY3AuZXhhbXBsZS5jb21gKS4gKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVBcm5gLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVgLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYW4gYXV0b21hdGljYWxseSBjcmVhdGVkIENOQU1FIHJlY29yZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbn1cblxuLyoqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCIgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciB0aGUgYWNjZXNzIGxvZyBncm91cC4gVmFsaWQgb25seSB3aGVuIGFjY2VzcyBsb2dnaW5nXG4gICAqIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLlxuICAgKiBAZGVmYXVsdCAxMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IDIwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKiBPd25lZC1BUEkgc3BlY2lhbGl6YXRpb24gZm9yIHN0YW5kYWxvbmUgTUNQIHNlcnZlcnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucyB7XG4gIC8qKiBPcHRpb25hbCBBUEkgbmFtZS4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKiogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBvd25lZCBieSB0aGlzIGNvbnN0cnVjdC4gKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi4gQWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVmYXVsdCBvbi5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKiBPcmRlcmVkIE1DUCByb3V0ZS1wYXR0ZXJuIGZhbWlseSB3aXJlZCBhcyBvbmUgZmFjYWRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseSB7XG4gIC8qKlxuICAgKiBPcmRlcmVkIHN5bnRoZXNpcy10aW1lIE1DUCByb3V0ZSBwYXR0ZXJucy5cbiAgICpcbiAgICogRWFjaCBzZWdtZW50IGlzIGVpdGhlciBhIGxpdGVyYWwgUkZDIDM5ODYgcGF0aCBzZWdtZW50IG9yIGEgY29tcGxldGVcbiAgICogYHtwYXJhbWV0ZXJfbmFtZX1gIHNlZ21lbnQuIENESyB0b2tlbnMsIG9yaWdpbnMsIGVtcHR5IHNlZ21lbnRzLCBkb3RcbiAgICogc2VnbWVudHMsIGdyZWVkeSBwYXJhbWV0ZXJzLCBhbmQgZHVwbGljYXRlIHBhdHRlcm5zIGFyZSByZWplY3RlZC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2lyZSB0aGUgYWxnZWJyYS1kZXJpdmVkIHVuc2NvcGVkIGF1dGhvcml6YXRpb24tc2VydmVyIGRpc2NvdmVyeSByb3V0ZS5cbiAgICogVGhlIHJ1bnRpbWUgbXVzdCBzdXBwbHkgYEZhY2FkZUNvbmZpZy5Sb290QXV0aG9yaXphdGlvblNlcnZlcmAgdG9vLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk/OiBib29sZWFuO1xufVxuXG4vKiogRHluYW1vREItYmFja2VkIE1DUCBzZXNzaW9uLXN0YXRlIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSBuYW1lLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBhdXRvLWdlbmVyYXRlZFxuICAgKi9cbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUVEwgaW4gbWludXRlcyBmb3Igc2Vzc2lvbiByZWNvcmRzLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpc1xuICAgKiBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCA2MFxuICAgKi9cbiAgcmVhZG9ubHkgdHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSByZW1vdmFsIHBvbGljeS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICovXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xufVxuXG4vKiogT25lIGRlcml2ZWQgTUNQIE9BdXRoIGZhY2FkZSByb3V0ZSBmYW1pbHkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlIHtcbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBtY3BNZXRob2RzOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5U3VmZml4UGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByZWdpc3RlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuO1xufVxuXG4vKiogRGVmZW5zaXZlIHNuYXBzaG90IG9mIHRoZSBjb25zdHJ1Y3QncyBkZXJpdmVkIGZhY2FkZSBpbnZlbnRvcnkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmVhZG9ubHkgY29udHJhY3RWZXJzaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvdXRlczogQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGVbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNhbGxiYWNrUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgY29uc3RydWN0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKiBMYW1iZGEgZnVuY3Rpb24gaGFuZGxpbmcgdGhlIHJ1bnRpbWUtY29tcG9zZWQgTUNQIGZhY2FkZS4gKi9cbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgTUNQIGZhY2FkZSBmYW1pbGllcyB0aGF0XG4gICAqIHNoYXJlIG9uZSBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3lcbiAgICogc2l6ZSBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJvdXRlLWVtaXNzaW9uIG1vZGVsLlxuICAgKlxuICAgKiBgZXhwbGljaXRgICh0aGUgZGVmYXVsdCkgd2lyZXMgdGhlIGZ1bGwgZGVyaXZlZCByb3V0ZSBpbnZlbnRvcnkgYXMgb25lIEhUVFBcbiAgICogQVBJIHYyIHJvdXRlIHBlciByb3V0ZSBrZXkgYW5kIGlzIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuXG4gICAqIGBjb25zb2xpZGF0ZWRgIHdpcmVzIGV4YWN0bHkgdHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCxcbiAgICogYW5kIGlzIHZhbGlkIG9ubHkgZm9yIHRoZSBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgIHRyYW5zcG9ydFxuICAgKiBwb3N0dXJlczsgYGlhbWAgYW5kIGBqd3RgIGFyZSByZWZ1c2VkIGF0IHN5bnRoZXNpcy5cbiAgICpcbiAgICogQ29uc29saWRhdGVkIG1vZGUgaXMgYWxsb3dlZCBvbiBhIGNvbnN0cnVjdC1vd25lZCBBUEksIG9yIG9uIGFuIGF0dGFjaGVkXG4gICAqIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWUuIFwiTm8gcm91dGVzXCIgaXMgZW5mb3JjZWQgb3ZlciB0aGVcbiAgICogd2hvbGUgc3RhY2ssIG5vdCBqdXN0IHRoZSBBUEkncyBvd24gY2hpbGRyZW46IGEgcm91dGUgd2lyZWQgb250byB0aGVcbiAgICogYXR0YWNoZWQgQVBJIGZyb20gYW55IHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIHJlZnVzZWQsIGJlY2F1c2UgaXQgaG9sZHNcbiAgICogYSByb3V0ZSBrZXkgdGhlIGdyZWVkeSByb3V0ZXMgd291bGQgY29sbGlkZSB3aXRoLlxuICAgKlxuICAgKiBBIGNvbnN1bWVyIG1heSBzdGlsbCBhZGQgZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIHRvIHRoZSBhdHRhY2hlZCBBUElcbiAgICogYWZ0ZXJ3YXJkcy4gVGhhdCBleGNlcHRpb24gaXMgZW5mb3JjZWQgYXQgc3ludGhlc2lzIHRpbWUgYW5kIGlzIGFsbG93ZWRcbiAgICogb25seSB3aGVuIHRoZSBhZGRlZCByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciBhbmQgZG9lcyBub3RcbiAgICogcmVkZWNsYXJlIHRoZSBncmVlZHkgYEFOWSAvYCBvciBgQU5ZIC97cHJveHkrfWAga2V5LiBXaXRoaW4gaXQsIGEgZnVsbFxuICAgKiBtZXRob2QrcGF0aCBtYXRjaCBiZWF0cyB0aGUgZ3JlZWR5IHJvdXRlcyBieSBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlLCBhbmQgYVxuICAgKiB3cm9uZy1tZXRob2QgaGl0IG9uIHN1Y2ggYSBwYXRoIGZhbGxzIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVNb2RlbD86IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWw7XG5cbiAgLyoqXG4gICAqIENvbnN0cnVjdC1pZCBkZXJpdmF0aW9uIGZvciB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwuXG4gICAqXG4gICAqIGBsZWdhY3lgICh0aGUgZGVmYXVsdCkgYXNzaWducyBwb3NpdGlvbmFsIGlkcyBpbiBlbWlzc2lvbiBvcmRlciBhbmQgaXNcbiAgICogYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy4gYHNlbWFudGljYCBkZXJpdmVzIGVhY2ggaWQgZnJvbSBpdHMgcm91dGVcbiAgICogbWV0aG9kIGFuZCBwYXR0ZXJuLCBzbyBpbnNlcnRpbmcsIHJlbW92aW5nLCBvciByZW9yZGVyaW5nIGEgcm91dGUgZmFtaWx5XG4gICAqIG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlOyBpdCBpcyBpbnRlbmRlZCBmb3IgbmV3bHkgY3JlYXRlZCBleHBsaWNpdFxuICAgKiBBUElzLlxuICAgKlxuICAgKiBTd2l0Y2hpbmcgYW4gZXhpc3RpbmcgZGVwbG95ZWQgZXhwbGljaXQgQVBJIGZyb20gYGxlZ2FjeWAgdG8gYHNlbWFudGljYCBpblxuICAgKiBwbGFjZSByZW5hbWVzIGV2ZXJ5IHJvdXRlIGluIG9uZSB1cGRhdGUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIHJvdXRlLWtleSBjb2xsaXNpb24gdGhlIG1pZ3JhdGlvbiBjaGVjayByZWZ1c2VzLiBBZG9wdFxuICAgKiBgc2VtYW50aWNgIG9uIGFuIGV4aXN0aW5nIHN0YWNrIG9ubHkgdGhyb3VnaCB0aGUgbmV3LUFQSSBzd2FwIGRvY3VtZW50ZWQgaW5cbiAgICogYFVQR1JBRElORy5tZGAuXG4gICAqXG4gICAqIFRoaXMgcHJvcCBhcHBsaWVzIHRvIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgb25seS4gVGhlIGBjb25zb2xpZGF0ZWRgIG1vZGVsXG4gICAqIGFscmVhZHkgZW1pdHMgdGhlIHR3byBmaXhlZCBzZW1hbnRpYyBpZHMgYFJvdXRlQW55Um9vdGAgYW5kIGBSb3V0ZUFueVByb3h5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSByb3V0ZUlkTW9kZT86IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlO1xuXG4gIC8qKlxuICAgKiBDT1JTIHByZWZsaWdodCBmb3IgYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBTZXQgdG8gYHRydWVgIGZvciBBcHBUaGVvcnlcbiAgICogZGVmYXVsdHMgb3Igc3VwcGx5IGFuIGBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnNgIG9iamVjdC4gSW52YWxpZCBpblxuICAgKiBhdHRhY2ggbW9kZSwgd2hlcmUgdGhlIG93bmluZyBBUEkgY29uZmlndXJlcyBDT1JTLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeGlzdGluZyBIVFRQIEFQSSB0byBhdHRhY2ggdG8uIEF0dGFjaCBtb2RlIGlzIHRoZSBwcmltYXJ5IGZyb250LWRvb3JcbiAgICogdG9wb2xvZ3kgYW5kIG5ldmVyIGNyZWF0ZXMgYW4gYEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlgIHJlc291cmNlLlxuICAgKiBAZGVmYXVsdCBhIGNvbnN0cnVjdC1vd25lZCBIdHRwQXBpXG4gICAqL1xuICByZWFkb25seSBhcGk/OiBhcGlnd3YyLklIdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lIHVzZWQgd2hlbiBkZXJpdmluZyBhdHRhY2gtbW9kZSBleGVjdXRlLWFwaSBlbmRwb2ludCB0ZW1wbGF0ZXMuXG4gICAqIFVzZSBgJGRlZmF1bHRgIGZvciB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdCBzdGFnZS4gV2hlbiBvbWl0dGVkLCB0aGUgc3RhZ2VcbiAgICogaXMgbm90IGRldGVybWluYWJsZSBhbmQgdGhlIHRlbXBsYXRlcyByZXRhaW4gdGhlIGJhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luLlxuICAgKiBUaGlzIHByb3AgZG9lcyBub3QgY3JlYXRlLCBpbXBvcnQsIG9yIG11dGF0ZSBhIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF0dGFjaGVkQXBpU3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEdvIGBydW50aW1lL21jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAgc2VydmVzIG9ubHkgdGhlIGNhbm9uaWNhbCBkZWZhdWx0XG4gICAqIGZhbWlseS4gTm9uY2Fub25pY2FsIHBhdHRlcm5zIHJlcXVpcmUgYXBwLW93bmVkIHJ1bnRpbWUgcm91dGUgcmVnaXN0cmF0aW9uXG4gICAqIHRoYXQgbWF0Y2hlcyB0aGUgY29uc3RydWN0J3MgYHJvdXRlSW52ZW50b3J5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKClcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlRmFtaWx5PzogQXBwVGhlb3J5TWNwUm91dGVGYW1pbHk7XG5cbiAgLyoqXG4gICAqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEFuIGV4cGxpY2l0IHNlbGVjdGlvbiBvdmVycmlkZXMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gV2hlbiBpdCBpc1xuICAgKiBvbWl0dGVkLCBhIHNlcnZlciB0aGF0IGF0dGFjaGVzIGBmYWNhZGVgIHJlc29sdmVzIHRvIGBydW50aW1lLWJlYXJlcmAgYW5kIGFcbiAgICogcGxhaW4gdHJhbnNwb3J0IHNlcnZlciByZXNvbHZlcyB0byBgaWFtYC4gYG5vbmUtcHVibGljYCBpcyBuZXZlciBhIGRlZmF1bHRcbiAgICogYW5kIGNhcnJpZXMgdGhlIGRlZmVuc2UtaW4tZGVwdGggZmxvb3IuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIgd2hlbiBgZmFjYWRlYCBpcyBhdHRhY2hlZCwgb3RoZXJ3aXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcblxuICAvKipcbiAgICogVXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IG1hcmtzIHRoaXMgc2VydmVyIGFzIGZhY2FkZS1jb25maWd1cmVkLlxuICAgKlxuICAgKiBUaGUgYXR0YWNobWVudCdzIHByZXNlbmNlIHNlbGVjdHMgdGhlIGBydW50aW1lLWJlYXJlcmAgcG9zdHVyZSBkZWZhdWx0LlxuICAgKiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50O1xuXG4gIC8qKlxuICAgKiBSdW50aW1lLXNpZGUgUkZDIDk3MjggYmVhcmVyIHZhbGlkYXRpb24gZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVkIGJ5IGB0cmFuc3BvcnRQb3N0dXJlOiBSVU5USU1FX0JFQVJFUmAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnlcbiAgICogb3RoZXIgcG9zdHVyZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBydW50aW1lUG9zdHVyZT86IEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucztcblxuICAvKipcbiAgICogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kXG4gICAqIE5PTkVfUFVCTElDLiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gaXMgcmVmdXNlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk/OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcbiAgcHJpdmF0ZSByb3V0ZUlkTW9kZSA9IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgcHJpdmF0ZSByZWFkb25seSByb3V0ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgLyoqXG4gICAqIFJlc29sdmVkIHRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEZhY2FkZS1jb25maWd1cmVkIHNlcnZlcnMgcmVzb2x2ZSB0byBgcnVudGltZS1iZWFyZXJgIHVubGVzc1xuICAgKiBgdHJhbnNwb3J0UG9zdHVyZWAgb3ZlcnJpZGVzIHRoZSBkZWZhdWx0OyBwbGFpbiB0cmFuc3BvcnQgc2VydmVycyByZXNvbHZlXG4gICAqIHRvIGBpYW1gLiBEZWxpYmVyYXRlbHkgcHVibGljIHNlcnZlcnMgbXVzdCBzZWxlY3QgYG5vbmUtcHVibGljYCBleHBsaWNpdGx5LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG4gIC8qKlxuICAgKiBEZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlcyBmb3IgdGhlIG9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgdGhlc2UgYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZXMsIG5vdCBkZWNsYXJhdGlvbnMgb2ZcbiAgICogcHVibGljIGF1dGhvcml0eS4gQW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkOyB0aGUgb3JpZ2luIGlzIGRlcml2ZWRcbiAgICogZnJvbSBgYXBpSWRgLCB0aGUgc3RhY2sgcmVnaW9uIGFuZCBVUkwgc3VmZml4LCBwbHVzXG4gICAqIGBhdHRhY2hlZEFwaVN0YWdlTmFtZWAgd2hlbiBzdXBwbGllZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlSW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeTtcblxuICAvKipcbiAgICogRmlyc3QgZGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgYW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkLiBUaGlzIHZhbHVlIGlzIGFuXG4gICAqIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZSBkZXJpdmVkIGJ5IHRoZSBzYW1lIHJ1bGVzIGFzIGBlbmRwb2ludHNgLCBub3RcbiAgICogdGhlIGZyb250IGRvb3IncyBwdWJsaWMgYXV0aG9yaXR5LlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYGVuZHBvaW50c2AuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBtY3BQYXRoc2AuICovXG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoOiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzYCBvciBgcm91dGVJbnZlbnRvcnlgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGg6IHN0cmluZztcblxuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHMpO1xuICAgIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHMpO1xuICAgIGNvbnN0IHJvdXRlRmFtaWx5ID0gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHMpO1xuXG4gICAgY29uc3QgcG9zdHVyZSA9IHByb3BzLnRyYW5zcG9ydFBvc3R1cmVcbiAgICAgID8/IChwcm9wcy5mYWNhZGUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAgICAgOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSk7XG4gICAgdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChwcm9wcy5mYWNhZGUpO1xuICAgIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhwcm9wcywgcm91dGVGYW1pbHksIHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgocHJvcHMsIHBvc3R1cmUpO1xuICAgIGNvbnN0IHJvdXRlTW9kZWwgPSByZXNvbHZlUm91dGVNb2RlbChwcm9wcyk7XG4gICAgdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShyb3V0ZU1vZGVsLCBwb3N0dXJlKTtcbiAgICBjb25zdCByb3V0ZUlkTW9kZSA9IHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wcyk7XG4gICAgdGhpcy5yb3V0ZUlkTW9kZSA9IHJvdXRlSWRNb2RlO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCAmJiBwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZCh0aGlzLCBwcm9wcy5hcGkpO1xuICAgIH1cbiAgICBjb25zdCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQgPSBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDO1xuICAgIGNvbnN0IHVwc3RyZWFtQ2FsbGJhY2tQYXRoID0gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzKTtcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgICB1cHN0cmVhbUNhbGxiYWNrUGF0aCxcbiAgICApO1xuICAgIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkodGhpcy5yb3V0ZUludmVudG9yeSwgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRocyA9IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLm1hcChcbiAgICAgIChyb3V0ZSkgPT4gcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLFxuICAgICk7XG4gICAgdGhpcy5tY3BQYXRoID0gdGhpcy5tY3BQYXRoc1swXTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNbMF07XG5cbiAgICBjb25zdCBvd25lZE9wdGlvbnMgPSBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHMpO1xuICAgIGxldCBvd25lZFN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb3duZWRTdGFnZU5hbWUgPSBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHByb3BzLmFwaSkge1xuICAgICAgdGhpcy5hcGkgPSBwcm9wcy5hcGk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHN0YWdlT3B0aW9ucyA9IG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvd25lZE9wdGlvbnMuc3RhZ2UpO1xuICAgICAgb3duZWRTdGFnZU5hbWUgPSBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lO1xuICAgICAgY29uc3QgYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgIGFwaU5hbWU6IG93bmVkT3B0aW9ucy5hcGlOYW1lLFxuICAgICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogZmFsc2UsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGkgfSkub3duZWRBcGkgPSBhcGk7XG4gICAgICB0aGlzLmFwaSA9IGFwaTtcblxuICAgICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IGFwaSxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdFbmFibGVkXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgb3duZWRTdGFnZSA9IHN0YWdlO1xuXG4gICAgICBpZiAoc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ1JldGVudGlvbixcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IGFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgXCJNY3BIYW5kbGVyXCIsXG4gICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSxcbiAgICApO1xuICAgIGNvbnN0IHRyYW5zcG9ydEF1dGhvcml6ZXIgPSByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihwcm9wcywgcG9zdHVyZSk7XG4gICAgbGV0IGZpcnN0VHJhbnNwb3J0Um91dGU6IGFwaWd3djIuSHR0cFJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCkge1xuICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9ST09UX1JPVVRFX0lELFxuICAgICAgICBcIi9cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgcHJveHlSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9QUk9YWV9ST1VURV9JRCxcbiAgICAgICAgXCIve3Byb3h5K31cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbih0aGlzLCB0aGlzLmFwaSwgW2ZpcnN0VHJhbnNwb3J0Um91dGUsIHByb3h5Um91dGVdKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcnVudGltZU93bmVkQXV0aCA9IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICAgIHRvSHR0cE1ldGhvZChtZXRob2QpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnJlZ2lzdGVyUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIHVwc3RyZWFtIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgbm90IHBlciBraW5kOiB3aXJlIGl0IGV4YWN0bHkgb25jZS5cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5jYWxsYmFja1BhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcG9zdHVyZU1hcmtlclRhcmdldCA9ICh0aGlzLm93bmVkQXBpPy5ub2RlLmRlZmF1bHRDaGlsZFxuICAgICAgPz8gZmlyc3RUcmFuc3BvcnRSb3V0ZT8ubm9kZS5kZWZhdWx0Q2hpbGQpIGFzIGFwaWd3djIuQ2ZuQXBpIHwgYXBpZ3d2Mi5DZm5Sb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBwb3N0dXJlTWFya2VyVGFyZ2V0Py5hZGRNZXRhZGF0YShNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZLCB7XG4gICAgICBwb3N0dXJlLFxuICAgICAgY29udHJhY3RfaWQ6IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCxcbiAgICAgIHJvdXRlX2NvdW50OiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5sZW5ndGgsXG4gICAgICBydW50aW1lX3Bvc3R1cmVfZGVjbGFyZWQ6IHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHMpO1xuICAgIGlmIChzZXNzaW9uU3RhdGUuZW5hYmxlZCkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHNlc3Npb25TdGF0ZS50YWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBzZXNzaW9uU3RhdGUucmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHsgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHNlc3Npb25TdGF0ZS50dGxNaW51dGVzKSk7XG4gICAgfVxuXG4gICAgbGV0IGVuZHBvaW50QmFzZTogc3RyaW5nO1xuICAgIGlmIChvd25lZE9wdGlvbnMuZG9tYWluKSB7XG4gICAgICBpZiAoIW93bmVkU3RhZ2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkb21haW4gY29uZmlndXJhdGlvbiByZXF1aXJlcyBjb25zdHJ1Y3Qtb3duZWQgQVBJIG1vZGVcIik7XG4gICAgICB9XG4gICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKG93bmVkT3B0aW9ucy5kb21haW4sIG93bmVkU3RhZ2UpO1xuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICB0aGlzLmVuZHBvaW50ID0gdGhpcy5lbmRwb2ludHNbMF07XG4gIH1cblxuICBwcml2YXRlIGFkZFJ1bnRpbWVSb3V0ZShcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsXG4gICAgaW50ZWdyYXRpb246IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uLFxuICAgIGF1dGhvcml6ZXI6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIsXG4gICk6IGFwaWd3djIuSHR0cFJvdXRlIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHRoaXMubmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kLCBwYXRoKSwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBtZXRob2QpLFxuICAgICAgaW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBuZXh0Um91dGVDb25zdHJ1Y3RJZChtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCwgcGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBpZiAodGhpcy5yb3V0ZUlkTW9kZSAhPT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuU0VNQU5USUMpIHtcbiAgICAgIHJldHVybiBgUm91dGUke3RoaXMucm91dGVTZXF1ZW5jZSsrfWA7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCk7XG4gICAgaWYgKHRoaXMucm91dGVJZHMuaGFzKGlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUlkTW9kZSBzZW1hbnRpYyBkZXJpdmVzIHRoZSBkdXBsaWNhdGUgcm91dGUgY29uc3RydWN0IGlkICR7aWR9IGZvciByb3V0ZSBrZXkgJHttZXRob2R9ICR7cGF0aH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5yb3V0ZUlkcy5hZGQoaWQpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIHByaXZhdGUgYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgaW50ZWdyYXRpb246IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uLFxuICAgIGF1dGhvcml6ZXI6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIsXG4gICk6IGFwaWd3djIuSHR0cFJvdXRlIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIGlkLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIGFwaWd3djIuSHR0cE1ldGhvZC5BTlkpLFxuICAgICAgaW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oXG4gICAgb3B0aW9uczogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyxcbiAgICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gb3B0aW9ucy5jZXJ0aWZpY2F0ZSA/PyAob3B0aW9ucy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGVcbiAgICAgIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBkb21haW5OYW1lID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkb21haW5OYW1lO1xuICAgIGNvbnN0IGFwaU1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgZG9tYWluTmFtZSxcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gYXBpTWFwcGluZztcbiAgICBpZiAob3B0aW9ucy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCBjbmFtZVJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHRvUm91dGU1M1JlY29yZE5hbWUob3B0aW9ucy5kb21haW5OYW1lLCBvcHRpb25zLmhvc3RlZFpvbmUpLFxuICAgICAgICBkb21haW5OYW1lOiBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSBjbmFtZVJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdDogbnVtYmVyO1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIHJlYWRvbmx5IGVuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgdHRsTWludXRlczogbnVtYmVyO1xuICByZWFkb25seSByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICBpZiAocHJvcHMucm91dGVGYW1pbHkgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkgYW5kIGRlcHJlY2F0ZWQgbWNwUGF0aCBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhd1BhdHRlcm5zID0gcHJvcHMucm91dGVGYW1pbHk/LnBhdHRlcm5zXG4gICAgPz8gKHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZFxuICAgICAgPyBbcHJvcHMubWNwUGF0aF1cbiAgICAgIDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWFwKFxuICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICApKTtcbiAgaWYgKHJhd1BhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgY29uc3QgcGF0dGVybnMgPSByYXdQYXR0ZXJucy5tYXAoKHBhdHRlcm4sIGluZGV4KSA9PlxuICAgIG5vcm1hbGl6ZVJvdXRlUGF0aChwYXR0ZXJuLCBgcm91dGVGYW1pbHkucGF0dGVybnNbJHtpbmRleH1dYCkpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGlmIChzZWVuLmhhcyhwYXR0ZXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBjb250YWlucyBkdXBsaWNhdGUgcGF0dGVybiAke0pTT04uc3RyaW5naWZ5KHBhdHRlcm4pfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBzZWVuLmFkZChwYXR0ZXJuKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHBhdHRlcm5zLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OlxuICAgICAgcHJvcHMucm91dGVGYW1pbHk/LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5ID8/IGZhbHNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZVBhdGgodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0dGVybmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIik7XG4gIGlmICghcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgY29uc3Qgc2VnbWVudHMgPSByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwIHx8IHNlZ21lbnRzLnNvbWUoKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiXCIpKSB7XG4gICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIH1cbiAgY29uc3QgbGl0ZXJhbCA9IC9eKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKyQvO1xuICBjb25zdCBwYXJhbWV0ZXIgPSAvXlxceyhbQS1aYS16X11bQS1aYS16MC05X10qKVxcfSQvO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICBpZiAocGFyYW1ldGVyLnRlc3Qoc2VnbWVudCkpIGNvbnRpbnVlO1xuICAgIGlmICghbGl0ZXJhbC50ZXN0KHNlZ21lbnQpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ7XCIpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ9XCIpKSB7XG4gICAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZTogc3RyaW5nKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gYWJzb2x1dGUgc3ludGhlc2lzLXRpbWUgcm91dGUgcGF0dGVybiB3aXRoIG5vbi1lbXB0eSBsaXRlcmFsIG9yIHtwYXJhbWV0ZXJfbmFtZX0gc2VnbWVudHMgYW5kIG5vIGRvdCBzZWdtZW50c2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBzdHJpbmcge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGg7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSDtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGNvbmZpZ3VyZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdGhcIixcbiAgICApO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChjb25maWd1cmVkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgcmVhc29uID0gZXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgID8gZXJyLm1lc3NhZ2UucmVwbGFjZSgvXm1jcHJvdXRlczogLywgXCJcIilcbiAgICAgIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggaXMgaW52YWxpZDogJHtyZWFzb259YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuLFxuICBjYWxsYmFja1BhdHRlcm46IHN0cmluZyxcbik6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJvdXRlczogcGF0dGVybnMubWFwKChtY3BQYXR0ZXJuKSA9PiAoe1xuICAgICAgbWNwUGF0dGVybixcbiAgICAgIG1jcE1ldGhvZHM6IFtcIlBPU1RcIiwgXCJHRVRcIiwgXCJERUxFVEVcIl0sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgcmVnaXN0ZXJQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICB9KSksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFwiL1wiKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkLFxuICAgIGNhbGxiYWNrUGF0dGVybixcbiAgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZUludmVudG9yeShcbiAgaW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgYWRkID0gKG1ldGhvZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHttZXRob2R9ICR7cGF0aH1gO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVyaXZlZCByb3V0ZSBmYW1pbHkgY29sbGlkZXMgYXQgJHtrZXl9YCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGtleSk7XG4gIH07XG4gIGZvciAoY29uc3Qgcm91dGUgb2YgaW52ZW50b3J5LnJvdXRlcykge1xuICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIGFkZChtZXRob2QsIHJvdXRlLm1jcFBhdHRlcm4pO1xuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS50b2tlblBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS5yZWdpc3RlclBhdHRlcm4pO1xuICAgIH1cbiAgfVxuICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5jYWxsYmFja1BhdHRlcm4pO1xuICB9XG4gIGlmIChpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGlmICghcHJvcHMuYXBpKSB7XG4gICAgaWYgKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIHJlcXVpcmVzIGF0dGFjaCBtb2RlIHdpdGggYXBpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWRcbiAgICAmJiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKVxuICAgICAgfHwgIS9eKD86XFwkZGVmYXVsdHxbQS1aYS16MC05Xy1dezEsMTI4fSkkLy50ZXN0KHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIEFQSSBHYXRld2F5IHN0YWdlIG5hbWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9wcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJvd25lZEFwaVwiKTtcbiAgaWYgKHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiYXBpTmFtZVwiKTtcbiAgaWYgKHByb3BzLmNvcnMgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiY29yc1wiKTtcbiAgaWYgKHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJkb21haW5cIik7XG4gIGlmIChwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJzdGFnZVwiKTtcbiAgaWYgKGludmFsaWQubGVuZ3RoICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoIG1vZGUgd2l0aCBhcGkgY2Fubm90IGNvbmZpZ3VyZSBvd25lZC1BUEkgcHJvcHM6ICR7aW52YWxpZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgaWYgKHByb3BzLm93bmVkQXBpPy5hcGlOYW1lICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmFwaU5hbWUgYW5kIGRlcHJlY2F0ZWQgYXBpTmFtZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uZG9tYWluICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIGFuZCBkZXByZWNhdGVkIGRvbWFpbiBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2UgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIGFuZCBkZXByZWNhdGVkIHN0YWdlIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhcGlOYW1lOiBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSA/PyBwcm9wcy5hcGlOYW1lLFxuICAgIGRvbWFpbjogcHJvcHMub3duZWRBcGk/LmRvbWFpbiA/PyBwcm9wcy5kb21haW4sXG4gICAgc3RhZ2U6IHByb3BzLm93bmVkQXBpPy5zdGFnZSA/PyBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMpOiBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgY29uc3QgYWNjZXNzTG9nZ2luZyA9IG9wdGlvbnM/LmFjY2Vzc0xvZ2dpbmcgPz8gdHJ1ZTtcbiAgaWYgKCFhY2Nlc3NMb2dnaW5nICYmIG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ1JldGVudGlvbiByZXF1aXJlcyBhY2Nlc3NMb2dnaW5nIHRvIGJlIGVuYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmdFbmFibGVkID0gb3B0aW9ucz8udGhyb3R0bGluZ0VuYWJsZWQgPz8gdHJ1ZTtcbiAgaWYgKFxuICAgICF0aHJvdHRsaW5nRW5hYmxlZFxuICAgICYmIChvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIHRocm90dGxpbmcgbGltaXRzIHJlcXVpcmUgdGhyb3R0bGluZ0VuYWJsZWQgdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF0ZUxpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVDtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihyYXRlTGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ1JhdGVMaW1pdFwiKTtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihidXJzdExpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdCdXJzdExpbWl0XCIpO1xuICByZXR1cm4ge1xuICAgIHN0YWdlTmFtZTogb3B0aW9ucz8uc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIixcbiAgICBhY2Nlc3NMb2dnaW5nLFxuICAgIGFjY2Vzc0xvZ1JldGVudGlvbjogb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgdGhyb3R0bGluZ0VuYWJsZWQsXG4gICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogcmF0ZUxpbWl0LFxuICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBidXJzdExpbWl0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIGNvbnN0IGhhc0xlZ2FjeSA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZDtcbiAgaWYgKHByb3BzLnNlc3Npb25TdGF0ZSAhPT0gdW5kZWZpbmVkICYmIGhhc0xlZ2FjeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBzZXNzaW9uU3RhdGUgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggZGVwcmVjYXRlZCBzZXNzaW9uLXRhYmxlIHByb3BzXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbmFibGVkID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5lbmFibGVkID8/IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSA/PyB0cnVlO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnRhYmxlTmFtZSA/PyBwcm9wcy5zZXNzaW9uVGFibGVOYW1lO1xuICBjb25zdCB0dGxNaW51dGVzID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzXG4gICAgPz8gcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXNcbiAgICA/PyBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVM7XG4gIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gIGlmIChcbiAgICAhZW5hYmxlZFxuICAgICYmICh0YWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkaXNhYmxlZCBzZXNzaW9uIHN0YXRlIGNhbm5vdCBjb25maWd1cmUgdGFibGVOYW1lLCB0dGxNaW51dGVzLCBvciByZW1vdmFsUG9saWN5XCIsXG4gICAgKTtcbiAgfVxuICB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih0dGxNaW51dGVzLCBcInNlc3Npb25TdGF0ZS50dGxNaW51dGVzXCIpO1xuICByZXR1cm4geyBlbmFibGVkLCB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIHJlbW92YWxQb2xpY3kgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHJldHVybjtcbiAgY29uc3QgaXNzdWVyID0gU3RyaW5nKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIpO1xuICBjb25zdCBqd2tzVXJpID0gU3RyaW5nKHByb3BzLmp3a3NVcmkpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBpc3N1ZXIsXG4gICAgICBmYWxzZSxcbiAgICAgIFwiYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChqd2tzVXJpKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgandrc1VyaSxcbiAgICAgIHRydWUsXG4gICAgICBcImp3a3NVcmkgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyB1c2VyaW5mbyBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudHJhbnNwb3J0QXV0aG9yaXplcjtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiB7XG4gICAgICBpZiAoY29uZmlndXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplciBpcyBvbmx5IHZhbGlkIHdpdGggdHJhbnNwb3J0UG9zdHVyZSBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgICAgICA/IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cElhbUF1dGhvcml6ZXIoKVxuICAgICAgICA6IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgIH1cbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiB7XG4gICAgICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcoY29uZmlndXJlZD8uaXNzdWVyID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChpc3N1ZXIgPT09IFwiXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBpcyByZXF1aXJlZCB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgICAgIGlzc3VlcixcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBcInRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGF1ZGllbmNlID0gKGNvbmZpZ3VyZWQ/LmF1ZGllbmNlID8/IFtdKVxuICAgICAgICAubWFwKCh2YWx1ZSkgPT4gU3RyaW5nKHZhbHVlKS50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gXCJcIik7XG4gICAgICBpZiAoYXVkaWVuY2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5hdWRpZW5jZSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgYWNjZXB0ZWQgYXVkaWVuY2Ugd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cEp3dEF1dGhvcml6ZXIoXG4gICAgICAgIE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCxcbiAgICAgICAgaXNzdWVyLFxuICAgICAgICB7XG4gICAgICAgICAgand0QXVkaWVuY2U6IGF1ZGllbmNlLFxuICAgICAgICAgIGlkZW50aXR5U291cmNlOiBjb25maWd1cmVkPy5pZGVudGl0eVNvdXJjZSxcbiAgICAgICAgICBhdXRob3JpemVyTmFtZTogY29uZmlndXJlZD8uYXV0aG9yaXplck5hbWUsXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwb3N0dXJlTGFiZWwocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHN0cmluZyB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06IHJldHVybiBcIklBTVwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHJldHVybiBcIkpXVFwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjogcmV0dXJuIFwiUlVOVElNRV9CRUFSRVJcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHJldHVybiBcIk5PTkVfUFVCTElDXCI7XG4gICAgZGVmYXVsdDogcmV0dXJuIFN0cmluZyhwb3N0dXJlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHZvaWQge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzpcbiAgICAgIHJldHVybjtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVNb2RlbChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlTW9kZWw7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVDtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgIHx8IGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICkge1xuICAgIHJldHVybiBjb25maWd1cmVkO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVQgb3IgLkNPTlNPTElEQVRFRFwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlTW9kZWxQb3N0dXJlKFxuICByb3V0ZU1vZGVsOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICByb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRFxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIGlzIG9ubHkgdmFsaWQgZm9yIHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgb3IgTk9ORV9QVUJMSUM7IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGtlZXBzIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbCBiZWNhdXNlIGNvbnNvbGlkYXRpb24gbXVzdCBuZXZlciBjaGFuZ2UgZ2F0ZXdheSBhZG1pc3Npb25gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJvdXRlSWRNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlSWRNb2RlO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuU0VNQU5USUNcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUlkTW9kZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWSBvciAuU0VNQU5USUNcIixcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgdHdvIGdyZWVkeSByb3V0ZSBrZXlzIGEgY29uc29saWRhdGVkIG1vZGVsIG93bnMuIEEgY29uc3VtZXIgcm91dGUgdGhhdFxuICogcmVkZWNsYXJlcyBvbmUgb2YgdGhlbSB3b3VsZCBtYWtlIHRoZSBBUEkgcmVqZWN0IHRoZSB1cGRhdGUuXG4gKi9cbmNvbnN0IENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUyA9IG5ldyBTZXQoW1wiQU5ZIC9cIiwgXCJBTlkgL3twcm94eSt9XCJdKTtcblxuLyoqXG4gKiBSZXNvbHZlIGFuIGBBcGlJZGAgKG9yIGFueSB0ZW1wbGF0ZSB2YWx1ZSkgdG8gYSBjb21wYXJhYmxlIHN0cmluZywgc28gYVxuICogYFJlZmAgdG9rZW4gYW5kIGl0cyBsb2dpY2FsIGlkIGNvbXBhcmUgZXF1YWwgYWNyb3NzIHR3byB0ZW1wbGF0ZXMgb2YgdGhlIHNhbWVcbiAqIHN0YWNrLlxuICovXG5mdW5jdGlvbiBjb21wYXJhYmxlQXBpSWQoc2NvcGU6IENvbnN0cnVjdCwgdmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoU3RhY2sub2Yoc2NvcGUpLnJlc29sdmUodmFsdWUpKTtcbn1cblxuLyoqXG4gKiBFdmVyeSBBUEkgR2F0ZXdheSB2MiByb3V0ZSBib3VuZCB0byBgYXBpYCwgcmVnYXJkbGVzcyBvZiB3aGljaCBjb25zdHJ1Y3RcbiAqIHNjb3BlIGNyZWF0ZWQgaXQuXG4gKlxuICogYGFwaS5ub2RlLmNoaWxkcmVuYCBvbmx5IHNlZXMgcm91dGVzIHRoZSBBUEkgaXRzZWxmIChvciBhIGNoaWxkIHNjb3BlKVxuICogY3JlYXRlZCwgd2hpY2ggbWlzc2VzIHRoZSBjb21tb24gcGF0dGVybiBvZiBhIHN0YWNrLWxldmVsIGNvbnN0cnVjdCB3aXJpbmcgYVxuICogcm91dGUgb250byBhbiBhdHRhY2hlZCBBUEkuIFdhbGtpbmcgdGhlIHN0YWNrIGFuZCByZXNvbHZpbmcgZWFjaCBgQ2ZuUm91dGVgJ3NcbiAqIGBBcGlJZGAgc2VlcyBib3RoLlxuICovXG5mdW5jdGlvbiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuUm91dGVbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmblJvdXRlW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkh0dHBSb3V0ZSkge1xuICAgICAgaWYgKGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5odHRwQXBpLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICAgIGZvdW5kLnB1c2gobm9kZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSByb3V0ZSdzIG93biBDZm5Sb3V0ZSBjaGlsZCBpcyB0aGUgc2FtZSByb3V0ZTsgZG8gbm90IGRvdWJsZSBjb3VudC5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmblJvdXRlICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kLmZpbHRlcigocm91dGUpID0+IHJvdXRlICE9PSB1bmRlZmluZWQpO1xufVxuXG4vKipcbiAqIFJlZnVzZSBhIGNvbnNvbGlkYXRlZCBhdHRhY2ggb250byBhbiBBUEkgdGhhdCBhbHJlYWR5IGNhcnJpZXMgcm91dGVzLlxuICpcbiAqIFRoZSBjaGVjayBkZWxpYmVyYXRlbHkgd2Fsa3MgdGhlIHdob2xlIHN0YWNrOiBhIHJvdXRlIGJvdW5kIHRvIHRoZSBhdHRhY2hlZFxuICogQVBJIGZyb20gYSBzaWJsaW5nIGNvbnN0cnVjdCBzY29wZSBpcyBqdXN0IGFzIG11Y2ggYSByb3V0ZSBrZXkgdGhlXG4gKiBjb25zb2xpZGF0ZWQgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGggYXMgb25lIGNyZWF0ZWQgdW5kZXIgdGhlIEFQSVxuICogaXRzZWxmLlxuICovXG5mdW5jdGlvbiBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZ1JvdXRlcyA9IHJvdXRlc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gIGlmIChleGlzdGluZ1JvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIG1heSBhdHRhY2ggb25seSB0byBhbiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lOyBcIlxuICAgICAgKyBgdGhlIEFQSSBhbHJlYWR5IGNhcnJpZXMgJHtleGlzdGluZ1JvdXRlcy5sZW5ndGh9IHJvdXRlKHMpOiAke2V4aXN0aW5nUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUucGF0aCkuam9pbihcIiwgXCIpfTsgYFxuICAgICAgKyBcImF0dGFjaCB0byBhIG5ldyBvciBlbXB0eSBBUEksIG9yIHVzZSByb3V0ZU1vZGVsIGV4cGxpY2l0XCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBzeW50aC10aW1lIHJ1bGUgZm9yIHJvdXRlcyBhZGRlZCB0byBhIGNvbnNvbGlkYXRlZCBBUEkgQUZURVJcbiAqIHRoZSBjb25zdHJ1Y3QgYXR0YWNoZWQuXG4gKlxuICogVGhlIGRvY3VtZW50ZWQgZXhjZXB0aW9uIGlzIHdoYXQgbWFrZXMgY29uc29saWRhdGVkIGF0dGFjaCB1c2FibGUgaW4gYSByZWFsXG4gKiBmcm9udCBkb29yOiBhIGNvbnN1bWVyIG1heSBhZGQgZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIGFmdGVyd2FyZHMuIEl0XG4gKiBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGUgcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgKHNvIHRoZSBncmVlZHlcbiAqIHJvdXRlcyBuZXZlciBzaWxlbnRseSB3aWRlbiBhIHN0cmljdGVyIHBvc3R1cmUpIGFuZCBkb2VzIG5vdCByZWRlY2xhcmUgYVxuICogZ3JlZWR5IHJvdXRlIGtleSAod2hpY2ggQVBJIEdhdGV3YXkgd291bGQgcmVqZWN0IGFzIGEgZHVwbGljYXRlKS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJDb25zb2xpZGF0ZWRBdHRhY2hWYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4gIG93bmVkUm91dGVzOiBhcGlnd3YyLkh0dHBSb3V0ZVtdLFxuKTogdm9pZCB7XG4gIGNvbnN0IG93bmVkID0gbmV3IFNldChcbiAgICBvd25lZFJvdXRlcy5tYXAoKHJvdXRlKSA9PiByb3V0ZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKSxcbiAgKTtcbiAgU3RhY2sub2Yoc2NvcGUpLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKSkge1xuICAgICAgICBpZiAob3duZWQuaGFzKHJvdXRlKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlS2V5ID0gcm91dGUucm91dGVLZXk7XG4gICAgICAgIGlmIChDT05TT0xJREFURURfR1JFRURZX1JPVVRFX0tFWVMuaGFzKHJvdXRlS2V5KSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgYWxyZWFkeSBvd25zIHRoZSBncmVlZHkgQVBJIEdhdGV3YXkgcm91dGUga2V5ICR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfSBvbiB0aGlzIEFQSTsgYSBjb25zdW1lciByb3V0ZSBhZGRlZCBhZnRlciBhdHRhY2ggbXVzdCBub3QgcmVkZWNsYXJlIGl0ICgke3JvdXRlLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25UeXBlID0gU3RyaW5nKHJvdXRlLmF1dGhvcml6YXRpb25UeXBlID8/IFwiTk9ORVwiKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblR5cGUgPT09IFwiTk9ORVwiKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhIHJvdXRlIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlciBhdHRhY2ggbXVzdCBjYXJyeSBhIG5vbi1OT05FIGF1dGhvcml6ZXIsIGJlY2F1c2UgdGhlIGdyZWVkeSByb3V0ZXMgYWRtaXQgZXZlcnkgbWV0aG9kIGFuZCBwYXRoIGF0IHRoZSBnYXRld2F5ICgke3JvdXRlS2V5fSBmcm9tICR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBlcnJvcnM7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50KTogdm9pZCB7XG4gIGlmIChmYWNhZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBwcm92aWRlcklkID0gKGZhY2FkZSBhcyB7IHByb3ZpZGVySWQ/OiB1bmtub3duIH0pPy5wcm92aWRlcklkO1xuICBpZiAoXG4gICAgdHlwZW9mIHByb3ZpZGVySWQgIT09IFwic3RyaW5nXCJcbiAgICB8fCBwcm92aWRlcklkLnRyaW0oKSA9PT0gXCJcIlxuICAgIHx8IFRva2VuLmlzVW5yZXNvbHZlZChwcm92aWRlcklkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZmFjYWRlLnByb3ZpZGVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHN0cmluZ1wiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3N0dXJlR3VhcmRzKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHJvdXRlRmFtaWx5OiBOb3JtYWxpemVkUm91dGVGYW1pbHksXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUMpIHtcbiAgICBpZiAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkIHx8IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG9yIGp3a3NVcmlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZW5hYmxlIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgdXBzdHJlYW1DYWxsYmFja1BhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0gY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZT8udGhyb3R0bGluZ0VuYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhbiBleHBsaWNpdCBvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nRW5hYmxlZDogdHJ1ZSB0aHJvdHRsaW5nIGRlY2lzaW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2U/LmFjY2Vzc0xvZ2dpbmcgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYWNjZXNzIGxvZ2dpbmdgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIpIHtcbiAgICB2YWxpZGF0ZURlbmlhbFNpZ25hbChwcm9wcy5kZW5pYWxTaWduYWwpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShcbiAgZGVmZW5zZTogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMgfCB1bmRlZmluZWQsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGRlZmVuc2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZSB0byByZWNvcmQgdGhlIG93bmluZyBBUEkncyBhY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWNpc2lvbnNgLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlZmVuc2UuYWNjZXNzTG9nZ2luZyAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS5hY2Nlc3NMb2dnaW5nIHRvIGJlIHRydWVgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZzogUGFydGlhbDxBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucz4gfCB1bmRlZmluZWQgPSBkZWZlbnNlLnRocm90dGxpbmc7XG4gIGNvbnN0IHJhdGVMaW1pdCA9IHRocm90dGxpbmc/LnJhdGVMaW1pdDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IHRocm90dGxpbmc/LmJ1cnN0TGltaXQ7XG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdClcbiAgICB8fCAocmF0ZUxpbWl0IGFzIG51bWJlcikgPD0gMFxuICAgIHx8ICFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdClcbiAgICB8fCAoYnVyc3RMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLnRocm90dGxpbmcgcmF0ZUxpbWl0IGFuZCBidXJzdExpbWl0IHRvIGJlIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKHNpZ25hbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgZGVuaWFsU2lnbmFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLm1ldHJpY05hbWUgIT09IHVuZGVmaW5lZCAmJiBzaWduYWwubWV0cmljTmFtZSAhPT0gTUNQX0RFTklBTF9NRVRSSUNfTkFNRSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5tZXRyaWNOYW1lIG11c3QgYmUgJHtNQ1BfREVOSUFMX01FVFJJQ19OQU1FfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLmRpbWVuc2lvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSBBcnJheS5pc0FycmF5KHNpZ25hbC5kaW1lbnNpb25zKSA/IHNpZ25hbC5kaW1lbnNpb25zIDogW107XG4gICAgY29uc3QgYm91bmRlZCA9IGRpbWVuc2lvbnMubGVuZ3RoID09PSBNQ1BfREVOSUFMX0RJTUVOU0lPTlMubGVuZ3RoXG4gICAgICAmJiBNQ1BfREVOSUFMX0RJTUVOU0lPTlMuZXZlcnkoXG4gICAgICAgIChkaW1lbnNpb24pID0+IGRpbWVuc2lvbnMuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgPT09IGRpbWVuc2lvbikubGVuZ3RoID09PSAxLFxuICAgICAgKTtcbiAgICBpZiAoIWJvdW5kZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLmRpbWVuc2lvbnMgbXVzdCBiZSBleGFjdGx5ICR7SlNPTi5zdHJpbmdpZnkoTUNQX0RFTklBTF9ESU1FTlNJT05TKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==