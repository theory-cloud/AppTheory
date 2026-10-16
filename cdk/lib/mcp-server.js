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
exports.AppTheoryMcpServer = exports.AppTheoryMcpOriginReachability = exports.AppTheoryMcpTransportPosture = exports.AppTheoryMcpRouteModel = void 0;
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
        const routeModel = resolveRouteModel(props);
        validateRouteModelPosture(routeModel, posture);
        if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED && props.api !== undefined) {
            assertConsolidatedAttachAllowed(props.api);
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
            this.addConsolidatedRoute(CONSOLIDATED_PROXY_ROUTE_ID, "/{proxy+}", integration, transportAuthorizer);
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
        return new apigwv2.HttpRoute(this, `Route${this.routeSequence++}`, {
            httpApi: this.api,
            routeKey: apigwv2.HttpRouteKey.with(path, method),
            integration,
            authorizer,
        });
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
function assertConsolidatedAttachAllowed(api) {
    const existingRoutes = api.node.children.filter((child) => child instanceof apigwv2.HttpRoute);
    if (existingRoutes.length > 0) {
        throw new Error("AppTheoryMcpServer: routeModel consolidated may attach only to an API that has no routes at attach time; attach to a new or empty API, or use routeModel explicit");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCx3RUFBMEQ7QUFDMUQsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBRXJELDJEQUE2QztBQUM3QyxpRUFBbUQ7QUFDbkQsMkNBQXVDO0FBRXZDLDJEQUErRDtBQUMvRCxpQ0FBNEM7QUFHNUMsTUFBTSwwQkFBMEIsR0FBRyxjQUFjLENBQUM7QUFDbEQsTUFBTSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7QUFDcEQsTUFBTSw2QkFBNkIsR0FBRyxHQUFHLENBQUM7QUFDMUMsTUFBTSw4QkFBOEIsR0FBRyxHQUFHLENBQUM7QUFDM0MsTUFBTSwyQkFBMkIsR0FBRyxFQUFFLENBQUM7QUFDdkMsTUFBTSwyQkFBMkIsR0FBRyx3QkFBd0IsQ0FBQztBQUM3RCxNQUFNLGtDQUFrQyxHQUFHLGlDQUFpQyxDQUFDO0FBQzdFLE1BQU0saUNBQWlDLEdBQUcsOEJBQThCLENBQUM7QUFDekUsTUFBTSxzQkFBc0IsR0FBRywyQkFBMkIsQ0FBQztBQUMzRCxNQUFNLHFCQUFxQixHQUFHLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBRTFELG1EQUFtRDtBQUNuRCxJQUFZLHNCQWdCWDtBQWhCRCxXQUFZLHNCQUFzQjtJQUNoQzs7OztPQUlHO0lBQ0gsK0NBQXFCLENBQUE7SUFDckI7Ozs7Ozs7T0FPRztJQUNILHVEQUE2QixDQUFBO0FBQy9CLENBQUMsRUFoQlcsc0JBQXNCLHNDQUF0QixzQkFBc0IsUUFnQmpDO0FBRUQsb0VBQW9FO0FBQ3BFLElBQVksNEJBU1g7QUFURCxXQUFZLDRCQUE0QjtJQUN0QyxtR0FBbUc7SUFDbkcsMkNBQVcsQ0FBQTtJQUNYLDJFQUEyRTtJQUMzRSwyQ0FBVyxD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LE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDdEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLEtBQWE7SUFDbEQsTUFBTSxTQUFTLEdBQUcsa0NBQWtDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsT0FBTyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsU0FBUyw4QkFBOEIsQ0FBQyxLQUFhO0lBQ25ELE1BQU0sU0FBUyxHQUFHLHdDQUF3QyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMgfSBmcm9tIFwiLi9odHRwLWFwaVwiO1xuXG5jb25zdCBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCA9IFwiUm91dGVBbnlSb290XCI7XG5jb25zdCBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQgPSBcIlJvdXRlQW55UHJveHlcIjtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFJvdXRlLWVtaXNzaW9uIG1vZGVsIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgLyoqXG4gICAqIE9uZSBBUEkgR2F0ZXdheSBIVFRQIEFQSSB2MiByb3V0ZSBwZXIgZGVyaXZlZCByb3V0ZSBrZXkuIFRoaXMgaXMgdGhlXG4gICAqIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3IgZGVwbG95ZWRcbiAgICogc3RhY2tzLCBzbyBhIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgdXBncmFkZSBkZXBsb3lzIGluIHBsYWNlLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIEVYUExJQ0lUID0gXCJleHBsaWNpdFwiLFxuICAvKipcbiAgICogVHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCwgYmFja2VkIGJ5IG9uZSBzaGFyZWRcbiAgICogaW50ZWdyYXRpb24uIFRoZSBBcHBUaGVvcnkgcnVudGltZSByb3V0ZXIgcGVyZm9ybXMgbWV0aG9kIGFuZCBwYXRoXG4gICAqIGRpc3BhdGNoLCBwYXRoLXBhcmFtZXRlciBjYXB0dXJlLCBhbmQgZGVuaWFsLiBDb25zb2xpZGF0aW9uIG5ldmVyIGNoYW5nZXNcbiAgICogZ2F0ZXdheSBhZG1pc3Npb24sIHNvIGl0IGlzIHZhbGlkIG9ubHkgd2hlbiBldmVyeSBnYXRld2F5IHJvdXRlIGlzIGBOT05FYDpcbiAgICogdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0IHBvc3R1cmVzLiBgaWFtYCBhbmQgYGp3dGBcbiAgICogYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzIHRpbWUuXG4gICAqL1xuICBDT05TT0xJREFURUQgPSBcImNvbnNvbGlkYXRlZFwiLFxufVxuXG4vKiogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuIFRoZSBkZWZhdWx0IGZvciBhIHNlcnZlciB3aXRoIG5vIGZhY2FkZSBhdHRhY2htZW50LiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogQSBzdGF0aWMgSldUIGF1dGhvcml6ZXIgKGlzc3VlciArIGF1ZGllbmNlKSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gKi9cbiAgSldUID0gXCJqd3RcIixcbiAgLyoqIFRoZSBnYXRld2F5IGF1dGhvcml6ZXIgaXMgTk9ORSBhbmQgdGhlIHJ1bnRpbWUgdmFsaWRhdGVzIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMuIFRoZSBkZWZhdWx0IGZvciBhIGZhY2FkZS1jb25maWd1cmVkIHNlcnZlci4gKi9cbiAgUlVOVElNRV9CRUFSRVIgPSBcInJ1bnRpbWUtYmVhcmVyXCIsXG4gIC8qKiBEZWxpYmVyYXRlbHkgcHVibGljIE1DUCBzZXJ2ZXI6IGV2ZXJ5IHRyYW5zcG9ydCByb3V0ZSBpcyBwdWJsaWMuIE5ldmVyIGEgZGVmYXVsdC4gKi9cbiAgTk9ORV9QVUJMSUMgPSBcIm5vbmUtcHVibGljXCIsXG59XG5cbi8qKiBQcmVzZW5jZS1vbmx5IHNrZWxldG9uIG9mIHRoZSB1cHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgc2VsZWN0cyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50IHtcbiAgLyoqIElkZW50aWZpZXMgdGhlIHVwc3RyZWFtIGF1dGhvcml6YXRpb24gcHJvdmlkZXIgdGhpcyBzZXJ2ZXIgZnJvbnRzIChmb3IgZXhhbXBsZSBgYXV0aGVvcnlgKS4gUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUgYW5kIHVzZXMgaXRzIHByZXNlbmNlIHRvIHNlbGVjdCB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBkZWZhdWx0LiAqL1xuICByZWFkb25seSBwcm92aWRlcklkOiBzdHJpbmc7XG59XG5cbi8qKiBSdW50aW1lLXNpZGUgZGVjbGFyYXRpb24gdGhhdCB0aGUgdHJhbnNwb3J0IHJvdXRlcyB2YWxpZGF0ZSBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zIGF0IHJ1bnRpbWUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucyB7XG4gIC8qKiBBc3NlcnQgdGhlIHJ1bnRpbWUgcmVnaXN0ZXJzIHRoZSB0cmFuc3BvcnQgcm91dGVzIHdpdGggdGhlIHJ1bnRpbWUtdmFsaWRhdGVkIGJlYXJlciBwb3N0dXJlIChHbyBgRmFjYWRlQ29uZmlnLlJlcXVpcmVCZWFyZXJUb2tlbmAsIFRTIGByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlYCwgUHl0aG9uIGByZXF1aXJlX2JlYXJlcl90b2tlbl9taWRkbGV3YXJlYCkuIE11c3QgYmUgYHRydWVgLiAqL1xuICByZWFkb25seSByZXF1aXJlQmVhcmVyVG9rZW46IGJvb2xlYW47XG59XG5cbi8qKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqIFRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGlzIGRpc2FibGVkLiAqL1xuICBESVNBQkxFRCA9IFwiZGlzYWJsZWRcIixcbiAgLyoqIFRoZSBvcmlnaW4gaXMgcmVhY2hhYmxlIG9ubHkgdGhyb3VnaCBhIGxvY2tlZCBmcm9udCBkb29yIChDbG91ZEZyb250IC8gVlBDIG9yaWdpbikuICovXG4gIExPQ0tFRCA9IFwibG9ja2VkXCIsXG59XG5cbi8qKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMge1xuICAvKiogRGVuaWFsIG1ldHJpYyBuYW1lLiBNdXN0IGJlIGBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkYC4gQGRlZmF1bHQgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZCAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lPzogc3RyaW5nO1xuICAvKiogQm91bmRlZCBtZXRyaWMgZGltZW5zaW9ucy4gTXVzdCBiZSBleGFjdGx5IGBvdXRjb21lYCBhbmQgYHJvdXRlX2ZhbWlseWAuIEBkZWZhdWx0IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl0gKi9cbiAgcmVhZG9ubHkgZGltZW5zaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vKiogT3duaW5nLUFQSSBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucyB7XG4gIC8qKiBTdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdDogbnVtYmVyO1xuICAvKiogU3RhZ2UgYnVyc3QgbGltaXQuICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuLyoqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIGRlZmVuc2UtaW4tZGVwdGggZGVjaXNpb25zIChyZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMge1xuICAvKiogV2hldGhlciB0aGUgb3duaW5nIEFQSSdzIHN0YWdlIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLiBNdXN0IGJlIHRydWUuICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIC8qKiBUaGUgb3duaW5nIEFQSSdzIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmc6IEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zO1xufVxuXG4vKiogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgSFRUUFMgSldUIGlzc3VlciBVUkwuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBhdWRpZW5jZT86IHN0cmluZ1tdO1xuICAvKiogSWRlbnRpdHkgc291cmNlcyBmb3IgdGhlIEpXVCBhdXRob3JpemVyLiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gQGRlZmF1bHQgdGhlIGF1dGhvcml6ZXIgY29uc3RydWN0IGlkICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xufVxuXG4vKiogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlLCBgbWNwLmV4YW1wbGUuY29tYCkuICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlQXJuYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGFuIGF1dG9tYXRpY2FsbHkgY3JlYXRlZCBDTkFNRSByZWNvcmQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbi8qKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgXCIkZGVmYXVsdFwiICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgdGhlIGFjY2VzcyBsb2cgZ3JvdXAuIFZhbGlkIG9ubHkgd2hlbiBhY2Nlc3MgbG9nZ2luZ1xuICAgKiBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC5cbiAgICogQGRlZmF1bHQgMTAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCAyMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKiogT3duZWQtQVBJIHNwZWNpYWxpemF0aW9uIGZvciBzdGFuZGFsb25lIE1DUCBzZXJ2ZXJzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnMge1xuICAvKiogT3B0aW9uYWwgQVBJIG5hbWUuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIE9wdGlvbmFsIGN1c3RvbSBkb21haW4gb3duZWQgYnkgdGhpcyBjb25zdHJ1Y3QuICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uIEFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlZmF1bHQgb24uXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKiogT3JkZXJlZCBNQ1Agcm91dGUtcGF0dGVybiBmYW1pbHkgd2lyZWQgYXMgb25lIGZhY2FkZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUm91dGVGYW1pbHkge1xuICAvKipcbiAgICogT3JkZXJlZCBzeW50aGVzaXMtdGltZSBNQ1Agcm91dGUgcGF0dGVybnMuXG4gICAqXG4gICAqIEVhY2ggc2VnbWVudCBpcyBlaXRoZXIgYSBsaXRlcmFsIFJGQyAzOTg2IHBhdGggc2VnbWVudCBvciBhIGNvbXBsZXRlXG4gICAqIGB7cGFyYW1ldGVyX25hbWV9YCBzZWdtZW50LiBDREsgdG9rZW5zLCBvcmlnaW5zLCBlbXB0eSBzZWdtZW50cywgZG90XG4gICAqIHNlZ21lbnRzLCBncmVlZHkgcGFyYW1ldGVycywgYW5kIGR1cGxpY2F0ZSBwYXR0ZXJucyBhcmUgcmVqZWN0ZWQuXG4gICAqL1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdpcmUgdGhlIGFsZ2VicmEtZGVyaXZlZCB1bnNjb3BlZCBhdXRob3JpemF0aW9uLXNlcnZlciBkaXNjb3Zlcnkgcm91dGUuXG4gICAqIFRoZSBydW50aW1lIG11c3Qgc3VwcGx5IGBGYWNhZGVDb25maWcuUm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJgIHRvby5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5PzogYm9vbGVhbjtcbn1cblxuLyoqIER5bmFtb0RCLWJhY2tlZCBNQ1Agc2Vzc2lvbi1zdGF0ZSBjb25maWd1cmF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgZW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgbmFtZS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgYXV0by1nZW5lcmF0ZWRcbiAgICovXG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVFRMIGluIG1pbnV0ZXMgZm9yIHNlc3Npb24gcmVjb3Jkcy4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXNcbiAgICogZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgcmVtb3ZhbCBwb2xpY3kuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbn1cblxuLyoqIE9uZSBkZXJpdmVkIE1DUCBPQXV0aCBmYWNhZGUgcm91dGUgZmFtaWx5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZSB7XG4gIHJlYWRvbmx5IG1jcFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbWNwTWV0aG9kczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSB0b2tlblBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcmVnaXN0ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xuICByZWFkb25seSBjYWxsYmFja1BhdHRlcm46IHN0cmluZztcbn1cblxuLyoqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKiogTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIHRoZSBydW50aW1lLWNvbXBvc2VkIE1DUCBmYWNhZGUuICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIE1DUCBmYWNhZGUgZmFtaWxpZXMgdGhhdFxuICAgKiBzaGFyZSBvbmUgTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5XG4gICAqIHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSb3V0ZS1lbWlzc2lvbiBtb2RlbC5cbiAgICpcbiAgICogYGV4cGxpY2l0YCAodGhlIGRlZmF1bHQpIHdpcmVzIHRoZSBmdWxsIGRlcml2ZWQgcm91dGUgaW52ZW50b3J5IGFzIG9uZSBIVFRQXG4gICAqIEFQSSB2MiByb3V0ZSBwZXIgcm91dGUga2V5IGFuZCBpcyBieXRlLXN0YWJsZSBmb3IgZGVwbG95ZWQgc3RhY2tzLlxuICAgKiBgY29uc29saWRhdGVkYCB3aXJlcyBleGFjdGx5IHR3byBncmVlZHkgcm91dGVzLCBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAsXG4gICAqIGFuZCBpcyB2YWxpZCBvbmx5IGZvciB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCB0cmFuc3BvcnRcbiAgICogcG9zdHVyZXM7IGBpYW1gIGFuZCBgand0YCBhcmUgcmVmdXNlZCBhdCBzeW50aGVzaXMuXG4gICAqXG4gICAqIENvbnNvbGlkYXRlZCBtb2RlIGlzIGFsbG93ZWQgb24gYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLCBvciBvbiBhbiBhdHRhY2hlZFxuICAgKiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lLiBBIGNvbnN1bWVyIG1heSBhZGQgZXhwbGljaXQsIG1vcmVcbiAgICogc3BlY2lmaWMgcm91dGVzIHdpdGggYSBzdHJpY3RlciBhdXRob3JpemVyIG9uIHRoZSBzYW1lIEFQSSBhZnRlcndhcmRzOyBhXG4gICAqIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggYmVhdHMgdGhlIGdyZWVkeSByb3V0ZXMgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSxcbiAgICogYW5kIGEgd3JvbmctbWV0aG9kIGhpdCBvbiBzdWNoIGEgcGF0aCBmYWxscyB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkXG4gICAqIDQwNC80MDUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlTW9kZWw/OiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsO1xuXG4gIC8qKlxuICAgKiBDT1JTIHByZWZsaWdodCBmb3IgYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBTZXQgdG8gYHRydWVgIGZvciBBcHBUaGVvcnlcbiAgICogZGVmYXVsdHMgb3Igc3VwcGx5IGFuIGBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnNgIG9iamVjdC4gSW52YWxpZCBpblxuICAgKiBhdHRhY2ggbW9kZSwgd2hlcmUgdGhlIG93bmluZyBBUEkgY29uZmlndXJlcyBDT1JTLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeGlzdGluZyBIVFRQIEFQSSB0byBhdHRhY2ggdG8uIEF0dGFjaCBtb2RlIGlzIHRoZSBwcmltYXJ5IGZyb250LWRvb3JcbiAgICogdG9wb2xvZ3kgYW5kIG5ldmVyIGNyZWF0ZXMgYW4gYEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlgIHJlc291cmNlLlxuICAgKiBAZGVmYXVsdCBhIGNvbnN0cnVjdC1vd25lZCBIdHRwQXBpXG4gICAqL1xuICByZWFkb25seSBhcGk/OiBhcGlnd3YyLklIdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lIHVzZWQgd2hlbiBkZXJpdmluZyBhdHRhY2gtbW9kZSBleGVjdXRlLWFwaSBlbmRwb2ludCB0ZW1wbGF0ZXMuXG4gICAqIFVzZSBgJGRlZmF1bHRgIGZvciB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdCBzdGFnZS4gV2hlbiBvbWl0dGVkLCB0aGUgc3RhZ2VcbiAgICogaXMgbm90IGRldGVybWluYWJsZSBhbmQgdGhlIHRlbXBsYXRlcyByZXRhaW4gdGhlIGJhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luLlxuICAgKiBUaGlzIHByb3AgZG9lcyBub3QgY3JlYXRlLCBpbXBvcnQsIG9yIG11dGF0ZSBhIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF0dGFjaGVkQXBpU3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEdvIGBydW50aW1lL21jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAgc2VydmVzIG9ubHkgdGhlIGNhbm9uaWNhbCBkZWZhdWx0XG4gICAqIGZhbWlseS4gTm9uY2Fub25pY2FsIHBhdHRlcm5zIHJlcXVpcmUgYXBwLW93bmVkIHJ1bnRpbWUgcm91dGUgcmVnaXN0cmF0aW9uXG4gICAqIHRoYXQgbWF0Y2hlcyB0aGUgY29uc3RydWN0J3MgYHJvdXRlSW52ZW50b3J5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKClcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlRmFtaWx5PzogQXBwVGhlb3J5TWNwUm91dGVGYW1pbHk7XG5cbiAgLyoqXG4gICAqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEFuIGV4cGxpY2l0IHNlbGVjdGlvbiBvdmVycmlkZXMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gV2hlbiBpdCBpc1xuICAgKiBvbWl0dGVkLCBhIHNlcnZlciB0aGF0IGF0dGFjaGVzIGBmYWNhZGVgIHJlc29sdmVzIHRvIGBydW50aW1lLWJlYXJlcmAgYW5kIGFcbiAgICogcGxhaW4gdHJhbnNwb3J0IHNlcnZlciByZXNvbHZlcyB0byBgaWFtYC4gYG5vbmUtcHVibGljYCBpcyBuZXZlciBhIGRlZmF1bHRcbiAgICogYW5kIGNhcnJpZXMgdGhlIGRlZmVuc2UtaW4tZGVwdGggZmxvb3IuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIgd2hlbiBgZmFjYWRlYCBpcyBhdHRhY2hlZCwgb3RoZXJ3aXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcblxuICAvKipcbiAgICogVXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IG1hcmtzIHRoaXMgc2VydmVyIGFzIGZhY2FkZS1jb25maWd1cmVkLlxuICAgKlxuICAgKiBUaGUgYXR0YWNobWVudCdzIHByZXNlbmNlIHNlbGVjdHMgdGhlIGBydW50aW1lLWJlYXJlcmAgcG9zdHVyZSBkZWZhdWx0LlxuICAgKiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50O1xuXG4gIC8qKlxuICAgKiBSdW50aW1lLXNpZGUgUkZDIDk3MjggYmVhcmVyIHZhbGlkYXRpb24gZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVkIGJ5IGB0cmFuc3BvcnRQb3N0dXJlOiBSVU5USU1FX0JFQVJFUmAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnlcbiAgICogb3RoZXIgcG9zdHVyZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBydW50aW1lUG9zdHVyZT86IEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucztcblxuICAvKipcbiAgICogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kXG4gICAqIE5PTkVfUFVCTElDLiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gaXMgcmVmdXNlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk/OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcblxuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLklIdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIC8qKlxuICAgKiBSZXNvbHZlZCB0cmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBGYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXJzIHJlc29sdmUgdG8gYHJ1bnRpbWUtYmVhcmVyYCB1bmxlc3NcbiAgICogYHRyYW5zcG9ydFBvc3R1cmVgIG92ZXJyaWRlcyB0aGUgZGVmYXVsdDsgcGxhaW4gdHJhbnNwb3J0IHNlcnZlcnMgcmVzb2x2ZVxuICAgKiB0byBgaWFtYC4gRGVsaWJlcmF0ZWx5IHB1YmxpYyBzZXJ2ZXJzIG11c3Qgc2VsZWN0IGBub25lLXB1YmxpY2AgZXhwbGljaXRseS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuICAvKipcbiAgICogRGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZXMgZm9yIHRoZSBvcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIHRoZXNlIGFyZSBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGVzLCBub3QgZGVjbGFyYXRpb25zIG9mXG4gICAqIHB1YmxpYyBhdXRob3JpdHkuIEFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZDsgdGhlIG9yaWdpbiBpcyBkZXJpdmVkXG4gICAqIGZyb20gYGFwaUlkYCwgdGhlIHN0YWNrIHJlZ2lvbiBhbmQgVVJMIHN1ZmZpeCwgcGx1c1xuICAgKiBgYXR0YWNoZWRBcGlTdGFnZU5hbWVgIHdoZW4gc3VwcGxpZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnRzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnk7XG5cbiAgLyoqXG4gICAqIEZpcnN0IGRlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGUuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIGFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZC4gVGhpcyB2YWx1ZSBpcyBhblxuICAgKiBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGUgZGVyaXZlZCBieSB0aGUgc2FtZSBydWxlcyBhcyBgZW5kcG9pbnRzYCwgbm90XG4gICAqIHRoZSBmcm9udCBkb29yJ3MgcHVibGljIGF1dGhvcml0eS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBlbmRwb2ludHNgLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgbWNwUGF0aHNgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc2Agb3IgYHJvdXRlSW52ZW50b3J5YC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzKTtcbiAgICBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCByb3V0ZUZhbWlseSA9IG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzKTtcblxuICAgIGNvbnN0IHBvc3R1cmUgPSBwcm9wcy50cmFuc3BvcnRQb3N0dXJlXG4gICAgICA/PyAocHJvcHMuZmFjYWRlICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgICAgIDogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0pO1xuICAgIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQocHJvcHMuZmFjYWRlKTtcbiAgICB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMocHJvcHMsIHJvdXRlRmFtaWx5LCBwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKHByb3BzLCBwb3N0dXJlKTtcbiAgICBjb25zdCByb3V0ZU1vZGVsID0gcmVzb2x2ZVJvdXRlTW9kZWwocHJvcHMpO1xuICAgIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUocm91dGVNb2RlbCwgcG9zdHVyZSk7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEICYmIHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHByb3BzLmFwaSk7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCA9IHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM7XG4gICAgY29uc3QgdXBzdHJlYW1DYWxsYmFja1BhdGggPSByZXNvbHZlVXBzdHJlYW1DYWxsYmFja1BhdGgocHJvcHMpO1xuXG4gICAgdGhpcy50cmFuc3BvcnRQb3N0dXJlID0gcG9zdHVyZTtcbiAgICB0aGlzLm1jcFBhdGhzID0gWy4uLnJvdXRlRmFtaWx5LnBhdHRlcm5zXTtcbiAgICB0aGlzLnJvdXRlSW52ZW50b3J5ID0gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgICAgIHRoaXMubWNwUGF0aHMsXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgICByb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSxcbiAgICAgIHVwc3RyZWFtQ2FsbGJhY2tQYXRoLFxuICAgICk7XG4gICAgdmFsaWRhdGVSb3V0ZUludmVudG9yeSh0aGlzLnJvdXRlSW52ZW50b3J5LCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzID0gdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubWFwKFxuICAgICAgKHJvdXRlKSA9PiByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sXG4gICAgKTtcbiAgICB0aGlzLm1jcFBhdGggPSB0aGlzLm1jcFBhdGhzWzBdO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGggPSB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc1swXTtcblxuICAgIGNvbnN0IG93bmVkT3B0aW9ucyA9IG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wcyk7XG4gICAgbGV0IG93bmVkU3RhZ2U6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBvd25lZFN0YWdlTmFtZSA9IFwiJGRlZmF1bHRcIjtcbiAgICBpZiAocHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFwaSA9IHByb3BzLmFwaTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3RhZ2VPcHRpb25zID0gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG93bmVkT3B0aW9ucy5zdGFnZSk7XG4gICAgICBvd25lZFN0YWdlTmFtZSA9IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWU7XG4gICAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgYXBpTmFtZTogb3duZWRPcHRpb25zLmFwaU5hbWUsXG4gICAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuXG4gICAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogYXBpLFxuICAgICAgICBzdGFnZU5hbWU6IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0VuYWJsZWRcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgICBvd25lZFN0YWdlID0gc3RhZ2U7XG5cbiAgICAgIGlmIChzdGFnZU9wdGlvbnMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzLCBwb3N0dXJlKTtcbiAgICBsZXQgZmlyc3RUcmFuc3BvcnRSb3V0ZTogYXBpZ3d2Mi5IdHRwUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEKSB7XG4gICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gdGhpcy5hZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICAgICAgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQsXG4gICAgICAgIFwiL1wiLFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICk7XG4gICAgICB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQsXG4gICAgICAgIFwiL3twcm94eSt9XCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcnVudGltZU93bmVkQXV0aCA9IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICAgIHRvSHR0cE1ldGhvZChtZXRob2QpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnJlZ2lzdGVyUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIHVwc3RyZWFtIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgbm90IHBlciBraW5kOiB3aXJlIGl0IGV4YWN0bHkgb25jZS5cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5jYWxsYmFja1BhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcG9zdHVyZU1hcmtlclRhcmdldCA9ICh0aGlzLm93bmVkQXBpPy5ub2RlLmRlZmF1bHRDaGlsZFxuICAgICAgPz8gZmlyc3RUcmFuc3BvcnRSb3V0ZT8ubm9kZS5kZWZhdWx0Q2hpbGQpIGFzIGFwaWd3djIuQ2ZuQXBpIHwgYXBpZ3d2Mi5DZm5Sb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBwb3N0dXJlTWFya2VyVGFyZ2V0Py5hZGRNZXRhZGF0YShNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZLCB7XG4gICAgICBwb3N0dXJlLFxuICAgICAgY29udHJhY3RfaWQ6IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCxcbiAgICAgIHJvdXRlX2NvdW50OiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5sZW5ndGgsXG4gICAgICBydW50aW1lX3Bvc3R1cmVfZGVjbGFyZWQ6IHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHMpO1xuICAgIGlmIChzZXNzaW9uU3RhdGUuZW5hYmxlZCkge1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHNlc3Npb25TdGF0ZS50YWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInNlc3Npb25JZFwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcImV4cGlyZXNBdFwiLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBzZXNzaW9uU3RhdGUucmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHsgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgICB0YWJsZS5ncmFudFJlYWRXcml0ZURhdGEocHJvcHMuaGFuZGxlcik7XG4gICAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRhYmxlO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RBQkxFXCIsIHRhYmxlLnRhYmxlTmFtZSk7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVFRMX01JTlVURVNcIiwgU3RyaW5nKHNlc3Npb25TdGF0ZS50dGxNaW51dGVzKSk7XG4gICAgfVxuXG4gICAgbGV0IGVuZHBvaW50QmFzZTogc3RyaW5nO1xuICAgIGlmIChvd25lZE9wdGlvbnMuZG9tYWluKSB7XG4gICAgICBpZiAoIW93bmVkU3RhZ2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkb21haW4gY29uZmlndXJhdGlvbiByZXF1aXJlcyBjb25zdHJ1Y3Qtb3duZWQgQVBJIG1vZGVcIik7XG4gICAgICB9XG4gICAgICB0aGlzLnNldHVwQ3VzdG9tRG9tYWluKG93bmVkT3B0aW9ucy5kb21haW4sIG93bmVkU3RhZ2UpO1xuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICB0aGlzLmVuZHBvaW50ID0gdGhpcy5lbmRwb2ludHNbMF07XG4gIH1cblxuICBwcml2YXRlIGFkZFJ1bnRpbWVSb3V0ZShcbiAgICBwYXRoOiBzdHJpbmcsXG4gICAgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsXG4gICAgaW50ZWdyYXRpb246IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uLFxuICAgIGF1dGhvcml6ZXI6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIsXG4gICk6IGFwaWd3djIuSHR0cFJvdXRlIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIGBSb3V0ZSR7dGhpcy5yb3V0ZVNlcXVlbmNlKyt9YCwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBtZXRob2QpLFxuICAgICAgaW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICBpZDogc3RyaW5nLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgaWQsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoY29uZmlndXJlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKGNvbmZpZ3VyZWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgPyBlcnIubWVzc2FnZS5yZXBsYWNlKC9ebWNwcm91dGVzOiAvLCBcIlwiKVxuICAgICAgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBpcyBpbnZhbGlkOiAke3JlYXNvbn1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIGNhbGxiYWNrUGF0dGVybjogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkNPTlRSQUNUX1ZFUlNJT04sXG4gICAgcm91dGVzOiBwYXR0ZXJucy5tYXAoKG1jcFBhdHRlcm4pID0+ICh7XG4gICAgICBtY3BQYXR0ZXJuLFxuICAgICAgbWNwTWV0aG9kczogW1wiUE9TVFwiLCBcIkdFVFwiLCBcIkRFTEVURVwiXSxcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gICAgY2FsbGJhY2tQYXR0ZXJuLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnJlZ2lzdGVyUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybik7XG4gIH1cbiAgaWYgKGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICBpZiAocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgcmVxdWlyZXMgYXR0YWNoIG1vZGUgd2l0aCBhcGlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICYmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpXG4gICAgICB8fCAhL14oPzpcXCRkZWZhdWx0fFtBLVphLXowLTlfLV17MSwxMjh9KSQvLnRlc3QocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgQVBJIEdhdGV3YXkgc3RhZ2UgbmFtZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHByb3BzLm93bmVkQXBpICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcIm93bmVkQXBpXCIpO1xuICBpZiAocHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJhcGlOYW1lXCIpO1xuICBpZiAocHJvcHMuY29ycyAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJjb3JzXCIpO1xuICBpZiAocHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImRvbWFpblwiKTtcbiAgaWYgKHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcInN0YWdlXCIpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggIT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2ggbW9kZSB3aXRoIGFwaSBjYW5ub3QgY29uZmlndXJlIG93bmVkLUFQSSBwcm9wczogJHtpbnZhbGlkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICBpZiAocHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuYXBpTmFtZSBhbmQgZGVwcmVjYXRlZCBhcGlOYW1lIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5kb21haW4gIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gYW5kIGRlcHJlY2F0ZWQgZG9tYWluIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgYW5kIGRlcHJlY2F0ZWQgc3RhZ2UgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFwaU5hbWU6IHByb3BzLm93bmVkQXBpPy5hcGlOYW1lID8/IHByb3BzLmFwaU5hbWUsXG4gICAgZG9tYWluOiBwcm9wcy5vd25lZEFwaT8uZG9tYWluID8/IHByb3BzLmRvbWFpbixcbiAgICBzdGFnZTogcHJvcHMub3duZWRBcGk/LnN0YWdlID8/IHByb3BzLnN0YWdlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU9wdGlvbnMob3B0aW9ucz86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyk6IE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICBjb25zdCBhY2Nlc3NMb2dnaW5nID0gb3B0aW9ucz8uYWNjZXNzTG9nZ2luZyA/PyB0cnVlO1xuICBpZiAoIWFjY2Vzc0xvZ2dpbmcgJiYgb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nUmV0ZW50aW9uIHJlcXVpcmVzIGFjY2Vzc0xvZ2dpbmcgdG8gYmUgZW5hYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZ0VuYWJsZWQgPSBvcHRpb25zPy50aHJvdHRsaW5nRW5hYmxlZCA/PyB0cnVlO1xuICBpZiAoXG4gICAgIXRocm90dGxpbmdFbmFibGVkXG4gICAgJiYgKG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgdGhyb3R0bGluZyBsaW1pdHMgcmVxdWlyZSB0aHJvdHRsaW5nRW5hYmxlZCB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXRlTGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUO1xuICBjb25zdCBidXJzdExpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHJhdGVMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nUmF0ZUxpbWl0XCIpO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKGJ1cnN0TGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0J1cnN0TGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VOYW1lOiBvcHRpb25zPy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiLFxuICAgIGFjY2Vzc0xvZ2dpbmcsXG4gICAgYWNjZXNzTG9nUmV0ZW50aW9uOiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICB0aHJvdHRsaW5nRW5hYmxlZCxcbiAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiByYXRlTGltaXQsXG4gICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IGJ1cnN0TGltaXQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgY29uc3QgaGFzTGVnYWN5ID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAocHJvcHMuc2Vzc2lvblN0YXRlICE9PSB1bmRlZmluZWQgJiYgaGFzTGVnYWN5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHNlc3Npb25TdGF0ZSBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBkZXByZWNhdGVkIHNlc3Npb24tdGFibGUgcHJvcHNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGVuYWJsZWQgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LmVuYWJsZWQgPz8gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlID8/IHRydWU7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lID8/IHByb3BzLnNlc3Npb25UYWJsZU5hbWU7XG4gIGNvbnN0IHR0bE1pbnV0ZXMgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXNcbiAgICA/PyBwcm9wcy5zZXNzaW9uVHRsTWludXRlc1xuICAgID8/IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUztcbiAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgaWYgKFxuICAgICFlbmFibGVkXG4gICAgJiYgKHRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRpc2FibGVkIHNlc3Npb24gc3RhdGUgY2Fubm90IGNvbmZpZ3VyZSB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIG9yIHJlbW92YWxQb2xpY3lcIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7IGVuYWJsZWQsIHRhYmxlTmFtZSwgdHRsTWludXRlcywgcmVtb3ZhbFBvbGljeSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkgcmV0dXJuO1xuICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGlzc3VlcixcbiAgICAgIGZhbHNlLFxuICAgICAgXCJhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBqd2tzVXJpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiandrc1VyaSBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHVzZXJpbmZvIG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy50cmFuc3BvcnRBdXRob3JpemVyO1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHtcbiAgICAgIGlmIChjb25maWd1cmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGlzIG9ubHkgdmFsaWQgd2l0aCB0cmFuc3BvcnRQb3N0dXJlIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAgICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgICAgIDogbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgfVxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBvc3R1cmVMYWJlbChwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTogcmV0dXJuIFwiSUFNXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDogcmV0dXJuIFwiSldUXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOiByZXR1cm4gXCJSVU5USU1FX0JFQVJFUlwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzogcmV0dXJuIFwiTk9ORV9QVUJMSUNcIjtcbiAgICBkZWZhdWx0OiByZXR1cm4gU3RyaW5nKHBvc3R1cmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogdm9pZCB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOlxuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVNb2RlbDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVCBvciAuQ09OU09MSURBVEVEXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUoXG4gIHJvdXRlTW9kZWw6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgaXMgb25seSB2YWxpZCBmb3IgdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiBvciBOT05FX1BVQkxJQzsgdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0ga2VlcHMgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsIGJlY2F1c2UgY29uc29saWRhdGlvbiBtdXN0IG5ldmVyIGNoYW5nZSBnYXRld2F5IGFkbWlzc2lvbmAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZ1JvdXRlcyA9IGFwaS5ub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwUm91dGUpO1xuICBpZiAoZXhpc3RpbmdSb3V0ZXMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBtYXkgYXR0YWNoIG9ubHkgdG8gYW4gQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZTsgYXR0YWNoIHRvIGEgbmV3IG9yIGVtcHR5IEFQSSwgb3IgdXNlIHJvdXRlTW9kZWwgZXhwbGljaXRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50KTogdm9pZCB7XG4gIGlmIChmYWNhZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBwcm92aWRlcklkID0gKGZhY2FkZSBhcyB7IHByb3ZpZGVySWQ/OiB1bmtub3duIH0pPy5wcm92aWRlcklkO1xuICBpZiAoXG4gICAgdHlwZW9mIHByb3ZpZGVySWQgIT09IFwic3RyaW5nXCJcbiAgICB8fCBwcm92aWRlcklkLnRyaW0oKSA9PT0gXCJcIlxuICAgIHx8IFRva2VuLmlzVW5yZXNvbHZlZChwcm92aWRlcklkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZmFjYWRlLnByb3ZpZGVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHN0cmluZ1wiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3N0dXJlR3VhcmRzKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHJvdXRlRmFtaWx5OiBOb3JtYWxpemVkUm91dGVGYW1pbHksXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUMpIHtcbiAgICBpZiAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkIHx8IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG9yIGp3a3NVcmlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZW5hYmxlIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgdXBzdHJlYW1DYWxsYmFja1BhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0gY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZT8udGhyb3R0bGluZ0VuYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhbiBleHBsaWNpdCBvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nRW5hYmxlZDogdHJ1ZSB0aHJvdHRsaW5nIGRlY2lzaW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2U/LmFjY2Vzc0xvZ2dpbmcgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYWNjZXNzIGxvZ2dpbmdgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIpIHtcbiAgICB2YWxpZGF0ZURlbmlhbFNpZ25hbChwcm9wcy5kZW5pYWxTaWduYWwpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShcbiAgZGVmZW5zZTogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMgfCB1bmRlZmluZWQsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGRlZmVuc2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZSB0byByZWNvcmQgdGhlIG93bmluZyBBUEkncyBhY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWNpc2lvbnNgLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlZmVuc2UuYWNjZXNzTG9nZ2luZyAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS5hY2Nlc3NMb2dnaW5nIHRvIGJlIHRydWVgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZzogUGFydGlhbDxBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucz4gfCB1bmRlZmluZWQgPSBkZWZlbnNlLnRocm90dGxpbmc7XG4gIGNvbnN0IHJhdGVMaW1pdCA9IHRocm90dGxpbmc/LnJhdGVMaW1pdDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IHRocm90dGxpbmc/LmJ1cnN0TGltaXQ7XG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdClcbiAgICB8fCAocmF0ZUxpbWl0IGFzIG51bWJlcikgPD0gMFxuICAgIHx8ICFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdClcbiAgICB8fCAoYnVyc3RMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLnRocm90dGxpbmcgcmF0ZUxpbWl0IGFuZCBidXJzdExpbWl0IHRvIGJlIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKHNpZ25hbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgZGVuaWFsU2lnbmFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLm1ldHJpY05hbWUgIT09IHVuZGVmaW5lZCAmJiBzaWduYWwubWV0cmljTmFtZSAhPT0gTUNQX0RFTklBTF9NRVRSSUNfTkFNRSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5tZXRyaWNOYW1lIG11c3QgYmUgJHtNQ1BfREVOSUFMX01FVFJJQ19OQU1FfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLmRpbWVuc2lvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSBBcnJheS5pc0FycmF5KHNpZ25hbC5kaW1lbnNpb25zKSA/IHNpZ25hbC5kaW1lbnNpb25zIDogW107XG4gICAgY29uc3QgYm91bmRlZCA9IGRpbWVuc2lvbnMubGVuZ3RoID09PSBNQ1BfREVOSUFMX0RJTUVOU0lPTlMubGVuZ3RoXG4gICAgICAmJiBNQ1BfREVOSUFMX0RJTUVOU0lPTlMuZXZlcnkoXG4gICAgICAgIChkaW1lbnNpb24pID0+IGRpbWVuc2lvbnMuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgPT09IGRpbWVuc2lvbikubGVuZ3RoID09PSAxLFxuICAgICAgKTtcbiAgICBpZiAoIWJvdW5kZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLmRpbWVuc2lvbnMgbXVzdCBiZSBleGFjdGx5ICR7SlNPTi5zdHJpbmdpZnkoTUNQX0RFTklBTF9ESU1FTlNJT05TKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==