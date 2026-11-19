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
const logical_name_1 = require("./private/logical-name");
const standard_logging_1 = require("./private/standard-logging");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "7.4.0" };
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
            const namingContext = props.namingContext;
            const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
            const standard = namingContext?.standardLogging === true;
            const api = new apigwv2.HttpApi(this, "Api", {
                apiName: ownedOptions.apiName ?? (namingContext && logical
                    ? namingContext.physicalName("api_http", logical).name
                    : ownedOptions.apiName),
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
                if (standard && !logical) {
                    throw new Error("AppTheoryMcpServer standard logging requires a logical name");
                }
                const logGroup = standard && namingContext && logical
                    ? new logs.LogGroup(this, "AccessLogs", {
                        logGroupName: namingContext.logGroupName(`logs/access/api/${logical}`),
                        retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                    })
                    : new logs.LogGroup(this, "AccessLogs", {
                        retention: stageOptions.accessLogRetention,
                    });
                this.accessLogGroup = logGroup;
                const cfnStage = stage.node.defaultChild;
                cfnStage.accessLogSettings = {
                    destinationArn: logGroup.logGroupArn,
                    format: standard ? (0, standard_logging_1.httpApiAccessLogFormat)() : accessLogFormat(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFFdkMsMkRBQStEO0FBQy9ELHlEQUE0RDtBQUM1RCxpRUFBa0Y7QUFFbEYsaUNBQTRDO0FBRTVDLDJDQUF1RDtBQUV2RCxNQUFNLDBCQUEwQixHQUFHLGNBQWMsQ0FBQztBQUNsRCxNQUFNLDJCQUEyQixHQUFHLGVBQWUsQ0FBQztBQUNwRCxNQUFNLDZCQUE2QixHQUFHLEdBQUcsQ0FBQztBQUMxQyxNQUFNLDhCQUE4QixHQUFHLEdBQUcsQ0FBQztBQUMzQyxNQUFNLDJCQUEyQixHQUFHLEVBQUUsQ0FBQztBQUN2QyxNQUFNLDJCQUEyQixHQUFHLHdCQUF3QixDQUFDO0FBQzdELE1BQU0sa0NBQWtDLEdBQUcsaUNBQWlDLENBQUM7QUFDN0UsTUFBTSxpQ0FBaUMsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RSxNQUFNLHNCQUFzQixHQUFHLDJCQUEyQixDQUFDO0FBQzNELE1BQU0scUJBQXFCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFFMUQsMkNBQTJDO0FBQzNDLE1BQU0sOEJBQThCLEdBQUcsc0JBQXNCLENBQUM7QUFFOUQsb0ZBQW9GO0FBQ3BGLE1BQU0seUJBQXlCLEdBQUcsMkJBQTJCLENBQUM7QUFFOUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLGlDQUFpQyxHQUFHLHVCQUF1QixDQUFDO0FBRWxFOzs7OztHQUtHO0FBQ0gsTUFBTSxvQ0FBb0MsR0FBRyxJQUFJLENBQUM7QUFD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QUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDdEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLEtBQWE7SUFDbEQsTUFBTSxTQUFTLEdBQUcsa0NBQWtDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsT0FBTyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsU0FBUyw4QkFBOEIsQ0FBQyxLQUFhO0lBQ25ELE1BQU0sU0FBUyxHQUFHLHdDQUF3QyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQsIHJldGVudGlvbkZvciB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IGJ1aWxkQ29yc1ByZWZsaWdodCB9IGZyb20gXCIuL2NvcnNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIH0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB7IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZCB9IGZyb20gXCIuL3JvdXRlLWlkc1wiO1xuXG5jb25zdCBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCA9IFwiUm91dGVBbnlSb290XCI7XG5jb25zdCBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQgPSBcIlJvdXRlQW55UHJveHlcIjtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUID0gMTAwO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUID0gMjAwO1xuY29uc3QgREVGQVVMVF9TRVNTSU9OX1RUTF9NSU5VVEVTID0gNjA7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQgPSBcIk1jcFRyYW5zcG9ydEF1dGhvcml6ZXJcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVcIjtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCA9IFwibTE3Lm1jcC10cmFuc3BvcnQtcG9zdHVyZS92MVwiO1xuY29uc3QgTUNQX0RFTklBTF9NRVRSSUNfTkFNRSA9IFwiYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZFwiO1xuY29uc3QgTUNQX0RFTklBTF9ESU1FTlNJT05TID0gW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXTtcblxuLyoqIFRoZSBmcm9udC1kb29yIGhlYWRlciBuYW1lIGFscGhhYmV0LiAqL1xuY29uc3QgRlJPTlRfRE9PUl9IRUFERVJfTkFNRV9QQVRURVJOID0gL15bQS1aYS16MC05LV17MSw2NH0kLztcblxuLyoqIFRoZSBmcm9udC1kb29yIHNlY3JldCBhbHBoYWJldDogaGVhZGVyLXZhbHVlLXNhZmUsIG5vIHdoaXRlc3BhY2Ugb3IgY29udHJvbHMuICovXG5jb25zdCBGUk9OVF9ET09SX1NFQ1JFVF9QQVRURVJOID0gL15bQS1aYS16MC05Ll9+LV17MzIsMTI4fSQvO1xuXG4vKipcbiAqIEEgd2VsbC1rbm93biBTU00gcGFyYW1ldGVyIG5hbWUsIGluIHRoZSBhbHBoYWJldCBhIENsb3VkRm9ybWF0aW9uIGBzc21gXG4gKiBkeW5hbWljIHJlZmVyZW5jZSBhY2NlcHRzLlxuICpcbiAqIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BV1NDbG91ZEZvcm1hdGlvbi9sYXRlc3QvVXNlckd1aWRlL2R5bmFtaWMtcmVmZXJlbmNlcy1zc20uaHRtbFxuICovXG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX1BBVFRFUk4gPSAvXlxcL1tBLVphLXowLTlfLlxcLS9dKyQvO1xuXG4vKipcbiAqIFRoZSBTU00gcGFyYW1ldGVyLW5hbWUgbGltaXRzOiAxMDExIGNoYXJhY3RlcnMgaW5jbHVkaW5nIHRoZSBBUk4gcHJlZml4LCBhXG4gKiBmaWZ0ZWVuLWxldmVsIGhpZXJhcmNoeSwgYW5kIG5vIGBhd3NgL2Bzc21gIHByZWZpeC5cbiAqXG4gKiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vc3lzdGVtcy1tYW5hZ2VyL2xhdGVzdC9BUElSZWZlcmVuY2UvQVBJX1B1dFBhcmFtZXRlci5odG1sXG4gKi9cbmNvbnN0IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFTkdUSCA9IDEwMTE7XG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRVZFTFMgPSAxNTtcblxuLyoqXG4gKiBSZXF1ZXN0IGhlYWRlcnMgYSBmcm9udCBkb29yIGNhbiBuZXZlciBjYXJyeSB0aGUgdmVyaWZpY2F0aW9uIGluOiB0aGV5IGVpdGhlclxuICogcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3Qgb3IgYXJlIHBsYXRmb3JtLW1hbmFnZWQsIHNvIGEgZGVjbGFyZWRcbiAqIHZhbHVlIGNvdWxkIG5vdCBiZSB2ZXJpZmllZCB0aGUgd2F5IHRoZSBydW50aW1lIHJlYWRzIGl0LlxuICovXG5jb25zdCBSRVNFUlZFRF9GUk9OVF9ET09SX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cblxuLyoqIFJvdXRlLWVtaXNzaW9uIG1vZGVsIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgLyoqXG4gICAqIE9uZSBBUEkgR2F0ZXdheSBIVFRQIEFQSSB2MiByb3V0ZSBwZXIgZGVyaXZlZCByb3V0ZSBrZXkuIFRoaXMgaXMgdGhlXG4gICAqIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3IgZGVwbG95ZWRcbiAgICogc3RhY2tzLCBzbyBhIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgdXBncmFkZSBkZXBsb3lzIGluIHBsYWNlLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIEVYUExJQ0lUID0gXCJleHBsaWNpdFwiLFxuICAvKipcbiAgICogVHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCwgYmFja2VkIGJ5IG9uZSBzaGFyZWRcbiAgICogaW50ZWdyYXRpb24uIFRoZSBBcHBUaGVvcnkgcnVudGltZSByb3V0ZXIgcGVyZm9ybXMgbWV0aG9kIGFuZCBwYXRoXG4gICAqIGRpc3BhdGNoLCBwYXRoLXBhcmFtZXRlciBjYXB0dXJlLCBhbmQgZGVuaWFsLiBDb25zb2xpZGF0aW9uIG5ldmVyIGNoYW5nZXNcbiAgICogZ2F0ZXdheSBhZG1pc3Npb24sIHNvIGl0IGlzIHZhbGlkIG9ubHkgd2hlbiBldmVyeSBnYXRld2F5IHJvdXRlIGlzIGBOT05FYDpcbiAgICogdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0IHBvc3R1cmVzLiBgaWFtYCBhbmQgYGp3dGBcbiAgICogYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzIHRpbWUuXG4gICAqL1xuICBDT05TT0xJREFURUQgPSBcImNvbnNvbGlkYXRlZFwiLFxufVxuXG4vKiogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgLyoqXG4gICAqIFBvc2l0aW9uYWwgaWRzIChgUm91dGUwYCwgYFJvdXRlMWAsIC4uLikgYXNzaWduZWQgaW4gZW1pc3Npb24gb3JkZXIuIFRoaXNcbiAgICogaXMgdGhlIGNvbnN0cnVjdCdzIGhpc3RvcmljYWwgaW52ZW50b3J5IGFuZCBzdGF5cyBieXRlLWlkZW50aWNhbCBmb3JcbiAgICogZGVwbG95ZWQgc3RhY2tzLiBUaGUgZGVmYXVsdC5cbiAgICovXG4gIExFR0FDWSA9IFwibGVnYWN5XCIsXG4gIC8qKlxuICAgKiBJZHMgZGVyaXZlZCBmcm9tIHRoZSByb3V0ZSBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yXG4gICAqIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHkgbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGUuIEludGVuZGVkIGZvclxuICAgKiBuZXdseSBjcmVhdGVkIGV4cGxpY2l0IEFQSXM6IHN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUElcbiAgICogZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUsIHdoaWNoIGlzIGl0c2VsZiBhXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIGNvbGxpc2lvbi4gQWRvcHQgaXQgb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoXG4gICAqIHRoZSBuZXctQVBJIHN3YXAgZGVzY3JpYmVkIGluIGBVUEdSQURJTkcubWRgLlxuICAgKi9cbiAgU0VNQU5USUMgPSBcInNlbWFudGljXCIsXG59XG5cbi8qKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBBcHBUaGVvcnlNY3BTZXJ2ZXIuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gVGhlIGRlZmF1bHQgZm9yIGEgc2VydmVyIHdpdGggbm8gZmFjYWRlIGF0dGFjaG1lbnQuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBBIHN0YXRpYyBKV1QgYXV0aG9yaXplciAoaXNzdWVyICsgYXVkaWVuY2UpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiAqL1xuICBKV1QgPSBcImp3dFwiLFxuICAvKiogVGhlIGdhdGV3YXkgYXV0aG9yaXplciBpcyBOT05FIGFuZCB0aGUgcnVudGltZSB2YWxpZGF0ZXMgUkZDIDk3MjggYmVhcmVyIHRva2Vucy4gVGhlIGRlZmF1bHQgZm9yIGEgZmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVyLiAqL1xuICBSVU5USU1FX0JFQVJFUiA9IFwicnVudGltZS1iZWFyZXJcIixcbiAgLyoqIERlbGliZXJhdGVseSBwdWJsaWMgTUNQIHNlcnZlcjogZXZlcnkgdHJhbnNwb3J0IHJvdXRlIGlzIHB1YmxpYy4gTmV2ZXIgYSBkZWZhdWx0LiAqL1xuICBOT05FX1BVQkxJQyA9IFwibm9uZS1wdWJsaWNcIixcbn1cblxuLyoqIFByZXNlbmNlLW9ubHkgc2tlbGV0b24gb2YgdGhlIHVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBzZWxlY3RzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQge1xuICAvKiogSWRlbnRpZmllcyB0aGUgdXBzdHJlYW0gYXV0aG9yaXphdGlvbiBwcm92aWRlciB0aGlzIHNlcnZlciBmcm9udHMgKGZvciBleGFtcGxlIGBhdXRoZW9yeWApLiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZSBhbmQgdXNlcyBpdHMgcHJlc2VuY2UgdG8gc2VsZWN0IHRoZSBgcnVudGltZS1iZWFyZXJgIGRlZmF1bHQuICovXG4gIHJlYWRvbmx5IHByb3ZpZGVySWQ6IHN0cmluZztcbn1cblxuLyoqIFJ1bnRpbWUtc2lkZSBkZWNsYXJhdGlvbiB0aGF0IHRoZSB0cmFuc3BvcnQgcm91dGVzIHZhbGlkYXRlIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMgYXQgcnVudGltZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zIHtcbiAgLyoqIEFzc2VydCB0aGUgcnVudGltZSByZWdpc3RlcnMgdGhlIHRyYW5zcG9ydCByb3V0ZXMgd2l0aCB0aGUgcnVudGltZS12YWxpZGF0ZWQgYmVhcmVyIHBvc3R1cmUgKEdvIGBGYWNhZGVDb25maWcuUmVxdWlyZUJlYXJlclRva2VuYCwgVFMgYHJlcXVpcmVCZWFyZXJUb2tlbk1pZGRsZXdhcmVgLCBQeXRob24gYHJlcXVpcmVfYmVhcmVyX3Rva2VuX21pZGRsZXdhcmVgKS4gTXVzdCBiZSBgdHJ1ZWAuICovXG4gIHJlYWRvbmx5IHJlcXVpcmVCZWFyZXJUb2tlbjogYm9vbGVhbjtcbn1cblxuLyoqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkge1xuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgYWR2ZXJ0aXNlIGFuIG93bmVkIG9yZGluYXJ5XG4gICAqIGN1c3RvbSBkb21haW4gYXMgdGhlIG9ubHkgTUNQIGF1dGhvcml0eS5cbiAgICovXG4gIERJU0FCTEVEID0gXCJkaXNhYmxlZFwiLFxuICAvKipcbiAgICogRGlzYWJsZSB0aGUgZXhlY3V0ZS1hcGkgZGVmYXVsdCBlbmRwb2ludCBhbmQgcmVxdWlyZSBtdXR1YWwgVExTIG9uIGV2ZXJ5XG4gICAqIGN1c3RvbSBkb21haW4gbWFwcGVkIHRvIHRoZSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBUaGUgb3duZWQgZG9tYWluJ3NcbiAgICogYG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyB0aGUgY29uY3JldGUgbG9jazsgYW4gZW51bSBhbG9uZSBvciBhblxuICAgKiBleHRlcm5hbC9hdHRhY2hlZCBmcm9udCBkb29yIG5ldmVyIHNhdGlzZmllcyBpdC5cbiAgICovXG4gIExPQ0tFRCA9IFwibG9ja2VkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIHN0YXlzIGRpcmVjdGx5IHJlYWNoYWJsZSBhdCBpdHMgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kIGlzXG4gICAqIHNlcnZlZCBvbmx5IHRocm91Z2ggYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnQgZG9vciB0aGF0IGluamVjdHNcbiAgICogYGZyb250RG9vclZlcmlmaWNhdGlvbmAgb24gZXZlcnkgb3JpZ2luIHJlcXVlc3QuXG4gICAqXG4gICAqIFRoaXMgaXMgdGhlIHBvc3R1cmUgZm9yIGFuIGFwcC1vd25lZCBkaXN0cmlidXRpb24gd2hvc2Ugb3JpZ2luIGlzIHRoZVxuICAgKiBleGVjdXRlLWFwaSBob3N0bmFtZTogdGhlIGNvbnN0cnVjdCBzZWVzIG5laXRoZXIgdGhlIGRpc3RyaWJ1dGlvbiBub3IgdGhlXG4gICAqIEFQSSdzIGVuZHBvaW50IGNvbmZpZ3VyYXRpb24sIHNvIGl0IGNhbm5vdCBwcm9kdWNlIGluLXN0YWNrIGV2aWRlbmNlIHRoZVxuICAgKiB3YXkgYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgZG8uIFZhbGlkIG9ubHkgaW4gYXR0YWNoIG1vZGUsIGFjY2VwdGVkIHdpdGhcbiAgICogYFJVTlRJTUVfQkVBUkVSYCBhbmQgYE5PTkVfUFVCTElDYCBsaWtlIHRoZSBvdGhlciBkZWNpc2lvbnMsIGFuZCBpdFxuICAgKiByZXF1aXJlcyB0aGUgbWFuZGF0b3J5IGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBgRlJPTlRFRGAgaXMgYSBkZWZlbnNlLWluLWRlcHRoIGRlY2xhcmF0aW9uIHdpdGggcnVudGltZSBlbmZvcmNlbWVudCwgbm90XG4gICAqIG11dHVhbC1UTFMgYXNzdXJhbmNlIGFuZCBub3Qgb3JpZ2luIHVucmVhY2hhYmlsaXR5LiBUaGUgZW5mb3JjZW1lbnQgaXMgdGhlXG4gICAqIHJ1bnRpbWUncyBmcm9udC1kb29yIGhlYWRlciBjaGVjayAoYG1jcGZhY2FkZS5GYWNhZGVDb25maWdgXG4gICAqIGBGcm9udERvb3JWZXJpZmljYXRpb25gIGluIEdvLCBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBpbiBUeXBlU2NyaXB0LFxuICAgKiBgZnJvbnRfZG9vcl92ZXJpZmljYXRpb25gIGluIFB5dGhvbik6IGl0IHJlZnVzZXMgZXZlcnkgZGVyaXZlZCByb3V0ZSB3aGVuXG4gICAqIHRoZSBkZWNsYXJlZCBoZWFkZXIgaXMgYWJzZW50IG9yIHdyb25nLCBhbmQgZmFpbHMgcmVnaXN0cmF0aW9uIHdoZW5cbiAgICogYEZST05URURgIGlzIGRlY2xhcmVkIHdpdGhvdXQgaXQuIEFuIHVud2lyZWQgcnVudGltZSBlbmZvcmNlcyBub3RoaW5nLlxuICAgKi9cbiAgRlJPTlRFRCA9IFwiZnJvbnRlZFwiLFxufVxuXG4vKipcbiAqIEZyb250LWRvb3IgdmVyaWZpY2F0aW9uIGZvciBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYC5cbiAqXG4gKiBBdHRhY2ggbW9kZSBtZWFucyB0aGUgZnJvbnQgZG9vciBpcyBhcHBsaWNhdGlvbi1vd25lZCwgc28gdGhlIGNvbnN0cnVjdFxuICogY2Fubm90IGluamVjdCB0aGUgaGVhZGVyIGl0c2VsZiBhbmQgY2Fubm90IG9ic2VydmUgdGhlIGRpc3RyaWJ1dGlvbi4gVGhlXG4gKiBkZWNsYXJhdGlvbiB0aGVyZWZvcmUgY2FycmllcyB0aHJlZSBpbmRlcGVuZGVudGx5IHdpcmVkIGNvcGllcyB0aGF0IG11c3QgY29tZVxuICogZnJvbSBvbmUgYXBwbGljYXRpb24tb3duZWQgY29uc3RhbnQ6IHRoaXMgcHJvcCwgdGhlIGRpc3RyaWJ1dGlvbidzIG9yaWdpblxuICogY3VzdG9tLWhlYWRlciBjb25maWd1cmF0aW9uLCBhbmQgdGhlIHJ1bnRpbWUncyBmcm9udC1kb29yIHZlcmlmaWNhdGlvblxuICogY29uZmlnLiBUaGUgY29uc3RydWN0IHByb3ZlcyBvbmx5IGl0cyBvd24gY29weS5cbiAqXG4gKiBTdXBwbHkgZXhhY3RseSBvbmUgb2YgYHNlY3JldFZhbHVlYCBhbmQgYHNlY3JldFBhcmFtZXRlck5hbWVgOlxuICpcbiAqIC0gYHNlY3JldFZhbHVlYCBpcyB0aGUgdjcuMyBsaXRlcmFsIGZvcm0uIEl0IGlzIGNvbnN1bWVkIGF0IHN5bnRoZXNpcyBmb3JcbiAqICAgdmFsaWRhdGlvbiBhbmQgdGhlIHJlY29yZGVkIFNIQS0yNTYgZGlnZXN0IG9ubHksIGFuZCBpdCBuZXZlciBsYW5kcyBpbiB0aGVcbiAqICAgY29uc3RydWN0J3Mgb3duIHN5bnRoZXNpemVkIHRlbXBsYXRlLlxuICogLSBgc2VjcmV0UGFyYW1ldGVyTmFtZWAgbmFtZXMgYSB3ZWxsLWtub3duLCBzdGFnZS1xdWFsaWZpZWQgUGFyYW1ldGVyIFN0b3JlXG4gKiAgIHBhcmFtZXRlciB0aGF0IHRoZSBhcHBsaWNhdGlvbidzIGluc3RhbGxlciBjcmVhdGVzIGlmIGFic2VudC4gVGhlIHZhbHVlXG4gKiAgIG5ldmVyIGVudGVycyB0aGUgYXBwbGljYXRpb24gc291cmNlOiB0aGUgY29uc3RydWN0IHJlbmRlcnMgdGhlIGhlYWRlciB2YWx1ZVxuICogICBhcyBhIENsb3VkRm9ybWF0aW9uIGBzc21gIGR5bmFtaWMgcmVmZXJlbmNlIGFuZCByZWNvcmRzIHRoZSBwYXJhbWV0ZXIgbmFtZVxuICogICBpbnN0ZWFkIG9mIGEgZGlnZXN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIG9yaWdpbiByZXF1ZXN0IGhlYWRlciB0aGUgZnJvbnQgZG9vciBpbmplY3RzIG9uIGV2ZXJ5IHJlcXVlc3QgaXQgc2VuZHNcbiAgICogdG8gdGhlIG9yaWdpbi5cbiAgICpcbiAgICogMSB0byA2NCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05LV1gLCBhbmQgbmV2ZXIgYSByZXF1ZXN0IGhlYWRlciB0aGF0XG4gICAqIHJld3JpdGVzIHRoZSBvcmlnaW4gY29udHJhY3QgKGBIb3N0YCwgYEF1dGhvcml6YXRpb25gLCBgQ29va2llYCxcbiAgICogYENvbnRlbnQtTGVuZ3RoYCwgYFRyYW5zZmVyLUVuY29kaW5nYCwgYENvbm5lY3Rpb25gLCBgV1dXLUF1dGhlbnRpY2F0ZWAsXG4gICAqIGBYLUZvcndhcmRlZC1Gb3JgKSwgYW55IGB4LWFtei0qYC9geC1hbXpuLSpgL2BjbG91ZGZyb250LSpgIG5hbWUsIG9yIGFcbiAgICogaG9wLWJ5LWhvcCBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgaGVhZGVyTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgbGl0ZXJhbCBzZWNyZXQgaW5qZWN0ZWQgYXMgdGhlIGZyb250LWRvb3IgaGVhZGVyIHZhbHVlLlxuICAgKlxuICAgKiAzMiB0byAxMjggY2hhcmFjdGVycyBvZiBgW0EtWmEtejAtOS5ffi1dYDogYSBoZWFkZXItdmFsdWUtc2FmZSBhbHBoYWJldFxuICAgKiB3aXRoIG5vIHdoaXRlc3BhY2UgYW5kIG5vIGNvbnRyb2wgY2hhcmFjdGVycy4gVGhlIHZhbHVlIGlzIGNvbnN1bWVkIGF0XG4gICAqIHN5bnRoZXNpcyBmb3IgdmFsaWRhdGlvbiBhbmQgdGhlIHJlY29yZGVkIFNIQS0yNTYgZGlnZXN0IG9ubHkg4oCUIHRoZSBsaXRlcmFsXG4gICAqIG5ldmVyIGxhbmRzIGluIHRoZSBjb25zdHJ1Y3QncyBzeW50aGVzaXplZCB0ZW1wbGF0ZSBvciBpbiBDbG91ZEZvcm1hdGlvbi5cbiAgICogSXQgaXMgbm90IGEgY3JlZGVudGlhbCBzdG9yZTsgcm90YXRpb24gbWVhbnMgY2hhbmdpbmcgdGhlIHZhbHVlIGFuZFxuICAgKiByZWRlcGxveWluZywgYW5kIGl0IG11c3Qgbm90IGJlIChvciBjb250YWluKSBhIHNlY3JldCB0aGF0IHByb3RlY3RzXG4gICAqIGFueXRoaW5nIGVsc2UuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYC4gUHJlZmVyIHRoZSBwYXJhbWV0ZXIgZm9ybTpcbiAgICogYSBjb21taXR0ZWQgbGl0ZXJhbCBpcyBleGFjdGx5IHdoYXQgdGhlIHBhcmFtZXRlciBmb3JtIHJlbW92ZXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0VmFsdWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSB3ZWxsLWtub3duLCBzdGFnZS1xdWFsaWZpZWQgUGFyYW1ldGVyIFN0b3JlIHBhcmFtZXRlciB0aGF0IGhvbGRzIHRoZVxuICAgKiBmcm9udC1kb29yIHNlY3JldC5cbiAgICpcbiAgICogQSBmdWxseSBxdWFsaWZpZWQgbmFtZSBmcm9tIGAvYCwgYXQgbW9zdCAxMDExIGNoYXJhY3RlcnMgYW5kIGZpZnRlZW5cbiAgICogbGV2ZWxzLCBpbiB0aGUgYFtBLVphLXowLTlfLlxcLS9dYCBhbHBoYWJldCBhIENsb3VkRm9ybWF0aW9uIGBzc21gIGR5bmFtaWNcbiAgICogcmVmZXJlbmNlIGFjY2VwdHMsIGFuZCBuZXZlciBpbiB0aGUgcmVzZXJ2ZWQgYGF3c2AvYHNzbWAgaGllcmFyY2h5LlxuICAgKlxuICAgKiBUaGUgcGFyYW1ldGVyIG11c3QgYmUgdHlwZSAqKlN0cmluZyoqLCBub3QgU2VjdXJlU3RyaW5nOiBDbG91ZEZyb250J3NcbiAgICogYE9yaWdpbkN1c3RvbUhlYWRlcnNgIHN1cHBvcnRzIHRoZSBwbGFpbnRleHQgYHNzbWAgcmVmZXJlbmNlIG9ubHksIGFuZCBBV1NcbiAgICogbGlzdHMgdGhlIHByb3BlcnRpZXMgdGhhdCBzdXBwb3J0IGBzc20tc2VjdXJlYCBleGhhdXN0aXZlbHkgKENsb3VkRnJvbnQgaXNcbiAgICogbm90IG9uZSBvZiB0aGVtKS4gVGhlIHZhbHVlIGlzIHRoZXJlZm9yZSBkZWZlbnNlLWluLWRlcHRoIGFnYWluc3QgZGlyZWN0XG4gICAqIG9yaWdpbiBhY2Nlc3MsIG5vdCBhIGNvbmZpZGVudGlhbGl0eSBjb250cm9sIOKAlCB0aGUgc2FtZSBwb3N0dXJlIGFzIHRoZVxuICAgKiBsaXRlcmFsIGZvcm0sIHdoaWNoIENsb3VkRnJvbnQgYWxyZWFkeSBleHBvc2VzIHRocm91Z2hcbiAgICogYEdldERpc3RyaWJ1dGlvbkNvbmZpZ2AuXG4gICAqXG4gICAqIGBmcm9udERvb3JPcmlnaW5IZWFkZXJgIHJlbmRlcnMgdGhlIGR5bmFtaWMgcmVmZXJlbmNlIGZvciB0aGUgZGlzdHJpYnV0aW9uXG4gICAqIHRoZSBhcHAgd2lyZXMsIGUuZy4gYHt7cmVzb2x2ZTpzc206L3RoZW9yeWNsb3VkL3Rtcy9sYWIvZnJvbnRlZC10b2tlbn19YCxcbiAgICogYW5kIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIGBzc206R2V0UGFyYW1ldGVyYCBvbiBleGFjdGx5IHRoaXMgcGFyYW1ldGVyIHRvXG4gICAqIGBoYW5kbGVyYC4gQSBzdGFjayB1cGRhdGUgcmUtcmVzb2x2ZXMgdGhlIGxhdGVzdCBwYXJhbWV0ZXIgdmVyc2lvbjsgZHJpZnRcbiAgICogZGV0ZWN0aW9uIGRvZXMgbm90IHNlZSBkeW5hbWljIHJlZmVyZW5jZXMuXG4gICAqXG4gICAqIE11dHVhbGx5IGV4Y2x1c2l2ZSB3aXRoIGBzZWNyZXRWYWx1ZWAuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0UGFyYW1ldGVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGN1c3RvbWVyIG1hbmFnZWQga2V5IHRoYXQgZW5jcnlwdHMgdGhlIHBhcmFtZXRlciB3aGVuIGl0IGlzIGFcbiAgICogU2VjdXJlU3RyaW5nLlxuICAgKlxuICAgKiBGUk9OVEVEIGNhbm5vdCB1c2UgYSBTZWN1cmVTdHJpbmcgZm9yIHRoZSBkaXN0cmlidXRpb24gaGVhZGVyIChzZWVcbiAgICogYHNlY3JldFBhcmFtZXRlck5hbWVgKSwgc28gdGhpcyBpcyBvbmx5IG1lYW5pbmdmdWwgd2hlbiB0aGUgc2FtZSB3ZWxsLWtub3duXG4gICAqIG5hbWUgaXMgYWxzbyByZWFkIGZvciBhIHB1cnBvc2Ugb3RoZXIgdGhhbiB0aGUgb3JpZ2luIGhlYWRlci4gV2hlbiBpdCBpc1xuICAgKiBzZXQgdGhlIGNvbnN0cnVjdCBncmFudHMgYGttczpEZWNyeXB0YCBvbiB0aGUga2V5IHRvIGBoYW5kbGVyYC4gTGVhdmUgaXRcbiAgICogdW5zZXQgZm9yIGEgU3RyaW5nIHBhcmFtZXRlcjogUGFyYW1ldGVyIFN0b3JlIG5lZWRzIG5vIEtNUyBwZXJtaXNzaW9uIGZvclxuICAgKiBwbGFpbnRleHQgdmFsdWVzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFBhcmFtZXRlckttc0tleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBUaGUgYXNzZXJ0aW9uIHRoYXQgdGhlIHJ1bnRpbWUgdmVyaWZpZXMgdGhlIGZyb250LWRvb3IgaGVhZGVyIG9uIGV2ZXJ5XG4gICAqIGRlcml2ZWQgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCB0aGF0IHZlcmlmaWNhdGlvbiB0byBhbiBhcHBsaWNhdGlvbi1vd25lZCBmcm9udFxuICAgKiBkb29yIG9yIGEgcnVudGltZSBpdCBkb2VzIG5vdCBvd24sIHNvIGl0IHJlZnVzZXMgdG8gc3ludGhlc2l6ZSB1bnRpbCB0aGVcbiAgICogY2FsbGVyIHJlY29yZHMgdGhhdCB0aGUgdmVyaWZpY2F0aW9uIGV4aXN0cy4gTXVzdCBiZSBgdHJ1ZWAuXG4gICAqL1xuICByZWFkb25seSBhc3NlcnRlZDogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcGxpY2F0aW9uIHdpcmVzIGludG8gaXRzIGZyb250IGRvb3IuXG4gKlxuICogYGhlYWRlclZhbHVlYCBpcyB0aGUgbGl0ZXJhbCBmb3IgdGhlIGxpdGVyYWwgZm9ybSBhbmQgYSBDbG91ZEZvcm1hdGlvblxuICogYHNzbWAgZHluYW1pYyByZWZlcmVuY2UgZm9yIHRoZSBwYXJhbWV0ZXIgZm9ybSwgc28gdGhlIHBhcmFtZXRlciB2YWx1ZSBuZXZlclxuICogZW50ZXJzIHRoZSBhcHBsaWNhdGlvbiBzb3VyY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIHtcbiAgLyoqIFRoZSBvcmlnaW4gcmVxdWVzdCBoZWFkZXIgbmFtZSB0byBzZW5kIHRvIHRoZSBvcmlnaW4uICovXG4gIHJlYWRvbmx5IGhlYWRlck5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSBoZWFkZXIgdmFsdWU6IGEgbGl0ZXJhbCwgb3IgYSBge3tyZXNvbHZlOnNzbTouLi59fWAgZHluYW1pYyByZWZlcmVuY2UuICovXG4gIHJlYWRvbmx5IGhlYWRlclZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMge1xuICAvKiogRGVuaWFsIG1ldHJpYyBuYW1lLiBNdXN0IGJlIGBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkYC4gQGRlZmF1bHQgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZCAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lPzogc3RyaW5nO1xuICAvKiogQm91bmRlZCBtZXRyaWMgZGltZW5zaW9ucy4gTXVzdCBiZSBleGFjdGx5IGBvdXRjb21lYCBhbmQgYHJvdXRlX2ZhbWlseWAuIEBkZWZhdWx0IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl0gKi9cbiAgcmVhZG9ubHkgZGltZW5zaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vKiogT3duaW5nLUFQSSBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucyB7XG4gIC8qKiBTdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdDogbnVtYmVyO1xuICAvKiogU3RhZ2UgYnVyc3QgbGltaXQuICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ6IG51bWJlcjtcbn1cblxuLyoqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIGRlZmVuc2UtaW4tZGVwdGggZGVjaXNpb25zIChyZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMge1xuICAvKiogV2hldGhlciB0aGUgb3duaW5nIEFQSSdzIHN0YWdlIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLiBNdXN0IGJlIHRydWUuICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIC8qKiBUaGUgb3duaW5nIEFQSSdzIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmc6IEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zO1xufVxuXG4vKiogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgSFRUUFMgSldUIGlzc3VlciBVUkwuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgaXNzdWVyPzogc3RyaW5nO1xuICAvKiogQWNjZXB0ZWQgSldUIGF1ZGllbmNlcy4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBhdWRpZW5jZT86IHN0cmluZ1tdO1xuICAvKiogSWRlbnRpdHkgc291cmNlcyBmb3IgdGhlIEpXVCBhdXRob3JpemVyLiBAZGVmYXVsdCBbXCIkcmVxdWVzdC5oZWFkZXIuQXV0aG9yaXphdGlvblwiXSAqL1xuICByZWFkb25seSBpZGVudGl0eVNvdXJjZT86IHN0cmluZ1tdO1xuICAvKiogSldUIGF1dGhvcml6ZXIgcmVzb3VyY2UgbmFtZS4gQGRlZmF1bHQgdGhlIGF1dGhvcml6ZXIgY29uc3RydWN0IGlkICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xufVxuXG4vKiogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zIHtcbiAgLyoqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlLCBgbWNwLmV4YW1wbGUuY29tYCkuICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlQXJuYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgQVJOLiBQcm92aWRlIHRoaXMgb3IgYGNlcnRpZmljYXRlYC4gKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGFuIGF1dG9tYXRpY2FsbHkgY3JlYXRlZCBDTkFNRSByZWNvcmQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgdHJ1c3RzdG9yZSBmb3IgdGhlIG93bmVkIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFN1cHBseWluZyB0aGlzIGlzIHRoZSBjb25jcmV0ZSBgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRGBcbiAgICogZXZpZGVuY2U6IHRoZSBjb25zdHJ1Y3QgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgYW5kXG4gICAqIHJlcXVpcmVzIGV2ZXJ5IEFQSSBtYXBwaW5nIGJvdW5kIHRvIHRoZSBvd25lZCBBUEkgdG8gdGFyZ2V0IGEgZG9tYWluIHdob3NlXG4gICAqIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmUgVVJJLiBTdXBwbHlpbmcgaXQgd2l0aCBhbnlcbiAgICogb3RoZXIgb3JpZ2luIGRlY2lzaW9uLCBvciBzZWxlY3RpbmcgYExPQ0tFRGAgd2l0aG91dCBpdCwgZmFpbHMgc3ludGhlc2lzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xufVxuXG4vKiogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIiAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIHRoZSBhY2Nlc3MgbG9nIGdyb3VwLiBWYWxpZCBvbmx5IHdoZW4gYWNjZXNzIGxvZ2dpbmdcbiAgICogaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSByYXRlIGxpbWl0IGluIHJlcXVlc3RzIHBlciBzZWNvbmQuXG4gICAqIEBkZWZhdWx0IDEwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogRGVmYXVsdC1zdGFnZSBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgMjAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqIE93bmVkLUFQSSBzcGVjaWFsaXphdGlvbiBmb3Igc3RhbmRhbG9uZSBNQ1Agc2VydmVycy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zIHtcbiAgLyoqIE9wdGlvbmFsIEFQSSBuYW1lLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIG93bmVkIGJ5IHRoaXMgY29uc3RydWN0LiAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLiBBY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWZhdWx0IG9uLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqIE9yZGVyZWQgTUNQIHJvdXRlLXBhdHRlcm4gZmFtaWx5IHdpcmVkIGFzIG9uZSBmYWNhZGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5IHtcbiAgLyoqXG4gICAqIE9yZGVyZWQgc3ludGhlc2lzLXRpbWUgTUNQIHJvdXRlIHBhdHRlcm5zLlxuICAgKlxuICAgKiBFYWNoIHNlZ21lbnQgaXMgZWl0aGVyIGEgbGl0ZXJhbCBSRkMgMzk4NiBwYXRoIHNlZ21lbnQgb3IgYSBjb21wbGV0ZVxuICAgKiBge3BhcmFtZXRlcl9uYW1lfWAgc2VnbWVudC4gQ0RLIHRva2Vucywgb3JpZ2lucywgZW1wdHkgc2VnbWVudHMsIGRvdFxuICAgKiBzZWdtZW50cywgZ3JlZWR5IHBhcmFtZXRlcnMsIGFuZCBkdXBsaWNhdGUgcGF0dGVybnMgYXJlIHJlamVjdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaXJlIHRoZSBhbGdlYnJhLWRlcml2ZWQgdW5zY29wZWQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgZGlzY292ZXJ5IHJvdXRlLlxuICAgKiBUaGUgcnVudGltZSBtdXN0IHN1cHBseSBgRmFjYWRlQ29uZmlnLlJvb3RBdXRob3JpemF0aW9uU2VydmVyYCB0b28uXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeT86IGJvb2xlYW47XG59XG5cbi8qKiBEeW5hbW9EQi1iYWNrZWQgTUNQIHNlc3Npb24tc3RhdGUgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIG5hbWUuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGF1dG8tZ2VuZXJhdGVkXG4gICAqL1xuICByZWFkb25seSB0YWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRUTCBpbiBtaW51dGVzIGZvciBzZXNzaW9uIHJlY29yZHMuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzXG4gICAqIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IDYwXG4gICAqL1xuICByZWFkb25seSB0dGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhYmxlIHJlbW92YWwgcG9saWN5LiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKiBPbmUgZGVyaXZlZCBNQ1AgT0F1dGggZmFjYWRlIHJvdXRlIGZhbWlseS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGUge1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1jcE1ldGhvZHM6IHN0cmluZ1tdO1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZVBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBEZWZlbnNpdmUgc25hcHNob3Qgb2YgdGhlIGNvbnN0cnVjdCdzIGRlcml2ZWQgZmFjYWRlIGludmVudG9yeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcm91dGVzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZVtdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY2FsbGJhY2tQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBQcm9wcyBmb3IgdGhlIEFwcFRoZW9yeU1jcFNlcnZlciBjb25zdHJ1Y3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclByb3BzIHtcbiAgLyoqIExhbWJkYSBmdW5jdGlvbiBoYW5kbGluZyB0aGUgcnVudGltZS1jb21wb3NlZCBNQ1AgZmFjYWRlLiAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciBsYXJnZSBNQ1AgZmFjYWRlIGZhbWlsaWVzIHRoYXRcbiAgICogc2hhcmUgb25lIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeVxuICAgKiBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUm91dGUtZW1pc3Npb24gbW9kZWwuXG4gICAqXG4gICAqIGBleHBsaWNpdGAgKHRoZSBkZWZhdWx0KSB3aXJlcyB0aGUgZnVsbCBkZXJpdmVkIHJvdXRlIGludmVudG9yeSBhcyBvbmUgSFRUUFxuICAgKiBBUEkgdjIgcm91dGUgcGVyIHJvdXRlIGtleSBhbmQgaXMgYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy5cbiAgICogYGNvbnNvbGlkYXRlZGAgd2lyZXMgZXhhY3RseSB0d28gZ3JlZWR5IHJvdXRlcywgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gLFxuICAgKiBhbmQgaXMgdmFsaWQgb25seSBmb3IgdGhlIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2AgdHJhbnNwb3J0XG4gICAqIHBvc3R1cmVzOyBgaWFtYCBhbmQgYGp3dGAgYXJlIHJlZnVzZWQgYXQgc3ludGhlc2lzLlxuICAgKlxuICAgKiBDb25zb2xpZGF0ZWQgbW9kZSBpcyBhbGxvd2VkIG9uIGEgY29uc3RydWN0LW93bmVkIEFQSSwgb3Igb24gYW4gYXR0YWNoZWRcbiAgICogQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZS4gXCJObyByb3V0ZXNcIiBpcyBlbmZvcmNlZCBvdmVyIHRoZVxuICAgKiB3aG9sZSBzdGFjaywgbm90IGp1c3QgdGhlIEFQSSdzIG93biBjaGlsZHJlbjogYSByb3V0ZSB3aXJlZCBvbnRvIHRoZVxuICAgKiBhdHRhY2hlZCBBUEkgZnJvbSBhbnkgc2libGluZyBjb25zdHJ1Y3Qgc2NvcGUgaXMgcmVmdXNlZCwgYmVjYXVzZSBpdCBob2xkc1xuICAgKiBhIHJvdXRlIGtleSB0aGUgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGguXG4gICAqXG4gICAqIEEgY29uc3VtZXIgbWF5IHN0aWxsIGFkZCBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgdG8gdGhlIGNvbnNvbGlkYXRlZFxuICAgKiBBUEkgYWZ0ZXJ3YXJkcywgaW4gZWl0aGVyIHRoZSBhdHRhY2hlZCBvciB0aGUgY29uc3RydWN0LW93bmVkIG1vZGUuIFRoYXRcbiAgICogZXhjZXB0aW9uIGlzIGVuZm9yY2VkIGF0IHN5bnRoZXNpcyB0aW1lIGFuZCBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGUgYWRkZWRcbiAgICogcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSB0aGUgZ3JlZWR5XG4gICAqIGBBTlkgL2Agb3IgYEFOWSAve3Byb3h5K31gIGtleS4gV2l0aGluIGl0LCBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggYmVhdHMgdGhlXG4gICAqIGdyZWVkeSByb3V0ZXMgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSwgYW5kIGEgd3JvbmctbWV0aG9kIGhpdCBvbiBzdWNoIGFcbiAgICogcGF0aCBmYWxscyB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkIDQwNC80MDUuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlTW9kZWw/OiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsO1xuXG4gIC8qKlxuICAgKiBDb25zdHJ1Y3QtaWQgZGVyaXZhdGlvbiBmb3IgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsLlxuICAgKlxuICAgKiBgbGVnYWN5YCAodGhlIGRlZmF1bHQpIGFzc2lnbnMgcG9zaXRpb25hbCBpZHMgaW4gZW1pc3Npb24gb3JkZXIgYW5kIGlzXG4gICAqIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuIGBzZW1hbnRpY2AgZGVyaXZlcyBlYWNoIGlkIGZyb20gaXRzIHJvdXRlXG4gICAqIG1ldGhvZCBhbmQgcGF0dGVybiwgc28gaW5zZXJ0aW5nLCByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhIHJvdXRlIGZhbWlseVxuICAgKiBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZTsgaXQgaXMgaW50ZW5kZWQgZm9yIG5ld2x5IGNyZWF0ZWQgZXhwbGljaXRcbiAgICogQVBJcy5cbiAgICpcbiAgICogU3dpdGNoaW5nIGFuIGV4aXN0aW5nIGRlcGxveWVkIGV4cGxpY2l0IEFQSSBmcm9tIGBsZWdhY3lgIHRvIGBzZW1hbnRpY2AgaW5cbiAgICogcGxhY2UgcmVuYW1lcyBldmVyeSByb3V0ZSBpbiBvbmUgdXBkYXRlLCB3aGljaCBpcyBleGFjdGx5IHRoZVxuICAgKiBjcmVhdGUtYmVmb3JlLWRlbGV0ZSByb3V0ZS1rZXkgY29sbGlzaW9uIHRoZSBtaWdyYXRpb24gY2hlY2sgcmVmdXNlcy4gQWRvcHRcbiAgICogYHNlbWFudGljYCBvbiBhbiBleGlzdGluZyBzdGFjayBvbmx5IHRocm91Z2ggdGhlIG5ldy1BUEkgc3dhcCBkb2N1bWVudGVkIGluXG4gICAqIGBVUEdSQURJTkcubWRgLlxuICAgKlxuICAgKiBUaGlzIHByb3AgYXBwbGllcyB0byBgcm91dGVNb2RlbDogZXhwbGljaXRgIG9ubHkuIFRoZSBgY29uc29saWRhdGVkYCBtb2RlbFxuICAgKiBhbHJlYWR5IGVtaXRzIHRoZSB0d28gZml4ZWQgc2VtYW50aWMgaWRzIGBSb3V0ZUFueVJvb3RgIGFuZCBgUm91dGVBbnlQcm94eWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVJZE1vZGU/OiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZTtcblxuICAvKipcbiAgICogQ09SUyBwcmVmbGlnaHQgZm9yIGEgY29uc3RydWN0LW93bmVkIEFQSS4gU2V0IHRvIGB0cnVlYCBmb3IgQXBwVGhlb3J5XG4gICAqIGRlZmF1bHRzIG9yIHN1cHBseSBhbiBgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zYCBvYmplY3QuIEludmFsaWQgaW5cbiAgICogYXR0YWNoIG1vZGUsIHdoZXJlIHRoZSBvd25pbmcgQVBJIGNvbmZpZ3VyZXMgQ09SUy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhpc3RpbmcgSFRUUCBBUEkgdG8gYXR0YWNoIHRvLiBBdHRhY2ggbW9kZSBpcyB0aGUgcHJpbWFyeSBmcm9udC1kb29yXG4gICAqIHRvcG9sb2d5IGFuZCBuZXZlciBjcmVhdGVzIGFuIGBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpYCByZXNvdXJjZS5cbiAgICogQGRlZmF1bHQgYSBjb25zdHJ1Y3Qtb3duZWQgSHR0cEFwaVxuICAgKi9cbiAgcmVhZG9ubHkgYXBpPzogYXBpZ3d2Mi5JSHR0cEFwaTtcblxuICAvKipcbiAgICogU3RhZ2UgbmFtZSB1c2VkIHdoZW4gZGVyaXZpbmcgYXR0YWNoLW1vZGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgdGVtcGxhdGVzLlxuICAgKiBVc2UgYCRkZWZhdWx0YCBmb3IgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHQgc3RhZ2UuIFdoZW4gb21pdHRlZCwgdGhlIHN0YWdlXG4gICAqIGlzIG5vdCBkZXRlcm1pbmFibGUgYW5kIHRoZSB0ZW1wbGF0ZXMgcmV0YWluIHRoZSBiYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbi5cbiAgICogVGhpcyBwcm9wIGRvZXMgbm90IGNyZWF0ZSwgaW1wb3J0LCBvciBtdXRhdGUgYSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdHRhY2hlZEFwaVN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBHbyBgcnVudGltZS9tY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgIHNlcnZlcyBvbmx5IHRoZSBjYW5vbmljYWwgZGVmYXVsdFxuICAgKiBmYW1pbHkuIE5vbmNhbm9uaWNhbCBwYXR0ZXJucyByZXF1aXJlIGFwcC1vd25lZCBydW50aW1lIHJvdXRlIHJlZ2lzdHJhdGlvblxuICAgKiB0aGF0IG1hdGNoZXMgdGhlIGNvbnN0cnVjdCdzIGByb3V0ZUludmVudG9yeWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpXG4gICAqL1xuICByZWFkb25seSByb3V0ZUZhbWlseT86IEFwcFRoZW9yeU1jcFJvdXRlRmFtaWx5O1xuXG4gIC8qKlxuICAgKiBUcmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBBbiBleHBsaWNpdCBzZWxlY3Rpb24gb3ZlcnJpZGVzIHRoZSBmYWNhZGUtc2NvcGVkIGRlZmF1bHQuIFdoZW4gaXQgaXNcbiAgICogb21pdHRlZCwgYSBzZXJ2ZXIgdGhhdCBhdHRhY2hlcyBgZmFjYWRlYCByZXNvbHZlcyB0byBgcnVudGltZS1iZWFyZXJgIGFuZCBhXG4gICAqIHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXIgcmVzb2x2ZXMgdG8gYGlhbWAuIGBub25lLXB1YmxpY2AgaXMgbmV2ZXIgYSBkZWZhdWx0XG4gICAqIGFuZCBjYXJyaWVzIHRoZSBkZWZlbnNlLWluLWRlcHRoIGZsb29yLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSIHdoZW4gYGZhY2FkZWAgaXMgYXR0YWNoZWQsIG90aGVyd2lzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZT86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG5cbiAgLyoqXG4gICAqIFVwc3RyZWFtLXByb3ZpZGVyIGF0dGFjaG1lbnQgdGhhdCBtYXJrcyB0aGlzIHNlcnZlciBhcyBmYWNhZGUtY29uZmlndXJlZC5cbiAgICpcbiAgICogVGhlIGF0dGFjaG1lbnQncyBwcmVzZW5jZSBzZWxlY3RzIHRoZSBgcnVudGltZS1iZWFyZXJgIHBvc3R1cmUgZGVmYXVsdC5cbiAgICogUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudDtcblxuICAvKipcbiAgICogUnVudGltZS1zaWRlIFJGQyA5NzI4IGJlYXJlciB2YWxpZGF0aW9uIGRlY2xhcmF0aW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZCBieSBgdHJhbnNwb3J0UG9zdHVyZTogUlVOVElNRV9CRUFSRVJgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5XG4gICAqIG90aGVyIHBvc3R1cmUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcnVudGltZVBvc3R1cmU/OiBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZFxuICAgKiBOT05FX1BVQkxJQy4gQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIGlzIHJlZnVzZWQgdW5sZXNzIGl0IGlzIGRlY2xhcmVkXG4gICAqIGBGUk9OVEVEYCwgd2hpY2ggcmVxdWlyZXMgYGZyb250RG9vclZlcmlmaWNhdGlvbmAuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5PzogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5O1xuXG4gIC8qKlxuICAgKiBGcm9udC1kb29yIHZlcmlmaWNhdGlvbiBkZWNsYXJhdGlvbiwgcmVxdWlyZWQgd2l0aFxuICAgKiBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYCBhbmQgcmVmdXNlZCB1bmRlciBldmVyeSBvdGhlciBkZWNpc2lvbi5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCByZWNvcmRzIHRoZSBwb3N0dXJlLCB0aGUgaGVhZGVyIG5hbWUsIGFuZCBlaXRoZXIgYSBTSEEtMjU2XG4gICAqIGRpZ2VzdCBvZiB0aGUgZGVjbGFyZWQgbGl0ZXJhbCBvciB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSBpbiB0aGVcbiAgICogYGFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVgIG1ldGFkYXRhOyBpdCBuZXZlciBlbWl0cyB0aGUgc2VjcmV0XG4gICAqIHZhbHVlLiBgZnJvbnREb29yT3JpZ2luSGVhZGVyYCBpcyB0aGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcGxpY2F0aW9uXG4gICAqIHdpcmVzLCBhbmQgZm9yIHRoZSBwYXJhbWV0ZXIgZm9ybSBpdHMgdmFsdWUgaXMgYSBDbG91ZEZvcm1hdGlvbiBkeW5hbWljXG4gICAqIHJlZmVyZW5jZS4gRW5mb3JjZW1lbnQgaXMgdGhlIHJ1bnRpbWUncyBmcm9udC1kb29yIGhlYWRlciBjaGVjaywgc28gYW5cbiAgICogdW53aXJlZCBydW50aW1lIGVuZm9yY2VzIG5vdGhpbmcuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZnJvbnREb29yVmVyaWZpY2F0aW9uPzogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucztcblxuICAvKipcbiAgICogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBvbmx5LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRlbmlhbFNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEF0dGFjaC1tb2RlIHJlY29yZCBvZiB0aGUgb3duaW5nIEFQSSdzIHRocm90dGxpbmcgYW5kIGFjY2Vzcy1sb2dnaW5nXG4gICAqIGRlY2lzaW9ucywgcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kIE5PTkVfUFVCTElDLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG93bmluZ0FwaURlZmVuc2U/OiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhdGljIEpXVCBjb25maWd1cmF0aW9uIGZvciB0aGUgTUNQIHRyYW5zcG9ydCByb3V0ZXMuXG4gICAqXG4gICAqIFRyYW5zcG9ydCByb3V0ZXMgYXJlIHRoZSBQT1NULCBHRVQsIGFuZCBERUxFVEUgcm91dGVzIG9uIGV2ZXJ5IE1DUCBwYXR0ZXJuLlxuICAgKiBUaGlzIHByb3AgaXMgb25seSB2YWxpZCB3aXRoIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLCB3aGljaCByZXF1aXJlcyBhblxuICAgKiBpc3N1ZXIgYW5kIGEgbm9uLWVtcHR5IGF1ZGllbmNlLiBEaXNjb3ZlcnksIHByb3RlY3RlZC1yZXNvdXJjZSBtZXRhZGF0YSxcbiAgICogYXV0aG9yaXplLCBhbmQgdG9rZW4gcm91dGVzIHJlbWFpbiBleHBsaWNpdGx5IHB1YmxpYyAoYE5PTkVgKSBiZWNhdXNlIE9BdXRoXG4gICAqIGNsaWVudHMgbXVzdCBmZXRjaCB0aGVtIGJlZm9yZSB0aGV5IGhvbGQgYSB0b2tlbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRBdXRob3JpemVyPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0QXV0aG9yaXplck9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlLWdsb2JhbCB1cHN0cmVhbSBPQXV0aCBjYWxsYmFjayBwYXRoLlxuICAgKlxuICAgKiBUaGUgQ0RLLW1vdW50ZWQgY2FsbGJhY2sgcm91dGUgYW5kIHRoZSBydW50aW1lLXJlZ2lzdGVyZWQgb25lIG11c3Qgbm90XG4gICAqIGRpdmVyZ2U6IHRoaXMgcHJvcCBpcyByZXNvbHZlZCBieVxuICAgKiBgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoYCwgdGhlIHNhbWUgYWxnZWJyYVxuICAgKiB0aGUgcnVudGltZSBhcHBsaWVzIHRvIGBGYWNhZGVDb25maWcuVXBzdHJlYW1DYWxsYmFja1BhdGhgLiBTdXBwbHkgYVxuICAgKiBzeW50aGVzaXMtdGltZSBsaXRlcmFsIGFic29sdXRlIHBhdGggd2l0aCBubyBxdWVyeSwgZnJhZ21lbnQsIG9yIGRvdFxuICAgKiBzZWdtZW50OyBhbiBlbXB0eSB2YWx1ZSBrZWVwcyB0aGUgY29udHJhY3QgZGVmYXVsdCwgYW5kIGEgdmFsdWUgdGhhdFxuICAgKiBjb2xsaWRlcyB3aXRoIGFub3RoZXIgZGVyaXZlZCByb3V0ZSBmYWlscyBzeW50aGVzaXMuIFJlZnVzZWQgdW5kZXJcbiAgICogYHRyYW5zcG9ydFBvc3R1cmU6IG5vbmUtcHVibGljYCwgd2hpY2ggYXR0YWNoZXMgbm8gT0F1dGggc3VyZmFjZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSFxuICAgKi9cbiAgcmVhZG9ubHkgdXBzdHJlYW1DYWxsYmFja1BhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24tc3RhdGUgdGFibGUgY29uZmlndXJhdGlvbi4gVGhlIHRhYmxlIGRlZmF1bHRzIG9uLlxuICAgKiBAZGVmYXVsdCBlbmFibGVkIHdpdGggcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblN0YXRlPzogQXBwVGhlb3J5TWNwU2Vzc2lvblN0YXRlT3B0aW9ucztcblxuICAvKipcbiAgICogT3duZWQtQVBJIGNvbmZpZ3VyYXRpb24gZm9yIHN0YW5kYWxvbmUgbW9kZS4gSW52YWxpZCB3aXRoIGBhcGlgLlxuICAgKiBAZGVmYXVsdCBwcm9kdWN0aW9uLW93bmVkIEFQSSBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgb3duZWRBcGk/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNpbmdsZSBNQ1Agcm91dGUgcGF0aCBmcm9tIHRoZSB2My4xLnggQTYgc3VyZmFjZS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGByb3V0ZUZhbWlseS5wYXR0ZXJuc2AuIFRoZSBuZXcgZGVmYXVsdCBpcyB0aGUgY2Fub25pY2FsXG4gICAqIGZvdXItcGF0dGVybiBmYW1pbHk7IHVzZSBgeyBwYXR0ZXJuczogWycvbWNwJ10gfWAgZm9yIHRoZSBvbGQgc2luZ2xldG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgbWNwUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogQXV0aG9yaXphdGlvbi1zZXJ2ZXIgaXNzdWVyIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSXNzdWVyVVJMYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgaXNzdWVyIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXI/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEpXS1MgVVJJIGZyb20gdGhlIHYzLjEueCBBNiBlbnZpcm9ubWVudCBjb250cmFjdC5cbiAgICogQGRlcHJlY2F0ZWQgQ29uZmlndXJlIGBydW50aW1lL21jcGZhY2FkZS5GYWNhZGVDb25maWcuSldLU1VSSWAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIEpXS1MgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgandrc1VyaT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5hcGlOYW1lYC4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQgZm9yIHRoZSBvd25lZCBIVFRQIEFQSS5cbiAgICpcbiAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIHRoZSBhY2Nlc3MgbG9nIGdyb3VwIGlzIG5hbWVkXG4gICAqIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgYW5kIGNhcnJpZXMgdGhlIGNvbnRyYWN0J3MgSlNPTiBmaWVsZCBzZXQuXG4gICAqIEFjY2VzcyBsb2dnaW5nIGFscmVhZHkgZGVmYXVsdHMgb247IHBhc3MgYG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ2dpbmc6XG4gICAqIGZhbHNlYCB0byBvcHQgb3V0LiBBdHRhY2ggbW9kZSBpZ25vcmVzIHRoaXMgcHJvcC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIG93bmVkIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuXG4gICAqIGEgbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUuZW5hYmxlZGAuIFNlc3Npb24gc3RhdGUgbm93IGRlZmF1bHRzIG9uLlxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlPzogYm9vbGVhbjtcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudGFibGVOYW1lYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBzZXNzaW9uU3RhdGUudHRsTWludXRlc2AuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmRvbWFpbmAuIERvbWFpbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLnN0YWdlYC4gU3RhZ2Ugb3B0aW9ucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIENvbnRyYWN0LWZpcnN0IE1DUCBmYWNhZGUgZGVwbG95bWVudCBjb25zdHJ1Y3QuXG4gKlxuICogVGhlIHByaW1hcnkgbW9kZSBhdHRhY2hlcyB0aGUgY29tcGxldGUgcm91dGUtYWxnZWJyYSBmYW1pbHkgdG8gYSBzdXBwbGllZFxuICogSFRUUCBBUEkuIE9taXR0aW5nIGBhcGlgIHNwZWNpYWxpemVzIHRoZSBzYW1lIHBhdGggaW50byBhIHN0YW5kYWxvbmUgb3duZWRcbiAqIEFQSS4gVGhlIGNvbnN0cnVjdCByb3V0ZXMgb25seTogT0F1dGggbWV0YWRhdGEsIHNjb3BlcywgY2FwYWJpbGl0aWVzLCBhbmRcbiAqIGF1dGhvcml6ZS90b2tlbiBiZWhhdmlvciByZW1haW4gYXBwbGljYXRpb24tb3duZWQgdGhyb3VnaCBHb1xuICogYG1jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BTZXJ2ZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwcml2YXRlIHJvdXRlU2VxdWVuY2UgPSAwO1xuICBwcml2YXRlIHJvdXRlSWRNb2RlID0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZO1xuICBwcml2YXRlIHJlYWRvbmx5IHJvdXRlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5JSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IG93bmVkQXBpPzogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICAvKipcbiAgICogUmVzb2x2ZWQgdHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogRmFjYWRlLWNvbmZpZ3VyZWQgc2VydmVycyByZXNvbHZlIHRvIGBydW50aW1lLWJlYXJlcmAgdW5sZXNzXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlYCBvdmVycmlkZXMgdGhlIGRlZmF1bHQ7IHBsYWluIHRyYW5zcG9ydCBzZXJ2ZXJzIHJlc29sdmVcbiAgICogdG8gYGlhbWAuIERlbGliZXJhdGVseSBwdWJsaWMgc2VydmVycyBtdXN0IHNlbGVjdCBgbm9uZS1wdWJsaWNgIGV4cGxpY2l0bHkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdHJhbnNwb3J0UG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcbiAgLyoqXG4gICAqIERlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGVzIGZvciB0aGUgb3JkZXJlZCBNQ1Agcm91dGUgZmFtaWx5LlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSB0aGVzZSBhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlcywgbm90IGRlY2xhcmF0aW9ucyBvZlxuICAgKiBwdWJsaWMgYXV0aG9yaXR5LiBBbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQ7IHRoZSBvcmlnaW4gaXMgZGVyaXZlZFxuICAgKiBmcm9tIGBhcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIHBsdXNcbiAgICogYGF0dGFjaGVkQXBpU3RhZ2VOYW1lYCB3aGVuIHN1cHBsaWVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50czogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVJbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5O1xuXG4gIC8qKlxuICAgKiBGaXJzdCBkZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlLlxuICAgKlxuICAgKiBJbiBhdHRhY2ggbW9kZSBhbiBgYXBpRW5kcG9pbnRgIHN1cHBsaWVkIHRocm91Z2hcbiAgICogYEh0dHBBcGkuZnJvbUh0dHBBcGlBdHRyaWJ1dGVzYCBpcyBuZXZlciBjb25zdWx0ZWQuIFRoaXMgdmFsdWUgaXMgYW5cbiAgICogZXhlY3V0ZS1hcGkgb3JpZ2luIHRlbXBsYXRlIGRlcml2ZWQgYnkgdGhlIHNhbWUgcnVsZXMgYXMgYGVuZHBvaW50c2AsIG5vdFxuICAgKiB0aGUgZnJvbnQgZG9vcidzIHB1YmxpYyBhdXRob3JpdHkuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgZW5kcG9pbnRzYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG1jcFBhdGhzYC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGg6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNgIG9yIGByb3V0ZUludmVudG9yeWAuICovXG4gIHB1YmxpYyByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aDogc3RyaW5nO1xuXG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gY3VzdG9tIGhlYWRlciB0aGUgYXBwLW93bmVkIGZyb250IGRvb3IgbXVzdCBzZW5kIG9uIGV2ZXJ5IG9yaWdpblxuICAgKiByZXF1ZXN0LCBwcmVzZW50IG9ubHkgdW5kZXIgYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAuXG4gICAqXG4gICAqIFdpcmUgaXQgaW50byB0aGUgZGlzdHJpYnV0aW9uIG9yaWdpbjpcbiAgICogYG9yaWdpbnMuSHR0cE9yaWdpbihob3N0LCB7IGN1c3RvbUhlYWRlcnM6IHsgW2guaGVhZGVyTmFtZV06IGguaGVhZGVyVmFsdWUgfSB9KWAuXG4gICAqIFVuZGVyIHRoZSBwYXJhbWV0ZXIgZm9ybSBgaGVhZGVyVmFsdWVgIGlzIGEgYHt7cmVzb2x2ZTpzc206Li4ufX1gXG4gICAqIENsb3VkRm9ybWF0aW9uIGR5bmFtaWMgcmVmZXJlbmNlLCBzbyB0aGUgdmFsdWUgbmV2ZXIgZW50ZXJzIHRoZVxuICAgKiBhcHBsaWNhdGlvbiBzb3VyY2Ugb3IgdGhlIGNvbnN0cnVjdCdzIHRlbXBsYXRlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGZyb250RG9vck9yaWdpbkhlYWRlcj86IEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlcjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdmFsaWRhdGVPd25pbmdNb2RlKHByb3BzKTtcbiAgICBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzKTtcbiAgICBjb25zdCByb3V0ZUZhbWlseSA9IG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzKTtcbiAgICBjb25zdCBvd25lZE9wdGlvbnMgPSBub3JtYWxpemVPd25lZEFwaU9wdGlvbnMocHJvcHMpO1xuXG4gICAgY29uc3QgcG9zdHVyZSA9IHByb3BzLnRyYW5zcG9ydFBvc3R1cmVcbiAgICAgID8/IChwcm9wcy5mYWNhZGUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAgICAgOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSk7XG4gICAgdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChwcm9wcy5mYWNhZGUpO1xuICAgIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhwcm9wcywgcm91dGVGYW1pbHksIHBvc3R1cmUpO1xuICAgIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgocHJvcHMsIHBvc3R1cmUsIG93bmVkT3B0aW9ucyk7XG4gICAgY29uc3Qgb3JpZ2luUmVhY2hhYmlsaXR5ID0gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eSh0aGlzLCBwcm9wcywgb3duZWRPcHRpb25zKTtcbiAgICBpZiAob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCkge1xuICAgICAgKHRoaXMgYXMgeyBmcm9udERvb3JPcmlnaW5IZWFkZXI/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXIgfSkuZnJvbnREb29yT3JpZ2luSGVhZGVyID1cbiAgICAgICAgZnJvbnREb29yT3JpZ2luSGVhZGVyKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgICBncmFudEZyb250RG9vclBhcmFtZXRlclJlYWQodGhpcywgcHJvcHMuaGFuZGxlciwgcHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKTtcbiAgICB9XG4gICAgY29uc3Qgcm91dGVNb2RlbCA9IHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzKTtcbiAgICB2YWxpZGF0ZVJvdXRlTW9kZWxQb3N0dXJlKHJvdXRlTW9kZWwsIHBvc3R1cmUpO1xuICAgIGNvbnN0IHJvdXRlSWRNb2RlID0gcmVzb2x2ZVJvdXRlSWRNb2RlKHByb3BzKTtcbiAgICB0aGlzLnJvdXRlSWRNb2RlID0gcm91dGVJZE1vZGU7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEICYmIHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHRoaXMsIHByb3BzLmFwaSk7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCA9IHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM7XG4gICAgY29uc3QgdXBzdHJlYW1DYWxsYmFja1BhdGggPSByZXNvbHZlVXBzdHJlYW1DYWxsYmFja1BhdGgocHJvcHMpO1xuXG4gICAgdGhpcy50cmFuc3BvcnRQb3N0dXJlID0gcG9zdHVyZTtcbiAgICB0aGlzLm1jcFBhdGhzID0gWy4uLnJvdXRlRmFtaWx5LnBhdHRlcm5zXTtcbiAgICB0aGlzLnJvdXRlSW52ZW50b3J5ID0gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgICAgIHRoaXMubWNwUGF0aHMsXG4gICAgICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQsXG4gICAgICByb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSxcbiAgICAgIHVwc3RyZWFtQ2FsbGJhY2tQYXRoLFxuICAgICk7XG4gICAgdmFsaWRhdGVSb3V0ZUludmVudG9yeSh0aGlzLnJvdXRlSW52ZW50b3J5LCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzID0gdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubWFwKFxuICAgICAgKHJvdXRlKSA9PiByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sXG4gICAgKTtcbiAgICB0aGlzLm1jcFBhdGggPSB0aGlzLm1jcFBhdGhzWzBdO1xuICAgIHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGggPSB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc1swXTtcblxuICAgIGxldCBvd25lZFN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb3duZWRTdGFnZU5hbWUgPSBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHByb3BzLmFwaSkge1xuICAgICAgdGhpcy5hcGkgPSBwcm9wcy5hcGk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHN0YWdlT3B0aW9ucyA9IG5vcm1hbGl6ZVN0YWdlT3B0aW9ucyhvd25lZE9wdGlvbnMuc3RhZ2UpO1xuICAgICAgb3duZWRTdGFnZU5hbWUgPSBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lO1xuICAgICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgY29uc3Qgc3RhbmRhcmQgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgICAgYXBpTmFtZTogb3duZWRPcHRpb25zLmFwaU5hbWUgPz8gKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfaHR0cFwiLCBsb2dpY2FsKS5uYW1lXG4gICAgICAgICAgOiBvd25lZE9wdGlvbnMuYXBpTmFtZSksXG4gICAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAgICAgICA/IHRydWVcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuICAgICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24odGhpcywgYXBpKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IGFwaSxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdFbmFibGVkXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgb3duZWRTdGFnZSA9IHN0YWdlO1xuXG4gICAgICBpZiAoc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgaWYgKHN0YW5kYXJkICYmICFsb2dpY2FsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbG9nR3JvdXAgPSBzdGFuZGFyZCAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICA/IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dC5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YCksXG4gICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIDogbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdGlvbnMuYWNjZXNzTG9nUmV0ZW50aW9uLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IHN0YW5kYXJkID8gaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpIDogYWNjZXNzTG9nRm9ybWF0KCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICBcIk1jcEhhbmRsZXJcIixcbiAgICAgIHByb3BzLmhhbmRsZXIsXG4gICAgICB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgY29uc3QgdHJhbnNwb3J0QXV0aG9yaXplciA9IHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKHByb3BzLCBwb3N0dXJlKTtcbiAgICBsZXQgZmlyc3RUcmFuc3BvcnRSb3V0ZTogYXBpZ3d2Mi5IdHRwUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEKSB7XG4gICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gdGhpcy5hZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICAgICAgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQsXG4gICAgICAgIFwiL1wiLFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICk7XG4gICAgICBjb25zdCBwcm94eVJvdXRlID0gdGhpcy5hZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICAgICAgQ09OU09MSURBVEVEX1BST1hZX1JPVVRFX0lELFxuICAgICAgICBcIi97cHJveHkrfVwiLFxuICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICk7XG4gICAgICByZWdpc3RlckNvbnNvbGlkYXRlZEF0dGFjaFZhbGlkYXRpb24odGhpcywgdGhpcy5hcGksIFtmaXJzdFRyYW5zcG9ydFJvdXRlLCBwcm94eVJvdXRlXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHJ1bnRpbWVPd25lZEF1dGggPSBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2YgdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMpIHtcbiAgICAgICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykge1xuICAgICAgICAgIGNvbnN0IGNyZWF0ZWQgPSB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICAgIHJvdXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICAgICB0b0h0dHBNZXRob2QobWV0aG9kKSxcbiAgICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgICAgdHJhbnNwb3J0QXV0aG9yaXplcixcbiAgICAgICAgICApO1xuICAgICAgICAgIGZpcnN0VHJhbnNwb3J0Um91dGUgPSBmaXJzdFRyYW5zcG9ydFJvdXRlID8/IGNyZWF0ZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5kaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuYXV0aG9yaXplUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnRva2VuUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5yZWdpc3RlclBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIFRoZSB1cHN0cmVhbSBjYWxsYmFjayBpcyBzdGFnZS1nbG9iYWwsIG5vdCBwZXIga2luZDogd2lyZSBpdCBleGFjdGx5IG9uY2UuXG4gICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkuY2FsbGJhY2tQYXR0ZXJuLFxuICAgICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHBvc3R1cmVNYXJrZXJUYXJnZXQgPSAodGhpcy5vd25lZEFwaT8ubm9kZS5kZWZhdWx0Q2hpbGRcbiAgICAgID8/IGZpcnN0VHJhbnNwb3J0Um91dGU/Lm5vZGUuZGVmYXVsdENoaWxkKSBhcyBhcGlnd3YyLkNmbkFwaSB8IGFwaWd3djIuQ2ZuUm91dGUgfCB1bmRlZmluZWQ7XG4gICAgcG9zdHVyZU1hcmtlclRhcmdldD8uYWRkTWV0YWRhdGEoTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSwge1xuICAgICAgcG9zdHVyZSxcbiAgICAgIGNvbnRyYWN0X2lkOiBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQsXG4gICAgICByb3V0ZV9jb3VudDogdGhpcy5yb3V0ZUludmVudG9yeS5yb3V0ZXMubGVuZ3RoLFxuICAgICAgcnVudGltZV9wb3N0dXJlX2RlY2xhcmVkOiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgLy8gT25seSBhIEZST05URUQgZGVjaXNpb24gZXh0ZW5kcyB0aGUgbWFya2VyLCBzbyBESVNBQkxFRCBhbmQgTE9DS0VEXG4gICAgICAvLyB0ZW1wbGF0ZXMgc3RheSBieXRlLWlkZW50aWNhbC4gVGhlIGxpdGVyYWwgc2VjcmV0IGlzIGNvbnN1bWVkIGhlcmUgZm9yXG4gICAgICAvLyBpdHMgZGlnZXN0IGFuZCBuZXZlciBlbWl0dGVkLlxuICAgICAgLi4uKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgICAgICAgPyBmcm9udERvb3JQb3N0dXJlTWV0YWRhdGEocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlc3Npb25TdGF0ZSA9IG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wcyk7XG4gICAgaWYgKHNlc3Npb25TdGF0ZS5lbmFibGVkKSB7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogc2Vzc2lvblN0YXRlLnRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwic2Vzc2lvbklkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHNlc3Npb25TdGF0ZS5yZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjogeyBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGFibGU7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVEFCTEVcIiwgdGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UVExfTUlOVVRFU1wiLCBTdHJpbmcoc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXMpKTtcbiAgICB9XG5cbiAgICBsZXQgZW5kcG9pbnRCYXNlOiBzdHJpbmc7XG4gICAgaWYgKG93bmVkT3B0aW9ucy5kb21haW4pIHtcbiAgICAgIGlmICghb3duZWRTdGFnZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiBjb25maWd1cmF0aW9uIHJlcXVpcmVzIGNvbnN0cnVjdC1vd25lZCBBUEkgbW9kZVwiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ob3duZWRPcHRpb25zLmRvbWFpbiwgb3duZWRTdGFnZSk7XG4gICAgICBpZiAoXG4gICAgICAgIG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICAgICAmJiB0aGlzLm93bmVkQXBpICE9PSB1bmRlZmluZWRcbiAgICAgICkge1xuICAgICAgICByZWdpc3Rlck93bmVkTG9ja2VkT3JpZ2luVmFsaWRhdGlvbih0aGlzLCB0aGlzLm93bmVkQXBpKTtcbiAgICAgIH1cbiAgICAgIGVuZHBvaW50QmFzZSA9IGBodHRwczovLyR7b3duZWRPcHRpb25zLmRvbWFpbi5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG4gICAgICBjb25zdCBleGVjdXRlQXBpT3JpZ2luID0gYGh0dHBzOi8vJHt0aGlzLmFwaS5hcGlJZH0uZXhlY3V0ZS1hcGkuJHtzdGFjay5yZWdpb259LiR7c3RhY2sudXJsU3VmZml4fWA7XG4gICAgICBlbmRwb2ludEJhc2UgPSBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyBleGVjdXRlQXBpT3JpZ2luXG4gICAgICAgIDogYCR7ZXhlY3V0ZUFwaU9yaWdpbn0vJHtwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZX1gO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbmRwb2ludEJhc2UgPSBvd25lZFN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtvd25lZFN0YWdlTmFtZX1gO1xuICAgIH1cbiAgICB0aGlzLmVuZHBvaW50cyA9IHRoaXMubWNwUGF0aHMubWFwKFxuICAgICAgKHBhdHRlcm4pID0+IGAke3N0cmlwVHJhaWxpbmdTbGFzaChlbmRwb2ludEJhc2UpfSR7cGF0dGVybn1gLFxuICAgICk7XG4gICAgaWYgKFxuICAgICAgcHJvcHMuYXBpID09PSB1bmRlZmluZWRcbiAgICAgICYmIChvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpXG4gICAgICAmJiB0aGlzLmVuZHBvaW50cy5zb21lKChlbmRwb2ludCkgPT4gZW5kcG9pbnQuaW5jbHVkZXMoXCIuZXhlY3V0ZS1hcGkuXCIpKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIG11c3QgYWR2ZXJ0aXNlIHRoZSBvd25lZCBjdXN0b20gZG9tYWluLCBuZXZlciB0aGUgZGlzYWJsZWQgZXhlY3V0ZS1hcGkgZW5kcG9pbnRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnQgPSB0aGlzLmVuZHBvaW50c1swXTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkUnVudGltZVJvdXRlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgdGhpcy5uZXh0Um91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIG1ldGhvZCksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIG5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLnJvdXRlSWRNb2RlICE9PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5TRU1BTlRJQykge1xuICAgICAgcmV0dXJuIGBSb3V0ZSR7dGhpcy5yb3V0ZVNlcXVlbmNlKyt9YDtcbiAgICB9XG4gICAgY29uc3QgaWQgPSBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQobWV0aG9kLCBwYXRoKTtcbiAgICBpZiAodGhpcy5yb3V0ZUlkcy5oYXMoaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlSWRNb2RlIHNlbWFudGljIGRlcml2ZXMgdGhlIGR1cGxpY2F0ZSByb3V0ZSBjb25zdHJ1Y3QgaWQgJHtpZH0gZm9yIHJvdXRlIGtleSAke21ldGhvZH0gJHtwYXRofWAsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLnJvdXRlSWRzLmFkZChpZCk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICBpZDogc3RyaW5nLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgaWQsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIG10bHM6IG9wdGlvbnMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkb21haW5OYW1lO1xuICAgIGNvbnN0IGFwaU1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgZG9tYWluTmFtZSxcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gYXBpTWFwcGluZztcbiAgICBpZiAob3B0aW9ucy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCBjbmFtZVJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHRvUm91dGU1M1JlY29yZE5hbWUob3B0aW9ucy5kb21haW5OYW1lLCBvcHRpb25zLmhvc3RlZFpvbmUpLFxuICAgICAgICBkb21haW5OYW1lOiBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSBjbmFtZVJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdDogbnVtYmVyO1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIHJlYWRvbmx5IGVuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgdHRsTWludXRlczogbnVtYmVyO1xuICByZWFkb25seSByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICBpZiAocHJvcHMucm91dGVGYW1pbHkgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkgYW5kIGRlcHJlY2F0ZWQgbWNwUGF0aCBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhd1BhdHRlcm5zID0gcHJvcHMucm91dGVGYW1pbHk/LnBhdHRlcm5zXG4gICAgPz8gKHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZFxuICAgICAgPyBbcHJvcHMubWNwUGF0aF1cbiAgICAgIDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWFwKFxuICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICApKTtcbiAgaWYgKHJhd1BhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgY29uc3QgcGF0dGVybnMgPSByYXdQYXR0ZXJucy5tYXAoKHBhdHRlcm4sIGluZGV4KSA9PlxuICAgIG5vcm1hbGl6ZVJvdXRlUGF0aChwYXR0ZXJuLCBgcm91dGVGYW1pbHkucGF0dGVybnNbJHtpbmRleH1dYCkpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGlmIChzZWVuLmhhcyhwYXR0ZXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBjb250YWlucyBkdXBsaWNhdGUgcGF0dGVybiAke0pTT04uc3RyaW5naWZ5KHBhdHRlcm4pfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBzZWVuLmFkZChwYXR0ZXJuKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHBhdHRlcm5zLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OlxuICAgICAgcHJvcHMucm91dGVGYW1pbHk/LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5ID8/IGZhbHNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZVBhdGgodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0dGVybmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIik7XG4gIGlmICghcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgY29uc3Qgc2VnbWVudHMgPSByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwIHx8IHNlZ21lbnRzLnNvbWUoKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiXCIpKSB7XG4gICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIH1cbiAgY29uc3QgbGl0ZXJhbCA9IC9eKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKyQvO1xuICBjb25zdCBwYXJhbWV0ZXIgPSAvXlxceyhbQS1aYS16X11bQS1aYS16MC05X10qKVxcfSQvO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICBpZiAocGFyYW1ldGVyLnRlc3Qoc2VnbWVudCkpIGNvbnRpbnVlO1xuICAgIGlmICghbGl0ZXJhbC50ZXN0KHNlZ21lbnQpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ7XCIpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ9XCIpKSB7XG4gICAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZTogc3RyaW5nKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gYWJzb2x1dGUgc3ludGhlc2lzLXRpbWUgcm91dGUgcGF0dGVybiB3aXRoIG5vbi1lbXB0eSBsaXRlcmFsIG9yIHtwYXJhbWV0ZXJfbmFtZX0gc2VnbWVudHMgYW5kIG5vIGRvdCBzZWdtZW50c2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBzdHJpbmcge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGg7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSDtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGNvbmZpZ3VyZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdGhcIixcbiAgICApO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChjb25maWd1cmVkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgcmVhc29uID0gZXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgID8gZXJyLm1lc3NhZ2UucmVwbGFjZSgvXm1jcHJvdXRlczogLywgXCJcIilcbiAgICAgIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggaXMgaW52YWxpZDogJHtyZWFzb259YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuLFxuICBjYWxsYmFja1BhdHRlcm46IHN0cmluZyxcbik6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJvdXRlczogcGF0dGVybnMubWFwKChtY3BQYXR0ZXJuKSA9PiAoe1xuICAgICAgbWNwUGF0dGVybixcbiAgICAgIG1jcE1ldGhvZHM6IFtcIlBPU1RcIiwgXCJHRVRcIiwgXCJERUxFVEVcIl0sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgcmVnaXN0ZXJQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICB9KSksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFwiL1wiKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkLFxuICAgIGNhbGxiYWNrUGF0dGVybixcbiAgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZUludmVudG9yeShcbiAgaW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgYWRkID0gKG1ldGhvZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHttZXRob2R9ICR7cGF0aH1gO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVyaXZlZCByb3V0ZSBmYW1pbHkgY29sbGlkZXMgYXQgJHtrZXl9YCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGtleSk7XG4gIH07XG4gIGZvciAoY29uc3Qgcm91dGUgb2YgaW52ZW50b3J5LnJvdXRlcykge1xuICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIGFkZChtZXRob2QsIHJvdXRlLm1jcFBhdHRlcm4pO1xuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS50b2tlblBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS5yZWdpc3RlclBhdHRlcm4pO1xuICAgIH1cbiAgfVxuICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5jYWxsYmFja1BhdHRlcm4pO1xuICB9XG4gIGlmIChpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGlmICghcHJvcHMuYXBpKSB7XG4gICAgaWYgKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIHJlcXVpcmVzIGF0dGFjaCBtb2RlIHdpdGggYXBpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWRcbiAgICAmJiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKVxuICAgICAgfHwgIS9eKD86XFwkZGVmYXVsdHxbQS1aYS16MC05Xy1dezEsMTI4fSkkLy50ZXN0KHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIEFQSSBHYXRld2F5IHN0YWdlIG5hbWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9wcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJvd25lZEFwaVwiKTtcbiAgaWYgKHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiYXBpTmFtZVwiKTtcbiAgaWYgKHByb3BzLmNvcnMgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiY29yc1wiKTtcbiAgaWYgKHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJkb21haW5cIik7XG4gIGlmIChwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJzdGFnZVwiKTtcbiAgaWYgKGludmFsaWQubGVuZ3RoICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoIG1vZGUgd2l0aCBhcGkgY2Fubm90IGNvbmZpZ3VyZSBvd25lZC1BUEkgcHJvcHM6ICR7aW52YWxpZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgaWYgKHByb3BzLm93bmVkQXBpPy5hcGlOYW1lICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmFwaU5hbWUgYW5kIGRlcHJlY2F0ZWQgYXBpTmFtZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uZG9tYWluICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIGFuZCBkZXByZWNhdGVkIGRvbWFpbiBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2UgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIGFuZCBkZXByZWNhdGVkIHN0YWdlIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhcGlOYW1lOiBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSA/PyBwcm9wcy5hcGlOYW1lLFxuICAgIGRvbWFpbjogcHJvcHMub3duZWRBcGk/LmRvbWFpbiA/PyBwcm9wcy5kb21haW4sXG4gICAgc3RhZ2U6IHByb3BzLm93bmVkQXBpPy5zdGFnZSA/PyBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMpOiBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgY29uc3QgYWNjZXNzTG9nZ2luZyA9IG9wdGlvbnM/LmFjY2Vzc0xvZ2dpbmcgPz8gdHJ1ZTtcbiAgaWYgKCFhY2Nlc3NMb2dnaW5nICYmIG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ1JldGVudGlvbiByZXF1aXJlcyBhY2Nlc3NMb2dnaW5nIHRvIGJlIGVuYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmdFbmFibGVkID0gb3B0aW9ucz8udGhyb3R0bGluZ0VuYWJsZWQgPz8gdHJ1ZTtcbiAgaWYgKFxuICAgICF0aHJvdHRsaW5nRW5hYmxlZFxuICAgICYmIChvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIHRocm90dGxpbmcgbGltaXRzIHJlcXVpcmUgdGhyb3R0bGluZ0VuYWJsZWQgdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF0ZUxpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVDtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihyYXRlTGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ1JhdGVMaW1pdFwiKTtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihidXJzdExpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdCdXJzdExpbWl0XCIpO1xuICByZXR1cm4ge1xuICAgIHN0YWdlTmFtZTogb3B0aW9ucz8uc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIixcbiAgICBhY2Nlc3NMb2dnaW5nLFxuICAgIGFjY2Vzc0xvZ1JldGVudGlvbjogb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgdGhyb3R0bGluZ0VuYWJsZWQsXG4gICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogcmF0ZUxpbWl0LFxuICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBidXJzdExpbWl0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIGNvbnN0IGhhc0xlZ2FjeSA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZDtcbiAgaWYgKHByb3BzLnNlc3Npb25TdGF0ZSAhPT0gdW5kZWZpbmVkICYmIGhhc0xlZ2FjeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBzZXNzaW9uU3RhdGUgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggZGVwcmVjYXRlZCBzZXNzaW9uLXRhYmxlIHByb3BzXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbmFibGVkID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5lbmFibGVkID8/IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSA/PyB0cnVlO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnRhYmxlTmFtZSA/PyBwcm9wcy5zZXNzaW9uVGFibGVOYW1lO1xuICBjb25zdCB0dGxNaW51dGVzID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzXG4gICAgPz8gcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXNcbiAgICA/PyBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVM7XG4gIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gIGlmIChcbiAgICAhZW5hYmxlZFxuICAgICYmICh0YWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkaXNhYmxlZCBzZXNzaW9uIHN0YXRlIGNhbm5vdCBjb25maWd1cmUgdGFibGVOYW1lLCB0dGxNaW51dGVzLCBvciByZW1vdmFsUG9saWN5XCIsXG4gICAgKTtcbiAgfVxuICB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih0dGxNaW51dGVzLCBcInNlc3Npb25TdGF0ZS50dGxNaW51dGVzXCIpO1xuICByZXR1cm4geyBlbmFibGVkLCB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIHJlbW92YWxQb2xpY3kgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHJldHVybjtcbiAgY29uc3QgaXNzdWVyID0gU3RyaW5nKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIpO1xuICBjb25zdCBqd2tzVXJpID0gU3RyaW5nKHByb3BzLmp3a3NVcmkpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBpc3N1ZXIsXG4gICAgICBmYWxzZSxcbiAgICAgIFwiYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChqd2tzVXJpKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgandrc1VyaSxcbiAgICAgIHRydWUsXG4gICAgICBcImp3a3NVcmkgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyB1c2VyaW5mbyBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudHJhbnNwb3J0QXV0aG9yaXplcjtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiB7XG4gICAgICBpZiAoY29uZmlndXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplciBpcyBvbmx5IHZhbGlkIHdpdGggdHJhbnNwb3J0UG9zdHVyZSBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgICAgICA/IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cElhbUF1dGhvcml6ZXIoKVxuICAgICAgICA6IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgIH1cbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiB7XG4gICAgICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcoY29uZmlndXJlZD8uaXNzdWVyID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChpc3N1ZXIgPT09IFwiXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBpcyByZXF1aXJlZCB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgICAgIGlzc3VlcixcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBcInRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGF1ZGllbmNlID0gKGNvbmZpZ3VyZWQ/LmF1ZGllbmNlID8/IFtdKVxuICAgICAgICAubWFwKCh2YWx1ZSkgPT4gU3RyaW5nKHZhbHVlKS50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gXCJcIik7XG4gICAgICBpZiAoYXVkaWVuY2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5hdWRpZW5jZSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgYWNjZXB0ZWQgYXVkaWVuY2Ugd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cEp3dEF1dGhvcml6ZXIoXG4gICAgICAgIE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCxcbiAgICAgICAgaXNzdWVyLFxuICAgICAgICB7XG4gICAgICAgICAgand0QXVkaWVuY2U6IGF1ZGllbmNlLFxuICAgICAgICAgIGlkZW50aXR5U291cmNlOiBjb25maWd1cmVkPy5pZGVudGl0eVNvdXJjZSxcbiAgICAgICAgICBhdXRob3JpemVyTmFtZTogY29uZmlndXJlZD8uYXV0aG9yaXplck5hbWUsXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwb3N0dXJlTGFiZWwocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHN0cmluZyB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06IHJldHVybiBcIklBTVwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHJldHVybiBcIkpXVFwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjogcmV0dXJuIFwiUlVOVElNRV9CRUFSRVJcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHJldHVybiBcIk5PTkVfUFVCTElDXCI7XG4gICAgZGVmYXVsdDogcmV0dXJuIFN0cmluZyhwb3N0dXJlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHZvaWQge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzpcbiAgICAgIHJldHVybjtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVNb2RlbChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlTW9kZWw7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVDtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgIHx8IGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICkge1xuICAgIHJldHVybiBjb25maWd1cmVkO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVQgb3IgLkNPTlNPTElEQVRFRFwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlTW9kZWxQb3N0dXJlKFxuICByb3V0ZU1vZGVsOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICByb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRFxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIGlzIG9ubHkgdmFsaWQgZm9yIHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgb3IgTk9ORV9QVUJMSUM7IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGtlZXBzIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbCBiZWNhdXNlIGNvbnNvbGlkYXRpb24gbXVzdCBuZXZlciBjaGFuZ2UgZ2F0ZXdheSBhZG1pc3Npb25gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJvdXRlSWRNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlSWRNb2RlO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuU0VNQU5USUNcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUlkTW9kZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWSBvciAuU0VNQU5USUNcIixcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgdHdvIGdyZWVkeSByb3V0ZSBrZXlzIGEgY29uc29saWRhdGVkIG1vZGVsIG93bnMuIEEgY29uc3VtZXIgcm91dGUgdGhhdFxuICogcmVkZWNsYXJlcyBvbmUgb2YgdGhlbSB3b3VsZCBtYWtlIHRoZSBBUEkgcmVqZWN0IHRoZSB1cGRhdGUuXG4gKi9cbmNvbnN0IENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUyA9IG5ldyBTZXQoW1wiQU5ZIC9cIiwgXCJBTlkgL3twcm94eSt9XCJdKTtcblxuLyoqXG4gKiBSZXNvbHZlIGFuIGBBcGlJZGAgKG9yIGFueSB0ZW1wbGF0ZSB2YWx1ZSkgdG8gYSBjb21wYXJhYmxlIHN0cmluZywgc28gYVxuICogYFJlZmAgdG9rZW4gYW5kIGl0cyBsb2dpY2FsIGlkIGNvbXBhcmUgZXF1YWwgYWNyb3NzIHR3byB0ZW1wbGF0ZXMgb2YgdGhlIHNhbWVcbiAqIHN0YWNrLlxuICovXG5mdW5jdGlvbiBjb21wYXJhYmxlQXBpSWQoc2NvcGU6IENvbnN0cnVjdCwgdmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoU3RhY2sub2Yoc2NvcGUpLnJlc29sdmUodmFsdWUpKTtcbn1cblxuLyoqXG4gKiBFdmVyeSBBUEkgR2F0ZXdheSB2MiByb3V0ZSBib3VuZCB0byBgYXBpYCwgcmVnYXJkbGVzcyBvZiB3aGljaCBjb25zdHJ1Y3RcbiAqIHNjb3BlIGNyZWF0ZWQgaXQuXG4gKlxuICogYGFwaS5ub2RlLmNoaWxkcmVuYCBvbmx5IHNlZXMgcm91dGVzIHRoZSBBUEkgaXRzZWxmIChvciBhIGNoaWxkIHNjb3BlKVxuICogY3JlYXRlZCwgd2hpY2ggbWlzc2VzIHRoZSBjb21tb24gcGF0dGVybiBvZiBhIHN0YWNrLWxldmVsIGNvbnN0cnVjdCB3aXJpbmcgYVxuICogcm91dGUgb250byBhbiBhdHRhY2hlZCBBUEkuIFdhbGtpbmcgdGhlIHN0YWNrIGFuZCByZXNvbHZpbmcgZWFjaCBgQ2ZuUm91dGVgJ3NcbiAqIGBBcGlJZGAgc2VlcyBib3RoLlxuICovXG5mdW5jdGlvbiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuUm91dGVbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmblJvdXRlW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkh0dHBSb3V0ZSkge1xuICAgICAgaWYgKGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5odHRwQXBpLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICAgIGZvdW5kLnB1c2gobm9kZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSByb3V0ZSdzIG93biBDZm5Sb3V0ZSBjaGlsZCBpcyB0aGUgc2FtZSByb3V0ZTsgZG8gbm90IGRvdWJsZSBjb3VudC5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmblJvdXRlICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kLmZpbHRlcigocm91dGUpID0+IHJvdXRlICE9PSB1bmRlZmluZWQpO1xufVxuXG4vKipcbiAqIFJlZnVzZSBhIGNvbnNvbGlkYXRlZCBhdHRhY2ggb250byBhbiBBUEkgdGhhdCBhbHJlYWR5IGNhcnJpZXMgcm91dGVzLlxuICpcbiAqIFRoZSBjaGVjayBkZWxpYmVyYXRlbHkgd2Fsa3MgdGhlIHdob2xlIHN0YWNrOiBhIHJvdXRlIGJvdW5kIHRvIHRoZSBhdHRhY2hlZFxuICogQVBJIGZyb20gYSBzaWJsaW5nIGNvbnN0cnVjdCBzY29wZSBpcyBqdXN0IGFzIG11Y2ggYSByb3V0ZSBrZXkgdGhlXG4gKiBjb25zb2xpZGF0ZWQgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGggYXMgb25lIGNyZWF0ZWQgdW5kZXIgdGhlIEFQSVxuICogaXRzZWxmLlxuICovXG5mdW5jdGlvbiBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZ1JvdXRlcyA9IHJvdXRlc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gIGlmIChleGlzdGluZ1JvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIG1heSBhdHRhY2ggb25seSB0byBhbiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lOyBcIlxuICAgICAgKyBgdGhlIEFQSSBhbHJlYWR5IGNhcnJpZXMgJHtleGlzdGluZ1JvdXRlcy5sZW5ndGh9IHJvdXRlKHMpOiAke2V4aXN0aW5nUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUucGF0aCkuam9pbihcIiwgXCIpfTsgYFxuICAgICAgKyBcImF0dGFjaCB0byBhIG5ldyBvciBlbXB0eSBBUEksIG9yIHVzZSByb3V0ZU1vZGVsIGV4cGxpY2l0XCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBzeW50aC10aW1lIHJ1bGUgZm9yIHJvdXRlcyBhZGRlZCB0byBhIGNvbnNvbGlkYXRlZCBBUEkgYWZ0ZXJcbiAqIHRoZSBjb25zdHJ1Y3QgY3JlYXRlZCBpdHMgZ3JlZWR5IHJvdXRlcy5cbiAqXG4gKiBUaGUgcnVsZSBhcHBsaWVzIGluIGJvdGggY29uc29saWRhdGVkIG1vZGVzOiBhbiBBUEkgdGhlIGNvbnN0cnVjdCBhdHRhY2hlZFxuICogdG8sIGFuZCBvbmUgdGhlIGNvbnN0cnVjdCBvd25zLiBUaGUgZG9jdW1lbnRlZCBleGNlcHRpb24gaXMgd2hhdCBtYWtlc1xuICogY29uc29saWRhdGVkIHJvdXRlcyB1c2FibGUgaW4gYSByZWFsIGZyb250IGRvb3I6IGEgY29uc3VtZXIgbWF5IGFkZFxuICogZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIGFmdGVyd2FyZHMuIEl0IGlzIGFsbG93ZWQgb25seSB3aGVuIHRoZVxuICogcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgKHNvIHRoZSBncmVlZHkgcm91dGVzIG5ldmVyIHNpbGVudGx5XG4gKiB3aWRlbiBhIHN0cmljdGVyIHBvc3R1cmUpIGFuZCBkb2VzIG5vdCByZWRlY2xhcmUgYSBncmVlZHkgcm91dGUga2V5ICh3aGljaFxuICogQVBJIEdhdGV3YXkgd291bGQgcmVqZWN0IGFzIGEgZHVwbGljYXRlKS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJDb25zb2xpZGF0ZWRBdHRhY2hWYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4gIG93bmVkUm91dGVzOiBhcGlnd3YyLkh0dHBSb3V0ZVtdLFxuKTogdm9pZCB7XG4gIGNvbnN0IG93bmVkID0gbmV3IFNldChcbiAgICBvd25lZFJvdXRlcy5tYXAoKHJvdXRlKSA9PiByb3V0ZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKSxcbiAgKTtcbiAgU3RhY2sub2Yoc2NvcGUpLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKSkge1xuICAgICAgICBpZiAob3duZWQuaGFzKHJvdXRlKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlS2V5ID0gcm91dGUucm91dGVLZXk7XG4gICAgICAgIGlmIChDT05TT0xJREFURURfR1JFRURZX1JPVVRFX0tFWVMuaGFzKHJvdXRlS2V5KSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgYWxyZWFkeSBvd25zIHRoZSBncmVlZHkgQVBJIEdhdGV3YXkgcm91dGUga2V5ICR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfSBvbiB0aGlzIEFQSTsgYSByb3V0ZSBhZGRlZCBhZnRlciBjb25zdHJ1Y3Rpb24gbXVzdCBub3QgcmVkZWNsYXJlIGl0ICgke3JvdXRlLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25UeXBlID0gU3RyaW5nKHJvdXRlLmF1dGhvcml6YXRpb25UeXBlID8/IFwiTk9ORVwiKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblR5cGUgPT09IFwiTk9ORVwiKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhIHJvdXRlIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlciBjb25zdHJ1Y3Rpb24gbXVzdCBjYXJyeSBhIG5vbi1OT05FIGF1dGhvcml6ZXIsIGJlY2F1c2UgdGhlIGdyZWVkeSByb3V0ZXMgYWRtaXQgZXZlcnkgbWV0aG9kIGFuZCBwYXRoIGF0IHRoZSBnYXRld2F5ICgke3JvdXRlS2V5fSBmcm9tICR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBlcnJvcnM7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50KTogdm9pZCB7XG4gIGlmIChmYWNhZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBwcm92aWRlcklkID0gKGZhY2FkZSBhcyB7IHByb3ZpZGVySWQ/OiB1bmtub3duIH0pPy5wcm92aWRlcklkO1xuICBpZiAoXG4gICAgdHlwZW9mIHByb3ZpZGVySWQgIT09IFwic3RyaW5nXCJcbiAgICB8fCBwcm92aWRlcklkLnRyaW0oKSA9PT0gXCJcIlxuICAgIHx8IFRva2VuLmlzVW5yZXNvbHZlZChwcm92aWRlcklkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZmFjYWRlLnByb3ZpZGVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHN0cmluZ1wiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3N0dXJlR3VhcmRzKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHJvdXRlRmFtaWx5OiBOb3JtYWxpemVkUm91dGVGYW1pbHksXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUMpIHtcbiAgICBpZiAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkIHx8IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG9yIGp3a3NVcmlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZW5hYmxlIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgdXBzdHJlYW1DYWxsYmFja1BhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0gY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuICBvd25lZDogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyxcbik6IHZvaWQge1xuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGxhYmVsID0gcG9zdHVyZUxhYmVsKHBvc3R1cmUpO1xuICBpZiAoXG4gICAgcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIChwcm9wcy5ydW50aW1lUG9zdHVyZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLnJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiAhPT0gdHJ1ZSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgcnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICYmIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICYmIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvcmlnaW5SZWFjaGFiaWxpdHkgdG8gYmUgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVELCAuTE9DS0VELCBvciAuRlJPTlRFRGAsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UocHJvcHMub3duaW5nQXBpRGVmZW5zZSwgbGFiZWwpO1xuICB9IGVsc2Uge1xuICAgIGlmIChvd25lZC5zdGFnZT8udGhyb3R0bGluZ0VuYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhbiBleHBsaWNpdCBvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nRW5hYmxlZDogdHJ1ZSB0aHJvdHRsaW5nIGRlY2lzaW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvd25lZC5zdGFnZT8uYWNjZXNzTG9nZ2luZyA9PT0gZmFsc2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhY2Nlc3MgbG9nZ2luZ2AsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUikge1xuICAgIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHByb3BzLmRlbmlhbFNpZ25hbCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBkZWNsYXJlZCBkaXJlY3Qtb3JpZ2luIGRlY2lzaW9uIHRvIGEgcHJvdmVuIHBvc3R1cmUuXG4gKlxuICogRXZlcnkgc3VwcGxpZWQgdmFsdWUgaXMgY2hlY2tlZCwgbm90IG9ubHkgdGhlIHBvc3R1cmVzIHRoYXQgcmVxdWlyZSB0aGVcbiAqIGRlY2lzaW9uLiBESVNBQkxFRCBuZWVkcyB0aGUgb3duZWQgb3JkaW5hcnkgZG9tYWluIHRoYXQgcmVwbGFjZXMgdGhlIGRpc2FibGVkXG4gKiBleGVjdXRlLWFwaSBhdXRob3JpdHkgKG9yIGEgcHJvdmFibGUgY29uY3JldGUgYXR0YWNoKSwgYW5kIExPQ0tFRFxuICogYWRkaXRpb25hbGx5IG5lZWRzIG11dHVhbCBUTFMgb24gZXZlcnkgZG9tYWluIG1hcHBlZCB0byB0aGUgb3duZWQgQVBJLlxuICogQXR0YWNoLW1vZGUgTE9DS0VEIGlzIHVuc3VwcG9ydGVkIGJlY2F1c2UgYW4gZXh0ZXJuYWwgQVBJIGNhcnJpZXMgbm8gaW4tc3RhY2tcbiAqIHRydXN0c3RvcmUgb3IgbWFwcGluZyBldmlkZW5jZS4gRlJPTlRFRCBpcyB0aGUgYXR0YWNoLW1vZGUgY291bnRlcnBhcnQgZm9yIGFuXG4gKiBhcHBsaWNhdGlvbi1vd25lZCBmcm9udCBkb29yOiBpdCBwcm9kdWNlcyBubyBpbi1zdGFjayBldmlkZW5jZSwgc28gaXQgaXNcbiAqIGFjY2VwdGVkIG9ubHkgd2l0aCBhbiBleHBsaWNpdCwgdmFsaWRhdGVkIGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uXG4gKiBhbmQgb25seSBpbiBhdHRhY2ggbW9kZS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBvd25lZDogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyxcbik6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGRlY2lzaW9uID0gcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5O1xuICBjb25zdCBtdXR1YWxUbHMgPSBvd25lZC5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uO1xuICBpZiAoZGVjaXNpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChtdXR1YWxUbHMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URURcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKFxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IG11c3QgYmUgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVELCAuTE9DS0VELCBvciAuRlJPTlRFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG11dHVhbFRscyAhPT0gdW5kZWZpbmVkICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICAgICYmIHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEKSB7XG4gICAgaWYgKHByb3BzLmFwaSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCBpcyB1bnN1cHBvcnRlZCBpbiBvd25lZCBtb2RlOyBhbiBvd25lZCBmcm9udCBkb29yIGlzIHdpcmVkIGJ5IHRoZSBESVNBQkxFRCBvciBMT0NLRUQgcG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdmFsaWRhdGVGcm9udERvb3JWZXJpZmljYXRpb24ocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKGRlY2lzaW9uID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEKSB7XG4gICAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIGlzIHVuc3VwcG9ydGVkIGluIGF0dGFjaCBtb2RlOyBhbiBBUEkgb3duZWQgb3V0c2lkZSB0aGUgY29uc3RydWN0IGNhcnJpZXMgbm8gaW4tc3RhY2sgbXV0dWFsLVRMUyBtYXBwaW5nIGV2aWRlbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3duZWQuZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgYW4gZWZmZWN0aXZlIG93bmVkQXBpLmRvbWFpbiB3aXRoIG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAobXV0dWFsVGxzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uOyBkaXNhYmxlbWVudCBhbG9uZSBpcyB0aGUgRElTQUJMRUQgcG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghKHByb3BzLmFwaSBpbnN0YW5jZW9mIGFwaWd3djIuSHR0cEFwaSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyBhIHNhbWUtc3RhY2sgY29uY3JldGUgSHR0cEFwaTsgYW4gaW1wb3J0ZWQgQVBJIGV4cG9zZXMgbm8gRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVnaXN0ZXJBdHRhY2hEaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oc2NvcGUsIHByb3BzLmFwaSk7XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChvd25lZC5kb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgcmVxdWlyZXMgYW4gZWZmZWN0aXZlIG93bmVkQXBpLmRvbWFpbjsgdGhlIGRpc2FibGVkIGV4ZWN1dGUtYXBpIGVuZHBvaW50IGlzIG5ldmVyIGEgcHVibGljIGF1dGhvcml0eVwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGRlY2lzaW9uO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIHRoZSBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvbiBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTpcbiAqIEZST05URURgLlxuICpcbiAqIFRoZSBkZWNsYXJhdGlvbiBpcyBtYW5kYXRvcnkgYW5kIGV2ZXJ5IGZpZWxkIGlzIGNoZWNrZWQ6IGFuIGFic2VudFxuICogZGVjbGFyYXRpb24sIGEgbWlzc2luZyBvciByZXNlcnZlZCBoZWFkZXIgbmFtZSwgYSBzZWNyZXQgb3V0c2lkZSB0aGVcbiAqIGhlYWRlci12YWx1ZS1zYWZlIGFscGhhYmV0LCBhbmQgYSBtaXNzaW5nIGBhc3NlcnRlZDogdHJ1ZWAgYWxsIGZhaWwgc3ludGhlc2lzXG4gKiByYXRoZXIgdGhhbiBwcm9kdWNpbmcgYSBkZWNsYXJhdGlvbiB0aGUgcnVudGltZSBjb3VsZCBub3QgaG9ub3IuXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlRnJvbnREb29yVmVyaWZpY2F0aW9uKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBoZWFkZXJOYW1lID0gdmVyaWZpY2F0aW9uLmhlYWRlck5hbWU7XG4gIGlmICh0eXBlb2YgaGVhZGVyTmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhRlJPTlRfRE9PUl9IRUFERVJfTkFNRV9QQVRURVJOLnRlc3QoaGVhZGVyTmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLmhlYWRlck5hbWUgbXVzdCBiZSAxIHRvIDY0IGNoYXJhY3RlcnMgb2YgW0EtWmEtejAtOS1dXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkSGVhZGVyID0gaGVhZGVyTmFtZS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoXG4gICAgUkVTRVJWRURfRlJPTlRfRE9PUl9IRUFERVJTLmhhcyhub3JtYWxpemVkSGVhZGVyKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcIngtYW16LVwiKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcIngtYW16bi1cIilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJjbG91ZGZyb250LVwiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uaGVhZGVyTmFtZSAke2hlYWRlck5hbWV9IGlzIGEgcmVzZXJ2ZWQgb3IgcGxhdGZvcm0tbWFuYWdlZCByZXF1ZXN0IGhlYWRlciBhbmQgY2Fubm90IGNhcnJ5IHRoZSBmcm9udC1kb29yIHZlcmlmaWNhdGlvbmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBzZWNyZXRWYWx1ZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZTtcbiAgY29uc3Qgc2VjcmV0UGFyYW1ldGVyTmFtZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lO1xuICBjb25zdCBoYXNMaXRlcmFsID0gc2VjcmV0VmFsdWUgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzUGFyYW1ldGVyID0gc2VjcmV0UGFyYW1ldGVyTmFtZSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzTGl0ZXJhbCA9PT0gaGFzUGFyYW1ldGVyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiByZXF1aXJlcyBleGFjdGx5IG9uZSBvZiBzZWNyZXRWYWx1ZSBhbmQgc2VjcmV0UGFyYW1ldGVyTmFtZTsgc3VwcGx5IHRoZSBsaXRlcmFsLCBvciB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSB0aGUgYXBwbGljYXRpb24ncyBpbnN0YWxsZXIgY3JlYXRlc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKGhhc0xpdGVyYWwpIHtcbiAgICBpZiAodHlwZW9mIHNlY3JldFZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICFGUk9OVF9ET09SX1NFQ1JFVF9QQVRURVJOLnRlc3Qoc2VjcmV0VmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0VmFsdWUgbXVzdCBiZSAzMiB0byAxMjggY2hhcmFjdGVycyBvZiBbQS1aYS16MC05Ll9+LV1cIixcbiAgICAgICk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHZhbGlkYXRlRnJvbnREb29yUGFyYW1ldGVyTmFtZShzZWNyZXRQYXJhbWV0ZXJOYW1lKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleSAhPT0gdW5kZWZpbmVkICYmICFoYXNQYXJhbWV0ZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleSBpcyBvbmx5IHZhbGlkIHdpdGggc2VjcmV0UGFyYW1ldGVyTmFtZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHZlcmlmaWNhdGlvbi5hc3NlcnRlZCAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gcmVxdWlyZXMgYXNzZXJ0ZWQ6IHRydWUg4oCUIHRoZSBjYWxsZXIgbXVzdCByZWNvcmQgdGhhdCB0aGUgcnVudGltZSB2ZXJpZmllcyB0aGUgZnJvbnQtZG9vciBoZWFkZXIgb24gZXZlcnkgZGVyaXZlZCByb3V0ZVwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHdlbGwta25vd24gZnJvbnQtZG9vciBwYXJhbWV0ZXIgbmFtZS5cbiAqXG4gKiBUaGUgbmFtZSBtdXN0IGJlIGV4cHJlc3NpYmxlIGluIGEgQ2xvdWRGb3JtYXRpb24gYHNzbWAgZHluYW1pYyByZWZlcmVuY2UgYW5kXG4gKiBhY2NlcHRhYmxlIHRvIFBhcmFtZXRlciBTdG9yZSwgYmVjYXVzZSB0aGUgY29uc3RydWN0IHJlbmRlcnMgdGhlIHJlZmVyZW5jZSBhbmRcbiAqIGdyYW50cyBvbiB0aGUgQVJOLiBBIG5hbWUgb3V0c2lkZSBlaXRoZXIgY29udHJhY3Qgd291bGQgZmFpbCBhdCBkZXBsb3kgdGltZSxcbiAqIHNvIGl0IGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUZyb250RG9vclBhcmFtZXRlck5hbWUobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGlmIChcbiAgICB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IG5hbWUubGVuZ3RoID4gRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVOR1RIXG4gICAgfHwgIUZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfUEFUVEVSTi50ZXN0KG5hbWUpXG4gICAgfHwgbmFtZS5lbmRzV2l0aChcIi9cIilcbiAgICB8fCBuYW1lLmluY2x1ZGVzKFwiLy9cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3QgYmUgYSBmdWxseSBxdWFsaWZpZWQgU1NNIHBhcmFtZXRlciBuYW1lIGZyb20gJy8nLCBhdCBtb3N0IDEwMTEgY2hhcmFjdGVycywgb2YgW0EtWmEtejAtOV8uLS9dIHdpdGggbm8gZW1wdHkgc2VnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbGV2ZWxzID0gbmFtZS5zcGxpdChcIi9cIikuZmlsdGVyKChzZWdtZW50KSA9PiBzZWdtZW50Lmxlbmd0aCA+IDApO1xuICBjb25zdCBmaXJzdCA9IGxldmVsc1swXT8udG9Mb3dlckNhc2UoKTtcbiAgaWYgKGxldmVscy5sZW5ndGggPT09IDAgfHwgbGV2ZWxzLmxlbmd0aCA+IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFVkVMUykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSBtdXN0IGhhdmUgYmV0d2VlbiBvbmUgYW5kIGZpZnRlZW4gaGllcmFyY2h5IGxldmVsc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZpcnN0ID09PSBcImF3c1wiIHx8IGZpcnN0ID09PSBcInNzbVwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3Qgbm90IHVzZSB0aGUgcmVzZXJ2ZWQgYXdzIG9yIHNzbSBoaWVyYXJjaHlcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogVGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHAtb3duZWQgZnJvbnQgZG9vciBtdXN0IHNlbmQuXG4gKlxuICogVGhlIHBhcmFtZXRlciBmb3JtIHJlbmRlcnMgdGhlIENsb3VkRm9ybWF0aW9uIGR5bmFtaWMgcmVmZXJlbmNlIHRoZVxuICogZGlzdHJpYnV0aW9uIHByb3BlcnR5IGFjY2VwdHMsIHNvIHRoZSB2YWx1ZSBpcyByZXNvbHZlZCBieSBDbG91ZEZvcm1hdGlvbiBhdFxuICogc3RhY2sgY3JlYXRlL3VwZGF0ZSB0aW1lIGFuZCBuZXZlciBhcHBlYXJzIGluIHRoZSBhcHBsaWNhdGlvbiBzb3VyY2Ugb3IgdGhpc1xuICogY29uc3RydWN0J3MgdGVtcGxhdGUuXG4gKi9cbmZ1bmN0aW9uIGZyb250RG9vck9yaWdpbkhlYWRlcihcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBoZWFkZXJWYWx1ZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lICE9PSB1bmRlZmluZWRcbiAgICA/IGB7e3Jlc29sdmU6c3NtOiR7dmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWV9fX1gXG4gICAgOiBTdHJpbmcodmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlKTtcbiAgcmV0dXJuIHsgaGVhZGVyTmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsIGhlYWRlclZhbHVlIH07XG59XG5cbi8qKlxuICogR3JhbnQgdGhlIHJ1bnRpbWUgZnVuY3Rpb24gcmVhZCBhY2Nlc3MgdG8gdGhlIHdlbGwta25vd24gZnJvbnQtZG9vciBwYXJhbWV0ZXIuXG4gKlxuICogUGFyYW1ldGVyIFN0b3JlIHJlc29sdmVzIHRoZSBkaXN0cmlidXRpb24ncyBkeW5hbWljIHJlZmVyZW5jZSB3aXRoIHRoZVxuICogZGVwbG95aW5nIHByaW5jaXBhbCdzIHBlcm1pc3Npb25zLCBzbyB0aGlzIGdyYW50IHNlcnZlcyB0aGUgcnVudGltZSdzIGxhenlcbiAqIHJlYWQ6IGBzc206R2V0UGFyYW1ldGVyYCBvbiBleGFjdGx5IHRoYXQgcGFyYW1ldGVyIEFSTiAobmV2ZXIgYSB3aWxkY2FyZCkgYW5kLFxuICogZm9yIGEgU2VjdXJlU3RyaW5nLCBga21zOkRlY3J5cHRgIG9uIHRoZSBkZWNsYXJlZCBrZXkuIFBhcmFtZXRlciBTdG9yZSBuZWVkc1xuICogbm8gS01TIHBlcm1pc3Npb24gZm9yIGEgU3RyaW5nIHBhcmFtZXRlciwgd2hpY2ggaXMgdGhlIHR5cGUgRlJPTlRFRCByZXF1aXJlcy5cbiAqL1xuZnVuY3Rpb24gZ3JhbnRGcm9udERvb3JQYXJhbWV0ZXJSZWFkKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgcGFyYW1ldGVyTmFtZSA9IHZlcmlmaWNhdGlvbj8uc2VjcmV0UGFyYW1ldGVyTmFtZTtcbiAgaWYgKHBhcmFtZXRlck5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBoYW5kbGVyLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICByZXNvdXJjZXM6IFtcbiAgICAgIFN0YWNrLm9mKHNjb3BlKS5mb3JtYXRBcm4oe1xuICAgICAgICBzZXJ2aWNlOiBcInNzbVwiLFxuICAgICAgICByZXNvdXJjZTogXCJwYXJhbWV0ZXJcIixcbiAgICAgICAgcmVzb3VyY2VOYW1lOiBwYXJhbWV0ZXJOYW1lLnJlcGxhY2UoL15cXC8rLywgXCJcIiksXG4gICAgICB9KSxcbiAgICBdLFxuICB9KSk7XG4gIGlmICh2ZXJpZmljYXRpb24/LnNlY3JldFBhcmFtZXRlckttc0tleSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleS5ncmFudERlY3J5cHQoaGFuZGxlcik7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgRlJPTlRFRCBmaWVsZHMgb2YgdGhlIGBhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlYCBtYXJrZXIuXG4gKlxuICogVGhlIGxpdGVyYWwgZm9ybSByZWNvcmRzIHRoZSBwb3N0dXJlLCB0aGUgaGVhZGVyIG5hbWUgYW5kIGEgU0hBLTI1NiBkaWdlc3Qgb2ZcbiAqIHRoZSBkZWNsYXJlZCBzZWNyZXQsIGV4YWN0bHkgYXMgdjcuMyBkaWQ7IHRoZSBsaXRlcmFsIGlzIGNvbnN1bWVkIGZvciBpdHNcbiAqIGRpZ2VzdCBvbmx5LCBzbyBpdCBuZXZlciBsYW5kcyBpbiB0aGUgc3ludGhlc2l6ZWQgdGVtcGxhdGUgb3IgaW5cbiAqIENsb3VkRm9ybWF0aW9uLiBUaGUgcGFyYW1ldGVyIGZvcm0gcmVjb3JkcyB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSBhbmRcbiAqIHRoYXQgdGhlIHZhbHVlIGlzIHBhcmFtZXRlci1zb3VyY2VkIGluc3RlYWQgb2YgYSBkaWdlc3QsIGJlY2F1c2UgdGhlcmUgaXMgbm9cbiAqIGxpdGVyYWwgaW4gdGhlIGFwcGxpY2F0aW9uIHRvIGRpZ2VzdC5cbiAqL1xuZnVuY3Rpb24gZnJvbnREb29yUG9zdHVyZU1ldGFkYXRhKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvcmlnaW5fcmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCxcbiAgICAgIGZyb250X2Rvb3JfaGVhZGVyX25hbWU6IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lLFxuICAgICAgZnJvbnRfZG9vcl9zZWNyZXRfc291cmNlOiBcInNzbS1wYXJhbWV0ZXJcIixcbiAgICAgIGZyb250X2Rvb3Jfc2VjcmV0X3BhcmFtZXRlcl9uYW1lOiB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb3JpZ2luX3JlYWNoYWJpbGl0eTogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQsXG4gICAgZnJvbnRfZG9vcl9oZWFkZXJfbmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsXG4gICAgZnJvbnRfZG9vcl9zZWNyZXRfc2hhMjU2OiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShTdHJpbmcodmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlKSwgXCJ1dGY4XCIpLmRpZ2VzdChcImhleFwiKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBGaW5hbCBzeW50aGVzaXMgcHJvb2YgZm9yIGFuIG93bmVkIERJU0FCTEVEIEFQSTogdGhlIGRlZmF1bHQgZXhlY3V0ZS1hcGlcbiAqIGVuZHBvaW50IG11c3Qgc3RpbGwgYmUgZGlzYWJsZWQgaW4gdGhlIGVtaXR0ZWQgdGVtcGxhdGUsIGV2ZW4gaWYgYSBsYXRlciBMMVxuICogb3ZlcnJpZGUgdHJpZXMgdG8gcmUtZW5hYmxlIGl0LlxuICovXG5mdW5jdGlvbiByZWdpc3Rlck93bmVkRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgY2ZuQXBpID0gYXBpLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuQXBpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGkuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgPT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpLlByb3BlcnRpZXMuRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCB0byByZXNvbHZlIHRvIHRydWVcIixcbiAgICAgIF07XG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKlxuICogRmluYWwgd2hvbGUtc3RhY2sgcHJvb2YgZm9yIGFuIG93bmVkIExPQ0tFRCBBUEkuXG4gKlxuICogTE9DS0VEIGlzIG5vdCBhbiBhbGlhcyBvZiBESVNBQkxFRDogYXQgZmluYWwgc3ludGhlc2lzIHRoZSBkZWZhdWx0IGVuZHBvaW50XG4gKiBtdXN0IHN0aWxsIGJlIGRpc2FibGVkIGFuZCBldmVyeSBgQ2ZuQXBpTWFwcGluZ2AgYm91bmQgdG8gdGhlIG93bmVkIEFQSSxcbiAqIGluY2x1ZGluZyBtYXBwaW5ncyBhbm90aGVyIHNjb3BlIGFkZHMgYWZ0ZXIgY29uc3RydWN0aW9uLCBtdXN0IHJlc29sdmUgdG8gYW5cbiAqIGluLXN0YWNrIGBDZm5Eb21haW5OYW1lYCB3aG9zZSBgTXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGNhcnJpZXMgYSB0cnVzdHN0b3JlXG4gKiBVUkkuIEFuIHVucmVzb2x2YWJsZSBtYXBwaW5nIG9yIGRvbWFpbiBmYWlscyBjbG9zZWQgaW5zdGVhZCBvZiBjb3VudGluZyBhc1xuICogZXZpZGVuY2UuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgY2ZuQXBpID0gYXBpLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuQXBpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGkuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgIT09IHRydWUpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgQVdTOjpBcGlHYXRld2F5VjI6OkFwaS5Qcm9wZXJ0aWVzLkRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgdG8gcmVzb2x2ZSB0byB0cnVlXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBtYXBwaW5ncyA9IGNmbkFwaU1hcHBpbmdzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgICAgIGlmIChtYXBwaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlNYXBwaW5nIGJvdW5kIHRvIHRoZSBvd25lZCBBUElcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRvbWFpbnMgPSBjZm5Eb21haW5OYW1lcyhzY29wZSk7XG4gICAgICBmb3IgKGNvbnN0IG1hcHBpbmcgb2YgbWFwcGluZ3MpIHtcbiAgICAgICAgY29uc3QgZG9tYWluID0gZG9tYWlucy5maW5kKFxuICAgICAgICAgIChjYW5kaWRhdGUpID0+IGNvbXBhcmFibGVBcGlJZChzY29wZSwgY2FuZGlkYXRlLnJlZilcbiAgICAgICAgICAgID09PSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG1hcHBpbmcuZG9tYWluTmFtZSksXG4gICAgICAgICk7XG4gICAgICAgIGlmIChkb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCBjYW5ub3QgcmVzb2x2ZSBtYXBwaW5nICR7bWFwcGluZy5ub2RlLnBhdGh9IHRvIGFuIGluLXN0YWNrIEFXUzo6QXBpR2F0ZXdheVYyOjpEb21haW5OYW1lOyBtdXR1YWwtVExTIGV2aWRlbmNlIGlzIHVudmVyaWZpYWJsZWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWhhc1RydXN0c3RvcmVVcmkoc3RhY2ssIGRvbWFpbikpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgZXZlcnkgbWFwcGluZyB0byB0YXJnZXQgYSBkb21haW4gd2l0aCBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbi5UcnVzdHN0b3JlVXJpICgke21hcHBpbmcubm9kZS5wYXRofSAtPiAke2RvbWFpbi5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGVycm9ycztcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFzVHJ1c3RzdG9yZVVyaShzdGFjazogU3RhY2ssIGRvbWFpbjogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lKTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlc29sdmVkID0gc3RhY2sucmVzb2x2ZShkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24pO1xuICBpZiAocmVzb2x2ZWQgPT09IHVuZGVmaW5lZCB8fCByZXNvbHZlZCA9PT0gbnVsbCB8fCB0eXBlb2YgcmVzb2x2ZWQgIT09IFwib2JqZWN0XCIpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgY29uc3QgYXV0aGVudGljYXRpb24gPSByZXNvbHZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgdHJ1c3RzdG9yZVVyaSA9IGF1dGhlbnRpY2F0aW9uLnRydXN0c3RvcmVVcmkgPz8gYXV0aGVudGljYXRpb24uVHJ1c3RzdG9yZVVyaTtcbiAgcmV0dXJuIHRydXN0c3RvcmVVcmkgIT09IHVuZGVmaW5lZCAmJiB0cnVzdHN0b3JlVXJpICE9PSBudWxsICYmIHRydXN0c3RvcmVVcmkgIT09IFwiXCI7XG59XG5cbi8qKiBFdmVyeSBpbi1zdGFjayBgQ2ZuQXBpTWFwcGluZ2Agd2hvc2UgcmVzb2x2ZWQgYEFwaUlkYCBpcyB0aGUgc3VwcGxpZWQgQVBJLiAqL1xuZnVuY3Rpb24gY2ZuQXBpTWFwcGluZ3NCb3VuZFRvQXBpKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4pOiBhcGlnd3YyLkNmbkFwaU1hcHBpbmdbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkFwaU1hcHBpbmdbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuQXBpTWFwcGluZyAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gY2ZuRG9tYWluTmFtZXMoc2NvcGU6IENvbnN0cnVjdCk6IGFwaWd3djIuQ2ZuRG9tYWluTmFtZVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWVbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuRG9tYWluTmFtZSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKipcbiAqIEZpbmFsIHN5bnRoZXNpcyBwcm9vZiBmb3IgYW4gYXR0YWNoIERJU0FCTEVEIGRlY2xhcmF0aW9uOiB0aGUgY29uY3JldGUgQVBJXG4gKiBtdXN0IGJpbmQgdG8gZXhhY3RseSBvbmUgaW4tc3RhY2sgQ2ZuQXBpIHdob3NlIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRcbiAqIHJlc29sdmVzIHRvIGxpdGVyYWwgdHJ1ZS4gVGhlIGNvbnN0cnVjdCBuZXZlciBtdXRhdGVzIHRoZSBhdHRhY2hlZCBBUEkuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyQXR0YWNoRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGNmbkFwaXMgPSBjZm5BcGlzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgICAgIGlmIChjZm5BcGlzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgZXhhY3RseSBvbmUgc2FtZS1zdGFjayBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpOyB0aGUgYXR0YWNoZWQgQVBJJ3MgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCBjYW5ub3QgYmUgcHJvdmVuXCIsXG4gICAgICAgIF07XG4gICAgICB9XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGlzWzBdLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpICE9PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyB0aGUgYXR0YWNoZWQgQVdTOjpBcGlHYXRld2F5VjI6OkFwaSB0byBzZXQgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludD10cnVlXCIsXG4gICAgICAgIF07XG4gICAgICB9XG4gICAgICByZXR1cm4gW107XG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKiBFdmVyeSBpbi1zdGFjayBgQ2ZuQXBpYCB3aG9zZSBgUmVmYCBpcyB0aGUgc3VwcGxpZWQgQVBJJ3MgaWQuICovXG5mdW5jdGlvbiBjZm5BcGlzQm91bmRUb0FwaShzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiBhcGlnd3YyLkNmbkFwaVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuQXBpW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkFwaSAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUucmVmKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShcbiAgZGVmZW5zZTogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMgfCB1bmRlZmluZWQsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGRlZmVuc2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZSB0byByZWNvcmQgdGhlIG93bmluZyBBUEkncyBhY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWNpc2lvbnNgLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlZmVuc2UuYWNjZXNzTG9nZ2luZyAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS5hY2Nlc3NMb2dnaW5nIHRvIGJlIHRydWVgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZzogUGFydGlhbDxBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucz4gfCB1bmRlZmluZWQgPSBkZWZlbnNlLnRocm90dGxpbmc7XG4gIGNvbnN0IHJhdGVMaW1pdCA9IHRocm90dGxpbmc/LnJhdGVMaW1pdDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IHRocm90dGxpbmc/LmJ1cnN0TGltaXQ7XG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdClcbiAgICB8fCAocmF0ZUxpbWl0IGFzIG51bWJlcikgPD0gMFxuICAgIHx8ICFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdClcbiAgICB8fCAoYnVyc3RMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLnRocm90dGxpbmcgcmF0ZUxpbWl0IGFuZCBidXJzdExpbWl0IHRvIGJlIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKHNpZ25hbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgZGVuaWFsU2lnbmFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLm1ldHJpY05hbWUgIT09IHVuZGVmaW5lZCAmJiBzaWduYWwubWV0cmljTmFtZSAhPT0gTUNQX0RFTklBTF9NRVRSSUNfTkFNRSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5tZXRyaWNOYW1lIG11c3QgYmUgJHtNQ1BfREVOSUFMX01FVFJJQ19OQU1FfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLmRpbWVuc2lvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSBBcnJheS5pc0FycmF5KHNpZ25hbC5kaW1lbnNpb25zKSA/IHNpZ25hbC5kaW1lbnNpb25zIDogW107XG4gICAgY29uc3QgYm91bmRlZCA9IGRpbWVuc2lvbnMubGVuZ3RoID09PSBNQ1BfREVOSUFMX0RJTUVOU0lPTlMubGVuZ3RoXG4gICAgICAmJiBNQ1BfREVOSUFMX0RJTUVOU0lPTlMuZXZlcnkoXG4gICAgICAgIChkaW1lbnNpb24pID0+IGRpbWVuc2lvbnMuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgPT09IGRpbWVuc2lvbikubGVuZ3RoID09PSAxLFxuICAgICAgKTtcbiAgICBpZiAoIWJvdW5kZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLmRpbWVuc2lvbnMgbXVzdCBiZSBleGFjdGx5ICR7SlNPTi5zdHJpbmdpZnkoTUNQX0RFTklBTF9ESU1FTlNJT05TKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==