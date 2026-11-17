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
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
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
 * A well-known SSM parameter name, in the alphabet a CloudFormation `ssm`
 * dynamic reference accepts.
 *
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-ssm.html
 */
const FRONT_DOOR_PARAMETER_NAME_PATTERN = /^\/[A-Za-z0-9_.\-/]+$/;
/**
 * The SSM parameter-name limits: 1011 characters including the ARN prefix, a
 * fifteen-level hierarchy, and no `aws`/`ssm` prefix.
 *
 * https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_PutParameter.html
 */
const FRONT_DOOR_PARAMETER_NAME_MAX_LENGTH = 1011;
const FRONT_DOOR_PARAMETER_NAME_MAX_LEVELS = 15;
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "7.3.1" };
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
    /**
     * The origin custom header the app-owned front door must send on every origin
     * request, present only under `originReachability: FRONTED`.
     *
     * Wire it into the distribution origin:
     * `origins.HttpOrigin(host, { customHeaders: { [h.headerName]: h.headerValue } })`.
     * Under the parameter form `headerValue` is a `{{resolve:ssm:...}}`
     * CloudFormation dynamic reference, so the value never enters the
     * application source or the construct's template.
     */
    frontDoorOriginHeader;
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
        if (originReachability === AppTheoryMcpOriginReachability.FRONTED) {
            this.frontDoorOriginHeader =
                frontDoorOriginHeader(props.frontDoorVerification);
            grantFrontDoorParameterRead(this, props.handler, props.frontDoorVerification);
        }
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
    const secretParameterName = verification.secretParameterName;
    const hasLiteral = secretValue !== undefined;
    const hasParameter = secretParameterName !== undefined;
    if (hasLiteral === hasParameter) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification requires exactly one of secretValue and secretParameterName; supply the literal, or the well-known parameter name the application's installer creates");
    }
    if (hasLiteral) {
        if (typeof secretValue !== "string" || !FRONT_DOOR_SECRET_PATTERN.test(secretValue)) {
            throw new Error("AppTheoryMcpServer: frontDoorVerification.secretValue must be 32 to 128 characters of [A-Za-z0-9._~-]");
        }
    }
    else {
        validateFrontDoorParameterName(secretParameterName);
    }
    if (verification.secretParameterKmsKey !== undefined && !hasParameter) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.secretParameterKmsKey is only valid with secretParameterName");
    }
    if (verification.asserted !== true) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification requires asserted: true — the caller must record that the runtime verifies the front-door header on every derived route");
    }
}
/**
 * Validate a well-known front-door parameter name.
 *
 * The name must be expressible in a CloudFormation `ssm` dynamic reference and
 * acceptable to Parameter Store, because the construct renders the reference and
 * grants on the ARN. A name outside either contract would fail at deploy time,
 * so it fails synthesis instead.
 */
function validateFrontDoorParameterName(name) {
    if (typeof name !== "string"
        || name.length > FRONT_DOOR_PARAMETER_NAME_MAX_LENGTH
        || !FRONT_DOOR_PARAMETER_NAME_PATTERN.test(name)
        || name.endsWith("/")
        || name.includes("//")) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.secretParameterName must be a fully qualified SSM parameter name from '/', at most 1011 characters, of [A-Za-z0-9_.-/] with no empty segment");
    }
    const levels = name.split("/").filter((segment) => segment.length > 0);
    const first = levels[0]?.toLowerCase();
    if (levels.length === 0 || levels.length > FRONT_DOOR_PARAMETER_NAME_MAX_LEVELS) {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.secretParameterName must have between one and fifteen hierarchy levels");
    }
    if (first === "aws" || first === "ssm") {
        throw new Error("AppTheoryMcpServer: frontDoorVerification.secretParameterName must not use the reserved aws or ssm hierarchy");
    }
}
/**
 * The origin custom header the app-owned front door must send.
 *
 * The parameter form renders the CloudFormation dynamic reference the
 * distribution property accepts, so the value is resolved by CloudFormation at
 * stack create/update time and never appears in the application source or this
 * construct's template.
 */
function frontDoorOriginHeader(verification) {
    if (verification === undefined) {
        throw new Error("AppTheoryMcpServer: originReachability FRONTED requires frontDoorVerification; the runtime cannot enforce an undeclared front door");
    }
    const headerValue = verification.secretParameterName !== undefined
        ? `{{resolve:ssm:${verification.secretParameterName}}}`
        : String(verification.secretValue);
    return { headerName: verification.headerName, headerValue };
}
/**
 * Grant the runtime function read access to the well-known front-door parameter.
 *
 * Parameter Store resolves the distribution's dynamic reference with the
 * deploying principal's permissions, so this grant serves the runtime's lazy
 * read: `ssm:GetParameter` on exactly that parameter ARN (never a wildcard) and,
 * for a SecureString, `kms:Decrypt` on the declared key. Parameter Store needs
 * no KMS permission for a String parameter, which is the type FRONTED requires.
 */
function grantFrontDoorParameterRead(scope, handler, verification) {
    const parameterName = verification?.secretParameterName;
    if (parameterName === undefined) {
        return;
    }
    handler.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
            aws_cdk_lib_1.Stack.of(scope).formatArn({
                service: "ssm",
                resource: "parameter",
                resourceName: parameterName.replace(/^\/+/, ""),
            }),
        ],
    }));
    if (verification?.secretParameterKmsKey !== undefined) {
        verification.secretParameterKmsKey.grantDecrypt(handler);
    }
}
/**
 * The FRONTED fields of the `apptheory:mcp-transport-posture` marker.
 *
 * The literal form records the posture, the header name and a SHA-256 digest of
 * the declared secret, exactly as v7.3 did; the literal is consumed for its
 * digest only, so it never lands in the synthesized template or in
 * CloudFormation. The parameter form records the well-known parameter name and
 * that the value is parameter-sourced instead of a digest, because there is no
 * literal in the application to digest.
 */
function frontDoorPostureMetadata(verification) {
    if (verification === undefined) {
        throw new Error("AppTheoryMcpServer: originReachability FRONTED requires frontDoorVerification; the runtime cannot enforce an undeclared front door");
    }
    if (verification.secretParameterName !== undefined) {
        return {
            origin_reachability: AppTheoryMcpOriginReachability.FRONTED,
            front_door_header_name: verification.headerName,
            front_door_secret_source: "ssm-parameter",
            front_door_secret_parameter_name: verification.secretParameterName,
        };
    }
    return {
        origin_reachability: AppTheoryMcpOriginReachability.FRONTED,
        front_door_header_name: verification.headerName,
        front_door_secret_sha256: (0, node_crypto_1.createHash)("sha256").update(String(verification.secretValue), "utf8").digest("hex"),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFFdkMsMkRBQStEO0FBQy9ELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFFdkQsTUFBTSwwQkFBMEIsR0FBRyxjQUFjLENBQUM7QUFDbEQsTUFBTSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7QUFDcEQsTUFBTSw2QkFBNkIsR0FBRyxHQUFHLENBQUM7QUFDMUMsTUFBTSw4QkFBOEIsR0FBRyxHQUFHLENBQUM7QUFDM0MsTUFBTSwyQkFBMkIsR0FBRyxFQUFFLENBQUM7QUFDdkMsTUFBTSwyQkFBMkIsR0FBRyx3QkFBd0IsQ0FBQztBQUM3RCxNQUFNLGtDQUFrQyxHQUFHLGlDQUFpQyxDQUFDO0FBQzdFLE1BQU0saUNBQWlDLEdBQUcsOEJBQThCLENBQUM7QUFDekUsTUFBTSxzQkFBc0IsR0FBRywyQkFBMkIsQ0FBQztBQUMzRCxNQUFNLHFCQUFxQixHQUFHLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBRTFELDJDQUEyQztBQUMzQyxNQUFNLDhCQUE4QixHQUFHLHNCQUFzQixDQUFDO0FBRTlELG9GQUFvRjtBQUNwRixNQUFNLHlCQUF5QixHQUFHLDJCQUEyQixDQUFDO0FBRTlEOzs7OztHQUtHO0FBQ0gsTUFBTSxpQ0FBaUMsR0FBRyx1QkFBdUIsQ0FBQztBQUVsRTs7Ozs7R0FLRztBQUNILE1BQU0sb0NBQW9DLEdBQUcsSUFBSSxDQUFDO0FBQ2xELE1BQU0sb0NBQW9DLEdBQUcsRUFBRSxD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LENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIH0gZnJvbSBcIi4vbWNwLXJvdXRlLWFsZ2VicmFcIjtcbmltcG9ydCB7IGJ1aWxkQ29yc1ByZWZsaWdodCB9IGZyb20gXCIuL2NvcnNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIH0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB7IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZCB9IGZyb20gXCIuL3JvdXRlLWlkc1wiO1xuXG5jb25zdCBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCA9IFwiUm91dGVBbnlSb290XCI7XG5jb25zdCBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQgPSBcIlJvdXRlQW55UHJveHlcIjtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFRoZSBmcm9udC1kb29yIGhlYWRlciBuYW1lIGFscGhhYmV0LiAqL1xuY29uc3QgRlJPTlRfRE9PUl9IRUFERVJfTkFNRV9QQVRURVJOID0gL15bQS1aYS16MC05LV17MSw2NH0kLztcblxuLyoqIFRoZSBmcm9udC1kb29yIHNlY3JldCBhbHBoYWJldDogaGVhZGVyLXZhbHVlLXNhZmUsIG5vIHdoaXRlc3BhY2Ugb3IgY29udHJvbHMuICovXG5jb25zdCBGUk9OVF9ET09SX1NFQ1JFVF9QQVRURVJOID0gL15bQS1aYS16MC05Ll9+LV17MzIsMTI4fSQvO1xuXG4vKipcbiAqIEEgd2VsbC1rbm93biBTU00gcGFyYW1ldGVyIG5hbWUsIGluIHRoZSBhbHBoYWJldCBhIENsb3VkRm9ybWF0aW9uIGBzc21gXG4gKiBkeW5hbWljIHJlZmVyZW5jZSBhY2NlcHRzLlxuICpcbiAqIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BV1NDbG91ZEZvcm1hdGlvbi9sYXRlc3QvVXNlckd1aWRlL2R5bmFtaWMtcmVmZXJlbmNlcy1zc20uaHRtbFxuICovXG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX1BBVFRFUk4gPSAvXlxcL1tBLVphLXowLTlfLlxcLS9dKyQvO1xuXG4vKipcbiAqIFRoZSBTU00gcGFyYW1ldGVyLW5hbWUgbGltaXRzOiAxMDExIGNoYXJhY3RlcnMgaW5jbHVkaW5nIHRoZSBBUk4gcHJlZml4LCBhXG4gKiBmaWZ0ZWVuLWxldmVsIGhpZXJhcmNoeSwgYW5kIG5vIGBhd3NgL2Bzc21gIHByZWZpeC5cbiAqXG4gKiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vc3lzdGVtcy1tYW5hZ2VyL2xhdGVzdC9BUElSZWZlcmVuY2UvQVBJX1B1dFBhcmFtZXRlci5odG1sXG4gKi9cbmNvbnN0IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFTkdUSCA9IDEwMTE7XG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRVZFTFMgPSAxNTtcblxuLyoqXG4gKiBSZXF1ZXN0IGhlYWRlcnMgYSBmcm9udCBkb29yIGNhbiBuZXZlciBjYXJyeSB0aGUgdmVyaWZpY2F0aW9uIGluOiB0aGV5IGVpdGhlclxuICogcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3Qgb3IgYXJlIHBsYXRmb3JtLW1hbmFnZWQsIHNvIGEgZGVjbGFyZWRcbiAqIHZhbHVlIGNvdWxkIG5vdCBiZSB2ZXJpZmllZCB0aGUgd2F5IHRoZSBydW50aW1lIHJlYWRzIGl0LlxuICovXG5jb25zdCBSRVNFUlZFRF9GUk9OVF9ET09SX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cblxuLyoqIFJvdXRlLWVtaXNzaW9uIG1vZGVsIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgLyoqXG4gICAqIE9uZSBBUEkgR2F0ZXdheSBIVFRQIEFQSSB2MiByb3V0ZSBwZXIgZGVyaXZlZCByb3V0ZSBrZXkuIFRoaXMgaXMgdGhlXG4gICAqIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3IgZGVwbG95ZWRcbiAgICogc3RhY2tzLCBzbyBhIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgdXBncmFkZSBkZXBsb3lzIGluIHBsYWNlLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIEVYUExJQ0lUID0gXCJleHBsaWNpdFwiLFxuICAvKipcbiAgICogVHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCwgYmFja2VkIGJ5IG9uZSBzaGFyZWRcbiAgICogaW50ZWdyYXRpb24uIFRoZSBBcHBUaGVvcnkgcnVudGltZSByb3V0ZXIgcGVyZm9ybXMgbWV0aG9kIGFuZCBwYXRoXG4gICAqIGRpc3BhdGNoLCBwYXRoLXBhcmFtZXRlciBjYXB0dXJlLCBhbmQgZGVuaWFsLiBDb25zb2xpZGF0aW9uIG5ldmVyIGNoYW5nZXNcbiAgICogZ2F0ZXdheSBhZG1pc3Npb24sIHNvIGl0IGlzIHZhbGlkIG9ubHkgd2hlbiBldmVyeSBnYXRld2F5IHJvdXRlIGlzIGBOT05FYDpcbiAgICogdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0IHBvc3R1cmVzLiBgaWFtYCBhbmQgYGp3dGBcbiAgICogYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzIHRpbWUuXG4gICAqL1xuICBDT05TT0xJREFURUQgPSBcImNvbnNvbGlkYXRlZFwiLFxufVxuXG4vKiogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgLyoqXG4gICAqIFBvc2l0aW9uYWwgaWRzIChgUm91dGUwYCwgYFJvdXRlMWAsIC4uLikgYXNzaWduZWQgaW4gZW1pc3Npb24gb3JkZXIuIFRoaXNcbiAgICogaXMgdGhlIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3JcbiAgICogZGVwbG95ZWQgc3RhY2tzLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG4gIC8qKlxuICAgKiBJZHMgZGVyaXZlZCBmcm9tIHRoZSByb3V0ZSBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yXG4gICAqIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHkgbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGUuIEludGVuZGVkIGZvclxuICAgKiBuZXdseSBjcmVhdGVkIGV4cGxpY2l0IEFQSXM6IHN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUElcbiAgICogZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUsIHdoaWNoIGlzIGl0c2VsZiBhXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIGNvbGxpc2lvbi4gQWRvcHQgaXQgb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoXG4gICAqIHRoZSBuZXctQVBJIHN3YXAgZGVzY3JpYmVkIGluIGBVUEdSQURJTkcubWRgLlxuICAgKi9cbiAgU0VNQU5USUMgPSBcInNlbWFudGljXCIsXG59XG5cbi8qKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gVGhlIGRlZmF1bHQgZm9yIGEgc2VydmVyIHdpdGggbm8gZmFjYWRlIGF0dGFjaG1lbnQuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBBIHN0YXRpYyBKV1QgYXV0aG9yaXplciAoaXNzdWVyICsgYXVkaWVuY2UpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiAqL1xuICBKV1QgPSBcImp3dFwiLFxuICAvKiogVGhlIGdhdGV3YXkgYXV0aG9yaXplciBpcyBOT05FIGFuZCB0aGUgcnVudGltZSB2YWxpZGF0ZXMgUkZDIDk3MjggYmVhcmVyIHRva2Vucy4gVGhlIGRlZmF1bHQgZm9yIGEgZmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVyLiAqL1xuICBSVU5USU1FX0JFQVJFUiA9IFwicnVudGltZS1iZWFyZXJcIixcbiAgLyoqIERlbGliZXJhdGVseSBwdWJsaWMgTUNQIHNlcnZlcjogZXZlcnkgdHJhbnNwb3J0IHJvdXRlIGlzIHB1YmxpYy4gTmV2ZXIgYSBkZWZhdWx0LiAqL1xuICBOT05FX1BVQkxJQyA9IFwibm9uZS1wdWJsaWNcIixcbn1cblxuLyoqIFByZXNlbmNlLW9ubHkgc2tlbGV0b24gb2YgdGhlIHVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBzZWxlY3RzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQge1xuICAvKiogSWRlbnRpZmllcyB0aGUgdXBzdHJlYW0gYXV0aG9yaXphdGlvbiBwcm92aWRlciB0aGlzIHNlcnZlciBmcm9udHMgKGZvciBleGFtcGxlIGBhdXRoZW9yeWApLiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZSBhbmQgdXNlcyBpdHMgcHJlc2VuY2UgdG8gc2VsZWN0IHRoZSBgcnVudGltZS1iZWFyZXJgIGRlZmF1bHQuICovXG4gIHJlYWRvbmx5IHByb3ZpZGVySWQ6IHN0cmluZztcbn1cblxuLyoqIFJ1bnRpbWUtc2lkZSBkZWNsYXJhdGlvbiB0aGF0IHRoZSB0cmFuc3BvcnQgcm91dGVzIHZhbGlkYXRlIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMgYXQgcnVudGltZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zIHtcbiAgLyoqIEFzc2VydCB0aGUgcnVudGltZSByZWdpc3RlcnMgdGhlIHRyYW5zcG9ydCByb3V0ZXMgd2l0aCB0aGUgcnVudGltZS12YWxpZGF0ZWQgYmVhcmVyIHBvc3R1cmUgKEdvIGBGYWNhZGVDb25maWcuUmVxdWlyZUJlYXJlclRva2VuYCwgVFMgYHJlcXVpcmVCZWFyZXJUb2tlbk1pZGRsZXdhcmVgLCBQeXRob24gYHJlcXVpcmVfYmVhcmVyX3Rva2VuX21pZGRsZXdhcmVgKS4gTXVzdCBiZSBgdHJ1ZWAuICovXG4gIHJlYWRvbmx5IHJlcXVpcmVCZWFyZXJUb2tlbjogYm9vbGVhbjtcbn1cblxuLyoqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkge1xuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgYWR2ZXJ0aXNlIGFuIG93bmVkIG9yZGluYXJ5XG4gICAqIGN1c3RvbSBkb21haW4gYXMgdGhlIG9ubHkgTUNQIGF1dGhvcml0eS5cbiAgICovXG4gIERJU0FCTEVEID0gXCJkaXNhYmxlZFwiLFxuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgcmVxdWlyZSBtdXR1YWwgVExTIG9uIGV2ZXJ5XG4gICAqIGN1c3RvbSBkb21haW4gbWFwcGVkIHRvIHRoZSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBUaGUgb3duZWQgZG9tYWluJ3NcbiAgICogYG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyB0aGUgY29uY3JldGUgbG9jazsgYW4gZW51bSBhbG9uZSBvciBhblxuICAgKiBleHRlcm5hbC9hdHRhY2hlZCBmcm9udCBkb29yIG5ldmVyIHNhdGlzZmllcyBpdC5cbiAgICovXG4gIExPQ0tFRCA9IFwibG9ja2VkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIHN0YXlzIGRpcmVjdGx5IHJlYWNoYWJsZSBhdCBpdHMgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kIGlzXG4gICAqIHNlcnZlZCBvbmx5IHRocm91Z2ggYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnQgZG9vciB0aGF0IGluamVjdHNcbiAgICogYGZyb250RG9vclZlcmlmaWNhdGlvbmAgb24gZXZlcnkgb3JpZ2luIHJlcXVlc3QuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIHBvc3R1cmUgZm9yIGFuIGFwcC1vd25lZCBkaXN0cmlidXRpb24gd2hvc2Ugb3JpZ2luIGlzIHRoZVxuICAgKiBleGVjdXRlLWFwaSBob3N0bmFtZTogdGhlIGNvbnN0cnVjdCBzZWVzIG5laXRoZXIgdGhlIGRpc3RyaWJ1dGlvbiBub3IgdGhlXG4gICAqIEFQSSdzIGVuZHBvaW50IGNvbmZpZ3VyYXRpb24sIHNvIGl0IGNhbm5vdCBwcm9kdWNlIGluLXN0YWNrIGV2aWRlbmNlIHRoZVxuICAgKiB3YXkgYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgZG8uIFZhbGlkIG9ubHkgaW4gYXR0YWNoIG1vZGUsIGFjY2VwdGVkIHdpdGhcbiAgICogYFJVTlRJTUVfQkVBUkVSYCBhbmQgYE5PTkVfUFVCTElDYCBsaWtlIHRoZSBvdGhlciBkZWNpc2lvbnMsIGFuZCBpdFxuICAgKiByZXF1aXJlcyB0aGUgbWFuZGF0b3J5IGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBgRlJPTlRFRGAgaXMgYSBkZWZlbnNlLWluLWRlcHRoIGRlY2xhcmF0aW9uIHdpdGggcnVudGltZSBlbmZvcmNlbWVudCwgbm90XG4gICAqIG11dHVhbC1UTFMgYXNzdXJhbmNlIGFuZCBub3Qgb3JpZ2luIHVucmVhY2hhYmlsaXR5LiBUaGUgZW5mb3JjZW1lbnQgaXMgdGhlXG4gICAqIHJ1bnRpbWUncyBmcm9udC1kb29yIGhlYWRlciBjaGVjayAoYG1jcGZhY2FkZS5GYWNhZGVDb25maWdgXG4gICAqIGBGcm9udERvb3JWZXJpZmljYXRpb25gIGluIEdvLCBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBpbiBUeXBlU2NyaXB0LFxuICAgKiBgZnJvbnRfZG9vcl92ZXJpZmljYXRpb25gIGluIFB5dGhvbik6IGl0IHJlZnVzZXMgZXZlcnkgZGVyaXZlZCByb3V0ZSB3aGVuXG4gICAqIHRoZSBkZWNsYXJlZCBoZWFkZXIgaXMgYWJzZW50IG9yIHdyb25nLCBhbmQgZmFpbHMgcmVnaXN0cmF0aW9uIHdoZW5cbiAgICogYEZST05URURgIGlzIGRlY2xhcmVkIHdpdGhvdXQgaXQuIEFuIHVud2lyZWQgcnVudGltZSBlbmZvcmNlcyBub3RoaW5nLlxuICAgKi9cbiAgRlJPTlRFRCA9IFwiZnJvbnRlZFwiLFxufVxuXG4vKipcbiAqIEZyb250LWRvb3IgdmVyaWZpY2F0aW9uIGZvciBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYC5cbiAqXG4gKiBBdHRhY2ggbW9kZSBtZWFucyB0aGUgZnJvbnQgZG9vciBpcyBhcHBsaWNhdGlvbi1vd25lZCwgc28gdGhlIGNvbnN0cnVjdFxuICogY2Fubm90IGluamVjdCB0aGUgaGVhZGVyIGl0c2VsZiBhbmQgY2Fubm90IG9ic2VydmUgdGhlIGRpc3RyaWJ1dGlvbi4gVGhlXG4gKiBkZWNsYXJhdGlvbiB0aGVyZWZvcmUgY2FycmllcyB0aHJlZSBpbmRlcGVuZGVudGx5IHdpcmVkIGNvcGllcyB0aGF0IG11c3QgY29tZVxuICogZnJvbSBvbmUgYXBwbGljYXRpb24tb3duZWQgY29uc3RhbnQ6IHRoaXMgcHJvcCwgdGhlIGRpc3RyaWJ1dGlvbidzIG9yaWdpblxuICogY3VzdG9tLWhlYWRlciBjb25maWd1cmF0aW9uLCBhbmQgdGhlIHJ1bnRpbWUncyBmcm9udC1kb29yIHZlcmlmaWNhdGlvblxuICogY29uZmlnLiBUaGUgY29uc3RydWN0IHByb3ZlcyBvbmx5IGl0cyBvd24gY29weS5cbiAqXG4gKiBTdXBwbHkgZXhhY3RseSBvbmUgb2YgYHNlY3JldFZhbHVlYCBhbmQgYHNlY3JldFBhcmFtZXRlck5hbWVgOlxuICpcbiAqIC0gYHNlY3JldFZhbHVlYCBpcyB0aGUgdjcuMyBsaXRlcmFsIGZvcm0uIEl0IGlzIGNvbnN1bWVkIGF0IHN5bnRoZXNpcyBmb3JcbiAqICAgdmFsaWRhdGlvbiBhbmQgdGhlIHJlY29yZGVkIFNIQS0yNTYgZGlnZXN0IG9ubHksIGFuZCBpdCBuZXZlciBsYW5kcyBpbiB0aGVcbiAqICAgY29uc3RydWN0J3Mgb3duIHN5bnRoZXNpemVkIHRlbXBsYXRlLlxuICogLSBgc2VjcmV0UGFyYW1ldGVyTmFtZWAgbmFtZXMgYSB3ZWxsLWtub3duLCBzdGFnZS1xdWFsaWZpZWQgUGFyYW1ldGVyIFN0b3JlXG4gKiAgIHBhcmFtZXRlciB0aGF0IHRoZSBhcHBsaWNhdGlvbidzIGluc3RhbGxlciBjcmVhdGVzIGlmIGFic2VudC4gVGhlIHZhbHVlXG4gKiAgIG5ldmVyIGVudGVycyB0aGUgYXBwbGljYXRpb24gc291cmNlOiB0aGUgY29uc3RydWN0IHJlbmRlcnMgdGhlIGhlYWRlciB2YWx1ZVxuICogICBhcyBhIENsb3VkRm9ybWF0aW9uIGBzc21gIGR5bmFtaWMgcmVmZXJlbmNlIGFuZCByZWNvcmRzIHRoZSBwYXJhbWV0ZXIgbmFtZVxuICogICBpbnN0ZWFkIG9mIGEgZGlnZXN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIG9yaWdpbiByZXF1ZXN0IGhlYWRlciB0aGUgZnJvbnQgZG9vciBpbmplY3RzIG9uIGV2ZXJ5IHJlcXVlc3QgaXQgc2VuZHNcbiAgICogdG8gdGhlIG9yaWdpbi5cbiAgICpcbiAgICogMSB0byA2NCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05LV1gLCBhbmQgbmV2ZXIgYSByZXF1ZXN0IGhlYWRlciB0aGF0XG4gICAqIHJld3JpdGVzIHRoZSBvcmlnaW4gY29udHJhY3QgKGBIb3N0YCwgYEF1dGhvcml6YXRpb25gLCBgQ29va2llYCxcbiAgICogYENvbnRlbnQtTGVuZ3RoYCwgYFRyYW5zZmVyLUVuY29kaW5nYCwgYENvbm5lY3Rpb25gLCBgV1dXLUF1dGhlbnRpY2F0ZWAsXG4gICAqIGBYLUZvcndhcmRlZC1Gb3JgKSwgYW55IGB4LWFtei0qYC9geC1hbXpuLSpgL2BjbG91ZGZyb250LSpgIG5hbWUsIG9yIGFcbiAgICogaG9wLWJ5LWhvcCBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgaGVhZGVyTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGl0ZXJhbCBzZWNyZXQgaW5qZWN0ZWQgYXMgdGhlIGZyb250LWRvb3IgaGVhZGVyIHZhbHVlLlxuICAgKlxuICAgKiAzMiB0byAxMjggY2hhcmFjdGVycyBvZiBgW0EtWmEtejAtOS5ffi1dYDogYSBoZWFkZXItdmFsdWUtc2FmZSBhbHBoYWJldFxuICAgKiB3aXRoIG5vIHdoaXRlc3BhY2UgYW5kIG5vIGNvbnRyb2wgY2hhcmFjdGVycy4gVGhlIHZhbHVlIGlzIGNvbnN1bWVkIGF0XG4gICAqIHN5bnRoZXNpcyBmb3IgdmFsaWRhdGlvbiBhbmQgdGhlIHJlY29yZGVkIFNIQS0yNTYgZGlnZXN0IG9ubHkg4oCUIHRoZSBsaXRlcmFsXG4gICAqIG5ldmVyIGxhbmRzIGluIHRoZSBjb25zdHJ1Y3QncyBzeW50aGVzaXplZCB0ZW1wbGF0ZSBvciBpbiBDbG91ZEZvcm1hdGlvbi5cbiAgICogSXQgaXMgbm90IGEgY3JlZGVudGlhbCBzdG9yZTsgcm90YXRpb24gbWVhbnMgY2hhbmdpbmcgdGhlIHZhbHVlIGFuZFxuICAgKiByZWRlcGxveWluZywgYW5kIGl0IG11c3Qgbm90IGJlIChvciBjb250YWluKSBhIHNlY3JldCB0aGF0IHByb3RlY3RzXG4gICAqIGFueXRoaW5nIGVsc2UuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYC4gUHJlZmVyIHRoZSBwYXJhbWV0ZXIgZm9ybTpcbiAgICogYSBjb21taXR0ZWQgbGl0ZXJhbCBpcyBleGFjdGx5IHdoYXQgdGhlIHBhcmFtZXRlciBmb3JtIHJlbW92ZXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0VmFsdWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB3ZWxsLWtub3duLCBzdGFnZS1xdWFsaWZpZWQgUGFyYW1ldGVyIFN0b3JlIHBhcmFtZXRlciB0aGF0IGhvbGRzIHRoZVxuICAgKiBmcm9udC1kb29yIHNlY3JldC5cbiAgICpcbiAgICogQSBmdWxseSBxdWFsaWZpZWQgbmFtZSBmcm9tIGAvYCwgYXQgbW9zdCAxMDExIGNoYXJhY3RlcnMgYW5kIGZpZnRlZW5cbiAgICogbGV2ZWxzLCBpbiB0aGUgYFtBLVphLXowLTlfLlxcLS9dYCBhbHBoYWJldCBhIENsb3VkRm9ybWF0aW9uIGBzc21gIGR5bmFtaWNcbiAgICogcmVmZXJlbmNlIGFjY2VwdHMsIGFuZCBuZXZlciBpbiB0aGUgcmVzZXJ2ZWQgYGF3c2AvYHNzbWAgaGllcmFyY2h5LlxuICAgKlxuICAgKiBUaGUgcGFyYW1ldGVyIG11c3QgYmUgdHlwZSAqKlN0cmluZyoqLCBub3QgU2VjdXJlU3RyaW5nOiBDbG91ZEZyb250J3NcbiAgICogYE9yaWdpbkN1c3RvbUhlYWRlcnNgIHN1cHBvcnRzIHRoZSBwbGFpbnRleHQgYHNzbWAgcmVmZXJlbmNlIG9ubHksIGFuZCBBV1NcbiAgICogbGlzdHMgdGhlIHByb3BlcnRpZXMgdGhhdCBzdXBwb3J0IGBzc20tc2VjdXJlYCBleGhhdXN0aXZlbHkgKENsb3VkRnJvbnQgaXNcbiAgICogbm90IG9uZSBvZiB0aGVtKS4gVGhlIHZhbHVlIGlzIHRoZXJlZm9yZSBkZWZlbnNlLWluLWRlcHRoIGFnYWluc3QgZGlyZWN0XG4gICAqIG9yaWdpbiBhY2Nlc3MsIG5vdCBhIGNvbmZpZGVudGlhbGl0eSBjb250cm9sIOKAlCB0aGUgc2FtZSBwb3N0dXJlIGFzIHRoZVxuICAgKiBsaXRlcmFsIGZvcm0sIHdoaWNoIENsb3VkRnJvbnQgYWxyZWFkeSBleHBvc2VzIHRocm91Z2hcbiAgICogYEdldERpc3RyaWJ1dGlvbkNvbmZpZ2AuXG4gICAqXG4gICAqIGBmcm9udERvb3JPcmlnaW5IZWFkZXJgIHJlbmRlcnMgdGhlIGR5bmFtaWMgcmVmZXJlbmNlIGZvciB0aGUgZGlzdHJpYnV0aW9uXG4gICAqIHRoZSBhcHAgd2lyZXMsIGUuZy4gYHt7cmVzb2x2ZTpzc206L3RoZW9yeWNsb3VkL3Rtcy9sYWIvZnJvbnRlZC10b2tlbn19YCxcbiAgICogYW5kIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIGBzc206R2V0UGFyYW1ldGVyYCBvbiBleGFjdGx5IHRoaXMgcGFyYW1ldGVyIHRvXG4gICAqIGBoYW5kbGVyYC4gQSBzdGFjayB1cGRhdGUgcmUtcmVzb2x2ZXMgdGhlIGxhdGVzdCBwYXJhbWV0ZXIgdmVyc2lvbjsgZHJpZnRcbiAgICogZGV0ZWN0aW9uIGRvZXMgbm90IHNlZSBkeW5hbWljIHJlZmVyZW5jZXMuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBzZWNyZXRWYWx1ZWAuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0UGFyYW1ldGVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGN1c3RvbWVyIG1hbmFnZWQga2V5IHRoYXQgZW5jcnlwdHMgdGhlIHBhcmFtZXRlciB3aGVuIGl0IGlzIGFcbiAgICogU2VjdXJlU3RyaW5nLlxuICAgKlxuICAgKiBGUk9OVEVEIGNhbm5vdCB1c2UgYSBTZWN1cmVTdHJpbmcgZm9yIHRoZSBkaXN0cmlidXRpb24gaGVhZGVyIChzZWVcbiAgICogYHNlY3JldFBhcmFtZXRlck5hbWVgKSwgc28gdGhpcyBpcyBvbmx5IG1lYW5pbmdmdWwgd2hlbiB0aGUgc2FtZSB3ZWxsLWtub3duXG4gICAqIG5hbWUgaXMgYWxzbyByZWFkIGZvciBhIHB1cnBvc2Ugb3RoZXIgdGhhbiB0aGUgb3JpZ2luIGhlYWRlci4gV2hlbiBpdCBpc1xuICAgKiBzZXQgdGhlIGNvbnN0cnVjdCBncmFudHMgYGttczpEZWNyeXB0YCBvbiB0aGUga2V5IHRvIGBoYW5kbGVyYC4gTGVhdmUgaXRcbiAgICogdW5zZXQgZm9yIGEgU3RyaW5nIHBhcmFtZXRlcjogUGFyYW1ldGVyIFN0b3JlIG5lZWRzIG5vIEtNUyBwZXJtaXNzaW9uIGZvclxuICAgKiBwbGFpbnRleHQgdmFsdWVzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFBhcmFtZXRlckttc0tleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBUaGUgYXNzZXJ0aW9uIHRoYXQgdGhlIHJ1bnRpbWUgdmVyaWZpZXMgdGhlIGZyb250LWRvb3IgaGVhZGVyIG9uIGV2ZXJ5XG4gICAqIGRlcml2ZWQgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCB0aGF0IHZlcmlmaWNhdGlvbiB0byBhbiBhcHBsaWNhdGlvbi1vd25lZCBmcm9udFxuICAgKiBkb29yIG9yIGEgcnVudGltZSBpdCBkb2VzIG5vdCBvd24sIHNvIGl0IHJlZnVzZXMgdG8gc3ludGhlc2l6ZSB1bnRpbCB0aGVcbiAgICogY2FsbGVyIHJlY29yZHMgdGhhdCB0aGUgdmVyaWZpY2F0aW9uIGV4aXN0cy4gTXVzdCBiZSBgdHJ1ZWAuXG4gICAqL1xuICByZWFkb25seSBhc3NlcnRlZDogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcGxpY2F0aW9uIHdpcmVzIGludG8gaXRzIGZyb250IGRvb3IuXG4gKlxuICogYGhlYWRlclZhbHVlYCBpcyB0aGUgbGl0ZXJhbCBmb3IgdGhlIGxpdGVyYWwgZm9ybSBhbmQgYSBDbG91ZEZvcm1hdGlvblxuICogYHNzbWAgZHluYW1pYyByZWZlcmVuY2UgZm9yIHRoZSBwYXJhbWV0ZXIgZm9ybSwgc28gdGhlIHBhcmFtZXRlciB2YWx1ZSBuZXZlclxuICogZW50ZXJzIHRoZSBhcHBsaWNhdGlvbiBzb3VyY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIHtcbiAgLyoqIFRoZSBvcmlnaW4gcmVxdWVzdCBoZWFkZXIgbmFtZSB0byBzZW5kIHRvIHRoZSBvcmlnaW4uICovXG4gIHJlYWRvbmx5IGhlYWRlck5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSBoZWFkZXIgdmFsdWU6IGEgbGl0ZXJhbCwgb3IgYSBge3tyZXNvbHZlOnNzbTouLi59fWAgZHluYW1pYyByZWZlcmVuY2UuICovXG4gIHJlYWRvbmx5IGhlYWRlclZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMge1xuICAvKiogRGVuaWFsIG1ldHJpYyBuYW1lLiBNdXN0IGJlIGBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkYC4gQGRlZmF1bHQgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZCAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lPzogc3RyaW5nO1xuICAvKiogQm91bmRlZCBtZXRyaWMgZGltZW5zaW9ucy4gTXVzdCBiZSBleGFjdGx5IGBvdXRjb21lYCBhbmQgYHJvdXRlX2ZhbWlseWAuIEBkZWZhdWx0IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl0gKi9cbiAgcmVhZG9ubHkgZGltZW5zaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vKiogT3duaW5nLUFQSSBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucyB7XG4gIC8qKiBTdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdDogbnVtYmVyO1xuICAvKiogU3RhZ2UgYnVyc3QgbGltaXQuICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuLyoqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIGRlZmVuc2UtaW4tZGVwdGggZGVjaXNpb25zIChyZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMge1xuICAvKiogV2hldGhlciB0aGUgb3duaW5nIEFQSSdzIHN0YWdlIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLiBNdXN0IGJlIHRydWUuICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIC8qKiBUaGUgb3duaW5nIEFQSSdzIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmc6IEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zO1xufVxuXG4vKiogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgSFRUUFMgSldUIGlzc3VlciBVUkwuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBhdWRpZW5jZT86IHN0cmluZ1tdO1xuICAvKiogSWRlbnRpdHkgc291cmNlcyBmb3IgdGhlIEpXVCBhdXRob3JpemVyLiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gQGRlZmF1bHQgdGhlIGF1dGhvcml6ZXIgY29uc3RydWN0IGlkICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xufVxuXG4vKiogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlLCBgbWNwLmV4YW1wbGUuY29tYCkuICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlQXJuYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGFuIGF1dG9tYXRpY2FsbHkgY3JlYXRlZCBDTkFNRSByZWNvcmQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgdHJ1c3RzdG9yZSBmb3IgdGhlIG93bmVkIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFN1cHBseWluZyB0aGlzIGlzIHRoZSBjb25jcmV0ZSBgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRGBcbiAgICogZXZpZGVuY2U6IHRoZSBjb25zdHJ1Y3QgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kXG4gICAqIHJlcXVpcmVzIGV2ZXJ5IEFQSSBtYXBwaW5nIGJvdW5kIHRvIHRoZSBvd25lZCBBUEkgdG8gdGFyZ2V0IGEgZG9tYWluIHdob3NlXG4gICAqIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmUgVVJJLiBTdXBwbHlpbmcgaXQgd2l0aCBhbnlcbiAgICogb3RoZXIgb3JpZ2luIGRlY2lzaW9uLCBvciBzZWxlY3RpbmcgYExPQ0tFRGAgd2l0aG91dCBpdCwgZmFpbHMgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZWZlbnNpdmUgc25hcHNob3Qgb2YgdGhlIGNvbnN0cnVjdCdzIGRlcml2ZWQgZmFjYWRlIGludmVudG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcm91dGVzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZVtdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclByb3BzIHtcbiAgLyoqIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyB0aGUgcnVudGltZS1jb21wb3NlZCBNQ1AgZmFjYWRlLiAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBNQ1AgZmFjYWRlIGZhbWlsaWVzIHRoYXRcbiAgICogc2hhcmUgb25lIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeVxuICAgKiBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUm91dGUtZW1pc3Npb24gbW9kZWwuXG4gICAqXG4gICAqIGBleHBsaWNpdGAgKHRoZSBkZWZhdWx0KSB3aXJlcyB0aGUgZnVsbCBkZXJpdmVkIHJvdXRlIGludmVudG9yeSBhcyBvbmUgSFRUUFxuICAgKiBBUEkgdjIgcm91dGUgcGVyIHJvdXRlIGtleSBhbmQgaXMgYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy5cbiAgICogYGNvbnNvbGlkYXRlZGAgd2lyZXMgZXhhY3RseSB0d28gZ3JlZWR5IHJvdXRlcywgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gLFxuICAgKiBhbmQgaXMgdmFsaWQgb25seSBmb3IgdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0XG4gICAqIHBvc3R1cmVzOyBgaWFtYCBhbmQgYGp3dGAgYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzLlxuICAgKlxuICAgKiBDb25zb2xpZGF0ZWQgbW9kZSBpcyBhbGxvd2VkIG9uIGEgY29uc3RydWN0LW93bmVkIEFQSSwgb3Igb24gYW4gYXR0YWNoZWRcbiAgICogQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZS4gXCJObyByb3V0ZXNcIiBpcyBlbmZvcmNlZCBvdmVyIHRoZVxuICAgKiB3aG9sZSBzdGFjaywgbm90IGp1c3QgdGhlIEFQSSdzIG93biBjaGlsZHJlbjogYSByb3V0ZSB3aXJlZCBvbnRvIHRoZVxuICAgKiBhdHRhY2hlZCBBUEkgZnJvbSBhbnkgc2libGluZyBjb25zdHJ1Y3Qgc2NvcGUgaXMgcmVmdXNlZCwgYmVjYXVzZSBpdCBob2xkc1xuICAgKiBhIHJvdXRlIGtleSB0aGUgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGguXG4gICAqXG4gICAqIEEgY29uc3VtZXIgbWF5IHN0aWxsIGFkZCBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgdG8gdGhlIGNvbnNvbGlkYXRlZFxuICAgKiBBUEkgYWZ0ZXJ3YXJkcywgaW4gZWl0aGVyIHRoZSBhdHRhY2hlZCBvciB0aGUgY29uc3RydWN0LW93bmVkIG1vZGUuIFRoYXRcbiAgICogZXhjZXB0aW9uIGlzIGVuZm9yY2VkIGF0IHN5bnRoZXNpcyB0aW1lIGFuZCBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGUgYWRkZWRcbiAgICogcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSB0aGUgZ3JlZWR5XG4gICAqIGBBTlkgL2Agb3IgYEFOWSAve3Byb3h5K31gIGtleS4gV2l0aGluIGl0LCBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggYmVhdHMgdGhlXG4gICAqIGdyZWVkeSByb3V0ZXMgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSwgYW5kIGEgd3JvbmctbWV0aG9kIGhpdCBvbiBzdWNoIGFcbiAgICogcGF0aCBmYWxscyB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkIDQwNC80MDUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlTW9kZWw/OiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsO1xuXG4gIC8qKlxuICAgKiBDb25zdHJ1Y3QtaWQgZGVyaXZhdGlvbiBmb3IgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsLlxuICAgKlxuICAgKiBgbGVnYWN5YCAodGhlIGRlZmF1bHQpIGFzc2lnbnMgcG9zaXRpb25hbCBpZHMgaW4gZW1pc3Npb24gb3JkZXIgYW5kIGlzXG4gICAqIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuIGBzZW1hbnRpY2AgZGVyaXZlcyBlYWNoIGlkIGZyb20gaXRzIHJvdXRlXG4gICAqIG1ldGhvZCBhbmQgcGF0dGVybiwgc28gaW5zZXJ0aW5nLCByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhIHJvdXRlIGZhbWlseVxuICAgKiBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZTsgaXQgaXMgaW50ZW5kZWQgZm9yIG5ld2x5IGNyZWF0ZWQgZXhwbGljaXRcbiAgICogQVBJcy5cbiAgICpcbiAgICogU3dpdGNoaW5nIGFuIGV4aXN0aW5nIGRlcGxveWVkIGV4cGxpY2l0IEFQSSBmcm9tIGBsZWdhY3lgIHRvIGBzZW1hbnRpY2AgaW5cbiAgICogcGxhY2UgcmVuYW1lcyBldmVyeSByb3V0ZSBpbiBvbmUgdXBkYXRlLCB3aGljaCBpcyBleGFjdGx5IHRoZVxuICAgKiBjcmVhdGUtYmVmb3JlLWRlbGV0ZSByb3V0ZS1rZXkgY29sbGlzaW9uIHRoZSBtaWdyYXRpb24gY2hlY2sgcmVmdXNlcy4gQWRvcHRcbiAgICogYHNlbWFudGljYCBvbiBhbiBleGlzdGluZyBzdGFjayBvbmx5IHRocm91Z2ggdGhlIG5ldy1BUEkgc3dhcCBkb2N1bWVudGVkIGluXG4gICAqIGBVUEdSQURJTkcubWRgLlxuICAgKlxuICAgKiBUaGlzIHByb3AgYXBwbGllcyB0byBgcm91dGVNb2RlbDogZXhwbGljaXRgIG9ubHkuIFRoZSBgY29uc29saWRhdGVkYCBtb2RlbFxuICAgKiBhbHJlYWR5IGVtaXRzIHRoZSB0d28gZml4ZWQgc2VtYW50aWMgaWRzIGBSb3V0ZUFueVJvb3RgIGFuZCBgUm91dGVBbnlQcm94eWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVJZE1vZGU/OiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZTtcblxuICAvKipcbiAgICogQ09SUyBwcmVmbGlnaHQgZm9yIGEgY29uc3RydWN0LW93bmVkIEFQSS4gU2V0IHRvIGB0cnVlYCBmb3IgQXBwVGhlb3J5XG4gICAqIGRlZmF1bHRzIG9yIHN1cHBseSBhbiBgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zYCBvYmplY3QuIEludmFsaWQgaW5cbiAgICogYXR0YWNoIG1vZGUsIHdoZXJlIHRoZSBvd25pbmcgQVBJIGNvbmZpZ3VyZXMgQ09SUy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogU3RhZ2UgbmFtZSB1c2VkIHdoZW4gZGVyaXZpbmcgYXR0YWNoLW1vZGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgdGVtcGxhdGVzLlxuICAgKiBVc2UgYCRkZWZhdWx0YCBmb3IgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHQgc3RhZ2UuIFdoZW4gb21pdHRlZCwgdGhlIHN0YWdlXG4gICAqIGlzIG5vdCBkZXRlcm1pbmFibGUgYW5kIHRoZSB0ZW1wbGF0ZXMgcmV0YWluIHRoZSBiYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbi5cbiAgICogVGhpcyBwcm9wIGRvZXMgbm90IGNyZWF0ZSwgaW1wb3J0LCBvciBtdXRhdGUgYSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdHRhY2hlZEFwaVN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBBbiBleHBsaWNpdCBzZWxlY3Rpb24gb3ZlcnJpZGVzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuIFdoZW4gaXQgaXNcbiAgICogb21pdHRlZCwgYSBzZXJ2ZXIgdGhhdCBhdHRhY2hlcyBgZmFjYWRlYCByZXNvbHZlcyB0byBgcnVudGltZS1iZWFyZXJgIGFuZCBhXG4gICAqIHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXIgcmVzb2x2ZXMgdG8gYGlhbWAuIGBub25lLXB1YmxpY2AgaXMgbmV2ZXIgYSBkZWZhdWx0XG4gICAqIGFuZCBjYXJyaWVzIHRoZSBkZWZlbnNlLWluLWRlcHRoIGZsb29yLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSIHdoZW4gYGZhY2FkZWAgaXMgYXR0YWNoZWQsIG90aGVyd2lzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZT86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG5cbiAgLyoqXG4gICAqIFVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBtYXJrcyB0aGlzIHNlcnZlciBhcyBmYWNhZGUtY29uZmlndXJlZC5cbiAgICpcbiAgICogVGhlIGF0dGFjaG1lbnQncyBwcmVzZW5jZSBzZWxlY3RzIHRoZSBgcnVudGltZS1iZWFyZXJgIHBvc3R1cmUgZGVmYXVsdC5cbiAgICogUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudDtcblxuICAvKipcbiAgICogUnVudGltZS1zaWRlIFJGQyA5NzI4IGJlYXJlciB2YWxpZGF0aW9uIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZCBieSBgdHJhbnNwb3J0UG9zdHVyZTogUlVOVElNRV9CRUFSRVJgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5XG4gICAqIG90aGVyIHBvc3R1cmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBvc3R1cmU/OiBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZFxuICAgKiBOT05FX1BVQkxJQy4gQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIGlzIHJlZnVzZWQgdW5sZXNzIGl0IGlzIGRlY2xhcmVkXG4gICAqIGBGUk9OVEVEYCwgd2hpY2ggcmVxdWlyZXMgYGZyb250RG9vclZlcmlmaWNhdGlvbmAuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5PzogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5O1xuXG4gIC8qKlxuICAgKiBGcm9udC1kb29yIHZlcmlmaWNhdGlvbiBkZWNsYXJhdGlvbiwgcmVxdWlyZWQgd2l0aFxuICAgKiBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYCBhbmQgcmVmdXNlZCB1bmRlciBldmVyeSBvdGhlciBkZWNpc2lvbi5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCByZWNvcmRzIHRoZSBwb3N0dXJlLCB0aGUgaGVhZGVyIG5hbWUsIGFuZCBlaXRoZXIgYSBTSEEtMjU2XG4gICAqIGRpZ2VzdCBvZiB0aGUgZGVjbGFyZWQgbGl0ZXJhbCBvciB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSBpbiB0aGVcbiAgICogYGFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVgIG1ldGFkYXRhOyBpdCBuZXZlciBlbWl0cyB0aGUgc2VjcmV0XG4gICAqIHZhbHVlLiBgZnJvbnREb29yT3JpZ2luSGVhZGVyYCBpcyB0aGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcGxpY2F0aW9uXG4gICAqIHdpcmVzLCBhbmQgZm9yIHRoZSBwYXJhbWV0ZXIgZm9ybSBpdHMgdmFsdWUgaXMgYSBDbG91ZEZvcm1hdGlvbiBkeW5hbWljXG4gICAqIHJlZmVyZW5jZS4gRW5mb3JjZW1lbnQgaXMgdGhlIHJ1bnRpbWUncyBmcm9udC1kb29yIGhlYWRlciBjaGVjaywgc28gYW5cbiAgICogdW53aXJlZCBydW50aW1lIGVuZm9yY2VzIG5vdGhpbmcuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZnJvbnREb29yVmVyaWZpY2F0aW9uPzogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucztcblxuICAvKipcbiAgICogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBvbmx5LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRlbmlhbFNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIHRocm90dGxpbmcgYW5kIGFjY2Vzcy1sb2dnaW5nXG4gICAqIGRlY2lzaW9ucywgcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kIE5PTkVfUFVCTElDLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG93bmluZ0FwaURlZmVuc2U/OiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciB0aGUgTUNQIHRyYW5zcG9ydCByb3V0ZXMuXG4gICAqXG4gICAqIFRyYW5zcG9ydCByb3V0ZXMgYXJlIHRoZSBQT1NULCBHRVQsIGFuZCBERUxFVEUgcm91dGVzIG9uIGV2ZXJ5IE1DUCBwYXR0ZXJuLlxuICAgKiBUaGlzIHByb3AgaXMgb25seSB2YWxpZCB3aXRoIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLCB3aGljaCByZXF1aXJlcyBhblxuICAgKiBpc3N1ZXIgYW5kIGEgbm9uLWVtcHR5IGF1ZGllbmNlLiBEaXNjb3ZlcnksIHByb3RlY3RlZC1yZXNvdXJjZSBtZXRhZGF0YSxcbiAgICogYXV0aG9yaXplLCBhbmQgdG9rZW4gcm91dGVzIHJlbWFpbiBleHBsaWNpdGx5IHB1YmxpYyAoYE5PTkVgKSBiZWNhdXNlIE9BdXRoXG4gICAqIGNsaWVudHMgbXVzdCBmZXRjaCB0aGVtIGJlZm9yZSB0aGV5IGhvbGQgYSB0b2tlbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRBdXRob3JpemVyPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlLWdsb2JhbCB1cHN0cmVhbSBPQXV0aCBjYWxsYmFjayBwYXRoLlxuICAgKlxuICAgKiBUaGUgQ0RLLW1vdW50ZWQgY2FsbGJhY2sgcm91dGUgYW5kIHRoZSBydW50aW1lLXJlZ2lzdGVyZWQgb25lIG11c3Qgbm90XG4gICAqIGRpdmVyZ2U6IHRoaXMgcHJvcCBpcyByZXNvbHZlZCBieVxuICAgKiBgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoYCwgdGhlIHNhbWUgYWxnZWJyYVxuICAgKiB0aGUgcnVudGltZSBhcHBsaWVzIHRvIGBGYWNhZGVDb25maWcuVXBzdHJlYW1DYWxsYmFja1BhdGhgLiBTdXBwbHkgYVxuICAgKiBzeW50aGVzaXMtdGltZSBsaXRlcmFsIGFic29sdXRlIHBhdGggd2l0aCBubyBxdWVyeSwgZnJhZ21lbnQsIG9yIGRvdFxuICAgKiBzZWdtZW50OyBhbiBlbXB0eSB2YWx1ZSBrZWVwcyB0aGUgY29udHJhY3QgZGVmYXVsdCwgYW5kIGEgdmFsdWUgdGhhdFxuICAgKiBjb2xsaWRlcyB3aXRoIGFub3RoZXIgZGVyaXZlZCByb3V0ZSBmYWlscyBzeW50aGVzaXMuIFJlZnVzZWQgdW5kZXJcbiAgICogYHRyYW5zcG9ydFBvc3R1cmU6IG5vbmUtcHVibGljYCwgd2hpY2ggYXR0YWNoZXMgbm8gT0F1dGggc3VyZmFjZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSFxuICAgKi9cbiAgcmVhZG9ubHkgdXBzdHJlYW1DYWxsYmFja1BhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24tc3RhdGUgdGFibGUgY29uZmlndXJhdGlvbi4gVGhlIHRhYmxlIGRlZmF1bHRzIG9uLlxuICAgKiBAZGVmYXVsdCBlbmFibGVkIHdpdGggcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblN0YXRlPzogQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucztcblxuICAvKipcbiAgICogT3duZWQtQVBJIGNvbmZpZ3VyYXRpb24gZm9yIHN0YW5kYWxvbmUgbW9kZS4gSW52YWxpZCB3aXRoIGBhcGlgLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uLW93bmVkIEFQSSBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgb3duZWRBcGk/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNpbmdsZSBNQ1Agcm91dGUgcGF0aCBmcm9tIHRoZSB2My4xLnggQTYgc3VyZmFjZS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGByb3V0ZUZhbWlseS5wYXR0ZXJuc2AuIFRoZSBuZXcgZGVmYXVsdCBpcyB0aGUgY2Fub25pY2FsXG4gICAqIGZvdXItcGF0dGVybiBmYW1pbHk7IHVzZSBgeyBwYXR0ZXJuczogWycvbWNwJ10gfWAgZm9yIHRoZSBvbGQgc2luZ2xldG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogQXV0aG9yaXphdGlvbi1zZXJ2ZXIgaXNzdWVyIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSXNzdWVyVVJMYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgaXNzdWVyIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEpXS1MgVVJJIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSldLU1VSSWAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIEpXS1MgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5hcGlOYW1lYC4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUuZW5hYmxlZGAuIFNlc3Npb24gc3RhdGUgbm93IGRlZmF1bHRzIG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudGFibGVOYW1lYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudHRsTWludXRlc2AuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmRvbWFpbmAuIERvbWFpbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLnN0YWdlYC4gU3RhZ2Ugb3B0aW9ucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIENvbnRyYWN0LWZpcnN0IE1DUCBmYWNhZGUgZGVwbG95bWVudCBjb25zdHJ1Y3QuXG4gKlxuICogVGhlIHByaW1hcnkgbW9kZSBhdHRhY2hlcyB0aGUgY29tcGxldGUgcm91dGUtYWxnZWJyYSBmYW1pbHkgdG8gYSBzdXBwbGllZFxuICogSFRUUCBBUEkuIE9taXR0aW5nIGBhcGlgIHNwZWNpYWxpemVzIHRoZSBzYW1lIHBhdGggaW50byBhIHN0YW5kYWxvbmUgb3duZWRcbiAqIEFQSS4gVGhlIGNvbnN0cnVjdCByb3V0ZXMgb25seTogT0F1dGggbWV0YWRhdGEsIHNjb3BlcywgY2FwYWJpbGl0aWVzLCBhbmRcbiAqIGF1dGhvcml6ZS90b2tlbiBiZWhhdmlvciByZW1haW4gYXBwbGljYXRpb24tb3duZWQgdGhyb3VnaCBHb1xuICogYG1jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwcml2YXRlIHJvdXRlU2VxdWVuY2UgPSAwO1xuICBwcml2YXRlIHJvdXRlSWRNb2RlID0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZO1xuICBwcml2YXRlIHJlYWRvbmx5IHJvdXRlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICAvKipcbiAgICogUmVzb2x2ZWQgdHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogRmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVycyByZXNvbHZlIHRvIGBydW50aW1lLWJlYXJlcmAgdW5sZXNzXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlYCBvdmVycmlkZXMgdGhlIGRlZmF1bHQ7IHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXJzIHJlc29sdmVcbiAgICogdG8gYGlhbWAuIERlbGliZXJhdGVseSBwdWJsaWMgc2VydmVycyBtdXN0IHNlbGVjdCBgbm9uZS1wdWJsaWNgIGV4cGxpY2l0bHkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcbiAgLyoqXG4gICAqIERlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGVzIGZvciB0aGUgb3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSB0aGVzZSBhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlcywgbm90IGRlY2xhcmF0aW9ucyBvZlxuICAgKiBwdWJsaWMgYXV0aG9yaXR5LiBBbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQ7IHRoZSBvcmlnaW4gaXMgZGVyaXZlZFxuICAgKiBmcm9tIGBhcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIHBsdXNcbiAgICogYGF0dGFjaGVkQXBpU3RhZ2VOYW1lYCB3aGVuIHN1cHBsaWVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKlxuICAgKiBGaXJzdCBkZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlLlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSBhbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQuIFRoaXMgdmFsdWUgaXMgYW5cbiAgICogZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlIGRlcml2ZWQgYnkgdGhlIHNhbWUgcnVsZXMgYXMgYGVuZHBvaW50c2AsIG5vdFxuICAgKiB0aGUgZnJvbnQgZG9vcidzIHB1YmxpYyBhdXRob3JpdHkuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgZW5kcG9pbnRzYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gY3VzdG9tIGhlYWRlciB0aGUgYXBwLW93bmVkIGZyb250IGRvb3IgbXVzdCBzZW5kIG9uIGV2ZXJ5IG9yaWdpblxuICAgKiByZXF1ZXN0LCBwcmVzZW50IG9ubHkgdW5kZXIgYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAuXG4gICAqXG4gICAqIFdpcmUgaXQgaW50byB0aGUgZGlzdHJpYnV0aW9uIG9yaWdpbjpcbiAgICogYG9yaWdpbnMuSHR0cE9yaWdpbihob3N0LCB7IGN1c3RvbUhlYWRlcnM6IHsgW2guaGVhZGVyTmFtZV06IGguaGVhZGVyVmFsdWUgfSB9KWAuXG4gICAqIFVuZGVyIHRoZSBwYXJhbWV0ZXIgZm9ybSBgaGVhZGVyVmFsdWVgIGlzIGEgYHt7cmVzb2x2ZTpzc206Li4ufX1gXG4gICAqIENsb3VkRm9ybWF0aW9uIGR5bmFtaWMgcmVmZXJlbmNlLCBzbyB0aGUgdmFsdWUgbmV2ZXIgZW50ZXJzIHRoZVxuICAgKiBhcHBsaWNhdGlvbiBzb3VyY2Ugb3IgdGhlIGNvbnN0cnVjdCdzIHRlbXBsYXRlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGZyb250RG9vck9yaWdpbkhlYWRlcj86IEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzKTtcbiAgICBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCByb3V0ZUZhbWlseSA9IG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzKTtcbiAgICBjb25zdCBvd25lZE9wdGlvbnMgPSBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHMpO1xuXG4gICAgY29uc3QgcG9zdHVyZSA9IHByb3BzLnRyYW5zcG9ydFBvc3R1cmVcbiAgICAgID8/IChwcm9wcy5mYWNhZGUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAgICAgOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSk7XG4gICAgdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChwcm9wcy5mYWNhZGUpO1xuICAgIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhwcm9wcywgcm91dGVGYW1pbHksIHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgocHJvcHMsIHBvc3R1cmUsIG93bmVkT3B0aW9ucyk7XG4gICAgY29uc3Qgb3JpZ2luUmVhY2hhYmlsaXR5ID0gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eSh0aGlzLCBwcm9wcywgb3duZWRPcHRpb25zKTtcbiAgICBpZiAob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCkge1xuICAgICAgKHRoaXMgYXMgeyBmcm9udERvb3JPcmlnaW5IZWFkZXI/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXIgfSkuZnJvbnREb29yT3JpZ2luSGVhZGVyID1cbiAgICAgICAgZnJvbnREb29yT3JpZ2luSGVhZGVyKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgICBncmFudEZyb250RG9vclBhcmFtZXRlclJlYWQodGhpcywgcHJvcHMuaGFuZGxlciwgcHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKTtcbiAgICB9XG4gICAgY29uc3Qgcm91dGVNb2RlbCA9IHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzKTtcbiAgICB2YWxpZGF0ZVJvdXRlTW9kZWxQb3N0dXJlKHJvdXRlTW9kZWwsIHBvc3R1cmUpO1xuICAgIGNvbnN0IHJvdXRlSWRNb2RlID0gcmVzb2x2ZVJvdXRlSWRNb2RlKHByb3BzKTtcbiAgICB0aGlzLnJvdXRlSWRNb2RlID0gcm91dGVJZE1vZGU7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEICYmIHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHRoaXMsIHByb3BzLmFwaSk7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCA9IHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM7XG4gICAgY29uc3QgdXBzdHJlYW1DYWxsYmFja1BhdGggPSByZXNvbHZlVXBzdHJlYW1DYWxsYmFja1BhdGgocHJvcHMpO1xuXG4gICAgdGhpcy50cmFuc3BvcnRQb3N0dXJlID0gcG9zdHVyZTtcbiAgICB0aGlzLm1jcFBhdGhzID0gWy4uLnJvdXRlRmFtaWx5LnBhdHRlcm5zXTtcbiAgICB0aGlzLnJvdXRlSW52ZW50b3J5ID0gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgICAgIHRoaXMubWNwUGF0aHMsXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgICByb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSxcbiAgICAgIHVwc3RyZWFtQ2FsbGJhY2tQYXRoLFxuICAgICk7XG4gICAgdmFsaWRhdGVSb3V0ZUludmVudG9yeSh0aGlzLnJvdXRlSW52ZW50b3J5LCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzID0gdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubWFwKFxuICAgICAgKHJvdXRlKSA9PiByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sXG4gICAgKTtcbiAgICB0aGlzLm1jcFBhdGggPSB0aGlzLm1jcFBhdGhzWzBdO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGggPSB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc1swXTtcblxuICAgIGxldCBvd25lZFN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb3duZWRTdGFnZU5hbWUgPSBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHByb3BzLmFwaSkge1xuICAgICAgdGhpcy5hcGkgPSBwcm9wcy5hcGk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHN0YWdlT3B0aW9ucyA9IG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvd25lZE9wdGlvbnMuc3RhZ2UpO1xuICAgICAgb3duZWRTdGFnZU5hbWUgPSBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lO1xuICAgICAgY29uc3QgYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgIGFwaU5hbWU6IG93bmVkT3B0aW9ucy5hcGlOYW1lLFxuICAgICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogZmFsc2UsXG4gICAgICAgIGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQ6IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgICAgfHwgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICAgPyB0cnVlXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGkgfSkub3duZWRBcGkgPSBhcGk7XG4gICAgICB0aGlzLmFwaSA9IGFwaTtcbiAgICAgIGlmIChvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCkge1xuICAgICAgICByZWdpc3Rlck93bmVkRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIGFwaSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICBodHRwQXBpOiBhcGksXG4gICAgICAgIHN0YWdlTmFtZTogc3RhZ2VPcHRpb25zLnN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nRW5hYmxlZFxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgIG93bmVkU3RhZ2UgPSBzdGFnZTtcblxuICAgICAgaWYgKHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dSZXRlbnRpb24sXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgICAgZm9ybWF0OiBhY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTWNwSGFuZGxlclwiLFxuICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCB0cmFuc3BvcnRBdXRob3JpemVyID0gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIocHJvcHMsIHBvc3R1cmUpO1xuICAgIGxldCBmaXJzdFRyYW5zcG9ydFJvdXRlOiBhcGlnd3YyLkh0dHBSb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAocm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURUQpIHtcbiAgICAgIGZpcnN0VHJhbnNwb3J0Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCxcbiAgICAgICAgXCIvXCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHByb3h5Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQsXG4gICAgICAgIFwiL3twcm94eSt9XCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbih0aGlzLCB0aGlzLmFwaSwgW2ZpcnN0VHJhbnNwb3J0Um91dGUsIHByb3h5Um91dGVdKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcnVudGltZU93bmVkQXV0aCA9IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICAgIHRvSHR0cE1ldGhvZChtZXRob2QpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnJlZ2lzdGVyUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIHVwc3RyZWFtIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgbm90IHBlciBraW5kOiB3aXJlIGl0IGV4YWN0bHkgb25jZS5cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5jYWxsYmFja1BhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcG9zdHVyZU1hcmtlclRhcmdldCA9ICh0aGlzLm93bmVkQXBpPy5ub2RlLmRlZmF1bHRDaGlsZFxuICAgICAgPz8gZmlyc3RUcmFuc3BvcnRSb3V0ZT8ubm9kZS5kZWZhdWx0Q2hpbGQpIGFzIGFwaWd3djIuQ2ZuQXBpIHwgYXBpZ3d2Mi5DZm5Sb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBwb3N0dXJlTWFya2VyVGFyZ2V0Py5hZGRNZXRhZGF0YShNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZLCB7XG4gICAgICBwb3N0dXJlLFxuICAgICAgY29udHJhY3RfaWQ6IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCxcbiAgICAgIHJvdXRlX2NvdW50OiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5sZW5ndGgsXG4gICAgICBydW50aW1lX3Bvc3R1cmVfZGVjbGFyZWQ6IHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQsXG4gICAgICAvLyBPbmx5IGEgRlJPTlRFRCBkZWNpc2lvbiBleHRlbmRzIHRoZSBtYXJrZXIsIHNvIERJU0FCTEVEIGFuZCBMT0NLRURcbiAgICAgIC8vIHRlbXBsYXRlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLiBUaGUgbGl0ZXJhbCBzZWNyZXQgaXMgY29uc3VtZWQgaGVyZSBmb3JcbiAgICAgIC8vIGl0cyBkaWdlc3QgYW5kIG5ldmVyIGVtaXR0ZWQuXG4gICAgICAuLi4ob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICAgICAgICA/IGZyb250RG9vclBvc3R1cmVNZXRhZGF0YShwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pXG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGlmIChcbiAgICAgICAgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICYmIHRoaXMub3duZWRBcGkgIT09IHVuZGVmaW5lZFxuICAgICAgKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIHRoaXMub3duZWRBcGkpO1xuICAgICAgfVxuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICBwcm9wcy5hcGkgPT09IHVuZGVmaW5lZFxuICAgICAgJiYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgIHx8IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRClcbiAgICAgICYmIHRoaXMuZW5kcG9pbnRzLnNvbWUoKGVuZHBvaW50KSA9PiBlbmRwb2ludC5pbmNsdWRlcyhcIi5leGVjdXRlLWFwaS5cIikpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgbXVzdCBhZHZlcnRpc2UgdGhlIG93bmVkIGN1c3RvbSBkb21haW4sIG5ldmVyIHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCB0aGlzLm5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCksIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgbmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMucm91dGVJZE1vZGUgIT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDKSB7XG4gICAgICByZXR1cm4gYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpO1xuICAgIGlmICh0aGlzLnJvdXRlSWRzLmhhcyhpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgc2VtYW50aWMgZGVyaXZlcyB0aGUgZHVwbGljYXRlIHJvdXRlIGNvbnN0cnVjdCBpZCAke2lkfSBmb3Igcm91dGUga2V5ICR7bWV0aG9kfSAke3BhdGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMucm91dGVJZHMuYWRkKGlkKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBpZCwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgbXRsczogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoY29uZmlndXJlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKGNvbmZpZ3VyZWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgPyBlcnIubWVzc2FnZS5yZXBsYWNlKC9ebWNwcm91dGVzOiAvLCBcIlwiKVxuICAgICAgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBpcyBpbnZhbGlkOiAke3JlYXNvbn1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIGNhbGxiYWNrUGF0dGVybjogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkNPTlRSQUNUX1ZFUlNJT04sXG4gICAgcm91dGVzOiBwYXR0ZXJucy5tYXAoKG1jcFBhdHRlcm4pID0+ICh7XG4gICAgICBtY3BQYXR0ZXJuLFxuICAgICAgbWNwTWV0aG9kczogW1wiUE9TVFwiLCBcIkdFVFwiLCBcIkRFTEVURVwiXSxcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gICAgY2FsbGJhY2tQYXR0ZXJuLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnJlZ2lzdGVyUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybik7XG4gIH1cbiAgaWYgKGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICBpZiAocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgcmVxdWlyZXMgYXR0YWNoIG1vZGUgd2l0aCBhcGlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICYmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpXG4gICAgICB8fCAhL14oPzpcXCRkZWZhdWx0fFtBLVphLXowLTlfLV17MSwxMjh9KSQvLnRlc3QocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgQVBJIEdhdGV3YXkgc3RhZ2UgbmFtZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHByb3BzLm93bmVkQXBpICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcIm93bmVkQXBpXCIpO1xuICBpZiAocHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJhcGlOYW1lXCIpO1xuICBpZiAocHJvcHMuY29ycyAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJjb3JzXCIpO1xuICBpZiAocHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImRvbWFpblwiKTtcbiAgaWYgKHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcInN0YWdlXCIpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggIT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2ggbW9kZSB3aXRoIGFwaSBjYW5ub3QgY29uZmlndXJlIG93bmVkLUFQSSBwcm9wczogJHtpbnZhbGlkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICBpZiAocHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuYXBpTmFtZSBhbmQgZGVwcmVjYXRlZCBhcGlOYW1lIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5kb21haW4gIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gYW5kIGRlcHJlY2F0ZWQgZG9tYWluIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgYW5kIGRlcHJlY2F0ZWQgc3RhZ2UgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFwaU5hbWU6IHByb3BzLm93bmVkQXBpPy5hcGlOYW1lID8/IHByb3BzLmFwaU5hbWUsXG4gICAgZG9tYWluOiBwcm9wcy5vd25lZEFwaT8uZG9tYWluID8/IHByb3BzLmRvbWFpbixcbiAgICBzdGFnZTogcHJvcHMub3duZWRBcGk/LnN0YWdlID8/IHByb3BzLnN0YWdlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU9wdGlvbnMob3B0aW9ucz86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyk6IE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICBjb25zdCBhY2Nlc3NMb2dnaW5nID0gb3B0aW9ucz8uYWNjZXNzTG9nZ2luZyA/PyB0cnVlO1xuICBpZiAoIWFjY2Vzc0xvZ2dpbmcgJiYgb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nUmV0ZW50aW9uIHJlcXVpcmVzIGFjY2Vzc0xvZ2dpbmcgdG8gYmUgZW5hYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZ0VuYWJsZWQgPSBvcHRpb25zPy50aHJvdHRsaW5nRW5hYmxlZCA/PyB0cnVlO1xuICBpZiAoXG4gICAgIXRocm90dGxpbmdFbmFibGVkXG4gICAgJiYgKG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgdGhyb3R0bGluZyBsaW1pdHMgcmVxdWlyZSB0aHJvdHRsaW5nRW5hYmxlZCB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXRlTGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUO1xuICBjb25zdCBidXJzdExpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHJhdGVMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nUmF0ZUxpbWl0XCIpO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKGJ1cnN0TGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0J1cnN0TGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VOYW1lOiBvcHRpb25zPy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiLFxuICAgIGFjY2Vzc0xvZ2dpbmcsXG4gICAgYWNjZXNzTG9nUmV0ZW50aW9uOiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICB0aHJvdHRsaW5nRW5hYmxlZCxcbiAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiByYXRlTGltaXQsXG4gICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IGJ1cnN0TGltaXQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgY29uc3QgaGFzTGVnYWN5ID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAocHJvcHMuc2Vzc2lvblN0YXRlICE9PSB1bmRlZmluZWQgJiYgaGFzTGVnYWN5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHNlc3Npb25TdGF0ZSBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBkZXByZWNhdGVkIHNlc3Npb24tdGFibGUgcHJvcHNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGVuYWJsZWQgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LmVuYWJsZWQgPz8gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlID8/IHRydWU7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lID8/IHByb3BzLnNlc3Npb25UYWJsZU5hbWU7XG4gIGNvbnN0IHR0bE1pbnV0ZXMgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXNcbiAgICA/PyBwcm9wcy5zZXNzaW9uVHRsTWludXRlc1xuICAgID8/IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUztcbiAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgaWYgKFxuICAgICFlbmFibGVkXG4gICAgJiYgKHRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRpc2FibGVkIHNlc3Npb24gc3RhdGUgY2Fubm90IGNvbmZpZ3VyZSB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIG9yIHJlbW92YWxQb2xpY3lcIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7IGVuYWJsZWQsIHRhYmxlTmFtZSwgdHRsTWludXRlcywgcmVtb3ZhbFBvbGljeSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkgcmV0dXJuO1xuICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGlzc3VlcixcbiAgICAgIGZhbHNlLFxuICAgICAgXCJhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBqd2tzVXJpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiandrc1VyaSBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHVzZXJpbmZvIG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy50cmFuc3BvcnRBdXRob3JpemVyO1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHtcbiAgICAgIGlmIChjb25maWd1cmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGlzIG9ubHkgdmFsaWQgd2l0aCB0cmFuc3BvcnRQb3N0dXJlIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAgICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgICAgIDogbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgfVxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBvc3R1cmVMYWJlbChwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTogcmV0dXJuIFwiSUFNXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDogcmV0dXJuIFwiSldUXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOiByZXR1cm4gXCJSVU5USU1FX0JFQVJFUlwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzogcmV0dXJuIFwiTk9ORV9QVUJMSUNcIjtcbiAgICBkZWZhdWx0OiByZXR1cm4gU3RyaW5nKHBvc3R1cmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogdm9pZCB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOlxuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVNb2RlbDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVCBvciAuQ09OU09MSURBVEVEXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUoXG4gIHJvdXRlTW9kZWw6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgaXMgb25seSB2YWxpZCBmb3IgdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiBvciBOT05FX1BVQkxJQzsgdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0ga2VlcHMgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsIGJlY2F1c2UgY29uc29saWRhdGlvbiBtdXN0IG5ldmVyIGNoYW5nZSBnYXRld2F5IGFkbWlzc2lvbmAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVJZE1vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVJZE1vZGU7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1lcbiAgICB8fCBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5TRU1BTlRJQ1xuICApIHtcbiAgICByZXR1cm4gY29uZmlndXJlZDtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlSWRNb2RlIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZIG9yIC5TRU1BTlRJQ1wiLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSB0d28gZ3JlZWR5IHJvdXRlIGtleXMgYSBjb25zb2xpZGF0ZWQgbW9kZWwgb3ducy4gQSBjb25zdW1lciByb3V0ZSB0aGF0XG4gKiByZWRlY2xhcmVzIG9uZSBvZiB0aGVtIHdvdWxkIG1ha2UgdGhlIEFQSSByZWplY3QgdGhlIHVwZGF0ZS5cbiAqL1xuY29uc3QgQ09OU09MSURBVEVEX0dSRUVEWV9ST1VURV9LRVlTID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4vKipcbiAqIFJlc29sdmUgYW4gYEFwaUlkYCAob3IgYW55IHRlbXBsYXRlIHZhbHVlKSB0byBhIGNvbXBhcmFibGUgc3RyaW5nLCBzbyBhXG4gKiBgUmVmYCB0b2tlbiBhbmQgaXRzIGxvZ2ljYWwgaWQgY29tcGFyZSBlcXVhbCBhY3Jvc3MgdHdvIHRlbXBsYXRlcyBvZiB0aGUgc2FtZVxuICogc3RhY2suXG4gKi9cbmZ1bmN0aW9uIGNvbXBhcmFibGVBcGlJZChzY29wZTogQ29uc3RydWN0LCB2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShTdGFjay5vZihzY29wZSkucmVzb2x2ZSh2YWx1ZSkpO1xufVxuXG4vKipcbiAqIEV2ZXJ5IEFQSSBHYXRld2F5IHYyIHJvdXRlIGJvdW5kIHRvIGBhcGlgLCByZWdhcmRsZXNzIG9mIHdoaWNoIGNvbnN0cnVjdFxuICogc2NvcGUgY3JlYXRlZCBpdC5cbiAqXG4gKiBgYXBpLm5vZGUuY2hpbGRyZW5gIG9ubHkgc2VlcyByb3V0ZXMgdGhlIEFQSSBpdHNlbGYgKG9yIGEgY2hpbGQgc2NvcGUpXG4gKiBjcmVhdGVkLCB3aGljaCBtaXNzZXMgdGhlIGNvbW1vbiBwYXR0ZXJuIG9mIGEgc3RhY2stbGV2ZWwgY29uc3RydWN0IHdpcmluZyBhXG4gKiByb3V0ZSBvbnRvIGFuIGF0dGFjaGVkIEFQSS4gV2Fsa2luZyB0aGUgc3RhY2sgYW5kIHJlc29sdmluZyBlYWNoIGBDZm5Sb3V0ZWAnc1xuICogYEFwaUlkYCBzZWVzIGJvdGguXG4gKi9cbmZ1bmN0aW9uIHJvdXRlc0JvdW5kVG9BcGkoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogYXBpZ3d2Mi5DZm5Sb3V0ZVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuUm91dGVbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuSHR0cFJvdXRlKSB7XG4gICAgICBpZiAoY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmh0dHBBcGkuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgICAgZm91bmQucHVzaChub2RlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpO1xuICAgICAgfVxuICAgICAgLy8gVGhlIHJvdXRlJ3Mgb3duIENmblJvdXRlIGNoaWxkIGlzIHRoZSBzYW1lIHJvdXRlOyBkbyBub3QgZG91YmxlIGNvdW50LlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuUm91dGUgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQuZmlsdGVyKChyb3V0ZSkgPT4gcm91dGUgIT09IHVuZGVmaW5lZCk7XG59XG5cbi8qKlxuICogUmVmdXNlIGEgY29uc29saWRhdGVkIGF0dGFjaCBvbnRvIGFuIEFQSSB0aGF0IGFscmVhZHkgY2FycmllcyByb3V0ZXMuXG4gKlxuICogVGhlIGNoZWNrIGRlbGliZXJhdGVseSB3YWxrcyB0aGUgd2hvbGUgc3RhY2s6IGEgcm91dGUgYm91bmQgdG8gdGhlIGF0dGFjaGVkXG4gKiBBUEkgZnJvbSBhIHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIGp1c3QgYXMgbXVjaCBhIHJvdXRlIGtleSB0aGVcbiAqIGNvbnNvbGlkYXRlZCBncmVlZHkgcm91dGVzIHdvdWxkIGNvbGxpZGUgd2l0aCBhcyBvbmUgY3JlYXRlZCB1bmRlciB0aGUgQVBJXG4gKiBpdHNlbGYuXG4gKi9cbmZ1bmN0aW9uIGFzc2VydENvbnNvbGlkYXRlZEF0dGFjaEFsbG93ZWQoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nUm91dGVzID0gcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgaWYgKGV4aXN0aW5nUm91dGVzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgbWF5IGF0dGFjaCBvbmx5IHRvIGFuIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWU7IFwiXG4gICAgICArIGB0aGUgQVBJIGFscmVhZHkgY2FycmllcyAke2V4aXN0aW5nUm91dGVzLmxlbmd0aH0gcm91dGUocyk6ICR7ZXhpc3RpbmdSb3V0ZXMubWFwKChyb3V0ZSkgPT4gcm91dGUubm9kZS5wYXRoKS5qb2luKFwiLCBcIil9OyBgXG4gICAgICArIFwiYXR0YWNoIHRvIGEgbmV3IG9yIGVtcHR5IEFQSSwgb3IgdXNlIHJvdXRlTW9kZWwgZXhwbGljaXRcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogUmVnaXN0ZXIgdGhlIHN5bnRoLXRpbWUgcnVsZSBmb3Igcm91dGVzIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlclxuICogdGhlIGNvbnN0cnVjdCBjcmVhdGVkIGl0cyBncmVlZHkgcm91dGVzLlxuICpcbiAqIFRoZSBydWxlIGFwcGxpZXMgaW4gYm90aCBjb25zb2xpZGF0ZWQgbW9kZXM6IGFuIEFQSSB0aGUgY29uc3RydWN0IGF0dGFjaGVkXG4gKiB0bywgYW5kIG9uZSB0aGUgY29uc3RydWN0IG93bnMuIFRoZSBkb2N1bWVudGVkIGV4Y2VwdGlvbiBpcyB3aGF0IG1ha2VzXG4gKiBjb25zb2xpZGF0ZWQgcm91dGVzIHVzYWJsZSBpbiBhIHJlYWwgZnJvbnQgZG9vcjogYSBjb25zdW1lciBtYXkgYWRkXG4gKiBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgYWZ0ZXJ3YXJkcy4gSXQgaXMgYWxsb3dlZCBvbmx5IHdoZW4gdGhlXG4gKiByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciAoc28gdGhlIGdyZWVkeSByb3V0ZXMgbmV2ZXIgc2lsZW50bHlcbiAqIHdpZGVuIGEgc3RyaWN0ZXIgcG9zdHVyZSkgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSBhIGdyZWVkeSByb3V0ZSBrZXkgKHdoaWNoXG4gKiBBUEkgR2F0ZXdheSB3b3VsZCByZWplY3QgYXMgYSBkdXBsaWNhdGUpLlxuICovXG5mdW5jdGlvbiByZWdpc3RlckNvbnNvbGlkYXRlZEF0dGFjaFZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbiAgb3duZWRSb3V0ZXM6IGFwaWd3djIuSHR0cFJvdXRlW10sXG4pOiB2b2lkIHtcbiAgY29uc3Qgb3duZWQgPSBuZXcgU2V0KFxuICAgIG93bmVkUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpLFxuICApO1xuICBTdGFjay5vZihzY29wZSkubm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpKSB7XG4gICAgICAgIGlmIChvd25lZC5oYXMocm91dGUpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm91dGVLZXkgPSByb3V0ZS5yb3V0ZUtleTtcbiAgICAgICAgaWYgKENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUy5oYXMocm91dGVLZXkpKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBhbHJlYWR5IG93bnMgdGhlIGdyZWVkeSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9IG9uIHRoaXMgQVBJOyBhIHJvdXRlIGFkZGVkIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IG5vdCByZWRlY2xhcmUgaXQgKCR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYXV0aG9yaXphdGlvblR5cGUgPSBTdHJpbmcocm91dGUuYXV0aG9yaXphdGlvblR5cGUgPz8gXCJOT05FXCIpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIGlmIChhdXRob3JpemF0aW9uVHlwZSA9PT0gXCJOT05FXCIpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGEgcm91dGUgYWRkZWQgdG8gYSBjb25zb2xpZGF0ZWQgQVBJIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IGNhcnJ5IGEgbm9uLU5PTkUgYXV0aG9yaXplciwgYmVjYXVzZSB0aGUgZ3JlZWR5IHJvdXRlcyBhZG1pdCBldmVyeSBtZXRob2QgYW5kIHBhdGggYXQgdGhlIGdhdGV3YXkgKCR7cm91dGVLZXl9IGZyb20gJHtyb3V0ZS5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGVycm9ycztcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQpOiB2b2lkIHtcbiAgaWYgKGZhY2FkZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIGNvbnN0IHByb3ZpZGVySWQgPSAoZmFjYWRlIGFzIHsgcHJvdmlkZXJJZD86IHVua25vd24gfSk/LnByb3ZpZGVySWQ7XG4gIGlmIChcbiAgICB0eXBlb2YgcHJvdmlkZXJJZCAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHByb3ZpZGVySWQudHJpbSgpID09PSBcIlwiXG4gICAgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHByb3ZpZGVySWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmYWNhZGUucHJvdmlkZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcm91dGVGYW1pbHk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQykge1xuICAgIGlmIChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgb3Igandrc1VyaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBlbmFibGUgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSB1cHN0cmVhbUNhbGxiYWNrUGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4gIG93bmVkOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG9yaWdpblJlYWNoYWJpbGl0eSB0byBiZSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQsIC5MT0NLRUQsIG9yIC5GUk9OVEVEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKG93bmVkLnN0YWdlPy50aHJvdHRsaW5nRW5hYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFuIGV4cGxpY2l0IG93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdFbmFibGVkOiB0cnVlIHRocm90dGxpbmcgZGVjaXNpb25gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG93bmVkLnN0YWdlPy5hY2Nlc3NMb2dnaW5nID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFjY2VzcyBsb2dnaW5nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSKSB7XG4gICAgdmFsaWRhdGVEZW5pYWxTaWduYWwocHJvcHMuZGVuaWFsU2lnbmFsKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGRlY2xhcmVkIGRpcmVjdC1vcmlnaW4gZGVjaXNpb24gdG8gYSBwcm92ZW4gcG9zdHVyZS5cbiAqXG4gKiBFdmVyeSBzdXBwbGllZCB2YWx1ZSBpcyBjaGVja2VkLCBub3Qgb25seSB0aGUgcG9zdHVyZXMgdGhhdCByZXF1aXJlIHRoZVxuICogZGVjaXNpb24uIERJU0FCTEVEIG5lZWRzIHRoZSBvd25lZCBvcmRpbmFyeSBkb21haW4gdGhhdCByZXBsYWNlcyB0aGUgZGlzYWJsZWRcbiAqIGV4ZWN1dGUtYXBpIGF1dGhvcml0eSAob3IgYSBwcm92YWJsZSBjb25jcmV0ZSBhdHRhY2gpLCBhbmQgTE9DS0VEXG4gKiBhZGRpdGlvbmFsbHkgbmVlZHMgbXV0dWFsIFRMUyBvbiBldmVyeSBkb21haW4gbWFwcGVkIHRvIHRoZSBvd25lZCBBUEkuXG4gKiBBdHRhY2gtbW9kZSBMT0NLRUQgaXMgdW5zdXBwb3J0ZWQgYmVjYXVzZSBhbiBleHRlcm5hbCBBUEkgY2FycmllcyBubyBpbi1zdGFja1xuICogdHJ1c3RzdG9yZSBvciBtYXBwaW5nIGV2aWRlbmNlLiBGUk9OVEVEIGlzIHRoZSBhdHRhY2gtbW9kZSBjb3VudGVycGFydCBmb3IgYW5cbiAqIGFwcGxpY2F0aW9uLW93bmVkIGZyb250IGRvb3I6IGl0IHByb2R1Y2VzIG5vIGluLXN0YWNrIGV2aWRlbmNlLCBzbyBpdCBpc1xuICogYWNjZXB0ZWQgb25seSB3aXRoIGFuIGV4cGxpY2l0LCB2YWxpZGF0ZWQgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgZGVjbGFyYXRpb25cbiAqIGFuZCBvbmx5IGluIGF0dGFjaCBtb2RlLlxuICovXG5mdW5jdGlvbiByZXNvbHZlT3JpZ2luUmVhY2hhYmlsaXR5KFxuICBzY29wZTogQ29uc3RydWN0LFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIG93bmVkOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zLFxuKTogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZGVjaXNpb24gPSBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHk7XG4gIGNvbnN0IG11dHVhbFRscyA9IG93bmVkLmRvbWFpbj8ubXV0dWFsVGxzQXV0aGVudGljYXRpb247XG4gIGlmIChkZWNpc2lvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKG11dHVhbFRscyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRURcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgbXVzdCBiZSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQsIC5MT0NLRUQsIG9yIC5GUk9OVEVEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAobXV0dWFsVGxzICE9PSB1bmRlZmluZWQgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICAgJiYgcHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URURcIixcbiAgICApO1xuICB9XG4gIGlmIChkZWNpc2lvbiA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQpIHtcbiAgICBpZiAocHJvcHMuYXBpID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIGlzIHVuc3VwcG9ydGVkIGluIG93bmVkIG1vZGU7IGFuIG93bmVkIGZyb250IGRvb3IgaXMgd2lyZWQgYnkgdGhlIERJU0FCTEVEIG9yIExPQ0tFRCBwb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB2YWxpZGF0ZUZyb250RG9vclZlcmlmaWNhdGlvbihwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pO1xuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgaXMgdW5zdXBwb3J0ZWQgaW4gYXR0YWNoIG1vZGU7IGFuIEFQSSBvd25lZCBvdXRzaWRlIHRoZSBjb25zdHJ1Y3QgY2FycmllcyBubyBpbi1zdGFjayBtdXR1YWwtVExTIG1hcHBpbmcgZXZpZGVuY2VcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvd25lZC5kb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluIHdpdGggbXV0dWFsVGxzQXV0aGVudGljYXRpb25cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChtdXR1YWxUbHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb247IGRpc2FibGVtZW50IGFsb25lIGlzIHRoZSBESVNBQkxFRCBwb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCEocHJvcHMuYXBpIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwQXBpKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIGEgc2FtZS1zdGFjayBjb25jcmV0ZSBIdHRwQXBpOyBhbiBpbXBvcnRlZCBBUEkgZXhwb3NlcyBubyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGV2aWRlbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZWdpc3RlckF0dGFjaERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihzY29wZSwgcHJvcHMuYXBpKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKG93bmVkLmRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluOyB0aGUgZGlzYWJsZWQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgaXMgbmV2ZXIgYSBwdWJsaWMgYXV0aG9yaXR5XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gZGVjaXNpb247XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhlIGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uIGZvciBgb3JpZ2luUmVhY2hhYmlsaXR5OlxuICogRlJPTlRFRGAuXG4gKlxuICogVGhlIGRlY2xhcmF0aW9uIGlzIG1hbmRhdG9yeSBhbmQgZXZlcnkgZmllbGQgaXMgY2hlY2tlZDogYW4gYWJzZW50XG4gKiBkZWNsYXJhdGlvbiwgYSBtaXNzaW5nIG9yIHJlc2VydmVkIGhlYWRlciBuYW1lLCBhIHNlY3JldCBvdXRzaWRlIHRoZVxuICogaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXQsIGFuZCBhIG1pc3NpbmcgYGFzc2VydGVkOiB0cnVlYCBhbGwgZmFpbCBzeW50aGVzaXNcbiAqIHJhdGhlciB0aGFuIHByb2R1Y2luZyBhIGRlY2xhcmF0aW9uIHRoZSBydW50aW1lIGNvdWxkIG5vdCBob25vci5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVGcm9udERvb3JWZXJpZmljYXRpb24oXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGhlYWRlck5hbWUgPSB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZTtcbiAgaWYgKHR5cGVvZiBoZWFkZXJOYW1lICE9PSBcInN0cmluZ1wiIHx8ICFGUk9OVF9ET09SX0hFQURFUl9OQU1FX1BBVFRFUk4udGVzdChoZWFkZXJOYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uaGVhZGVyTmFtZSBtdXN0IGJlIDEgdG8gNjQgY2hhcmFjdGVycyBvZiBbQS1aYS16MC05LV1cIixcbiAgICApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRIZWFkZXIgPSBoZWFkZXJOYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChcbiAgICBSRVNFUlZFRF9GUk9OVF9ET09SX0hFQURFUlMuaGFzKG5vcm1hbGl6ZWRIZWFkZXIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwieC1hbXotXCIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwieC1hbXpuLVwiKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcImNsb3VkZnJvbnQtXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lICR7aGVhZGVyTmFtZX0gaXMgYSByZXNlcnZlZCBvciBwbGF0Zm9ybS1tYW5hZ2VkIHJlcXVlc3QgaGVhZGVyIGFuZCBjYW5ub3QgY2FycnkgdGhlIGZyb250LWRvb3IgdmVyaWZpY2F0aW9uYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHNlY3JldFZhbHVlID0gdmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlO1xuICBjb25zdCBzZWNyZXRQYXJhbWV0ZXJOYW1lID0gdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWU7XG4gIGNvbnN0IGhhc0xpdGVyYWwgPSBzZWNyZXRWYWx1ZSAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNQYXJhbWV0ZXIgPSBzZWNyZXRQYXJhbWV0ZXJOYW1lICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNMaXRlcmFsID09PSBoYXNQYXJhbWV0ZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIHJlcXVpcmVzIGV4YWN0bHkgb25lIG9mIHNlY3JldFZhbHVlIGFuZCBzZWNyZXRQYXJhbWV0ZXJOYW1lOyBzdXBwbHkgdGhlIGxpdGVyYWwsIG9yIHRoZSB3ZWxsLWtub3duIHBhcmFtZXRlciBuYW1lIHRoZSBhcHBsaWNhdGlvbidzIGluc3RhbGxlciBjcmVhdGVzXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzTGl0ZXJhbCkge1xuICAgIGlmICh0eXBlb2Ygc2VjcmV0VmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIUZST05UX0RPT1JfU0VDUkVUX1BBVFRFUk4udGVzdChzZWNyZXRWYWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZSBtdXN0IGJlIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIFtBLVphLXowLTkuX34tXVwiLFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdmFsaWRhdGVGcm9udERvb3JQYXJhbWV0ZXJOYW1lKHNlY3JldFBhcmFtZXRlck5hbWUpO1xuICB9XG4gIGlmICh2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5ICE9PSB1bmRlZmluZWQgJiYgIWhhc1BhcmFtZXRlcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5IGlzIG9ubHkgdmFsaWQgd2l0aCBzZWNyZXRQYXJhbWV0ZXJOYW1lXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLmFzc2VydGVkICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiByZXF1aXJlcyBhc3NlcnRlZDogdHJ1ZSDigJQgdGhlIGNhbGxlciBtdXN0IHJlY29yZCB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeSBkZXJpdmVkIHJvdXRlXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFZhbGlkYXRlIGEgd2VsbC1rbm93biBmcm9udC1kb29yIHBhcmFtZXRlciBuYW1lLlxuICpcbiAqIFRoZSBuYW1lIG11c3QgYmUgZXhwcmVzc2libGUgaW4gYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljIHJlZmVyZW5jZSBhbmRcbiAqIGFjY2VwdGFibGUgdG8gUGFyYW1ldGVyIFN0b3JlLCBiZWNhdXNlIHRoZSBjb25zdHJ1Y3QgcmVuZGVycyB0aGUgcmVmZXJlbmNlIGFuZFxuICogZ3JhbnRzIG9uIHRoZSBBUk4uIEEgbmFtZSBvdXRzaWRlIGVpdGhlciBjb250cmFjdCB3b3VsZCBmYWlsIGF0IGRlcGxveSB0aW1lLFxuICogc28gaXQgZmFpbHMgc3ludGhlc2lzIGluc3RlYWQuXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlRnJvbnREb29yUGFyYW1ldGVyTmFtZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKFxuICAgIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiXG4gICAgfHwgbmFtZS5sZW5ndGggPiBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRU5HVEhcbiAgICB8fCAhRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9QQVRURVJOLnRlc3QobmFtZSlcbiAgICB8fCBuYW1lLmVuZHNXaXRoKFwiL1wiKVxuICAgIHx8IG5hbWUuaW5jbHVkZXMoXCIvL1wiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgbXVzdCBiZSBhIGZ1bGx5IHF1YWxpZmllZCBTU00gcGFyYW1ldGVyIG5hbWUgZnJvbSAnLycsIGF0IG1vc3QgMTAxMSBjaGFyYWN0ZXJzLCBvZiBbQS1aYS16MC05Xy4tL10gd2l0aCBubyBlbXB0eSBzZWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBsZXZlbHMgPSBuYW1lLnNwbGl0KFwiL1wiKS5maWx0ZXIoKHNlZ21lbnQpID0+IHNlZ21lbnQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IGZpcnN0ID0gbGV2ZWxzWzBdPy50b0xvd2VyQ2FzZSgpO1xuICBpZiAobGV2ZWxzLmxlbmd0aCA9PT0gMCB8fCBsZXZlbHMubGVuZ3RoID4gRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVWRUxTKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3QgaGF2ZSBiZXR3ZWVuIG9uZSBhbmQgZmlmdGVlbiBoaWVyYXJjaHkgbGV2ZWxzXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZmlyc3QgPT09IFwiYXdzXCIgfHwgZmlyc3QgPT09IFwic3NtXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgbXVzdCBub3QgdXNlIHRoZSByZXNlcnZlZCBhd3Mgb3Igc3NtIGhpZXJhcmNoeVwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcC1vd25lZCBmcm9udCBkb29yIG11c3Qgc2VuZC5cbiAqXG4gKiBUaGUgcGFyYW1ldGVyIGZvcm0gcmVuZGVycyB0aGUgQ2xvdWRGb3JtYXRpb24gZHluYW1pYyByZWZlcmVuY2UgdGhlXG4gKiBkaXN0cmlidXRpb24gcHJvcGVydHkgYWNjZXB0cywgc28gdGhlIHZhbHVlIGlzIHJlc29sdmVkIGJ5IENsb3VkRm9ybWF0aW9uIGF0XG4gKiBzdGFjayBjcmVhdGUvdXBkYXRlIHRpbWUgYW5kIG5ldmVyIGFwcGVhcnMgaW4gdGhlIGFwcGxpY2F0aW9uIHNvdXJjZSBvciB0aGlzXG4gKiBjb25zdHJ1Y3QncyB0ZW1wbGF0ZS5cbiAqL1xuZnVuY3Rpb24gZnJvbnREb29yT3JpZ2luSGVhZGVyKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXIge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGhlYWRlclZhbHVlID0gdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgIT09IHVuZGVmaW5lZFxuICAgID8gYHt7cmVzb2x2ZTpzc206JHt2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZX19fWBcbiAgICA6IFN0cmluZyh2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWUpO1xuICByZXR1cm4geyBoZWFkZXJOYW1lOiB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZSwgaGVhZGVyVmFsdWUgfTtcbn1cblxuLyoqXG4gKiBHcmFudCB0aGUgcnVudGltZSBmdW5jdGlvbiByZWFkIGFjY2VzcyB0byB0aGUgd2VsbC1rbm93biBmcm9udC1kb29yIHBhcmFtZXRlci5cbiAqXG4gKiBQYXJhbWV0ZXIgU3RvcmUgcmVzb2x2ZXMgdGhlIGRpc3RyaWJ1dGlvbidzIGR5bmFtaWMgcmVmZXJlbmNlIHdpdGggdGhlXG4gKiBkZXBsb3lpbmcgcHJpbmNpcGFsJ3MgcGVybWlzc2lvbnMsIHNvIHRoaXMgZ3JhbnQgc2VydmVzIHRoZSBydW50aW1lJ3MgbGF6eVxuICogcmVhZDogYHNzbTpHZXRQYXJhbWV0ZXJgIG9uIGV4YWN0bHkgdGhhdCBwYXJhbWV0ZXIgQVJOIChuZXZlciBhIHdpbGRjYXJkKSBhbmQsXG4gKiBmb3IgYSBTZWN1cmVTdHJpbmcsIGBrbXM6RGVjcnlwdGAgb24gdGhlIGRlY2xhcmVkIGtleS4gUGFyYW1ldGVyIFN0b3JlIG5lZWRzXG4gKiBubyBLTVMgcGVybWlzc2lvbiBmb3IgYSBTdHJpbmcgcGFyYW1ldGVyLCB3aGljaCBpcyB0aGUgdHlwZSBGUk9OVEVEIHJlcXVpcmVzLlxuICovXG5mdW5jdGlvbiBncmFudEZyb250RG9vclBhcmFtZXRlclJlYWQoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBjb25zdCBwYXJhbWV0ZXJOYW1lID0gdmVyaWZpY2F0aW9uPy5zZWNyZXRQYXJhbWV0ZXJOYW1lO1xuICBpZiAocGFyYW1ldGVyTmFtZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGhhbmRsZXIuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgIHJlc291cmNlczogW1xuICAgICAgU3RhY2sub2Yoc2NvcGUpLmZvcm1hdEFybih7XG4gICAgICAgIHNlcnZpY2U6IFwic3NtXCIsXG4gICAgICAgIHJlc291cmNlOiBcInBhcmFtZXRlclwiLFxuICAgICAgICByZXNvdXJjZU5hbWU6IHBhcmFtZXRlck5hbWUucmVwbGFjZSgvXlxcLysvLCBcIlwiKSxcbiAgICAgIH0pLFxuICAgIF0sXG4gIH0pKTtcbiAgaWYgKHZlcmlmaWNhdGlvbj8uc2VjcmV0UGFyYW1ldGVyS21zS2V5ICE9PSB1bmRlZmluZWQpIHtcbiAgICB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5LmdyYW50RGVjcnlwdChoYW5kbGVyKTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBGUk9OVEVEIGZpZWxkcyBvZiB0aGUgYGFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVgIG1hcmtlci5cbiAqXG4gKiBUaGUgbGl0ZXJhbCBmb3JtIHJlY29yZHMgdGhlIHBvc3R1cmUsIHRoZSBoZWFkZXIgbmFtZSBhbmQgYSBTSEEtMjU2IGRpZ2VzdCBvZlxuICogdGhlIGRlY2xhcmVkIHNlY3JldCwgZXhhY3RseSBhcyB2Ny4zIGRpZDsgdGhlIGxpdGVyYWwgaXMgY29uc3VtZWQgZm9yIGl0c1xuICogZGlnZXN0IG9ubHksIHNvIGl0IG5ldmVyIGxhbmRzIGluIHRoZSBzeW50aGVzaXplZCB0ZW1wbGF0ZSBvciBpblxuICogQ2xvdWRGb3JtYXRpb24uIFRoZSBwYXJhbWV0ZXIgZm9ybSByZWNvcmRzIHRoZSB3ZWxsLWtub3duIHBhcmFtZXRlciBuYW1lIGFuZFxuICogdGhhdCB0aGUgdmFsdWUgaXMgcGFyYW1ldGVyLXNvdXJjZWQgaW5zdGVhZCBvZiBhIGRpZ2VzdCwgYmVjYXVzZSB0aGVyZSBpcyBub1xuICogbGl0ZXJhbCBpbiB0aGUgYXBwbGljYXRpb24gdG8gZGlnZXN0LlxuICovXG5mdW5jdGlvbiBmcm9udERvb3JQb3N0dXJlTWV0YWRhdGEoXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGlmICh2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9yaWdpbl9yZWFjaGFiaWxpdHk6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVELFxuICAgICAgZnJvbnRfZG9vcl9oZWFkZXJfbmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsXG4gICAgICBmcm9udF9kb29yX3NlY3JldF9zb3VyY2U6IFwic3NtLXBhcmFtZXRlclwiLFxuICAgICAgZnJvbnRfZG9vcl9zZWNyZXRfcGFyYW1ldGVyX25hbWU6IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvcmlnaW5fcmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCxcbiAgICBmcm9udF9kb29yX2hlYWRlcl9uYW1lOiB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZSxcbiAgICBmcm9udF9kb29yX3NlY3JldF9zaGEyNTY6IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKFN0cmluZyh2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWUpLCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpLFxuICB9O1xufVxuXG4vKipcbiAqIEZpbmFsIHN5bnRoZXNpcyBwcm9vZiBmb3IgYW4gb3duZWQgRElTQUJMRUQgQVBJOiB0aGUgZGVmYXVsdCBleGVjdXRlLWFwaVxuICogZW5kcG9pbnQgbXVzdCBzdGlsbCBiZSBkaXNhYmxlZCBpbiB0aGUgZW1pdHRlZCB0ZW1wbGF0ZSwgZXZlbiBpZiBhIGxhdGVyIEwxXG4gKiBvdmVycmlkZSB0cmllcyB0byByZS1lbmFibGUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSA9PT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gW107XG4gICAgICB9XG4gICAgICByZXR1cm4gW1xuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkuUHJvcGVydGllcy5EaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IHRvIHJlc29sdmUgdG8gdHJ1ZVwiLFxuICAgICAgXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqXG4gKiBGaW5hbCB3aG9sZS1zdGFjayBwcm9vZiBmb3IgYW4gb3duZWQgTE9DS0VEIEFQSS5cbiAqXG4gKiBMT0NLRUQgaXMgbm90IGFuIGFsaWFzIG9mIERJU0FCTEVEOiBhdCBmaW5hbCBzeW50aGVzaXMgdGhlIGRlZmF1bHQgZW5kcG9pbnRcbiAqIG11c3Qgc3RpbGwgYmUgZGlzYWJsZWQgYW5kIGV2ZXJ5IGBDZm5BcGlNYXBwaW5nYCBib3VuZCB0byB0aGUgb3duZWQgQVBJLFxuICogaW5jbHVkaW5nIG1hcHBpbmdzIGFub3RoZXIgc2NvcGUgYWRkcyBhZnRlciBjb25zdHJ1Y3Rpb24sIG11c3QgcmVzb2x2ZSB0byBhblxuICogaW4tc3RhY2sgYENmbkRvbWFpbk5hbWVgIHdob3NlIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmVcbiAqIFVSSS4gQW4gdW5yZXNvbHZhYmxlIG1hcHBpbmcgb3IgZG9tYWluIGZhaWxzIGNsb3NlZCBpbnN0ZWFkIG9mIGNvdW50aW5nIGFzXG4gKiBldmlkZW5jZS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJPd25lZExvY2tlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSAhPT0gdHJ1ZSkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpLlByb3BlcnRpZXMuRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCB0byByZXNvbHZlIHRvIHRydWVcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1hcHBpbmdzID0gY2ZuQXBpTWFwcGluZ3NCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKG1hcHBpbmdzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhdCBsZWFzdCBvbmUgQVdTOjpBcGlHYXRld2F5VjI6OkFwaU1hcHBpbmcgYm91bmQgdG8gdGhlIG93bmVkIEFQSVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgZG9tYWlucyA9IGNmbkRvbWFpbk5hbWVzKHNjb3BlKTtcbiAgICAgIGZvciAoY29uc3QgbWFwcGluZyBvZiBtYXBwaW5ncykge1xuICAgICAgICBjb25zdCBkb21haW4gPSBkb21haW5zLmZpbmQoXG4gICAgICAgICAgKGNhbmRpZGF0ZSkgPT4gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBjYW5kaWRhdGUucmVmKVxuICAgICAgICAgICAgPT09IGNvbXBhcmFibGVBcGlJZChzY29wZSwgbWFwcGluZy5kb21haW5OYW1lKSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIGNhbm5vdCByZXNvbHZlIG1hcHBpbmcgJHttYXBwaW5nLm5vZGUucGF0aH0gdG8gYW4gaW4tc3RhY2sgQVdTOjpBcGlHYXRld2F5VjI6OkRvbWFpbk5hbWU7IG11dHVhbC1UTFMgZXZpZGVuY2UgaXMgdW52ZXJpZmlhYmxlYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaGFzVHJ1c3RzdG9yZVVyaShzdGFjaywgZG9tYWluKSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBldmVyeSBtYXBwaW5nIHRvIHRhcmdldCBhIGRvbWFpbiB3aXRoIE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLlRydXN0c3RvcmVVcmkgKCR7bWFwcGluZy5ub2RlLnBhdGh9IC0+ICR7ZG9tYWluLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZXJyb3JzO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBoYXNUcnVzdHN0b3JlVXJpKHN0YWNrOiBTdGFjaywgZG9tYWluOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWUpOiBib29sZWFuIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBzdGFjay5yZXNvbHZlKGRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbik7XG4gIGlmIChyZXNvbHZlZCA9PT0gdW5kZWZpbmVkIHx8IHJlc29sdmVkID09PSBudWxsIHx8IHR5cGVvZiByZXNvbHZlZCAhPT0gXCJvYmplY3RcIikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBhdXRoZW50aWNhdGlvbiA9IHJlc29sdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCB0cnVzdHN0b3JlVXJpID0gYXV0aGVudGljYXRpb24udHJ1c3RzdG9yZVVyaSA/PyBhdXRoZW50aWNhdGlvbi5UcnVzdHN0b3JlVXJpO1xuICByZXR1cm4gdHJ1c3RzdG9yZVVyaSAhPT0gdW5kZWZpbmVkICYmIHRydXN0c3RvcmVVcmkgIT09IG51bGwgJiYgdHJ1c3RzdG9yZVVyaSAhPT0gXCJcIjtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlNYXBwaW5nYCB3aG9zZSByZXNvbHZlZCBgQXBpSWRgIGlzIHRoZSBzdXBwbGllZCBBUEkuICovXG5mdW5jdGlvbiBjZm5BcGlNYXBwaW5nc0JvdW5kVG9BcGkoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG5mdW5jdGlvbiBjZm5Eb21haW5OYW1lcyhzY29wZTogQ29uc3RydWN0KTogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuRG9tYWluTmFtZVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5Eb21haW5OYW1lKSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogRmluYWwgc3ludGhlc2lzIHByb29mIGZvciBhbiBhdHRhY2ggRElTQUJMRUQgZGVjbGFyYXRpb246IHRoZSBjb25jcmV0ZSBBUElcbiAqIG11c3QgYmluZCB0byBleGFjdGx5IG9uZSBpbi1zdGFjayBDZm5BcGkgd2hvc2UgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludFxuICogcmVzb2x2ZXMgdG8gbGl0ZXJhbCB0cnVlLiBUaGUgY29uc3RydWN0IG5ldmVyIG11dGF0ZXMgdGhlIGF0dGFjaGVkIEFQSS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJBdHRhY2hEaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgY2ZuQXBpcyA9IGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKGNmbkFwaXMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyBleGFjdGx5IG9uZSBzYW1lLXN0YWNrIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGk7IHRoZSBhdHRhY2hlZCBBUEkncyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGNhbm5vdCBiZSBwcm92ZW5cIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaXNbMF0uZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIHRoZSBhdHRhY2hlZCBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpIHRvIHNldCBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50PXRydWVcIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlgIHdob3NlIGBSZWZgIGlzIHRoZSBzdXBwbGllZCBBUEkncyBpZC4gKi9cbmZ1bmN0aW9uIGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuQXBpW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5BcGlbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuQXBpICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5yZWYpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKFxuICBkZWZlbnNlOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB8IHVuZGVmaW5lZCxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoZGVmZW5zZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlIHRvIHJlY29yZCB0aGUgb3duaW5nIEFQSSdzIGFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlY2lzaW9uc2AsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVmZW5zZS5hY2Nlc3NMb2dnaW5nICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgdG8gYmUgdHJ1ZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nOiBQYXJ0aWFsPEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zPiB8IHVuZGVmaW5lZCA9IGRlZmVuc2UudGhyb3R0bGluZztcbiAgY29uc3QgcmF0ZUxpbWl0ID0gdGhyb3R0bGluZz8ucmF0ZUxpbWl0O1xuICBjb25zdCBidXJzdExpbWl0ID0gdGhyb3R0bGluZz8uYnVyc3RMaW1pdDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KVxuICAgIHx8IChyYXRlTGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICAgfHwgIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KVxuICAgIHx8IChidXJzdExpbWl0IGFzIG51bWJlcikgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UudGhyb3R0bGluZyByYXRlTGltaXQgYW5kIGJ1cnN0TGltaXQgdG8gYmUgcG9zaXRpdmUgZmluaXRlIG51bWJlcnNgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZW5pYWxTaWduYWwoc2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyk6IHZvaWQge1xuICBpZiAoc2lnbmFsID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBkZW5pYWxTaWduYWxcIixcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwubWV0cmljTmFtZSAhPT0gdW5kZWZpbmVkICYmIHNpZ25hbC5tZXRyaWNOYW1lICE9PSBNQ1BfREVOSUFMX01FVFJJQ19OQU1FKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLm1ldHJpY05hbWUgbXVzdCBiZSAke01DUF9ERU5JQUxfTUVUUklDX05BTUV9YCxcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwuZGltZW5zaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGltZW5zaW9ucyA9IEFycmF5LmlzQXJyYXkoc2lnbmFsLmRpbWVuc2lvbnMpID8gc2lnbmFsLmRpbWVuc2lvbnMgOiBbXTtcbiAgICBjb25zdCBib3VuZGVkID0gZGltZW5zaW9ucy5sZW5ndGggPT09IE1DUF9ERU5JQUxfRElNRU5TSU9OUy5sZW5ndGhcbiAgICAgICYmIE1DUF9ERU5JQUxfRElNRU5TSU9OUy5ldmVyeShcbiAgICAgICAgKGRpbWVuc2lvbikgPT4gZGltZW5zaW9ucy5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSA9PT0gZGltZW5zaW9uKS5sZW5ndGggPT09IDEsXG4gICAgICApO1xuICAgIGlmICghYm91bmRlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwuZGltZW5zaW9ucyBtdXN0IGJlIGV4YWN0bHkgJHtKU09OLnN0cmluZ2lmeShNQ1BfREVOSUFMX0RJTUVOU0lPTlMpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTCh2YWx1ZTogc3RyaW5nLCBhbGxvd1F1ZXJ5OiBib29sZWFuLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGl0ZXJhbCA9IHZhbHVlLnRyaW0oKTtcbiAgbGV0IHBhcnNlZDogVVJMIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwobGl0ZXJhbCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFRoZSBzaGFyZWQgdmFsaWRhdGlvbiBlcnJvciBiZWxvdyBpcyB0aGUgcHVibGljIHN5bnRoZXNpcyBjb250cmFjdC5cbiAgfVxuICBpZiAoXG4gICAgIXBhcnNlZFxuICAgIHx8ICFsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eShsaXRlcmFsKVxuICAgIHx8IHBhcnNlZC5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgIHx8ICFwYXJzZWQuaG9zdG5hbWVcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8obGl0ZXJhbClcbiAgICB8fCAoIWFsbG93UXVlcnkgJiYgbGl0ZXJhbC5pbmNsdWRlcyhcIj9cIikpXG4gICAgfHwgbGl0ZXJhbC5pbmNsdWRlcyhcIiNcIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7bWVzc2FnZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0b0h0dHBNZXRob2QobWV0aG9kOiBzdHJpbmcpOiBhcGlnd3YyLkh0dHBNZXRob2Qge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJQT1NUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVDtcbiAgICBjYXNlIFwiR0VUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuR0VUO1xuICAgIGNhc2UgXCJERUxFVEVcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEU7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiB1bnN1cHBvcnRlZCBydW50aW1lIE1DUCBtZXRob2QgJHttZXRob2R9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZU51bWJlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgZ3JlYXRlciB0aGFuIHplcm9gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICByZXR1cm4gZnFkbi5lbmRzV2l0aChzdWZmaXgpID8gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCkgOiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXmh0dHBzOlxcL1xcLyhbXi8/I10rKSg/OlsvPyNdfCQpL2kuZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmICFhdXRob3JpdHkuaW5jbHVkZXMoXCIlXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8odmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXltBLVphLXpdW0EtWmEtejAtOSsuLV0qOlxcL1xcLyhbXi8/I10qKS8uZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eT8uaW5jbHVkZXMoXCJAXCIpID8/IGZhbHNlO1xufVxuIl19