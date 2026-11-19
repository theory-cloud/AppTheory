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
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
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
            const apiNameProp = props.ownedApi?.apiName !== undefined ? "ownedApi.apiName" : "apiName";
            (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMcpServer", apiNameProp, "api_http", logical, ownedOptions.apiName !== undefined);
            (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMcpServer", "sessionState.tableName", "dynamodb_table", logical ? `${logical}-sessions` : undefined, props.sessionState?.tableName !== undefined || props.sessionTableName !== undefined);
            const derivedApiName = namingContext && logical ? namingContext.physicalName("api_http", logical) : undefined;
            const api = new apigwv2.HttpApi(this, "Api", {
                apiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : ownedOptions.apiName,
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
                // The construct-created access-log group is a logging resource: under
                // the standard profile it takes the contract log-source name, and under
                // the legacy profile it keeps today's CloudFormation-generated name and
                // consumes no naming entry (r3, ADV-1312-1).
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
            const namingContext = props.api ? undefined : props.namingContext;
            const logical = namingContext
                ? props.logicalName ?? (0, logical_name_1.defaultLogicalName)(this)
                : undefined;
            const derivedTableName = namingContext && logical
                ? namingContext.physicalName("dynamodb_table", `${logical}-sessions`)
                : undefined;
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: derivedTableName && !derivedTableName.generated ? derivedTableName.name : sessionState.tableName,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFFdkMsMkRBQStEO0FBQy9ELHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsaUVBQWtGO0FBRWxGLGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFFdkQsTUFBTSwwQkFBMEIsR0FBRyxjQUFjLENBQUM7QUFDbEQsTUFBTSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7QUFDcEQsTUFBTSw2QkFBNkIsR0FBRyxHQUFHLENBQUM7QUFDMUMsTUFBTSw4QkFBOEIsR0FBRyxHQUFHLENBQUM7QUFDM0MsTUFBTSwyQkFBMkIsR0FBRyxFQUFFLENBQUM7QUFDdkMsTUFBTSwyQkFBMkIsR0FBRyx3QkFBd0IsQ0FBQztBQUM3RCxNQUFNLGtDQUFrQyxHQUFHLGlDQUFpQyxDQUFDO0FBQzdFLE1BQU0saUNBQWlDLEdBQUcsOEJBQThCLENBQUM7QUFDekUsTUFBTSxzQkFBc0IsR0FBRywyQkFBMkIsQ0FBQztBQUMzRCxNQUFNLHFCQUFxQixHQUFHLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBRTFELDJDQUEyQztBQUMzQyxNQUFNLDhCQUE4QixHQUFHLHNCQUFzQixDQUFDO0FBRTlELG9GQUFvRjtBQUNwRixNQUFNLHlCQUF5QixHQUFHLDJCQUEyQixDQUFDO0FBRTlEOzs7OztHQUtHO0FBQ0gsTUFBTSxpQ0FBaUMsR0FBRyx1QkFBdUIsQ0FBQztBQUVsRTs7Ozs7R0FLRztBQUNILE1BQU0sb0NBQW9DLEdBQUcsSUFBSSxDQUFDO0FBQ2xELE1BQU0sb0NBQW9DLEdBQUcsRUFBRSxDQUFDO0FBRWhEOzs7O0dBSUc7QUFDSCxNQUFNLDJCQUEyQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQzFDLGVBQWU7SUFDZixZQUFZO0lBQ1osZ0JBQWdCO0lBQ2hCLFFBQVE7SUFDUixNQUFNO0lBQ04sbUJBQW1CO0lBQ25CLGtCQUFrQjtJQUNsQixpQkFBaUI7Q0FDbEIsQ0FBQyxDQUFDO0FBR0gsbURBQW1EO0FBQ25ELElBQVksc0JBZ0JYO0FBaEJELFdBQVksc0JBQXNCO0lBQ2hDOzs7O09BSUc7SUFDSCwrQ0FBcUIsQ0FBQTtJQUNyQjs7Ozs7OztPQU9HO0lBQ0gsdURBQTZCLENBQUE7QUFDL0IsQ0FBQyxFQWhCVyxzQkFBc0Isc0NBQXRCLHNCQUFzQixRQWdCakM7QUFFRCw0REFBNEQ7QUFDNUQsSUFBWSx1QkFnQlg7QUFoQkQsV0FBWSx1QkFBdUI7SUFDakM7Ozs7T0FJRztJQUNILDRDQUFpQixDQUFBO0lBQ2pCOzs7Ozs7O09BT0c7SUFDSCxnREFBcUIsQ0FBQTtBQUN2QixDQUFDLEVBaEJXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBZ0JsQztBQUVELG9FQUFvRTtBQUNwRSxJQUFZLDRCQVNYO0FBVEQsV0FBWSw0QkFBNEI7SUFDdEMsbUdBQW1HO0lBQ25HLDJDQUFXLENBQUE7SUFDWCwyRUFBMkU7SUFDM0UsMkNBQVcsQ0FBQTtJQUNYLG1JQUFtSTtJQUNuSSxpRUFBaUMsQ0FBQTtJQUNqQyx3RkFBd0Y7SUFDeEYsMkRBQTJCLENBQUE7QUFDN0IsQ0FBQyxFQVRXLDRCQUE0Qiw0Q0FBNUIsNEJBQTRCLFFBU3ZDO0FBY0QsNkZBQTZGO0FBQzdGLElBQVksOEJBa0NYO0FBbENELFdBQVksOEJBQThCO0lBQ3hDOzs7T0FHRztJQUNILHVEQUFxQixDQUFBO0lBQ3JCOzs7OztPQUtHO0lBQ0gsbURBQWlCLENBQUE7SUFDakI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7T0FtQkc7SUFDSCxxREFBbUIsQ0FBQTtBQUNyQixDQUFDLEVBbENXLDhCQUE4Qiw4Q0FBOUIsOEJBQThCLFFBa0N6QztBQXdqQkQ7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFhLGtCQUFtQixTQUFRLHNCQUFTOztJQUN2QyxhQUFhLEdBQUcsQ0FBQyxDQUFDO0lBQ2xCLFdBQVcsR0FBRyx1QkFBdUIsQ0FBQyxNQUFNLENBQUM7SUFDcEMsUUFBUSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFFOUIsR0FBRyxDQUFtQjtJQUN0QixRQUFRLENBQW1CO0lBQzNCLFlBQVksQ0FBbUI7SUFDL0M7Ozs7OztPQU1HO0lBQ2EsZ0JBQWdCLENBQStCO0lBQy9EOzs7Ozs7OztPQVFHO0lBQ2EsU0FBUyxDQUFXO0lBQ3BCLFFBQVEsQ0FBVztJQUNuQiw4QkFBOEIsQ0FBVztJQUN6QyxjQUFjLENBQW1DO0lBRWpFOzs7Ozs7OztPQVFHO0lBQ2EsUUFBUSxDQUFTO0lBRWpDLGtDQUFrQztJQUNsQixPQUFPLENBQVM7SUFFaEMsNEVBQTRFO0lBQzVELDZCQUE2QixDQUFTO0lBRXRDLFVBQVUsQ0FBc0I7SUFDaEMsVUFBVSxDQUFzQjtJQUNoQyxXQUFXLENBQXVCO0lBQ2xDLGNBQWMsQ0FBa0I7SUFFaEQ7Ozs7Ozs7OztPQVNHO0lBQ2EscUJBQXFCLENBQStCO0lBRXBFLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixrQkFBa0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQix5QkFBeUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQyxNQUFNLFdBQVcsR0FBRyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNoRCxNQUFNLFlBQVksR0FBRyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVyRCxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsZ0JBQWdCO2VBQ2pDLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxTQUFTO2dCQUM1QixDQUFDLENBQUMsNEJBQTRCLENBQUMsY0FBYztnQkFDN0MsQ0FBQyxDQUFDLDRCQUE0QixDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3hDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2xDLHdCQUF3QixDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUN2QyxxQkFBcUIsQ0FBQyxLQUFLLEVBQUUsV0FBVyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ25ELHNCQUFzQixDQUFDLEtBQUssRUFBRSxPQUFPLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDckQsTUFBTSxrQkFBa0IsR0FBRyx5QkFBeUIsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ2hGLElBQUksa0JBQWtCLEtBQUssOEJBQThCLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDakUsSUFBZ0UsQ0FBQyxxQkFBcUI7Z0JBQ3JGLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1lBQ3JELDJCQUEyQixDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQ2hGLENBQUM7UUFDRCxNQUFNLFVBQVUsR0FBRyxpQkFBaUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM1Qyx5QkFBeUIsQ0FBQyxVQUFVLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDL0MsTUFBTSxXQUFXLEdBQUcsa0JBQWtCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDOUMsSUFBSSxDQUFDLFdBQVcsR0FBRyxXQUFXLENBQUM7UUFDL0IsSUFBSSxVQUFVLEtBQUssc0JBQXNCLENBQUMsWUFBWSxJQUFJLEtBQUssQ0FBQyxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDbEYsK0JBQStCLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuRCxDQUFDO1FBQ0QsTUFBTSwyQkFBMkIsR0FBRyxPQUFPLEtBQUssNEJBQTRCLENBQUMsV0FBVyxDQUFDO1FBQ3pGLE1BQU0sb0JBQW9CLEdBQUcsMkJBQTJCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFaEUsSUFBSSxDQUFDLGdCQUFnQixHQUFHLE9BQU8sQ0FBQztRQUNoQyxJQUFJLENBQUMsUUFBUSxHQUFHLENBQUMsR0FBRyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDMUMsSUFBSSxDQUFDLGNBQWMsR0FBRyxtQkFBbUIsQ0FDdkMsSUFBSSxDQUFDLFFBQVEsRUFDYiwyQkFBMkIsRUFDM0IsV0FBVyxDQUFDLGdDQUFnQyxFQUM1QyxvQkFBb0IsQ0FDckIsQ0FBQztRQUNGLHNCQUFzQixDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsMkJBQTJCLENBQUMsQ0FBQztRQUN6RSxJQUFJLENBQUMsOEJBQThCLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUNsRSxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUMxQyxDQUFDO1FBQ0YsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2hDLElBQUksQ0FBQyw2QkFBNkIsR0FBRyxJQUFJLENBQUMsOEJBQThCLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFFNUUsSUFBSSxVQUFzQyxDQUFDO1FBQzNDLElBQUksY0FBYyxHQUFHLFVBQVUsQ0FBQztRQUNoQyxJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLEdBQUcsQ0FBQztRQUN2QixDQUFDO2FBQU0sQ0FBQztZQUNOLE1BQU0sWUFBWSxHQUFHLHFCQUFxQixDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUMvRCxjQUFjLEdBQUcsWUFBWSxDQUFDLFNBQVMsQ0FBQztZQUN4QyxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxDQUFDO1lBQzFDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUEsaUNBQWtCLEVBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQzVGLE1BQU0sUUFBUSxHQUFHLGFBQWEsRUFBRSxlQUFlLEtBQUssSUFBSSxDQUFDO1lBQ3pELE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxRQUFRLEVBQUUsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUMzRixJQUFBLHlDQUFrQixFQUFDLGFBQWEsRUFBRSxvQkFBb0IsRUFBRSxXQUFXLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxZQUFZLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1lBQzlILElBQUEseUNBQWtCLEVBQ2hCLGFBQWEsRUFDYixvQkFBb0IsRUFDcEIsd0JBQXdCLEVBQ3hCLGdCQUFnQixFQUNoQixPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFDM0MsS0FBSyxDQUFDLFlBQVksRUFBRSxTQUFTLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLENBQ3BGLENBQUM7WUFDRixNQUFNLGNBQWMsR0FBRyxhQUFhLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsWUFBWSxDQUFDLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1lBQzlHLE1BQU0sR0FBRyxHQUFHLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO2dCQUMzQyxPQUFPLEVBQUUsY0FBYyxJQUFJLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLE9BQU87Z0JBQ2pHLGFBQWEsRUFBRSxJQUFBLHlCQUFrQixFQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQzdDLGtCQUFrQixFQUFFLEtBQUs7Z0JBQ3pCLHlCQUF5QixFQUFFLGtCQUFrQixLQUFLLDhCQUE4QixDQUFDLFFBQVE7dUJBQ3BGLGtCQUFrQixLQUFLLDhCQUE4QixDQUFDLE1BQU07b0JBQy9ELENBQUMsQ0FBQyxJQUFJO29CQUNOLENBQUMsQ0FBQyxTQUFTO2FBQ2QsQ0FBQyxDQUFDO1lBQ0YsSUFBdUMsQ0FBQyxRQUFRLEdBQUcsR0FBRyxDQUFDO1lBQ3hELElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO1lBQ2YsSUFBSSxrQkFBa0IsS0FBSyw4QkFBOEIsQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDbkUscUNBQXFDLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ25ELENBQUM7WUFFRCxNQUFNLEtBQUssR0FBRyxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtnQkFDakQsT0FBTyxFQUFFLEdBQUc7Z0JBQ1osU0FBUyxFQUFFLFlBQVksQ0FBQyxTQUFTO2dCQUNqQyxVQUFVLEVBQUUsSUFBSTtnQkFDaEIsUUFBUSxFQUFFLFlBQVksQ0FBQyxpQkFBaUI7b0JBQ3RDLENBQUMsQ0FBQzt3QkFDQSxTQUFTLEVBQUUsWUFBWSxDQUFDLG1CQUFtQjt3QkFDM0MsVUFBVSxFQUFFLFlBQVksQ0FBQyxvQkFBb0I7cUJBQzlDO29CQUNELENBQUMsQ0FBQyxTQUFTO2FBQ2QsQ0FBQyxDQUFDO1lBQ0gsVUFBVSxHQUFHLEtBQUssQ0FBQztZQUVuQixJQUFJLFlBQVksQ0FBQyxhQUFhLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxRQUFRLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztvQkFDekIsTUFBTSxJQUFJLEtBQUssQ0FBQyw2REFBNkQsQ0FBQyxDQUFDO2dCQUNqRixDQUFDO2dCQUNELHNFQUFzRTtnQkFDdEUsd0VBQXdFO2dCQUN4RSx3RUFBd0U7Z0JBQ3hFLDZDQUE2QztnQkFDN0MsTUFBTSxRQUFRLEdBQUcsUUFBUSxJQUFJLGFBQWEsSUFBSSxPQUFPO29CQUNuRCxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7d0JBQ3BDLFlBQVksRUFBRSxhQUFhLENBQUMsWUFBWSxDQUFDLG1CQUFtQixPQUFPLEVBQUUsQ0FBQzt3QkFDdEUsU0FBUyxFQUFFLElBQUEsK0JBQVksRUFBQyxhQUFhLENBQUMsYUFBYSxDQUFDO3FCQUNyRCxDQUFDO29CQUNKLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTt3QkFDcEMsU0FBUyxFQUFFLFlBQVksQ0FBQyxrQkFBa0I7cUJBQzNDLENBQUMsQ0FBQztnQkFDTixJQUE0QyxDQUFDLGNBQWMsR0FBRyxRQUFRLENBQUM7Z0JBQ3hFLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQztnQkFDN0QsUUFBUSxDQUFDLGlCQUFpQixHQUFHO29CQUMzQixjQUFjLEVBQUUsUUFBUSxDQUFDLFdBQVc7b0JBQ3BDLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUEseUNBQXNCLEdBQUUsQ0FBQyxDQUFDLENBQUMsZUFBZSxFQUFFO2lCQUNoRSxDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxJQUFJLG1CQUFtQixDQUFDLHFCQUFxQixDQUMvRCxZQUFZLEVBQ1osS0FBSyxDQUFDLE9BQU8sRUFDYjtZQUNFLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO1lBQzlELHNCQUFzQixFQUFFLEtBQUssQ0FBQyxzQkFBc0IsSUFBSSxJQUFJO1NBQzdELENBQ0YsQ0FBQztRQUNGLE1BQU0sbUJBQW1CLEdBQUcsMEJBQTBCLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1FBQ3ZFLElBQUksbUJBQWtELENBQUM7UUFDdkQsSUFBSSxVQUFVLEtBQUssc0JBQXNCLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDdkQsbUJBQW1CLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUM3QywwQkFBMEIsRUFDMUIsR0FBRyxFQUNILFdBQVcsRUFDWCxtQkFBbUIsQ0FDcEIsQ0FBQztZQUNGLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FDMUMsMkJBQTJCLEVBQzNCLFdBQVcsRUFDWCxXQUFXLEVBQ1gsbUJBQW1CLENBQ3BCLENBQUM7WUFDRixvQ0FBb0MsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLG1CQUFtQixFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUM7UUFDMUYsQ0FBQzthQUFNLENBQUM7WUFDTixNQUFNLGdCQUFnQixHQUFHLElBQUksT0FBTyxDQUFDLGtCQUFrQixFQUFFLENBQUM7WUFDMUQsS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0sRUFBRSxDQUFDO2dCQUMvQyxLQUFLLE1BQU0sTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztvQkFDdEMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FDbEMsS0FBSyxDQUFDLFVBQVUsRUFDaEIsWUFBWSxDQUFDLE1BQU0sQ0FBQyxFQUNwQixXQUFXLEVBQ1gsbUJBQW1CLENBQ3BCLENBQUM7b0JBQ0YsbUJBQW1CLEdBQUcsbUJBQW1CLElBQUksT0FBTyxDQUFDO2dCQUN2RCxDQUFDO2dCQUNELElBQUksMkJBQTJCLEVBQUUsQ0FBQztvQkFDaEMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsd0JBQXdCLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFLGdCQUFnQixDQUFDLENBQUM7b0JBQzVHLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLHlCQUF5QixFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLFdBQVcsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO29CQUM3RyxJQUFJLENBQUMsZUFBZSxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDMUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFLGdCQUFnQixDQUFDLENBQUM7b0JBQ3BHLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDakcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsZUFBZSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO2dCQUN0RyxDQUFDO1lBQ0gsQ0FBQztZQUNELDZFQUE2RTtZQUM3RSxJQUFJLDJCQUEyQixFQUFFLENBQUM7Z0JBQ2hDLElBQUksQ0FBQyxlQUFlLENBQ2xCLElBQUksQ0FBQyxjQUFjLENBQUMsZUFBZSxFQUNuQyxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFDdEIsV0FBVyxFQUNYLGdCQUFnQixDQUNqQixDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksSUFBSSxDQUFDLGNBQWMsQ0FBQywrQkFBK0IsRUFBRSxDQUFDO2dCQUN4RCxJQUFJLENBQUMsZUFBZSxDQUNsQixJQUFJLENBQUMsY0FBYyxDQUFDLDhCQUE4QixFQUNsRCxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFDdEIsV0FBVyxFQUNYLGdCQUFnQixDQUNqQixDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7UUFFRCxNQUFNLG1CQUFtQixHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsWUFBWTtlQUN4RCxtQkFBbUIsRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFrRCxDQUFDO1FBQzlGLG1CQUFtQixFQUFFLFdBQVcsQ0FBQyxrQ0FBa0MsRUFBRTtZQUNuRSxPQUFPO1lBQ1AsV0FBVyxFQUFFLGlDQUFpQztZQUM5QyxXQUFXLEVBQUUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsTUFBTTtZQUM5Qyx3QkFBd0IsRUFBRSxLQUFLLENBQUMsY0FBYyxLQUFLLFNBQVM7WUFDNUQscUVBQXFFO1lBQ3JFLHlFQUF5RTtZQUN6RSxnQ0FBZ0M7WUFDaEMsR0FBRyxDQUFDLGtCQUFrQixLQUFLLDhCQUE4QixDQUFDLE9BQU87Z0JBQy9ELENBQUMsQ0FBQyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUM7Z0JBQ3ZELENBQUMsQ0FBQyxFQUFFLENBQUM7U0FDUixDQUFDLENBQUM7UUFFSCxNQUFNLFlBQVksR0FBRyxxQkFBcUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNsRCxJQUFJLFlBQVksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUN6QixNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUM7WUFDbEUsTUFBTSxPQUFPLEdBQUcsYUFBYTtnQkFDM0IsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLElBQUksSUFBQSxpQ0FBa0IsRUFBQyxJQUFJLENBQUM7Z0JBQy9DLENBQUMsQ0FBQyxTQUFTLENBQUM7WUFDZCxNQUFNLGdCQUFnQixHQUFHLGFBQWEsSUFBSSxPQUFPO2dCQUMvQyxDQUFDLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxnQkFBZ0IsRUFBRSxHQUFHLE9BQU8sV0FBVyxDQUFDO2dCQUNyRSxDQUFDLENBQUMsU0FBUyxDQUFDO1lBQ2QsTUFBTSxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7Z0JBQ3JELFNBQVMsRUFBRSxnQkFBZ0IsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsU0FBUztnQkFDM0csV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtnQkFDakQsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7Z0JBQ3hFLG1CQUFtQixFQUFFLFdBQVc7Z0JBQ2hDLGFBQWEsRUFBRSxZQUFZLENBQUMsYUFBYTtnQkFDekMsZ0NBQWdDLEVBQUUsRUFBRSwwQkFBMEIsRUFBRSxJQUFJLEVBQUU7Z0JBQ3RFLFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7YUFDakQsQ0FBQyxDQUFDO1lBQ0gsS0FBSyxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN4QyxJQUFJLENBQUMsWUFBWSxHQUFHLEtBQUssQ0FBQztZQUMxQixJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3pFLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7UUFDakcsQ0FBQztRQUVELElBQUksWUFBb0IsQ0FBQztRQUN6QixJQUFJLFlBQVksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7Z0JBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsNEVBQTRFLENBQUMsQ0FBQztZQUNoRyxDQUFDO1lBQ0QsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUM7WUFDeEQsSUFDRSxrQkFBa0IsS0FBSyw4QkFBOEIsQ0FBQyxNQUFNO21CQUN6RCxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsRUFDOUIsQ0FBQztnQkFDRCxtQ0FBbUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQzNELENBQUM7WUFDRCxZQUFZLEdBQUcsV0FBVyxZQUFZLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQzdELENBQUM7YUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNyQixNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM3QixNQUFNLGdCQUFnQixHQUFHLFdBQVcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLGdCQUFnQixLQUFLLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNwRyxZQUFZLEdBQUcsS0FBSyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsb0JBQW9CLEtBQUssVUFBVTtnQkFDbEcsQ0FBQyxDQUFDLGdCQUFnQjtnQkFDbEIsQ0FBQyxDQUFDLEdBQUcsZ0JBQWdCLElBQUksS0FBSyxDQUFDLG9CQUFvQixFQUFFLENBQUM7UUFDMUQsQ0FBQzthQUFNLENBQUM7WUFDTixZQUFZLEdBQUcsY0FBYyxLQUFLLFVBQVU7Z0JBQzFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFdBQVc7Z0JBQ3RCLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsV0FBVyxJQUFJLGNBQWMsRUFBRSxDQUFDO1FBQ2xELENBQUM7UUFDRCxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUNoQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxZQUFZLENBQUMsR0FBRyxPQUFPLEVBQUUsQ0FDN0QsQ0FBQztRQUNGLElBQ0UsS0FBSyxDQUFDLEdBQUcsS0FBSyxTQUFTO2VBQ3BCLENBQUMsa0JBQWtCLEtBQUssOEJBQThCLENBQUMsUUFBUTttQkFDN0Qsa0JBQWtCLEtBQUssOEJBQThCLENBQUMsTUFBTSxDQUFDO2VBQy9ELElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxDQUFDLEVBQ3hFLENBQUM7WUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLGlJQUFpSSxDQUNsSSxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRU8sZUFBZSxDQUNyQixJQUFZLEVBQ1osTUFBMEIsRUFDMUIsV0FBc0QsRUFDdEQsVUFBd0M7UUFFeEMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLEVBQUU7WUFDMUUsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHO1lBQ2pCLFFBQVEsRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1lBQ2pELFdBQVc7WUFDWCxVQUFVO1NBQ1gsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLG9CQUFvQixDQUFDLE1BQTBCLEVBQUUsSUFBWTtRQUNuRSxJQUFJLElBQUksQ0FBQyxXQUFXLEtBQUssdUJBQXVCLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDMUQsT0FBTyxRQUFRLElBQUksQ0FBQyxhQUFhLEVBQUUsRUFBRSxDQUFDO1FBQ3hDLENBQUM7UUFDRCxNQUFNLEVBQUUsR0FBRyxJQUFBLG9DQUF3QixFQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztRQUNsRCxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7WUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FDYixxRkFBcUYsRUFBRSxrQkFBa0IsTUFBTSxJQUFJLElBQUksRUFBRSxDQUMxSCxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3RCLE9BQU8sRUFBRSxDQUFDO0lBQ1osQ0FBQztJQUVPLG9CQUFvQixDQUMxQixFQUFVLEVBQ1YsSUFBWSxFQUNaLFdBQXNELEVBQ3RELFVBQXdDO1FBRXhDLE9BQU8sSUFBSSxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxFQUFFLEVBQUU7WUFDckMsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHO1lBQ2pCLFFBQVEsRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7WUFDakUsV0FBVztZQUNYLFVBQVU7U0FDWCxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRU8sY0FBYyxDQUFDLE9BQXlCLEVBQUUsR0FBVyxFQUFFLEtBQWE7UUFDMUUsSUFBSSxnQkFBZ0IsSUFBSSxPQUFPLElBQUksT0FBTyxPQUFPLENBQUMsY0FBYyxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQ2hGLE9BQU8sQ0FBQyxjQUFjLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3JDLENBQUM7SUFDSCxDQUFDO0lBRU8saUJBQWlCLENBQ3ZCLE9BQXdDLEVBQ3hDLEtBQXFCO1FBRXJCLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYztZQUNoRSxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjLENBQXFCO1lBQ3RHLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNmLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNqQixNQUFNLElBQUksS0FBSyxDQUNiLG1GQUFtRixDQUNwRixDQUFDO1FBQ0osQ0FBQztRQUNELE1BQU0sVUFBVSxHQUFHLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQzVELFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVTtZQUM5QixXQUFXO1lBQ1gsSUFBSSxFQUFFLE9BQU8sQ0FBQyx1QkFBdUI7U0FDdEMsQ0FBQyxDQUFDO1FBQ0YsSUFBNEMsQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO1FBQ3RFLE1BQU0sVUFBVSxHQUFHLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQzVELEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLFVBQVU7WUFDVixLQUFLO1NBQ04sQ0FBQyxDQUFDO1FBQ0YsSUFBNEMsQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO1FBQ3RFLElBQUksT0FBTyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sV0FBVyxHQUFHLElBQUksT0FBTyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO2dCQUMvRCxJQUFJLEVBQUUsT0FBTyxDQUFDLFVBQVU7Z0JBQ3hCLFVBQVUsRUFBRSxtQkFBbUIsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUM7Z0JBQ3ZFLFVBQVUsRUFBRSxVQUFVLENBQUMsa0JBQWtCO2FBQzFDLENBQUMsQ0FBQztZQUNGLElBQThDLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztRQUM1RSxDQUFDO0lBQ0gsQ0FBQzs7QUF4WkgsZ0RBeVpDO0FBNkJELFNBQVMsb0JBQW9CLENBQUMsS0FBOEI7SUFDMUQsSUFBSSxLQUFLLENBQUMsV0FBVyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ25FLE1BQU0sSUFBSSxLQUFLLENBQ2Isb0ZBQW9GLENBQ3JGLENBQUM7SUFDSixDQUFDO0lBQ0QsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsRUFBRSxRQUFRO1dBQzFDLENBQUMsS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTO1lBQzdCLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUM7WUFDakIsQ0FBQyxDQUFDLDRDQUF3QixDQUFDLDBCQUEwQixFQUFFLENBQUMsR0FBRyxDQUN6RCxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FDbEMsQ0FBQyxDQUFDO0lBQ1AsSUFBSSxXQUFXLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzdCLE1BQU0sSUFBSSxLQUFLLENBQUMsNERBQTRELENBQUMsQ0FBQztJQUNoRixDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUNsRCxrQkFBa0IsQ0FBQyxPQUFPLEVBQUUsd0JBQXdCLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztJQUNqRSxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQy9CLEtBQUssTUFBTSxPQUFPLElBQUksUUFBUSxFQUFFLENBQUM7UUFDL0IsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDdEIsTUFBTSxJQUFJLEtBQUssQ0FDYix1RUFBdUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUNqRyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDcEIsQ0FBQztJQUNELE9BQU87UUFDTCxRQUFRO1FBQ1IsZ0NBQWdDLEVBQzlCLEtBQUssQ0FBQyxXQUFXLEVBQUUsZ0NBQWdDLElBQUksS0FBSztLQUMvRCxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsS0FBYSxFQUFFLFFBQWdCO0lBQ3pELElBQUksbUJBQUssQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUM5QixNQUFNLElBQUksS0FBSyxDQUNiLHVCQUF1QixRQUFRLGlEQUFpRCxDQUNqRixDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUM7SUFDdEMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1FBQUUsTUFBTSxtQkFBbUIsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNwRSxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMvQyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxJQUFJLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLE9BQU8sS0FBSyxFQUFFLENBQUMsRUFBRSxDQUFDO1FBQ3hFLE1BQU0sbUJBQW1CLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDdEMsQ0FBQztJQUNELE1BQU0sT0FBTyxHQUFHLHFEQUFxRCxDQUFDO0lBQ3RFLE1BQU0sU0FBUyxHQUFHLGdDQUFnQyxDQUFDO0lBQ25ELEtBQUssTUFBTSxPQUFPLElBQUksUUFBUSxFQUFFLENBQUM7UUFDL0IsSUFBSSxPQUFPLEtBQUssR0FBRyxJQUFJLE9BQU8sS0FBSyxJQUFJO1lBQUUsTUFBTSxtQkFBbUIsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM3RSxJQUFJLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO1lBQUUsU0FBUztRQUN0QyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUM3RSxNQUFNLG1CQUFtQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3RDLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQztBQUVELFNBQVMsbUJBQW1CLENBQUMsUUFBZ0I7SUFDM0MsT0FBTyxJQUFJLEtBQUssQ0FDZCx1QkFBdUIsUUFBUSwySEFBMkgsQ0FDM0osQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLDJCQUEyQixDQUFDLEtBQThCO0lBQ2pFLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQztJQUM5QyxJQUFJLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUM3QixPQUFPLDRDQUF3QixDQUFDLHFCQUFxQixDQUFDO0lBQ3hELENBQUM7SUFDRCxJQUFJLG1CQUFLLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7UUFDbkMsTUFBTSxJQUFJLEtBQUssQ0FDYixzRkFBc0YsQ0FDdkYsQ0FBQztJQUNKLENBQUM7SUFDRCxJQUFJLENBQUM7UUFDSCxPQUFPLDRDQUF3QixDQUFDLDZCQUE2QixDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQzVFLENBQUM7SUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ2IsTUFBTSxNQUFNLEdBQUcsR0FBRyxZQUFZLEtBQUs7WUFDakMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLGNBQWMsRUFBRSxFQUFFLENBQUM7WUFDekMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNoQixNQUFNLElBQUksS0FBSyxDQUNiLHdEQUF3RCxNQUFNLEVBQUUsQ0FDakUsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxtQkFBbUIsQ0FDMUIsUUFBa0IsRUFDbEIsMkJBQW9DLEVBQ3BDLCtCQUF3QyxFQUN4QyxlQUF1QjtJQUV2QixPQUFPO1FBQ0wsZUFBZSxFQUFFLDRDQUF3QixDQUFDLGdCQUFnQjtRQUMxRCxNQUFNLEVBQUUsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUNwQyxVQUFVO1lBQ1YsVUFBVSxFQUFFLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUM7WUFDckMsd0JBQXdCLEVBQ3RCLDRDQUF3QixDQUFDLG9DQUFvQyxDQUFDLFVBQVUsQ0FBQztZQUMzRSx5QkFBeUIsRUFDdkIsNENBQXdCLENBQUMsc0NBQXNDLENBQUMsVUFBVSxDQUFDO1lBQzdFLHNCQUFzQixFQUNwQiw0Q0FBd0IsQ0FBQyw0Q0FBNEMsQ0FBQyxVQUFVLENBQUM7WUFDbkYsZ0JBQWdCLEVBQ2QsNENBQXdCLENBQUMseUNBQXlDLENBQUMsVUFBVSxDQUFDO1lBQ2hGLFlBQVksRUFDViw0Q0FBd0IsQ0FBQyxxQ0FBcUMsQ0FBQyxVQUFVLENBQUM7WUFDNUUsZUFBZSxFQUNiLDRDQUF3QixDQUFDLHdDQUF3QyxDQUFDLFVBQVUsQ0FBQztZQUMvRSwyQkFBMkI7U0FDNUIsQ0FBQyxDQUFDO1FBQ0gsOEJBQThCLEVBQzVCLDRDQUF3QixDQUFDLHNDQUFzQyxDQUFDLEdBQUcsQ0FBQztRQUN0RSwrQkFBK0I7UUFDL0IsZUFBZTtLQUNoQixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsc0JBQXNCLENBQzdCLFNBQTJDLEVBQzNDLDJCQUFvQztJQUVwQyxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQy9CLE1BQU0sR0FBRyxHQUFHLENBQUMsTUFBYyxFQUFFLElBQVksRUFBUSxFQUFFO1FBQ2pELE1BQU0sR0FBRyxHQUFHLEdBQUcsTUFBTSxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ2hDLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sSUFBSSxLQUFLLENBQUMsd0RBQXdELEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDakYsQ0FBQztRQUNELElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEIsQ0FBQyxDQUFDO0lBQ0YsS0FBSyxNQUFNLEtBQUssSUFBSSxTQUFTLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDckMsS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLENBQUMsVUFBVTtZQUFFLEdBQUcsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3JFLElBQUksMkJBQTJCLEVBQUUsQ0FBQztZQUNoQyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1lBQzNDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7WUFDNUMsR0FBRyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUN6QyxHQUFHLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1lBQ25DLEdBQUcsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQ2hDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLGVBQWUsQ0FBQyxDQUFDO1FBQ3JDLENBQUM7SUFDSCxDQUFDO0lBQ0QsSUFBSSwyQkFBMkIsRUFBRSxDQUFDO1FBQ2hDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBQ3hDLENBQUM7SUFDRCxJQUFJLFNBQVMsQ0FBQywrQkFBK0IsRUFBRSxDQUFDO1FBQzlDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLDhCQUE4QixDQUFDLENBQUM7SUFDdkQsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEtBQThCO0lBQ3hELElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDZixJQUFJLEtBQUssQ0FBQyxvQkFBb0IsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM3QyxNQUFNLElBQUksS0FBSyxDQUNiLHdFQUF3RSxDQUN6RSxDQUFDO1FBQ0osQ0FBQztRQUNELE9BQU87SUFDVCxDQUFDO0lBQ0QsSUFDRSxLQUFLLENBQUMsb0JBQW9CLEtBQUssU0FBUztXQUNyQyxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQztlQUM3QyxDQUFDLHNDQUFzQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxFQUM5RSxDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYixrR0FBa0csQ0FDbkcsQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBYSxFQUFFLENBQUM7SUFDN0IsSUFBSSxLQUFLLENBQUMsUUFBUSxLQUFLLFNBQVM7UUFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQzNELElBQUksS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTO1FBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN6RCxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssU0FBUztRQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDbkQsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLFNBQVM7UUFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ3ZELElBQUksS0FBSyxDQUFDLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNyRCxJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDekIsTUFBTSxJQUFJLEtBQUssQ0FDYiw4RUFBOEUsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUNuRyxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHdCQUF3QixDQUFDLEtBQThCO0lBQzlELElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxPQUFPLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDekUsTUFBTSxJQUFJLEtBQUssQ0FDYix5RkFBeUYsQ0FDMUYsQ0FBQztJQUNKLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxRQUFRLEVBQUUsTUFBTSxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3ZFLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUZBQXVGLENBQ3hGLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsUUFBUSxFQUFFLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNyRSxNQUFNLElBQUksS0FBSyxDQUNiLHFGQUFxRixDQUN0RixDQUFDO0lBQ0osQ0FBQztJQUNELE9BQU87UUFDTCxPQUFPLEVBQUUsS0FBSyxDQUFDLFFBQVEsRUFBRSxPQUFPLElBQUksS0FBSyxDQUFDLE9BQU87UUFDakQsTUFBTSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxNQUFNO1FBQzlDLEtBQUssRUFBRSxLQUFLLENBQUMsUUFBUSxFQUFFLEtBQUssSUFBSSxLQUFLLENBQUMsS0FBSztLQUM1QyxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsT0FBd0M7SUFDckUsTUFBTSxhQUFhLEdBQUcsT0FBTyxFQUFFLGFBQWEsSUFBSSxJQUFJLENBQUM7SUFDckQsSUFBSSxDQUFDLGFBQWEsSUFBSSxPQUFPLEVBQUUsa0JBQWtCLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDaEUsTUFBTSxJQUFJLEtBQUssQ0FDYiw0RkFBNEYsQ0FDN0YsQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLGlCQUFpQixHQUFHLE9BQU8sRUFBRSxpQkFBaUIsSUFBSSxJQUFJLENBQUM7SUFDN0QsSUFDRSxDQUFDLGlCQUFpQjtXQUNmLENBQUMsT0FBTyxFQUFFLG1CQUFtQixLQUFLLFNBQVMsSUFBSSxPQUFPLEVBQUUsb0JBQW9CLEtBQUssU0FBUyxDQUFDLEVBQzlGLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLDJGQUEyRixDQUM1RixDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sU0FBUyxHQUFHLE9BQU8sRUFBRSxtQkFBbUIsSUFBSSw2QkFBNkIsQ0FBQztJQUNoRixNQUFNLFVBQVUsR0FBRyxPQUFPLEVBQUUsb0JBQW9CLElBQUksOEJBQThCLENBQUM7SUFDbkYsc0JBQXNCLENBQUMsU0FBUyxFQUFFLG9DQUFvQyxDQUFDLENBQUM7SUFDeEUsc0JBQXNCLENBQUMsVUFBVSxFQUFFLHFDQUFxQyxDQUFDLENBQUM7SUFDMUUsT0FBTztRQUNMLFNBQVMsRUFBRSxPQUFPLEVBQUUsU0FBUyxJQUFJLFVBQVU7UUFDM0MsYUFBYTtRQUNiLGtCQUFrQixFQUFFLE9BQU8sRUFBRSxrQkFBa0IsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7UUFDL0UsaUJBQWlCO1FBQ2pCLG1CQUFtQixFQUFFLFNBQVM7UUFDOUIsb0JBQW9CLEVBQUUsVUFBVTtLQUNqQyxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsS0FBOEI7SUFDM0QsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLGtCQUFrQixLQUFLLFNBQVM7V0FDbkQsS0FBSyxDQUFDLGdCQUFnQixLQUFLLFNBQVM7V0FDcEMsS0FBSyxDQUFDLGlCQUFpQixLQUFLLFNBQVMsQ0FBQztJQUMzQyxJQUFJLEtBQUssQ0FBQyxZQUFZLEtBQUssU0FBUyxJQUFJLFNBQVMsRUFBRSxDQUFDO1FBQ2xELE1BQU0sSUFBSSxLQUFLLENBQ2IseUZBQXlGLENBQzFGLENBQUM7SUFDSixDQUFDO0lBQ0QsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxPQUFPLElBQUksS0FBSyxDQUFDLGtCQUFrQixJQUFJLElBQUksQ0FBQztJQUNoRixNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsWUFBWSxFQUFFLFNBQVMsSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUM7SUFDMUUsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxVQUFVO1dBQzVDLEtBQUssQ0FBQyxpQkFBaUI7V0FDdkIsMkJBQTJCLENBQUM7SUFDakMsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxhQUFhLElBQUksMkJBQWEsQ0FBQyxNQUFNLENBQUM7SUFDaEYsSUFDRSxDQUFDLE9BQU87V0FDTCxDQUFDLFNBQVMsS0FBSyxTQUFTO2VBQ3RCLEtBQUssQ0FBQyxZQUFZLEVBQUUsVUFBVSxLQUFLLFNBQVM7ZUFDNUMsS0FBSyxDQUFDLFlBQVksRUFBRSxhQUFhLEtBQUssU0FBUztlQUMvQyxLQUFLLENBQUMsZ0JBQWdCLEtBQUssU0FBUztlQUNwQyxLQUFLLENBQUMsaUJBQWlCLEtBQUssU0FBUyxDQUFDLEVBQzNDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLHFHQUFxRyxDQUN0RyxDQUFDO0lBQ0osQ0FBQztJQUNELHVCQUF1QixDQUFDLFVBQVUsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO0lBQy9ELE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxhQUFhLEVBQUUsQ0FBQztBQUMzRCxDQUFDO0FBRUQsU0FBUyx5QkFBeUIsQ0FBQyxLQUE4QjtJQUMvRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMseUJBQXlCLEtBQUssU0FBUyxDQUFDO0lBQ2hFLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxPQUFPLEtBQUssU0FBUyxDQUFDO0lBQy9DLElBQUksU0FBUyxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQzdCLE1BQU0sSUFBSSxLQUFLLENBQ2IscUZBQXFGLENBQ3RGLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxDQUFDLFNBQVMsSUFBSSxDQUFDLFVBQVU7UUFBRSxPQUFPO0lBQ3RDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztJQUN2RCxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ2hDLHVCQUF1QixDQUNyQixNQUFNLEVBQ04sS0FBSyxFQUNMLG1GQUFtRixDQUNwRixDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQ2pDLHVCQUF1QixDQUNyQixPQUFPLEVBQ1AsSUFBSSxFQUNKLG9FQUFvRSxDQUNyRSxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLDBCQUEwQixDQUNqQyxLQUE4QixFQUM5QixPQUFxQztJQUVyQyxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsbUJBQW1CLENBQUM7SUFDN0MsUUFBUSxPQUFPLEVBQUUsQ0FBQztRQUNoQixLQUFLLDRCQUE0QixDQUFDLEdBQUcsQ0FBQztRQUN0QyxLQUFLLDRCQUE0QixDQUFDLGNBQWMsQ0FBQztRQUNqRCxLQUFLLDRCQUE0QixDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7WUFDOUMsSUFBSSxVQUFVLEtBQUssU0FBUyxFQUFFLENBQUM7Z0JBQzdCLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUZBQWlGLENBQ2xGLENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTyxPQUFPLEtBQUssNEJBQTRCLENBQUMsR0FBRztnQkFDakQsQ0FBQyxDQUFDLElBQUksa0JBQWtCLENBQUMsaUJBQWlCLEVBQUU7Z0JBQzVDLENBQUMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQ3ZDLENBQUM7UUFDRCxLQUFLLDRCQUE0QixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDdEMsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLFVBQVUsRUFBRSxNQUFNLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDdkQsSUFBSSxNQUFNLEtBQUssRUFBRSxFQUFFLENBQUM7Z0JBQ2xCLE1BQU0sSUFBSSxLQUFLLENBQ2IseUZBQXlGLENBQzFGLENBQUM7WUFDSixDQUFDO1lBQ0QsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7Z0JBQ2hDLHVCQUF1QixDQUNyQixNQUFNLEVBQ04sS0FBSyxFQUNMLG9GQUFvRixDQUNyRixDQUFDO1lBQ0osQ0FBQztZQUNELE1BQU0sUUFBUSxHQUFHLENBQUMsVUFBVSxFQUFFLFFBQVEsSUFBSSxFQUFFLENBQUM7aUJBQzFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO2lCQUNwQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssS0FBSyxFQUFFLENBQUMsQ0FBQztZQUNuQyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQzFCLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUhBQXVILENBQ3hILENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTyxJQUFJLGtCQUFrQixDQUFDLGlCQUFpQixDQUM3QywyQkFBMkIsRUFDM0IsTUFBTSxFQUNOO2dCQUNFLFdBQVcsRUFBRSxRQUFRO2dCQUNyQixjQUFjLEVBQUUsVUFBVSxFQUFFLGNBQWM7Z0JBQzFDLGNBQWMsRUFBRSxVQUFVLEVBQUUsY0FBYzthQUMzQyxDQUNGLENBQUM7UUFDSixDQUFDO1FBQ0Q7WUFDRSxNQUFNLElBQUksS0FBSyxDQUNiLHVIQUF1SCxDQUN4SCxDQUFDO0lBQ04sQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxPQUFxQztJQUN6RCxRQUFRLE9BQU8sRUFBRSxDQUFDO1FBQ2hCLEtBQUssNEJBQTRCLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxLQUFLLENBQUM7UUFDcEQsS0FBSyw0QkFBNEIsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEtBQUssQ0FBQztRQUNwRCxLQUFLLDRCQUE0QixDQUFDLGNBQWMsQ0FBQyxDQUFDLE9BQU8sZ0JBQWdCLENBQUM7UUFDMUUsS0FBSyw0QkFBNEIsQ0FBQyxXQUFXLENBQUMsQ0FBQyxPQUFPLGFBQWEsQ0FBQztRQUNwRSxPQUFPLENBQUMsQ0FBQyxPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNsQyxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsd0JBQXdCLENBQUMsT0FBcUM7SUFDckUsUUFBUSxPQUFPLEVBQUUsQ0FBQztRQUNoQixLQUFLLDRCQUE0QixDQUFDLEdBQUcsQ0FBQztRQUN0QyxLQUFLLDRCQUE0QixDQUFDLEdBQUcsQ0FBQztRQUN0QyxLQUFLLDRCQUE0QixDQUFDLGNBQWMsQ0FBQztRQUNqRCxLQUFLLDRCQUE0QixDQUFDLFdBQVc7WUFDM0MsT0FBTztRQUNUO1lBQ0UsTUFBTSxJQUFJLEtBQUssQ0FDYix1SEFBdUgsQ0FDeEgsQ0FBQztJQUNOLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxpQkFBaUIsQ0FBQyxLQUE4QjtJQUN2RCxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDO0lBQ3BDLElBQUksVUFBVSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzdCLE9BQU8sc0JBQXNCLENBQUMsUUFBUSxDQUFDO0lBQ3pDLENBQUM7SUFDRCxJQUNFLFVBQVUsS0FBSyxzQkFBc0IsQ0FBQyxRQUFRO1dBQzNDLFVBQVUsS0FBSyxzQkFBc0IsQ0FBQyxZQUFZLEVBQ3JELENBQUM7UUFDRCxPQUFPLFVBQVUsQ0FBQztJQUNwQixDQUFDO0lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix5RkFBeUYsQ0FDMUYsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLHlCQUF5QixDQUNoQyxVQUFrQyxFQUNsQyxPQUFxQztJQUVyQyxJQUNFLFVBQVUsS0FBSyxzQkFBc0IsQ0FBQyxZQUFZO1dBQy9DLE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxjQUFjO1dBQ3ZELE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxXQUFXLEVBQ3ZELENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLGtJQUFrSSxZQUFZLENBQUMsT0FBTyxDQUFDLDJGQUEyRixDQUNuUCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEtBQThCO0lBQ3hELE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxXQUFXLENBQUM7SUFDckMsSUFBSSxVQUFVLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDN0IsT0FBTyx1QkFBdUIsQ0FBQyxNQUFNLENBQUM7SUFDeEMsQ0FBQztJQUNELElBQ0UsVUFBVSxLQUFLLHVCQUF1QixDQUFDLE1BQU07V0FDMUMsVUFBVSxLQUFLLHVCQUF1QixDQUFDLFFBQVEsRUFDbEQsQ0FBQztRQUNELE9BQU8sVUFBVSxDQUFDO0lBQ3BCLENBQUM7SUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLHFGQUFxRixDQUN0RixDQUFDO0FBQ0osQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sOEJBQThCLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUUzRTs7OztHQUlHO0FBQ0gsU0FBUyxlQUFlLENBQUMsS0FBZ0IsRUFBRSxLQUFjO0lBQ3ZELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQ7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFTLGdCQUFnQixDQUFDLEtBQWdCLEVBQUUsR0FBcUI7SUFDL0QsTUFBTSxLQUFLLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUIsTUFBTSxNQUFNLEdBQUcsZUFBZSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakQsTUFBTSxLQUFLLEdBQXVCLEVBQUUsQ0FBQztJQUNyQyxNQUFNLEtBQUssR0FBRyxDQUFDLElBQWUsRUFBUSxFQUFFO1FBQ3RDLElBQUksSUFBSSxZQUFZLE9BQU8sQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUN0QyxJQUFJLGVBQWUsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztnQkFDMUQsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQWdDLENBQUMsQ0FBQztZQUN6RCxDQUFDO1lBQ0QseUVBQXlFO1lBQ3pFLE9BQU87UUFDVCxDQUFDO1FBQ0QsSUFBSSxJQUFJLFlBQVksT0FBTyxDQUFDLFFBQVEsSUFBSSxlQUFlLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztZQUN0RixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ25CLENBQUM7UUFDRCxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDdkMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2YsQ0FBQztJQUNILENBQUMsQ0FBQztJQUNGLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNiLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDO0FBQ3RELENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsU0FBUywrQkFBK0IsQ0FBQyxLQUFnQixFQUFFLEdBQXFCO0lBQzlFLE1BQU0sY0FBYyxHQUFHLGdCQUFnQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNwRCxJQUFJLGNBQWMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDOUIsTUFBTSxJQUFJLEtBQUssQ0FDYiwyR0FBMkc7Y0FDekcsMkJBQTJCLGNBQWMsQ0FBQyxNQUFNLGNBQWMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUk7Y0FDM0gsMERBQTBELENBQzdELENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7Ozs7Ozs7OztHQVdHO0FBQ0gsU0FBUyxvQ0FBb0MsQ0FDM0MsS0FBZ0IsRUFDaEIsR0FBcUIsRUFDckIsV0FBZ0M7SUFFaEMsTUFBTSxLQUFLLEdBQUcsSUFBSSxHQUFHLENBQ25CLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQyxDQUN4RSxDQUFDO0lBQ0YsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztRQUNqQyxRQUFRLEVBQUUsR0FBRyxFQUFFO1lBQ2IsTUFBTSxNQUFNLEdBQWEsRUFBRSxDQUFDO1lBQzVCLEtBQUssTUFBTSxLQUFLLElBQUksZ0JBQWdCLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQ2pELElBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO29CQUNyQixTQUFTO2dCQUNYLENBQUM7Z0JBQ0QsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQztnQkFDaEMsSUFBSSw4QkFBOEIsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztvQkFDakQsTUFBTSxDQUFDLElBQUksQ0FDVCw2RkFBNkYsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMseUVBQXlFLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQ2pOLENBQUM7b0JBQ0YsU0FBUztnQkFDWCxDQUFDO2dCQUNELE1BQU0saUJBQWlCLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxNQUFNLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFDbEYsSUFBSSxpQkFBaUIsS0FBSyxNQUFNLEVBQUUsQ0FBQztvQkFDakMsTUFBTSxDQUFDLElBQUksQ0FDVCxzTEFBc0wsUUFBUSxTQUFTLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQzFOLENBQUM7Z0JBQ0osQ0FBQztZQUNILENBQUM7WUFDRCxPQUFPLE1BQU0sQ0FBQztRQUNoQixDQUFDO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVELFNBQVMsd0JBQXdCLENBQUMsTUFBcUM7SUFDckUsSUFBSSxNQUFNLEtBQUssU0FBUztRQUFFLE9BQU87SUFDakMsTUFBTSxVQUFVLEdBQUksTUFBbUMsRUFBRSxVQUFVLENBQUM7SUFDcEUsSUFDRSxPQUFPLFVBQVUsS0FBSyxRQUFRO1dBQzNCLFVBQVUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1dBQ3hCLG1CQUFLLENBQUMsWUFBWSxDQUFDLFVBQVUsQ0FBQyxFQUNqQyxDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix5RkFBeUYsQ0FDMUYsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FDNUIsS0FBOEIsRUFDOUIsV0FBa0MsRUFDbEMsT0FBcUM7SUFFckMsSUFBSSxPQUFPLEtBQUssNEJBQTRCLENBQUMsV0FBVyxFQUFFLENBQUM7UUFDekQsSUFBSSxLQUFLLENBQUMseUJBQXlCLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDakYsTUFBTSxJQUFJLEtBQUssQ0FDYiwrR0FBK0csQ0FDaEgsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLFdBQVcsQ0FBQyxnQ0FBZ0MsRUFBRSxDQUFDO1lBQ2pELE1BQU0sSUFBSSxLQUFLLENBQ2IsaUdBQWlHLENBQ2xHLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsY0FBYyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3ZDLE1BQU0sSUFBSSxLQUFLLENBQ2IsZ0ZBQWdGLENBQ2pGLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsb0JBQW9CLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDN0MsTUFBTSxJQUFJLEtBQUssQ0FDYixzRkFBc0YsQ0FDdkYsQ0FBQztRQUNKLENBQUM7UUFDRCxPQUFPO0lBQ1QsQ0FBQztJQUNELElBQ0UsT0FBTyxLQUFLLDRCQUE0QixDQUFDLGNBQWM7V0FDcEQsS0FBSyxDQUFDLGNBQWMsS0FBSyxTQUFTLEVBQ3JDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLHdDQUF3QyxZQUFZLENBQUMsT0FBTyxDQUFDLGdDQUFnQyxDQUM5RixDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHNCQUFzQixDQUM3QixLQUE4QixFQUM5QixPQUFxQyxFQUNyQyxLQUFnQztJQUVoQyxJQUNFLE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxjQUFjO1dBQ3BELE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxXQUFXLEVBQ3ZELENBQUM7UUFDRCxPQUFPO0lBQ1QsQ0FBQztJQUNELE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNwQyxJQUNFLE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxjQUFjO1dBQ3BELENBQUMsS0FBSyxDQUFDLGNBQWMsS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFDM0YsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQ2IsMkdBQTJHLENBQzVHLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFDRSxLQUFLLENBQUMsa0JBQWtCLEtBQUssOEJBQThCLENBQUMsUUFBUTtXQUNqRSxLQUFLLENBQUMsa0JBQWtCLEtBQUssOEJBQThCLENBQUMsTUFBTTtXQUNsRSxLQUFLLENBQUMsa0JBQWtCLEtBQUssOEJBQThCLENBQUMsT0FBTyxFQUN0RSxDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix3Q0FBd0MsS0FBSyxrR0FBa0csQ0FDaEosQ0FBQztJQUNKLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDNUIsd0JBQXdCLENBQUMsS0FBSyxDQUFDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzFELENBQUM7U0FBTSxDQUFDO1FBQ04sSUFBSSxLQUFLLENBQUMsS0FBSyxFQUFFLGlCQUFpQixLQUFLLElBQUksRUFBRSxDQUFDO1lBQzVDLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0NBQXdDLEtBQUssa0ZBQWtGLENBQ2hJLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsS0FBSyxFQUFFLGFBQWEsS0FBSyxLQUFLLEVBQUUsQ0FBQztZQUN6QyxNQUFNLElBQUksS0FBSyxDQUNiLHdDQUF3QyxLQUFLLDBCQUEwQixDQUN4RSxDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7SUFDRCxJQUFJLE9BQU8sS0FBSyw0QkFBNEIsQ0FBQyxjQUFjLEVBQUUsQ0FBQztRQUM1RCxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDM0MsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7Ozs7Ozs7O0dBWUc7QUFDSCxTQUFTLHlCQUF5QixDQUNoQyxLQUFnQixFQUNoQixLQUE4QixFQUM5QixLQUFnQztJQUVoQyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsa0JBQWtCLENBQUM7SUFDMUMsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSx1QkFBdUIsQ0FBQztJQUN4RCxJQUFJLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzQixJQUFJLFNBQVMsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM1QixNQUFNLElBQUksS0FBSyxDQUNiLDBHQUEwRyxDQUMzRyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLHFCQUFxQixLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzlDLE1BQU0sSUFBSSxLQUFLLENBQ2IseUZBQXlGLENBQzFGLENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELElBQ0UsUUFBUSxLQUFLLDhCQUE4QixDQUFDLFFBQVE7V0FDakQsUUFBUSxLQUFLLDhCQUE4QixDQUFDLE1BQU07V0FDbEQsUUFBUSxLQUFLLDhCQUE4QixDQUFDLE9BQU8sRUFDdEQsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQ2IsOEdBQThHLENBQy9HLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxTQUFTLEtBQUssU0FBUyxJQUFJLFFBQVEsS0FBSyw4QkFBOEIsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNsRixNQUFNLElBQUksS0FBSyxDQUNiLDBHQUEwRyxDQUMzRyxDQUFDO0lBQ0osQ0FBQztJQUNELElBQ0UsUUFBUSxLQUFLLDhCQUE4QixDQUFDLE9BQU87V0FDaEQsS0FBSyxDQUFDLHFCQUFxQixLQUFLLFNBQVMsRUFDNUMsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQ2IseUZBQXlGLENBQzFGLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxRQUFRLEtBQUssOEJBQThCLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDeEQsSUFBSSxLQUFLLENBQUMsR0FBRyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzVCLE1BQU0sSUFBSSxLQUFLLENBQ2IsNklBQTZJLENBQzlJLENBQUM7UUFDSixDQUFDO1FBQ0QsNkJBQTZCLENBQUMsS0FBSyxDQUFDLHFCQUFxQixDQUFDLENBQUM7UUFDM0QsT0FBTyxRQUFRLENBQUM7SUFDbEIsQ0FBQztJQUNELElBQUksUUFBUSxLQUFLLDhCQUE4QixDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3ZELElBQUksS0FBSyxDQUFDLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM1QixNQUFNLElBQUksS0FBSyxDQUNiLGlLQUFpSyxDQUNsSyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUMvQixNQUFNLElBQUksS0FBSyxDQUNiLGtIQUFrSCxDQUNuSCxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksU0FBUyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzVCLE1BQU0sSUFBSSxLQUFLLENBQ2IsMklBQTJJLENBQzVJLENBQUM7UUFDSixDQUFDO1FBQ0QsT0FBTyxRQUFRLENBQUM7SUFDbEIsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUM1QixJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxZQUFZLE9BQU8sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQzVDLE1BQU0sSUFBSSxLQUFLLENBQ2Isc0tBQXNLLENBQ3ZLLENBQUM7UUFDSixDQUFDO1FBQ0Qsc0NBQXNDLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN6RCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQy9CLE1BQU0sSUFBSSxLQUFLLENBQ2Isc0pBQXNKLENBQ3ZKLENBQUM7SUFDSixDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQztBQUVEOzs7Ozs7OztHQVFHO0FBQ0gsU0FBUyw2QkFBNkIsQ0FDcEMsWUFBa0U7SUFFbEUsSUFBSSxZQUFZLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDL0IsTUFBTSxJQUFJLEtBQUssQ0FDYixvSUFBb0ksQ0FDckksQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxZQUFZLENBQUMsVUFBVSxDQUFDO0lBQzNDLElBQUksT0FBTyxVQUFVLEtBQUssUUFBUSxJQUFJLENBQUMsOEJBQThCLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7UUFDdkYsTUFBTSxJQUFJLEtBQUssQ0FDYixpR0FBaUcsQ0FDbEcsQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLGdCQUFnQixHQUFHLFVBQVUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUNsRCxJQUNFLDJCQUEyQixDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQztXQUM5QyxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDO1dBQ3JDLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUM7V0FDdEMsZ0JBQWdCLENBQUMsVUFBVSxDQUFDLGFBQWEsQ0FBQyxFQUM3QyxDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix3REFBd0QsVUFBVSxnR0FBZ0csQ0FDbkssQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxZQUFZLENBQUMsV0FBVyxDQUFDO0lBQzdDLE1BQU0sbUJBQW1CLEdBQUcsWUFBWSxDQUFDLG1CQUFtQixDQUFDO0lBQzdELE1BQU0sVUFBVSxHQUFHLFdBQVcsS0FBSyxTQUFTLENBQUM7SUFDN0MsTUFBTSxZQUFZLEdBQUcsbUJBQW1CLEtBQUssU0FBUyxDQUFDO0lBQ3ZELElBQUksVUFBVSxLQUFLLFlBQVksRUFBRSxDQUFDO1FBQ2hDLE1BQU0sSUFBSSxLQUFLLENBQ2IsaU1BQWlNLENBQ2xNLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxVQUFVLEVBQUUsQ0FBQztRQUNmLElBQUksT0FBTyxXQUFXLEtBQUssUUFBUSxJQUFJLENBQUMseUJBQXlCLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUM7WUFDcEYsTUFBTSxJQUFJLEtBQUssQ0FDYix1R0FBdUcsQ0FDeEcsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO1NBQU0sQ0FBQztRQUNOLDhCQUE4QixDQUFDLG1CQUFtQixDQUFDLENBQUM7SUFDdEQsQ0FBQztJQUNELElBQUksWUFBWSxDQUFDLHFCQUFxQixLQUFLLFNBQVMsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3RFLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0dBQXdHLENBQ3pHLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxZQUFZLENBQUMsUUFBUSxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxLQUFLLENBQ2IsbUtBQW1LLENBQ3BLLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxTQUFTLDhCQUE4QixDQUFDLElBQXdCO0lBQzlELElBQ0UsT0FBTyxJQUFJLEtBQUssUUFBUTtXQUNyQixJQUFJLENBQUMsTUFBTSxHQUFHLG9DQUFvQztXQUNsRCxDQUFDLGlDQUFpQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7V0FDN0MsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUM7V0FDbEIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFDdEIsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQ2Isd0xBQXdMLENBQ3pMLENBQUM7SUFDSixDQUFDO0lBQ0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDdkUsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLFdBQVcsRUFBRSxDQUFDO0lBQ3ZDLElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxvQ0FBb0MsRUFBRSxDQUFDO1FBQ2hGLE1BQU0sSUFBSSxLQUFLLENBQ2Isa0hBQWtILENBQ25ILENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxLQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssS0FBSyxLQUFLLEVBQUUsQ0FBQztRQUN2QyxNQUFNLElBQUksS0FBSyxDQUNiLDhHQUE4RyxDQUMvRyxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7OztHQU9HO0FBQ0gsU0FBUyxxQkFBcUIsQ0FDNUIsWUFBa0U7SUFFbEUsSUFBSSxZQUFZLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDL0IsTUFBTSxJQUFJLEtBQUssQ0FDYixvSUFBb0ksQ0FDckksQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLFdBQVcsR0FBRyxZQUFZLENBQUMsbUJBQW1CLEtBQUssU0FBUztRQUNoRSxDQUFDLENBQUMsaUJBQWlCLFlBQVksQ0FBQyxtQkFBbUIsSUFBSTtRQUN2RCxDQUFDLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNyQyxPQUFPLEVBQUUsVUFBVSxFQUFFLFlBQVksQ0FBQyxVQUFVLEVBQUUsV0FBVyxFQUFFLENBQUM7QUFDOUQsQ0FBQztBQUVEOzs7Ozs7OztHQVFHO0FBQ0gsU0FBUywyQkFBMkIsQ0FDbEMsS0FBZ0IsRUFDaEIsT0FBeUIsRUFDekIsWUFBa0U7SUFFbEUsTUFBTSxhQUFhLEdBQUcsWUFBWSxFQUFFLG1CQUFtQixDQUFDO0lBQ3hELElBQUksYUFBYSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ2hDLE9BQU87SUFDVCxDQUFDO0lBQ0QsT0FBTyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7UUFDOUMsT0FBTyxFQUFFLENBQUMsa0JBQWtCLENBQUM7UUFDN0IsU0FBUyxFQUFFO1lBQ1QsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsU0FBUyxDQUFDO2dCQUN4QixPQUFPLEVBQUUsS0FBSztnQkFDZCxRQUFRLEVBQUUsV0FBVztnQkFDckIsWUFBWSxFQUFFLGFBQWEsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQzthQUNoRCxDQUFDO1NBQ0g7S0FDRixDQUFDLENBQUMsQ0FBQztJQUNKLElBQUksWUFBWSxFQUFFLHFCQUFxQixLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3RELFlBQVksQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDM0QsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLHdCQUF3QixDQUMvQixZQUFrRTtJQUVsRSxJQUFJLFlBQVksS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMvQixNQUFNLElBQUksS0FBSyxDQUNiLG9JQUFvSSxDQUNySSxDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksWUFBWSxDQUFDLG1CQUFtQixLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ25ELE9BQU87WUFDTCxtQkFBbUIsRUFBRSw4QkFBOEIsQ0FBQyxPQUFPO1lBQzNELHNCQUFzQixFQUFFLFlBQVksQ0FBQyxVQUFVO1lBQy9DLHdCQUF3QixFQUFFLGVBQWU7WUFDekMsZ0NBQWdDLEVBQUUsWUFBWSxDQUFDLG1CQUFtQjtTQUNuRSxDQUFDO0lBQ0osQ0FBQztJQUNELE9BQU87UUFDTCxtQkFBbUIsRUFBRSw4QkFBOEIsQ0FBQyxPQUFPO1FBQzNELHNCQUFzQixFQUFFLFlBQVksQ0FBQyxVQUFVO1FBQy9DLHdCQUF3QixFQUFFLElBQUEsd0JBQVUsRUFBQyxRQUFRLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDO0tBQzlHLENBQUM7QUFDSixDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILFNBQVMscUNBQXFDLENBQzVDLEtBQWdCLEVBQ2hCLEdBQW9CO0lBRXBCLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlCLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsWUFBOEIsQ0FBQztJQUN2RCxLQUFLLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQztRQUN2QixRQUFRLEVBQUUsR0FBRyxFQUFFO1lBQ2IsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyx5QkFBeUIsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO2dCQUM3RCxPQUFPLEVBQUUsQ0FBQztZQUNaLENBQUM7WUFDRCxPQUFPO2dCQUNMLHlJQUF5STthQUMxSSxDQUFDO1FBQ0osQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLG1DQUFtQyxDQUMxQyxLQUFnQixFQUNoQixHQUFvQjtJQUVwQixNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixNQUFNLE1BQU0sR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLFlBQThCLENBQUM7SUFDdkQsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7UUFDdkIsUUFBUSxFQUFFLEdBQUcsRUFBRTtZQUNiLE1BQU0sTUFBTSxHQUFhLEVBQUUsQ0FBQztZQUM1QixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLHlCQUF5QixDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7Z0JBQzdELE1BQU0sQ0FBQyxJQUFJLENBQ1QsdUlBQXVJLENBQ3hJLENBQUM7WUFDSixDQUFDO1lBQ0QsTUFBTSxRQUFRLEdBQUcsd0JBQXdCLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3RELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDMUIsTUFBTSxDQUFDLElBQUksQ0FDVCwwSEFBMEgsQ0FDM0gsQ0FBQztZQUNKLENBQUM7WUFDRCxNQUFNLE9BQU8sR0FBRyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDdEMsS0FBSyxNQUFNLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FDekIsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLGVBQWUsQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQzt3QkFDOUMsZUFBZSxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLENBQ2pELENBQUM7Z0JBQ0YsSUFBSSxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7b0JBQ3pCLE1BQU0sQ0FBQyxJQUFJLENBQ1Qsd0VBQXdFLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxvRkFBb0YsQ0FDOUssQ0FBQztvQkFDRixTQUFTO2dCQUNYLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssRUFBRSxNQUFNLENBQUMsRUFBRSxDQUFDO29CQUNyQyxNQUFNLENBQUMsSUFBSSxDQUNULHVJQUF1SSxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksR0FBRyxDQUNuTCxDQUFDO2dCQUNKLENBQUM7WUFDSCxDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUM7UUFDaEIsQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLEtBQVksRUFBRSxNQUE2QjtJQUNuRSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0lBQy9ELElBQUksUUFBUSxLQUFLLFNBQVMsSUFBSSxRQUFRLEtBQUssSUFBSSxJQUFJLE9BQU8sUUFBUSxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ2hGLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUNELE1BQU0sY0FBYyxHQUFHLFFBQW1DLENBQUM7SUFDM0QsTUFBTSxhQUFhLEdBQUcsY0FBYyxDQUFDLGFBQWEsSUFBSSxjQUFjLENBQUMsYUFBYSxDQUFDO0lBQ25GLE9BQU8sYUFBYSxLQUFLLFNBQVMsSUFBSSxhQUFhLEtBQUssSUFBSSxJQUFJLGFBQWEsS0FBSyxFQUFFLENBQUM7QUFDdkYsQ0FBQztBQUVELGlGQUFpRjtBQUNqRixTQUFTLHdCQUF3QixDQUMvQixLQUFnQixFQUNoQixHQUFxQjtJQUVyQixNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixNQUFNLE1BQU0sR0FBRyxlQUFlLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNqRCxNQUFNLEtBQUssR0FBNEIsRUFBRSxDQUFDO0lBQzFDLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBZSxFQUFRLEVBQUU7UUFDdEMsSUFBSSxJQUFJLFlBQVksT0FBTyxDQUFDLGFBQWEsSUFBSSxlQUFlLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztZQUMzRixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ25CLENBQUM7UUFDRCxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDdkMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2YsQ0FBQztJQUNILENBQUMsQ0FBQztJQUNGLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNiLE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEtBQWdCO0lBQ3RDLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlCLE1BQU0sS0FBSyxHQUE0QixFQUFFLENBQUM7SUFDMUMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxJQUFlLEVBQVEsRUFBRTtRQUN0QyxJQUFJLElBQUksWUFBWSxPQUFPLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDMUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNuQixDQUFDO1FBQ0QsS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ3ZDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDLENBQUM7SUFDRixLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDYixPQUFPLEtBQUssQ0FBQztBQUNmLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBUyxzQ0FBc0MsQ0FDN0MsS0FBZ0IsRUFDaEIsR0FBcUI7SUFFckIsTUFBTSxLQUFLLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUIsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7UUFDdkIsUUFBUSxFQUFFLEdBQUcsRUFBRTtZQUNiLE1BQU0sT0FBTyxHQUFHLGlCQUFpQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztZQUM5QyxJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ3pCLE9BQU87b0JBQ0wsc0xBQXNMO2lCQUN2TCxDQUFDO1lBQ0osQ0FBQztZQUNELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztnQkFDakUsT0FBTztvQkFDTCxtSkFBbUo7aUJBQ3BKLENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTyxFQUFFLENBQUM7UUFDWixDQUFDO0tBQ0YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVELG9FQUFvRTtBQUNwRSxTQUFTLGlCQUFpQixDQUFDLEtBQWdCLEVBQUUsR0FBcUI7SUFDaEUsTUFBTSxLQUFLLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUIsTUFBTSxNQUFNLEdBQUcsZUFBZSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakQsTUFBTSxLQUFLLEdBQXFCLEVBQUUsQ0FBQztJQUNuQyxNQUFNLEtBQUssR0FBRyxDQUFDLElBQWUsRUFBUSxFQUFFO1FBQ3RDLElBQUksSUFBSSxZQUFZLE9BQU8sQ0FBQyxNQUFNLElBQUksZUFBZSxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssTUFBTSxFQUFFLENBQUM7WUFDbEYsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNuQixDQUFDO1FBQ0QsS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ3ZDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDLENBQUM7SUFDRixLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDYixPQUFPLEtBQUssQ0FBQztBQUNmLENBQUM7QUFFRCxTQUFTLHdCQUF3QixDQUMvQixPQUF3RCxFQUN4RCxLQUFhO0lBRWIsSUFBSSxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FDYix3Q0FBd0MsS0FBSywrRkFBK0YsQ0FDN0ksQ0FBQztJQUNKLENBQUM7SUFDRCxJQUFJLE9BQU8sQ0FBQyxhQUFhLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDbkMsTUFBTSxJQUFJLEtBQUssQ0FDYix3Q0FBd0MsS0FBSyxxREFBcUQsQ0FDbkcsQ0FBQztJQUNKLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBZ0UsT0FBTyxDQUFDLFVBQVUsQ0FBQztJQUNuRyxNQUFNLFNBQVMsR0FBRyxVQUFVLEVBQUUsU0FBUyxDQUFDO0lBQ3hDLE1BQU0sVUFBVSxHQUFHLFVBQVUsRUFBRSxVQUFVLENBQUM7SUFDMUMsSUFDRSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDO1dBQ3ZCLFNBQW9CLElBQUksQ0FBQztXQUMxQixDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDO1dBQzNCLFVBQXFCLElBQUksQ0FBQyxFQUM5QixDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix3Q0FBd0MsS0FBSyw4RkFBOEYsQ0FDNUksQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxvQkFBb0IsQ0FBQyxNQUF3QztJQUNwRSxJQUFJLE1BQU0sS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN6QixNQUFNLElBQUksS0FBSyxDQUNiLDJFQUEyRSxDQUM1RSxDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksTUFBTSxDQUFDLFVBQVUsS0FBSyxTQUFTLElBQUksTUFBTSxDQUFDLFVBQVUsS0FBSyxzQkFBc0IsRUFBRSxDQUFDO1FBQ3BGLE1BQU0sSUFBSSxLQUFLLENBQ2IsdURBQXVELHNCQUFzQixFQUFFLENBQ2hGLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxNQUFNLENBQUMsVUFBVSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDN0UsTUFBTSxPQUFPLEdBQUcsVUFBVSxDQUFDLE1BQU0sS0FBSyxxQkFBcUIsQ0FBQyxNQUFNO2VBQzdELHFCQUFxQixDQUFDLEtBQUssQ0FDNUIsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssS0FBSyxTQUFTLENBQUMsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUM5RSxDQUFDO1FBQ0osSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ2IsTUFBTSxJQUFJLEtBQUssQ0FDYiwrREFBK0QsSUFBSSxDQUFDLFNBQVMsQ0FBQyxxQkFBcUIsQ0FBQyxFQUFFLENBQ3ZHLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLEtBQWEsRUFBRSxVQUFtQixFQUFFLE9BQWU7SUFDbEYsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLElBQUksTUFBdUIsQ0FBQztJQUM1QixJQUFJLENBQUM7UUFDSCxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDNUIsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLHNFQUFzRTtJQUN4RSxDQUFDO0lBQ0QsSUFDRSxDQUFDLE1BQU07V0FDSixDQUFDLDZCQUE2QixDQUFDLE9BQU8sQ0FBQztXQUN2QyxNQUFNLENBQUMsUUFBUSxLQUFLLFFBQVE7V0FDNUIsQ0FBQyxNQUFNLENBQUMsUUFBUTtXQUNoQixNQUFNLENBQUMsUUFBUSxLQUFLLEVBQUU7V0FDdEIsTUFBTSxDQUFDLFFBQVEsS0FBSyxFQUFFO1dBQ3RCLDhCQUE4QixDQUFDLE9BQU8sQ0FBQztXQUN2QyxDQUFDLENBQUMsVUFBVSxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7V0FDdEMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFDeEIsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsdUJBQXVCLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFDcEQsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxNQUFjO0lBQ2xDLFFBQVEsTUFBTSxFQUFFLENBQUM7UUFDZixLQUFLLE1BQU0sQ0FBQyxDQUFDLE9BQU8sT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7UUFDNUMsS0FBSyxLQUFLLENBQUMsQ0FBQyxPQUFPLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1FBQzFDLEtBQUssUUFBUSxDQUFDLENBQUMsT0FBTyxPQUFPLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQztRQUNoRDtZQUNFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0RBQXNELE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDcEYsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHNCQUFzQixDQUFDLEtBQWEsRUFBRSxRQUFnQjtJQUM3RCxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsUUFBUSw0QkFBNEIsQ0FBQyxDQUFDO0lBQy9FLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxLQUFhLEVBQUUsUUFBZ0I7SUFDOUQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQzNDLE1BQU0sSUFBSSxLQUFLLENBQUMsdUJBQXVCLFFBQVEsNkJBQTZCLENBQUMsQ0FBQztJQUNoRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsZUFBZTtJQUN0QixPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixFQUFFLEVBQUUsNEJBQTRCO1FBQ2hDLFdBQVcsRUFBRSxzQkFBc0I7UUFDbkMsVUFBVSxFQUFFLHFCQUFxQjtRQUNqQyxRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixjQUFjLEVBQUUseUJBQXlCO1FBQ3pDLGtCQUFrQixFQUFFLDZCQUE2QjtLQUNsRCxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxtQkFBbUIsQ0FBQyxVQUFrQixFQUFFLElBQXlCO0lBQ3hFLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNoRSxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZFLElBQUksQ0FBQyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0IsSUFBSSxJQUFJLEtBQUssUUFBUTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLElBQUksUUFBUSxFQUFFLENBQUM7SUFDOUIsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ3RFLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsQ0FBQyxLQUFhO0lBQ2xELE1BQU0sU0FBUyxHQUFHLGtDQUFrQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RFLE9BQU8sU0FBUyxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUVELFNBQVMsOEJBQThCLENBQUMsS0FBYTtJQUNuRCxNQUFNLFNBQVMsR0FBRyx3Q0FBd0MsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxPQUFPLFNBQVMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDO0FBQzNDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIH0gZnJvbSBcIi4vbWNwLXJvdXRlLWFsZ2VicmFcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyB9IGZyb20gXCIuL2h0dHAtYXBpXCI7XG5pbXBvcnQgeyBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQgfSBmcm9tIFwiLi9yb3V0ZS1pZHNcIjtcblxuY29uc3QgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQgPSBcIlJvdXRlQW55Um9vdFwiO1xuY29uc3QgQ09OU09MSURBVEVEX1BST1hZX1JPVVRFX0lEID0gXCJSb3V0ZUFueVByb3h5XCI7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVCA9IDEwMDtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVCA9IDIwMDtcbmNvbnN0IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUyA9IDYwO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lEID0gXCJNY3BUcmFuc3BvcnRBdXRob3JpemVyXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZID0gXCJhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQgPSBcIm0xNy5tY3AtdHJhbnNwb3J0LXBvc3R1cmUvdjFcIjtcbmNvbnN0IE1DUF9ERU5JQUxfTUVUUklDX05BTUUgPSBcImFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRcIjtcbmNvbnN0IE1DUF9ERU5JQUxfRElNRU5TSU9OUyA9IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl07XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IEZST05UX0RPT1JfSEVBREVSX05BTUVfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS1dezEsNjR9JC87XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBzZWNyZXQgYWxwaGFiZXQ6IGhlYWRlci12YWx1ZS1zYWZlLCBubyB3aGl0ZXNwYWNlIG9yIGNvbnRyb2xzLiAqL1xuY29uc3QgRlJPTlRfRE9PUl9TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqXG4gKiBBIHdlbGwta25vd24gU1NNIHBhcmFtZXRlciBuYW1lLCBpbiB0aGUgYWxwaGFiZXQgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYFxuICogZHluYW1pYyByZWZlcmVuY2UgYWNjZXB0cy5cbiAqXG4gKiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vQVdTQ2xvdWRGb3JtYXRpb24vbGF0ZXN0L1VzZXJHdWlkZS9keW5hbWljLXJlZmVyZW5jZXMtc3NtLmh0bWxcbiAqL1xuY29uc3QgRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9QQVRURVJOID0gL15cXC9bQS1aYS16MC05Xy5cXC0vXSskLztcblxuLyoqXG4gKiBUaGUgU1NNIHBhcmFtZXRlci1uYW1lIGxpbWl0czogMTAxMSBjaGFyYWN0ZXJzIGluY2x1ZGluZyB0aGUgQVJOIHByZWZpeCwgYVxuICogZmlmdGVlbi1sZXZlbCBoaWVyYXJjaHksIGFuZCBubyBgYXdzYC9gc3NtYCBwcmVmaXguXG4gKlxuICogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL3N5c3RlbXMtbWFuYWdlci9sYXRlc3QvQVBJUmVmZXJlbmNlL0FQSV9QdXRQYXJhbWV0ZXIuaHRtbFxuICovXG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRU5HVEggPSAxMDExO1xuY29uc3QgRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVWRUxTID0gMTU7XG5cbi8qKlxuICogUmVxdWVzdCBoZWFkZXJzIGEgZnJvbnQgZG9vciBjYW4gbmV2ZXIgY2FycnkgdGhlIHZlcmlmaWNhdGlvbiBpbjogdGhleSBlaXRoZXJcbiAqIHJld3JpdGUgdGhlIG9yaWdpbiByZXF1ZXN0IGNvbnRyYWN0IG9yIGFyZSBwbGF0Zm9ybS1tYW5hZ2VkLCBzbyBhIGRlY2xhcmVkXG4gKiB2YWx1ZSBjb3VsZCBub3QgYmUgdmVyaWZpZWQgdGhlIHdheSB0aGUgcnVudGltZSByZWFkcyBpdC5cbiAqL1xuY29uc3QgUkVTRVJWRURfRlJPTlRfRE9PUl9IRUFERVJTID0gbmV3IFNldChbXG4gIFwiYXV0aG9yaXphdGlvblwiLFxuICBcImNvbm5lY3Rpb25cIixcbiAgXCJjb250ZW50LWxlbmd0aFwiLFxuICBcImNvb2tpZVwiLFxuICBcImhvc3RcIixcbiAgXCJ0cmFuc2Zlci1lbmNvZGluZ1wiLFxuICBcInd3dy1hdXRoZW50aWNhdGVcIixcbiAgXCJ4LWZvcndhcmRlZC1mb3JcIixcbl0pO1xuXG5cbi8qKiBSb3V0ZS1lbWlzc2lvbiBtb2RlbCBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbCB7XG4gIC8qKlxuICAgKiBPbmUgQVBJIEdhdGV3YXkgSFRUUCBBUEkgdjIgcm91dGUgcGVyIGRlcml2ZWQgcm91dGUga2V5LiBUaGlzIGlzIHRoZVxuICAgKiBjb25zdHJ1Y3QncyBoaXN0b3JpY2FsIGludmVudG9yeSBhbmQgc3RheXMgYnl0ZS1pZGVudGljYWwgZm9yIGRlcGxveWVkXG4gICAqIHN0YWNrcywgc28gYSBgcm91dGVNb2RlbDogZXhwbGljaXRgIHVwZ3JhZGUgZGVwbG95cyBpbiBwbGFjZS4gVGhlIGRlZmF1bHQuXG4gICAqL1xuICBFWFBMSUNJVCA9IFwiZXhwbGljaXRcIixcbiAgLyoqXG4gICAqIFR3byBncmVlZHkgcm91dGVzLCBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAsIGJhY2tlZCBieSBvbmUgc2hhcmVkXG4gICAqIGludGVncmF0aW9uLiBUaGUgQXBwVGhlb3J5IHJ1bnRpbWUgcm91dGVyIHBlcmZvcm1zIG1ldGhvZCBhbmQgcGF0aFxuICAgKiBkaXNwYXRjaCwgcGF0aC1wYXJhbWV0ZXIgY2FwdHVyZSwgYW5kIGRlbmlhbC4gQ29uc29saWRhdGlvbiBuZXZlciBjaGFuZ2VzXG4gICAqIGdhdGV3YXkgYWRtaXNzaW9uLCBzbyBpdCBpcyB2YWxpZCBvbmx5IHdoZW4gZXZlcnkgZ2F0ZXdheSByb3V0ZSBpcyBgTk9ORWA6XG4gICAqIHRoZSBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgIHRyYW5zcG9ydCBwb3N0dXJlcy4gYGlhbWAgYW5kIGBqd3RgXG4gICAqIGFyZSByZWZ1c2VkIGF0IHN5bnRoZXNpcyB0aW1lLlxuICAgKi9cbiAgQ09OU09MSURBVEVEID0gXCJjb25zb2xpZGF0ZWRcIixcbn1cblxuLyoqIENvbnN0cnVjdC1pZCBkZXJpdmF0aW9uIGZvciB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZSB7XG4gIC8qKlxuICAgKiBQb3NpdGlvbmFsIGlkcyAoYFJvdXRlMGAsIGBSb3V0ZTFgLCAuLi4pIGFzc2lnbmVkIGluIGVtaXNzaW9uIG9yZGVyLiBUaGlzXG4gICAqIGlzIHRoZSBjb25zdHJ1Y3QncyBoaXN0b3JpY2FsIGludmVudG9yeSBhbmQgc3RheXMgYnl0ZS1pZGVudGljYWwgZm9yXG4gICAqIGRlcGxveWVkIHN0YWNrcy4gVGhlIGRlZmF1bHQuXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxuICAvKipcbiAgICogSWRzIGRlcml2ZWQgZnJvbSB0aGUgcm91dGUgbWV0aG9kIGFuZCBwYXR0ZXJuLCBzbyBpbnNlcnRpbmcsIHJlbW92aW5nLCBvclxuICAgKiByZW9yZGVyaW5nIGEgcm91dGUgZmFtaWx5IG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlLiBJbnRlbmRlZCBmb3JcbiAgICogbmV3bHkgY3JlYXRlZCBleHBsaWNpdCBBUElzOiBzd2l0Y2hpbmcgYW4gZXhpc3RpbmcgZGVwbG95ZWQgZXhwbGljaXQgQVBJXG4gICAqIGZyb20gYGxlZ2FjeWAgdG8gYHNlbWFudGljYCBpbiBwbGFjZSByZW5hbWVzIGV2ZXJ5IHJvdXRlLCB3aGljaCBpcyBpdHNlbGYgYVxuICAgKiBjcmVhdGUtYmVmb3JlLWRlbGV0ZSBjb2xsaXNpb24uIEFkb3B0IGl0IG9uIGFuIGV4aXN0aW5nIHN0YWNrIG9ubHkgdGhyb3VnaFxuICAgKiB0aGUgbmV3LUFQSSBzd2FwIGRlc2NyaWJlZCBpbiBgVVBHUkFESU5HLm1kYC5cbiAgICovXG4gIFNFTUFOVElDID0gXCJzZW1hbnRpY1wiLFxufVxuXG4vKiogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuIFRoZSBkZWZhdWx0IGZvciBhIHNlcnZlciB3aXRoIG5vIGZhY2FkZSBhdHRhY2htZW50LiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogQSBzdGF0aWMgSldUIGF1dGhvcml6ZXIgKGlzc3VlciArIGF1ZGllbmNlKSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gKi9cbiAgSldUID0gXCJqd3RcIixcbiAgLyoqIFRoZSBnYXRld2F5IGF1dGhvcml6ZXIgaXMgTk9ORSBhbmQgdGhlIHJ1bnRpbWUgdmFsaWRhdGVzIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMuIFRoZSBkZWZhdWx0IGZvciBhIGZhY2FkZS1jb25maWd1cmVkIHNlcnZlci4gKi9cbiAgUlVOVElNRV9CRUFSRVIgPSBcInJ1bnRpbWUtYmVhcmVyXCIsXG4gIC8qKiBEZWxpYmVyYXRlbHkgcHVibGljIE1DUCBzZXJ2ZXI6IGV2ZXJ5IHRyYW5zcG9ydCByb3V0ZSBpcyBwdWJsaWMuIE5ldmVyIGEgZGVmYXVsdC4gKi9cbiAgTk9ORV9QVUJMSUMgPSBcIm5vbmUtcHVibGljXCIsXG59XG5cbi8qKiBQcmVzZW5jZS1vbmx5IHNrZWxldG9uIG9mIHRoZSB1cHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgc2VsZWN0cyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50IHtcbiAgLyoqIElkZW50aWZpZXMgdGhlIHVwc3RyZWFtIGF1dGhvcml6YXRpb24gcHJvdmlkZXIgdGhpcyBzZXJ2ZXIgZnJvbnRzIChmb3IgZXhhbXBsZSBgYXV0aGVvcnlgKS4gUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUgYW5kIHVzZXMgaXRzIHByZXNlbmNlIHRvIHNlbGVjdCB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBkZWZhdWx0LiAqL1xuICByZWFkb25seSBwcm92aWRlcklkOiBzdHJpbmc7XG59XG5cbi8qKiBSdW50aW1lLXNpZGUgZGVjbGFyYXRpb24gdGhhdCB0aGUgdHJhbnNwb3J0IHJvdXRlcyB2YWxpZGF0ZSBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zIGF0IHJ1bnRpbWUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucyB7XG4gIC8qKiBBc3NlcnQgdGhlIHJ1bnRpbWUgcmVnaXN0ZXJzIHRoZSB0cmFuc3BvcnQgcm91dGVzIHdpdGggdGhlIHJ1bnRpbWUtdmFsaWRhdGVkIGJlYXJlciBwb3N0dXJlIChHbyBgRmFjYWRlQ29uZmlnLlJlcXVpcmVCZWFyZXJUb2tlbmAsIFRTIGByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlYCwgUHl0aG9uIGByZXF1aXJlX2JlYXJlcl90b2tlbl9taWRkbGV3YXJlYCkuIE11c3QgYmUgYHRydWVgLiAqL1xuICByZWFkb25seSByZXF1aXJlQmVhcmVyVG9rZW46IGJvb2xlYW47XG59XG5cbi8qKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGV4ZWN1dGUtYXBpIGRlZmF1bHQgZW5kcG9pbnQgYW5kIGFkdmVydGlzZSBhbiBvd25lZCBvcmRpbmFyeVxuICAgKiBjdXN0b20gZG9tYWluIGFzIHRoZSBvbmx5IE1DUCBhdXRob3JpdHkuXG4gICAqL1xuICBESVNBQkxFRCA9IFwiZGlzYWJsZWRcIixcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGV4ZWN1dGUtYXBpIGRlZmF1bHQgZW5kcG9pbnQgYW5kIHJlcXVpcmUgbXV0dWFsIFRMUyBvbiBldmVyeVxuICAgKiBjdXN0b20gZG9tYWluIG1hcHBlZCB0byB0aGUgY29uc3RydWN0LW93bmVkIEFQSS4gVGhlIG93bmVkIGRvbWFpbidzXG4gICAqIGBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgaXMgdGhlIGNvbmNyZXRlIGxvY2s7IGFuIGVudW0gYWxvbmUgb3IgYW5cbiAgICogZXh0ZXJuYWwvYXR0YWNoZWQgZnJvbnQgZG9vciBuZXZlciBzYXRpc2ZpZXMgaXQuXG4gICAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxuICAvKipcbiAgICogVGhlIG9yaWdpbiBzdGF5cyBkaXJlY3RseSByZWFjaGFibGUgYXQgaXRzIGV4ZWN1dGUtYXBpIGVuZHBvaW50IGFuZCBpc1xuICAgKiBzZXJ2ZWQgb25seSB0aHJvdWdoIGFuIGFwcGxpY2F0aW9uLW93bmVkIGZyb250IGRvb3IgdGhhdCBpbmplY3RzXG4gICAqIGBmcm9udERvb3JWZXJpZmljYXRpb25gIG9uIGV2ZXJ5IG9yaWdpbiByZXF1ZXN0LlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBwb3N0dXJlIGZvciBhbiBhcHAtb3duZWQgZGlzdHJpYnV0aW9uIHdob3NlIG9yaWdpbiBpcyB0aGVcbiAgICogZXhlY3V0ZS1hcGkgaG9zdG5hbWU6IHRoZSBjb25zdHJ1Y3Qgc2VlcyBuZWl0aGVyIHRoZSBkaXN0cmlidXRpb24gbm9yIHRoZVxuICAgKiBBUEkncyBlbmRwb2ludCBjb25maWd1cmF0aW9uLCBzbyBpdCBjYW5ub3QgcHJvZHVjZSBpbi1zdGFjayBldmlkZW5jZSB0aGVcbiAgICogd2F5IGBESVNBQkxFRGAgYW5kIGBMT0NLRURgIGRvLiBWYWxpZCBvbmx5IGluIGF0dGFjaCBtb2RlLCBhY2NlcHRlZCB3aXRoXG4gICAqIGBSVU5USU1FX0JFQVJFUmAgYW5kIGBOT05FX1BVQkxJQ2AgbGlrZSB0aGUgb3RoZXIgZGVjaXNpb25zLCBhbmQgaXRcbiAgICogcmVxdWlyZXMgdGhlIG1hbmRhdG9yeSBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvbi5cbiAgICpcbiAgICogYEZST05URURgIGlzIGEgZGVmZW5zZS1pbi1kZXB0aCBkZWNsYXJhdGlvbiB3aXRoIHJ1bnRpbWUgZW5mb3JjZW1lbnQsIG5vdFxuICAgKiBtdXR1YWwtVExTIGFzc3VyYW5jZSBhbmQgbm90IG9yaWdpbiB1bnJlYWNoYWJpbGl0eS4gVGhlIGVuZm9yY2VtZW50IGlzIHRoZVxuICAgKiBydW50aW1lJ3MgZnJvbnQtZG9vciBoZWFkZXIgY2hlY2sgKGBtY3BmYWNhZGUuRmFjYWRlQ29uZmlnYFxuICAgKiBgRnJvbnREb29yVmVyaWZpY2F0aW9uYCBpbiBHbywgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgaW4gVHlwZVNjcmlwdCxcbiAgICogYGZyb250X2Rvb3JfdmVyaWZpY2F0aW9uYCBpbiBQeXRob24pOiBpdCByZWZ1c2VzIGV2ZXJ5IGRlcml2ZWQgcm91dGUgd2hlblxuICAgKiB0aGUgZGVjbGFyZWQgaGVhZGVyIGlzIGFic2VudCBvciB3cm9uZywgYW5kIGZhaWxzIHJlZ2lzdHJhdGlvbiB3aGVuXG4gICAqIGBGUk9OVEVEYCBpcyBkZWNsYXJlZCB3aXRob3V0IGl0LiBBbiB1bndpcmVkIHJ1bnRpbWUgZW5mb3JjZXMgbm90aGluZy5cbiAgICovXG4gIEZST05URUQgPSBcImZyb250ZWRcIixcbn1cblxuLyoqXG4gKiBGcm9udC1kb29yIHZlcmlmaWNhdGlvbiBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAuXG4gKlxuICogQXR0YWNoIG1vZGUgbWVhbnMgdGhlIGZyb250IGRvb3IgaXMgYXBwbGljYXRpb24tb3duZWQsIHNvIHRoZSBjb25zdHJ1Y3RcbiAqIGNhbm5vdCBpbmplY3QgdGhlIGhlYWRlciBpdHNlbGYgYW5kIGNhbm5vdCBvYnNlcnZlIHRoZSBkaXN0cmlidXRpb24uIFRoZVxuICogZGVjbGFyYXRpb24gdGhlcmVmb3JlIGNhcnJpZXMgdGhyZWUgaW5kZXBlbmRlbnRseSB3aXJlZCBjb3BpZXMgdGhhdCBtdXN0IGNvbWVcbiAqIGZyb20gb25lIGFwcGxpY2F0aW9uLW93bmVkIGNvbnN0YW50OiB0aGlzIHByb3AsIHRoZSBkaXN0cmlidXRpb24ncyBvcmlnaW5cbiAqIGN1c3RvbS1oZWFkZXIgY29uZmlndXJhdGlvbiwgYW5kIHRoZSBydW50aW1lJ3MgZnJvbnQtZG9vciB2ZXJpZmljYXRpb25cbiAqIGNvbmZpZy4gVGhlIGNvbnN0cnVjdCBwcm92ZXMgb25seSBpdHMgb3duIGNvcHkuXG4gKlxuICogU3VwcGx5IGV4YWN0bHkgb25lIG9mIGBzZWNyZXRWYWx1ZWAgYW5kIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYDpcbiAqXG4gKiAtIGBzZWNyZXRWYWx1ZWAgaXMgdGhlIHY3LjMgbGl0ZXJhbCBmb3JtLiBJdCBpcyBjb25zdW1lZCBhdCBzeW50aGVzaXMgZm9yXG4gKiAgIHZhbGlkYXRpb24gYW5kIHRoZSByZWNvcmRlZCBTSEEtMjU2IGRpZ2VzdCBvbmx5LCBhbmQgaXQgbmV2ZXIgbGFuZHMgaW4gdGhlXG4gKiAgIGNvbnN0cnVjdCdzIG93biBzeW50aGVzaXplZCB0ZW1wbGF0ZS5cbiAqIC0gYHNlY3JldFBhcmFtZXRlck5hbWVgIG5hbWVzIGEgd2VsbC1rbm93biwgc3RhZ2UtcXVhbGlmaWVkIFBhcmFtZXRlciBTdG9yZVxuICogICBwYXJhbWV0ZXIgdGhhdCB0aGUgYXBwbGljYXRpb24ncyBpbnN0YWxsZXIgY3JlYXRlcyBpZiBhYnNlbnQuIFRoZSB2YWx1ZVxuICogICBuZXZlciBlbnRlcnMgdGhlIGFwcGxpY2F0aW9uIHNvdXJjZTogdGhlIGNvbnN0cnVjdCByZW5kZXJzIHRoZSBoZWFkZXIgdmFsdWVcbiAqICAgYXMgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljIHJlZmVyZW5jZSBhbmQgcmVjb3JkcyB0aGUgcGFyYW1ldGVyIG5hbWVcbiAqICAgaW5zdGVhZCBvZiBhIGRpZ2VzdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gcmVxdWVzdCBoZWFkZXIgdGhlIGZyb250IGRvb3IgaW5qZWN0cyBvbiBldmVyeSByZXF1ZXN0IGl0IHNlbmRzXG4gICAqIHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDEgdG8gNjQgY2hhcmFjdGVycyBvZiBgW0EtWmEtejAtOS1dYCwgYW5kIG5ldmVyIGEgcmVxdWVzdCBoZWFkZXIgdGhhdFxuICAgKiByZXdyaXRlcyB0aGUgb3JpZ2luIGNvbnRyYWN0IChgSG9zdGAsIGBBdXRob3JpemF0aW9uYCwgYENvb2tpZWAsXG4gICAqIGBDb250ZW50LUxlbmd0aGAsIGBUcmFuc2Zlci1FbmNvZGluZ2AsIGBDb25uZWN0aW9uYCwgYFdXVy1BdXRoZW50aWNhdGVgLFxuICAgKiBgWC1Gb3J3YXJkZWQtRm9yYCksIGFueSBgeC1hbXotKmAvYHgtYW16bi0qYC9gY2xvdWRmcm9udC0qYCBuYW1lLCBvciBhXG4gICAqIGhvcC1ieS1ob3AgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGhlYWRlck5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBmcm9udC1kb29yIGhlYWRlciB2YWx1ZS5cbiAgICpcbiAgICogMzIgdG8gMTI4IGNoYXJhY3RlcnMgb2YgYFtBLVphLXowLTkuX34tXWA6IGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXRcbiAgICogd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBubyBjb250cm9sIGNoYXJhY3RlcnMuIFRoZSB2YWx1ZSBpcyBjb25zdW1lZCBhdFxuICAgKiBzeW50aGVzaXMgZm9yIHZhbGlkYXRpb24gYW5kIHRoZSByZWNvcmRlZCBTSEEtMjU2IGRpZ2VzdCBvbmx5IOKAlCB0aGUgbGl0ZXJhbFxuICAgKiBuZXZlciBsYW5kcyBpbiB0aGUgY29uc3RydWN0J3Mgc3ludGhlc2l6ZWQgdGVtcGxhdGUgb3IgaW4gQ2xvdWRGb3JtYXRpb24uXG4gICAqIEl0IGlzIG5vdCBhIGNyZWRlbnRpYWwgc3RvcmU7IHJvdGF0aW9uIG1lYW5zIGNoYW5naW5nIHRoZSB2YWx1ZSBhbmRcbiAgICogcmVkZXBsb3lpbmcsIGFuZCBpdCBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBzZWNyZXQgdGhhdCBwcm90ZWN0c1xuICAgKiBhbnl0aGluZyBlbHNlLlxuICAgKlxuICAgKiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBgc2VjcmV0UGFyYW1ldGVyTmFtZWAuIFByZWZlciB0aGUgcGFyYW1ldGVyIGZvcm06XG4gICAqIGEgY29tbWl0dGVkIGxpdGVyYWwgaXMgZXhhY3RseSB3aGF0IHRoZSBwYXJhbWV0ZXIgZm9ybSByZW1vdmVzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFZhbHVlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgd2VsbC1rbm93biwgc3RhZ2UtcXVhbGlmaWVkIFBhcmFtZXRlciBTdG9yZSBwYXJhbWV0ZXIgdGhhdCBob2xkcyB0aGVcbiAgICogZnJvbnQtZG9vciBzZWNyZXQuXG4gICAqXG4gICAqIEEgZnVsbHkgcXVhbGlmaWVkIG5hbWUgZnJvbSBgL2AsIGF0IG1vc3QgMTAxMSBjaGFyYWN0ZXJzIGFuZCBmaWZ0ZWVuXG4gICAqIGxldmVscywgaW4gdGhlIGBbQS1aYS16MC05Xy5cXC0vXWAgYWxwaGFiZXQgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljXG4gICAqIHJlZmVyZW5jZSBhY2NlcHRzLCBhbmQgbmV2ZXIgaW4gdGhlIHJlc2VydmVkIGBhd3NgL2Bzc21gIGhpZXJhcmNoeS5cbiAgICpcbiAgICogVGhlIHBhcmFtZXRlciBtdXN0IGJlIHR5cGUgKipTdHJpbmcqKiwgbm90IFNlY3VyZVN0cmluZzogQ2xvdWRGcm9udCdzXG4gICAqIGBPcmlnaW5DdXN0b21IZWFkZXJzYCBzdXBwb3J0cyB0aGUgcGxhaW50ZXh0IGBzc21gIHJlZmVyZW5jZSBvbmx5LCBhbmQgQVdTXG4gICAqIGxpc3RzIHRoZSBwcm9wZXJ0aWVzIHRoYXQgc3VwcG9ydCBgc3NtLXNlY3VyZWAgZXhoYXVzdGl2ZWx5IChDbG91ZEZyb250IGlzXG4gICAqIG5vdCBvbmUgb2YgdGhlbSkuIFRoZSB2YWx1ZSBpcyB0aGVyZWZvcmUgZGVmZW5zZS1pbi1kZXB0aCBhZ2FpbnN0IGRpcmVjdFxuICAgKiBvcmlnaW4gYWNjZXNzLCBub3QgYSBjb25maWRlbnRpYWxpdHkgY29udHJvbCDigJQgdGhlIHNhbWUgcG9zdHVyZSBhcyB0aGVcbiAgICogbGl0ZXJhbCBmb3JtLCB3aGljaCBDbG91ZEZyb250IGFscmVhZHkgZXhwb3NlcyB0aHJvdWdoXG4gICAqIGBHZXREaXN0cmlidXRpb25Db25maWdgLlxuICAgKlxuICAgKiBgZnJvbnREb29yT3JpZ2luSGVhZGVyYCByZW5kZXJzIHRoZSBkeW5hbWljIHJlZmVyZW5jZSBmb3IgdGhlIGRpc3RyaWJ1dGlvblxuICAgKiB0aGUgYXBwIHdpcmVzLCBlLmcuIGB7e3Jlc29sdmU6c3NtOi90aGVvcnljbG91ZC90bXMvbGFiL2Zyb250ZWQtdG9rZW59fWAsXG4gICAqIGFuZCB0aGUgY29uc3RydWN0IGdyYW50cyBgc3NtOkdldFBhcmFtZXRlcmAgb24gZXhhY3RseSB0aGlzIHBhcmFtZXRlciB0b1xuICAgKiBgaGFuZGxlcmAuIEEgc3RhY2sgdXBkYXRlIHJlLXJlc29sdmVzIHRoZSBsYXRlc3QgcGFyYW1ldGVyIHZlcnNpb247IGRyaWZ0XG4gICAqIGRldGVjdGlvbiBkb2VzIG5vdCBzZWUgZHluYW1pYyByZWZlcmVuY2VzLlxuICAgKlxuICAgKiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBgc2VjcmV0VmFsdWVgLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFBhcmFtZXRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjdXN0b21lciBtYW5hZ2VkIGtleSB0aGF0IGVuY3J5cHRzIHRoZSBwYXJhbWV0ZXIgd2hlbiBpdCBpcyBhXG4gICAqIFNlY3VyZVN0cmluZy5cbiAgICpcbiAgICogRlJPTlRFRCBjYW5ub3QgdXNlIGEgU2VjdXJlU3RyaW5nIGZvciB0aGUgZGlzdHJpYnV0aW9uIGhlYWRlciAoc2VlXG4gICAqIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYCksIHNvIHRoaXMgaXMgb25seSBtZWFuaW5nZnVsIHdoZW4gdGhlIHNhbWUgd2VsbC1rbm93blxuICAgKiBuYW1lIGlzIGFsc28gcmVhZCBmb3IgYSBwdXJwb3NlIG90aGVyIHRoYW4gdGhlIG9yaWdpbiBoZWFkZXIuIFdoZW4gaXQgaXNcbiAgICogc2V0IHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIGBrbXM6RGVjcnlwdGAgb24gdGhlIGtleSB0byBgaGFuZGxlcmAuIExlYXZlIGl0XG4gICAqIHVuc2V0IGZvciBhIFN0cmluZyBwYXJhbWV0ZXI6IFBhcmFtZXRlciBTdG9yZSBuZWVkcyBubyBLTVMgcGVybWlzc2lvbiBmb3JcbiAgICogcGxhaW50ZXh0IHZhbHVlcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzZWNyZXRQYXJhbWV0ZXJLbXNLZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogVGhlIGFzc2VydGlvbiB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeVxuICAgKiBkZXJpdmVkIHJvdXRlLlxuICAgKlxuICAgKiBUaGUgY29uc3RydWN0IGNhbm5vdCBhdHRhY2ggdGhhdCB2ZXJpZmljYXRpb24gdG8gYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnRcbiAgICogZG9vciBvciBhIHJ1bnRpbWUgaXQgZG9lcyBub3Qgb3duLCBzbyBpdCByZWZ1c2VzIHRvIHN5bnRoZXNpemUgdW50aWwgdGhlXG4gICAqIGNhbGxlciByZWNvcmRzIHRoYXQgdGhlIHZlcmlmaWNhdGlvbiBleGlzdHMuIE11c3QgYmUgYHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgYXNzZXJ0ZWQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHBsaWNhdGlvbiB3aXJlcyBpbnRvIGl0cyBmcm9udCBkb29yLlxuICpcbiAqIGBoZWFkZXJWYWx1ZWAgaXMgdGhlIGxpdGVyYWwgZm9yIHRoZSBsaXRlcmFsIGZvcm0gYW5kIGEgQ2xvdWRGb3JtYXRpb25cbiAqIGBzc21gIGR5bmFtaWMgcmVmZXJlbmNlIGZvciB0aGUgcGFyYW1ldGVyIGZvcm0sIHNvIHRoZSBwYXJhbWV0ZXIgdmFsdWUgbmV2ZXJcbiAqIGVudGVycyB0aGUgYXBwbGljYXRpb24gc291cmNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlciB7XG4gIC8qKiBUaGUgb3JpZ2luIHJlcXVlc3QgaGVhZGVyIG5hbWUgdG8gc2VuZCB0byB0aGUgb3JpZ2luLiAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lOiBzdHJpbmc7XG4gIC8qKiBUaGUgaGVhZGVyIHZhbHVlOiBhIGxpdGVyYWwsIG9yIGEgYHt7cmVzb2x2ZTpzc206Li4ufX1gIGR5bmFtaWMgcmVmZXJlbmNlLiAqL1xuICByZWFkb25seSBoZWFkZXJWYWx1ZTogc3RyaW5nO1xufVxuXG4vKiogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zIHtcbiAgLyoqIERlbmlhbCBtZXRyaWMgbmFtZS4gTXVzdCBiZSBgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZGAuIEBkZWZhdWx0IGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWQgKi9cbiAgcmVhZG9ubHkgbWV0cmljTmFtZT86IHN0cmluZztcbiAgLyoqIEJvdW5kZWQgbWV0cmljIGRpbWVuc2lvbnMuIE11c3QgYmUgZXhhY3RseSBgb3V0Y29tZWAgYW5kIGByb3V0ZV9mYW1pbHlgLiBAZGVmYXVsdCBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdICovXG4gIHJlYWRvbmx5IGRpbWVuc2lvbnM/OiBzdHJpbmdbXTtcbn1cblxuLyoqIE93bmluZy1BUEkgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnMge1xuICAvKiogU3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLiAqL1xuICByZWFkb25seSByYXRlTGltaXQ6IG51bWJlcjtcbiAgLyoqIFN0YWdlIGJ1cnN0IGxpbWl0LiAqL1xuICByZWFkb25seSBidXJzdExpbWl0OiBudW1iZXI7XG59XG5cbi8qKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyBkZWZlbnNlLWluLWRlcHRoIGRlY2lzaW9ucyAocmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHtcbiAgLyoqIFdoZXRoZXIgdGhlIG93bmluZyBBUEkncyBzdGFnZSBoYXMgYWNjZXNzIGxvZ2dpbmcgZW5hYmxlZC4gTXVzdCBiZSB0cnVlLiAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICAvKiogVGhlIG93bmluZyBBUEkncyBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucztcbn1cblxuLyoqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIEhUVFBTIEpXVCBpc3N1ZXIgVVJMLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGlzc3Vlcj86IHN0cmluZztcbiAgLyoqIEFjY2VwdGVkIEpXVCBhdWRpZW5jZXMuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgYXVkaWVuY2U/OiBzdHJpbmdbXTtcbiAgLyoqIElkZW50aXR5IHNvdXJjZXMgZm9yIHRoZSBKV1QgYXV0aG9yaXplci4gQGRlZmF1bHQgW1wiJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb25cIl0gKi9cbiAgcmVhZG9ubHkgaWRlbnRpdHlTb3VyY2U/OiBzdHJpbmdbXTtcbiAgLyoqIEpXVCBhdXRob3JpemVyIHJlc291cmNlIG5hbWUuIEBkZWZhdWx0IHRoZSBhdXRob3JpemVyIGNvbnN0cnVjdCBpZCAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcbn1cblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBNdXR1YWwgVExTIHRydXN0c3RvcmUgZm9yIHRoZSBvd25lZCBjdXN0b20gZG9tYWluLlxuICAgKlxuICAgKiBTdXBwbHlpbmcgdGhpcyBpcyB0aGUgY29uY3JldGUgYEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURgXG4gICAqIGV2aWRlbmNlOiB0aGUgY29uc3RydWN0IGRpc2FibGVzIHRoZSBkZWZhdWx0IGV4ZWN1dGUtYXBpIGVuZHBvaW50IGFuZFxuICAgKiByZXF1aXJlcyBldmVyeSBBUEkgbWFwcGluZyBib3VuZCB0byB0aGUgb3duZWQgQVBJIHRvIHRhcmdldCBhIGRvbWFpbiB3aG9zZVxuICAgKiBgTXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGNhcnJpZXMgYSB0cnVzdHN0b3JlIFVSSS4gU3VwcGx5aW5nIGl0IHdpdGggYW55XG4gICAqIG90aGVyIG9yaWdpbiBkZWNpc2lvbiwgb3Igc2VsZWN0aW5nIGBMT0NLRURgIHdpdGhvdXQgaXQsIGZhaWxzIHN5bnRoZXNpcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcbn1cblxuLyoqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCIgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciB0aGUgYWNjZXNzIGxvZyBncm91cC4gVmFsaWQgb25seSB3aGVuIGFjY2VzcyBsb2dnaW5nXG4gICAqIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLlxuICAgKiBAZGVmYXVsdCAxMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IDIwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKiBPd25lZC1BUEkgc3BlY2lhbGl6YXRpb24gZm9yIHN0YW5kYWxvbmUgTUNQIHNlcnZlcnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucyB7XG4gIC8qKiBPcHRpb25hbCBBUEkgbmFtZS4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKiogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBvd25lZCBieSB0aGlzIGNvbnN0cnVjdC4gKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi4gQWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVmYXVsdCBvbi5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKiBPcmRlcmVkIE1DUCByb3V0ZS1wYXR0ZXJuIGZhbWlseSB3aXJlZCBhcyBvbmUgZmFjYWRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseSB7XG4gIC8qKlxuICAgKiBPcmRlcmVkIHN5bnRoZXNpcy10aW1lIE1DUCByb3V0ZSBwYXR0ZXJucy5cbiAgICpcbiAgICogRWFjaCBzZWdtZW50IGlzIGVpdGhlciBhIGxpdGVyYWwgUkZDIDM5ODYgcGF0aCBzZWdtZW50IG9yIGEgY29tcGxldGVcbiAgICogYHtwYXJhbWV0ZXJfbmFtZX1gIHNlZ21lbnQuIENESyB0b2tlbnMsIG9yaWdpbnMsIGVtcHR5IHNlZ21lbnRzLCBkb3RcbiAgICogc2VnbWVudHMsIGdyZWVkeSBwYXJhbWV0ZXJzLCBhbmQgZHVwbGljYXRlIHBhdHRlcm5zIGFyZSByZWplY3RlZC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2lyZSB0aGUgYWxnZWJyYS1kZXJpdmVkIHVuc2NvcGVkIGF1dGhvcml6YXRpb24tc2VydmVyIGRpc2NvdmVyeSByb3V0ZS5cbiAgICogVGhlIHJ1bnRpbWUgbXVzdCBzdXBwbHkgYEZhY2FkZUNvbmZpZy5Sb290QXV0aG9yaXphdGlvblNlcnZlcmAgdG9vLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk/OiBib29sZWFuO1xufVxuXG4vKiogRHluYW1vREItYmFja2VkIE1DUCBzZXNzaW9uLXN0YXRlIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSBuYW1lLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBhdXRvLWdlbmVyYXRlZFxuICAgKi9cbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUVEwgaW4gbWludXRlcyBmb3Igc2Vzc2lvbiByZWNvcmRzLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpc1xuICAgKiBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCA2MFxuICAgKi9cbiAgcmVhZG9ubHkgdHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSByZW1vdmFsIHBvbGljeS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICovXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xufVxuXG4vKiogT25lIGRlcml2ZWQgTUNQIE9BdXRoIGZhY2FkZSByb3V0ZSBmYW1pbHkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlIHtcbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBtY3BNZXRob2RzOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5U3VmZml4UGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByZWdpc3RlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuO1xufVxuXG4vKiogRGVmZW5zaXZlIHNuYXBzaG90IG9mIHRoZSBjb25zdHJ1Y3QncyBkZXJpdmVkIGZhY2FkZSBpbnZlbnRvcnkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmVhZG9ubHkgY29udHJhY3RWZXJzaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvdXRlczogQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGVbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNhbGxiYWNrUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgY29uc3RydWN0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKiBMYW1iZGEgZnVuY3Rpb24gaGFuZGxpbmcgdGhlIHJ1bnRpbWUtY29tcG9zZWQgTUNQIGZhY2FkZS4gKi9cbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgTUNQIGZhY2FkZSBmYW1pbGllcyB0aGF0XG4gICAqIHNoYXJlIG9uZSBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3lcbiAgICogc2l6ZSBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJvdXRlLWVtaXNzaW9uIG1vZGVsLlxuICAgKlxuICAgKiBgZXhwbGljaXRgICh0aGUgZGVmYXVsdCkgd2lyZXMgdGhlIGZ1bGwgZGVyaXZlZCByb3V0ZSBpbnZlbnRvcnkgYXMgb25lIEhUVFBcbiAgICogQVBJIHYyIHJvdXRlIHBlciByb3V0ZSBrZXkgYW5kIGlzIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuXG4gICAqIGBjb25zb2xpZGF0ZWRgIHdpcmVzIGV4YWN0bHkgdHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCxcbiAgICogYW5kIGlzIHZhbGlkIG9ubHkgZm9yIHRoZSBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgIHRyYW5zcG9ydFxuICAgKiBwb3N0dXJlczsgYGlhbWAgYW5kIGBqd3RgIGFyZSByZWZ1c2VkIGF0IHN5bnRoZXNpcy5cbiAgICpcbiAgICogQ29uc29saWRhdGVkIG1vZGUgaXMgYWxsb3dlZCBvbiBhIGNvbnN0cnVjdC1vd25lZCBBUEksIG9yIG9uIGFuIGF0dGFjaGVkXG4gICAqIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWUuIFwiTm8gcm91dGVzXCIgaXMgZW5mb3JjZWQgb3ZlciB0aGVcbiAgICogd2hvbGUgc3RhY2ssIG5vdCBqdXN0IHRoZSBBUEkncyBvd24gY2hpbGRyZW46IGEgcm91dGUgd2lyZWQgb250byB0aGVcbiAgICogYXR0YWNoZWQgQVBJIGZyb20gYW55IHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIHJlZnVzZWQsIGJlY2F1c2UgaXQgaG9sZHNcbiAgICogYSByb3V0ZSBrZXkgdGhlIGdyZWVkeSByb3V0ZXMgd291bGQgY29sbGlkZSB3aXRoLlxuICAgKlxuICAgKiBBIGNvbnN1bWVyIG1heSBzdGlsbCBhZGQgZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIHRvIHRoZSBjb25zb2xpZGF0ZWRcbiAgICogQVBJIGFmdGVyd2FyZHMsIGluIGVpdGhlciB0aGUgYXR0YWNoZWQgb3IgdGhlIGNvbnN0cnVjdC1vd25lZCBtb2RlLiBUaGF0XG4gICAqIGV4Y2VwdGlvbiBpcyBlbmZvcmNlZCBhdCBzeW50aGVzaXMgdGltZSBhbmQgaXMgYWxsb3dlZCBvbmx5IHdoZW4gdGhlIGFkZGVkXG4gICAqIHJvdXRlIGNhcnJpZXMgYSBub24tTk9ORSBhdXRob3JpemVyIGFuZCBkb2VzIG5vdCByZWRlY2xhcmUgdGhlIGdyZWVkeVxuICAgKiBgQU5ZIC9gIG9yIGBBTlkgL3twcm94eSt9YCBrZXkuIFdpdGhpbiBpdCwgYSBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIGJlYXRzIHRoZVxuICAgKiBncmVlZHkgcm91dGVzIGJ5IEFQSSBHYXRld2F5IHByZWNlZGVuY2UsIGFuZCBhIHdyb25nLW1ldGhvZCBoaXQgb24gc3VjaCBhXG4gICAqIHBhdGggZmFsbHMgdG8gdGhlIHJ1bnRpbWUncyBmYWlsLWNsb3NlZCA0MDQvNDA1LlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAqL1xuICByZWFkb25seSByb3V0ZU1vZGVsPzogQXBwVGhlb3J5TWNwUm91dGVNb2RlbDtcblxuICAvKipcbiAgICogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC5cbiAgICpcbiAgICogYGxlZ2FjeWAgKHRoZSBkZWZhdWx0KSBhc3NpZ25zIHBvc2l0aW9uYWwgaWRzIGluIGVtaXNzaW9uIG9yZGVyIGFuZCBpc1xuICAgKiBieXRlLXN0YWJsZSBmb3IgZGVwbG95ZWQgc3RhY2tzLiBgc2VtYW50aWNgIGRlcml2ZXMgZWFjaCBpZCBmcm9tIGl0cyByb3V0ZVxuICAgKiBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHlcbiAgICogbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGU7IGl0IGlzIGludGVuZGVkIGZvciBuZXdseSBjcmVhdGVkIGV4cGxpY2l0XG4gICAqIEFQSXMuXG4gICAqXG4gICAqIFN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUEkgZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluXG4gICAqIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUgaW4gb25lIHVwZGF0ZSwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAgICogY3JlYXRlLWJlZm9yZS1kZWxldGUgcm91dGUta2V5IGNvbGxpc2lvbiB0aGUgbWlncmF0aW9uIGNoZWNrIHJlZnVzZXMuIEFkb3B0XG4gICAqIGBzZW1hbnRpY2Agb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoIHRoZSBuZXctQVBJIHN3YXAgZG9jdW1lbnRlZCBpblxuICAgKiBgVVBHUkFESU5HLm1kYC5cbiAgICpcbiAgICogVGhpcyBwcm9wIGFwcGxpZXMgdG8gYHJvdXRlTW9kZWw6IGV4cGxpY2l0YCBvbmx5LiBUaGUgYGNvbnNvbGlkYXRlZGAgbW9kZWxcbiAgICogYWxyZWFkeSBlbWl0cyB0aGUgdHdvIGZpeGVkIHNlbWFudGljIGlkcyBgUm91dGVBbnlSb290YCBhbmQgYFJvdXRlQW55UHJveHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1lcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlSWRNb2RlPzogQXBwVGhlb3J5TWNwUm91dGVJZE1vZGU7XG5cbiAgLyoqXG4gICAqIENPUlMgcHJlZmxpZ2h0IGZvciBhIGNvbnN0cnVjdC1vd25lZCBBUEkuIFNldCB0byBgdHJ1ZWAgZm9yIEFwcFRoZW9yeVxuICAgKiBkZWZhdWx0cyBvciBzdXBwbHkgYW4gYEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9uc2Agb2JqZWN0LiBJbnZhbGlkIGluXG4gICAqIGF0dGFjaCBtb2RlLCB3aGVyZSB0aGUgb3duaW5nIEFQSSBjb25maWd1cmVzIENPUlMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEV4aXN0aW5nIEhUVFAgQVBJIHRvIGF0dGFjaCB0by4gQXR0YWNoIG1vZGUgaXMgdGhlIHByaW1hcnkgZnJvbnQtZG9vclxuICAgKiB0b3BvbG9neSBhbmQgbmV2ZXIgY3JlYXRlcyBhbiBgQVdTOjpBcGlHYXRld2F5VjI6OkFwaWAgcmVzb3VyY2UuXG4gICAqIEBkZWZhdWx0IGEgY29uc3RydWN0LW93bmVkIEh0dHBBcGlcbiAgICovXG4gIHJlYWRvbmx5IGFwaT86IGFwaWd3djIuSUh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUgdXNlZCB3aGVuIGRlcml2aW5nIGF0dGFjaC1tb2RlIGV4ZWN1dGUtYXBpIGVuZHBvaW50IHRlbXBsYXRlcy5cbiAgICogVXNlIGAkZGVmYXVsdGAgZm9yIHRoZSBBUEkgR2F0ZXdheSBkZWZhdWx0IHN0YWdlLiBXaGVuIG9taXR0ZWQsIHRoZSBzdGFnZVxuICAgKiBpcyBub3QgZGV0ZXJtaW5hYmxlIGFuZCB0aGUgdGVtcGxhdGVzIHJldGFpbiB0aGUgYmFyZSBleGVjdXRlLWFwaSBvcmlnaW4uXG4gICAqIFRoaXMgcHJvcCBkb2VzIG5vdCBjcmVhdGUsIGltcG9ydCwgb3IgbXV0YXRlIGEgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXR0YWNoZWRBcGlTdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogR28gYHJ1bnRpbWUvbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYCBzZXJ2ZXMgb25seSB0aGUgY2Fub25pY2FsIGRlZmF1bHRcbiAgICogZmFtaWx5LiBOb25jYW5vbmljYWwgcGF0dGVybnMgcmVxdWlyZSBhcHAtb3duZWQgcnVudGltZSByb3V0ZSByZWdpc3RyYXRpb25cbiAgICogdGhhdCBtYXRjaGVzIHRoZSBjb25zdHJ1Y3QncyBgcm91dGVJbnZlbnRvcnlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVGYW1pbHk/OiBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseTtcblxuICAvKipcbiAgICogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogQW4gZXhwbGljaXQgc2VsZWN0aW9uIG92ZXJyaWRlcyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiBXaGVuIGl0IGlzXG4gICAqIG9taXR0ZWQsIGEgc2VydmVyIHRoYXQgYXR0YWNoZXMgYGZhY2FkZWAgcmVzb2x2ZXMgdG8gYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYVxuICAgKiBwbGFpbiB0cmFuc3BvcnQgc2VydmVyIHJlc29sdmVzIHRvIGBpYW1gLiBgbm9uZS1wdWJsaWNgIGlzIG5ldmVyIGEgZGVmYXVsdFxuICAgKiBhbmQgY2FycmllcyB0aGUgZGVmZW5zZS1pbi1kZXB0aCBmbG9vci5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUiB3aGVuIGBmYWNhZGVgIGlzIGF0dGFjaGVkLCBvdGhlcndpc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuXG4gIC8qKlxuICAgKiBVcHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgbWFya3MgdGhpcyBzZXJ2ZXIgYXMgZmFjYWRlLWNvbmZpZ3VyZWQuXG4gICAqXG4gICAqIFRoZSBhdHRhY2htZW50J3MgcHJlc2VuY2Ugc2VsZWN0cyB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBwb3N0dXJlIGRlZmF1bHQuXG4gICAqIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQ7XG5cbiAgLyoqXG4gICAqIFJ1bnRpbWUtc2lkZSBSRkMgOTcyOCBiZWFyZXIgdmFsaWRhdGlvbiBkZWNsYXJhdGlvbi5cbiAgICpcbiAgICogUmVxdWlyZWQgYnkgYHRyYW5zcG9ydFBvc3R1cmU6IFJVTlRJTUVfQkVBUkVSYCBhbmQgcmVmdXNlZCB1bmRlciBldmVyeVxuICAgKiBvdGhlciBwb3N0dXJlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJ1bnRpbWVQb3N0dXJlPzogQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmRcbiAgICogTk9ORV9QVUJMSUMuIEEgZGlyZWN0bHkgcmVhY2hhYmxlIG9yaWdpbiBpcyByZWZ1c2VkIHVubGVzcyBpdCBpcyBkZWNsYXJlZFxuICAgKiBgRlJPTlRFRGAsIHdoaWNoIHJlcXVpcmVzIGBmcm9udERvb3JWZXJpZmljYXRpb25gLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG9yaWdpblJlYWNoYWJpbGl0eT86IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eTtcblxuICAvKipcbiAgICogRnJvbnQtZG9vciB2ZXJpZmljYXRpb24gZGVjbGFyYXRpb24sIHJlcXVpcmVkIHdpdGhcbiAgICogYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnkgb3RoZXIgZGVjaXNpb24uXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgcmVjb3JkcyB0aGUgcG9zdHVyZSwgdGhlIGhlYWRlciBuYW1lLCBhbmQgZWl0aGVyIGEgU0hBLTI1NlxuICAgKiBkaWdlc3Qgb2YgdGhlIGRlY2xhcmVkIGxpdGVyYWwgb3IgdGhlIHdlbGwta25vd24gcGFyYW1ldGVyIG5hbWUgaW4gdGhlXG4gICAqIGBhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlYCBtZXRhZGF0YTsgaXQgbmV2ZXIgZW1pdHMgdGhlIHNlY3JldFxuICAgKiB2YWx1ZS4gYGZyb250RG9vck9yaWdpbkhlYWRlcmAgaXMgdGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHBsaWNhdGlvblxuICAgKiB3aXJlcywgYW5kIGZvciB0aGUgcGFyYW1ldGVyIGZvcm0gaXRzIHZhbHVlIGlzIGEgQ2xvdWRGb3JtYXRpb24gZHluYW1pY1xuICAgKiByZWZlcmVuY2UuIEVuZm9yY2VtZW50IGlzIHRoZSBydW50aW1lJ3MgZnJvbnQtZG9vciBoZWFkZXIgY2hlY2ssIHNvIGFuXG4gICAqIHVud2lyZWQgcnVudGltZSBlbmZvcmNlcyBub3RoaW5nLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGZyb250RG9vclZlcmlmaWNhdGlvbj86IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0IGZvciB0aGUgb3duZWQgSFRUUCBBUEkuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgYWNjZXNzIGxvZyBncm91cCBpcyBuYW1lZFxuICAgKiBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGFuZCBjYXJyaWVzIHRoZSBjb250cmFjdCdzIEpTT04gZmllbGQgc2V0LlxuICAgKiBBY2Nlc3MgbG9nZ2luZyBhbHJlYWR5IGRlZmF1bHRzIG9uOyBwYXNzIGBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dnaW5nOlxuICAgKiBmYWxzZWAgdG8gb3B0IG91dC4gQXR0YWNoIG1vZGUgaWdub3JlcyB0aGlzIHByb3AuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBvd25lZCBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlblxuICAgKiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcbiAgcHJpdmF0ZSByb3V0ZUlkTW9kZSA9IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgcHJpdmF0ZSByZWFkb25seSByb3V0ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgLyoqXG4gICAqIFJlc29sdmVkIHRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEZhY2FkZS1jb25maWd1cmVkIHNlcnZlcnMgcmVzb2x2ZSB0byBgcnVudGltZS1iZWFyZXJgIHVubGVzc1xuICAgKiBgdHJhbnNwb3J0UG9zdHVyZWAgb3ZlcnJpZGVzIHRoZSBkZWZhdWx0OyBwbGFpbiB0cmFuc3BvcnQgc2VydmVycyByZXNvbHZlXG4gICAqIHRvIGBpYW1gLiBEZWxpYmVyYXRlbHkgcHVibGljIHNlcnZlcnMgbXVzdCBzZWxlY3QgYG5vbmUtcHVibGljYCBleHBsaWNpdGx5LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG4gIC8qKlxuICAgKiBEZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlcyBmb3IgdGhlIG9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgdGhlc2UgYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZXMsIG5vdCBkZWNsYXJhdGlvbnMgb2ZcbiAgICogcHVibGljIGF1dGhvcml0eS4gQW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkOyB0aGUgb3JpZ2luIGlzIGRlcml2ZWRcbiAgICogZnJvbSBgYXBpSWRgLCB0aGUgc3RhY2sgcmVnaW9uIGFuZCBVUkwgc3VmZml4LCBwbHVzXG4gICAqIGBhdHRhY2hlZEFwaVN0YWdlTmFtZWAgd2hlbiBzdXBwbGllZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlSW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeTtcblxuICAvKipcbiAgICogRmlyc3QgZGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgYW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkLiBUaGlzIHZhbHVlIGlzIGFuXG4gICAqIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZSBkZXJpdmVkIGJ5IHRoZSBzYW1lIHJ1bGVzIGFzIGBlbmRwb2ludHNgLCBub3RcbiAgICogdGhlIGZyb250IGRvb3IncyBwdWJsaWMgYXV0aG9yaXR5LlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYGVuZHBvaW50c2AuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBtY3BQYXRoc2AuICovXG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoOiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzYCBvciBgcm91dGVJbnZlbnRvcnlgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGg6IHN0cmluZztcblxuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcC1vd25lZCBmcm9udCBkb29yIG11c3Qgc2VuZCBvbiBldmVyeSBvcmlnaW5cbiAgICogcmVxdWVzdCwgcHJlc2VudCBvbmx5IHVuZGVyIGBvcmlnaW5SZWFjaGFiaWxpdHk6IEZST05URURgLlxuICAgKlxuICAgKiBXaXJlIGl0IGludG8gdGhlIGRpc3RyaWJ1dGlvbiBvcmlnaW46XG4gICAqIGBvcmlnaW5zLkh0dHBPcmlnaW4oaG9zdCwgeyBjdXN0b21IZWFkZXJzOiB7IFtoLmhlYWRlck5hbWVdOiBoLmhlYWRlclZhbHVlIH0gfSlgLlxuICAgKiBVbmRlciB0aGUgcGFyYW1ldGVyIGZvcm0gYGhlYWRlclZhbHVlYCBpcyBhIGB7e3Jlc29sdmU6c3NtOi4uLn19YFxuICAgKiBDbG91ZEZvcm1hdGlvbiBkeW5hbWljIHJlZmVyZW5jZSwgc28gdGhlIHZhbHVlIG5ldmVyIGVudGVycyB0aGVcbiAgICogYXBwbGljYXRpb24gc291cmNlIG9yIHRoZSBjb25zdHJ1Y3QncyB0ZW1wbGF0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBmcm9udERvb3JPcmlnaW5IZWFkZXI/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcblxuICAgIGNvbnN0IHBvc3R1cmUgPSBwcm9wcy50cmFuc3BvcnRQb3N0dXJlXG4gICAgICA/PyAocHJvcHMuZmFjYWRlICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgICAgIDogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0pO1xuICAgIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQocHJvcHMuZmFjYWRlKTtcbiAgICB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMocHJvcHMsIHJvdXRlRmFtaWx5LCBwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKHByb3BzLCBwb3N0dXJlLCBvd25lZE9wdGlvbnMpO1xuICAgIGNvbnN0IG9yaWdpblJlYWNoYWJpbGl0eSA9IHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkodGhpcywgcHJvcHMsIG93bmVkT3B0aW9ucyk7XG4gICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQpIHtcbiAgICAgICh0aGlzIGFzIHsgZnJvbnREb29yT3JpZ2luSGVhZGVyPzogQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIH0pLmZyb250RG9vck9yaWdpbkhlYWRlciA9XG4gICAgICAgIGZyb250RG9vck9yaWdpbkhlYWRlcihwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pO1xuICAgICAgZ3JhbnRGcm9udERvb3JQYXJhbWV0ZXJSZWFkKHRoaXMsIHByb3BzLmhhbmRsZXIsIHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgfVxuICAgIGNvbnN0IHJvdXRlTW9kZWwgPSByZXNvbHZlUm91dGVNb2RlbChwcm9wcyk7XG4gICAgdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShyb3V0ZU1vZGVsLCBwb3N0dXJlKTtcbiAgICBjb25zdCByb3V0ZUlkTW9kZSA9IHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wcyk7XG4gICAgdGhpcy5yb3V0ZUlkTW9kZSA9IHJvdXRlSWRNb2RlO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCAmJiBwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZCh0aGlzLCBwcm9wcy5hcGkpO1xuICAgIH1cbiAgICBjb25zdCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQgPSBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDO1xuICAgIGNvbnN0IHVwc3RyZWFtQ2FsbGJhY2tQYXRoID0gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzKTtcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgICB1cHN0cmVhbUNhbGxiYWNrUGF0aCxcbiAgICApO1xuICAgIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkodGhpcy5yb3V0ZUludmVudG9yeSwgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRocyA9IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLm1hcChcbiAgICAgIChyb3V0ZSkgPT4gcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLFxuICAgICk7XG4gICAgdGhpcy5tY3BQYXRoID0gdGhpcy5tY3BQYXRoc1swXTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNbMF07XG5cbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgIGNvbnN0IHN0YW5kYXJkID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgICAgY29uc3QgYXBpTmFtZVByb3AgPSBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkID8gXCJvd25lZEFwaS5hcGlOYW1lXCIgOiBcImFwaU5hbWVcIjtcbiAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeU1jcFNlcnZlclwiLCBhcGlOYW1lUHJvcCwgXCJhcGlfaHR0cFwiLCBsb2dpY2FsLCBvd25lZE9wdGlvbnMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXJcIixcbiAgICAgICAgXCJzZXNzaW9uU3RhdGUudGFibGVOYW1lXCIsXG4gICAgICAgIFwiZHluYW1vZGJfdGFibGVcIixcbiAgICAgICAgbG9naWNhbCA/IGAke2xvZ2ljYWx9LXNlc3Npb25zYCA6IHVuZGVmaW5lZCxcbiAgICAgICAgcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWQsXG4gICAgICApO1xuICAgICAgY29uc3QgZGVyaXZlZEFwaU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV9odHRwXCIsIGxvZ2ljYWwpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogb3duZWRPcHRpb25zLmFwaU5hbWUsXG4gICAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAgICAgICA/IHRydWVcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuICAgICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24odGhpcywgYXBpKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IGFwaSxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdFbmFibGVkXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgb3duZWRTdGFnZSA9IHN0YWdlO1xuXG4gICAgICBpZiAoc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgaWYgKHN0YW5kYXJkICYmICFsb2dpY2FsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlclxuICAgICAgICAvLyB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpdCB0YWtlcyB0aGUgY29udHJhY3QgbG9nLXNvdXJjZSBuYW1lLCBhbmQgdW5kZXJcbiAgICAgICAgLy8gdGhlIGxlZ2FjeSBwcm9maWxlIGl0IGtlZXBzIHRvZGF5J3MgQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIG5hbWUgYW5kXG4gICAgICAgIC8vIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgICBjb25zdCBsb2dHcm91cCA9IHN0YW5kYXJkICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBuYW1pbmdDb250ZXh0LmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gKSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dSZXRlbnRpb24sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogc3RhbmRhcmQgPyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0KCkgOiBhY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTWNwSGFuZGxlclwiLFxuICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCB0cmFuc3BvcnRBdXRob3JpemVyID0gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIocHJvcHMsIHBvc3R1cmUpO1xuICAgIGxldCBmaXJzdFRyYW5zcG9ydFJvdXRlOiBhcGlnd3YyLkh0dHBSb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAocm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURUQpIHtcbiAgICAgIGZpcnN0VHJhbnNwb3J0Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCxcbiAgICAgICAgXCIvXCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHByb3h5Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQsXG4gICAgICAgIFwiL3twcm94eSt9XCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbih0aGlzLCB0aGlzLmFwaSwgW2ZpcnN0VHJhbnNwb3J0Um91dGUsIHByb3h5Um91dGVdKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcnVudGltZU93bmVkQXV0aCA9IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICAgIHRvSHR0cE1ldGhvZChtZXRob2QpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnJlZ2lzdGVyUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIHVwc3RyZWFtIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgbm90IHBlciBraW5kOiB3aXJlIGl0IGV4YWN0bHkgb25jZS5cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5jYWxsYmFja1BhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcG9zdHVyZU1hcmtlclRhcmdldCA9ICh0aGlzLm93bmVkQXBpPy5ub2RlLmRlZmF1bHRDaGlsZFxuICAgICAgPz8gZmlyc3RUcmFuc3BvcnRSb3V0ZT8ubm9kZS5kZWZhdWx0Q2hpbGQpIGFzIGFwaWd3djIuQ2ZuQXBpIHwgYXBpZ3d2Mi5DZm5Sb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBwb3N0dXJlTWFya2VyVGFyZ2V0Py5hZGRNZXRhZGF0YShNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZLCB7XG4gICAgICBwb3N0dXJlLFxuICAgICAgY29udHJhY3RfaWQ6IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCxcbiAgICAgIHJvdXRlX2NvdW50OiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5sZW5ndGgsXG4gICAgICBydW50aW1lX3Bvc3R1cmVfZGVjbGFyZWQ6IHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQsXG4gICAgICAvLyBPbmx5IGEgRlJPTlRFRCBkZWNpc2lvbiBleHRlbmRzIHRoZSBtYXJrZXIsIHNvIERJU0FCTEVEIGFuZCBMT0NLRURcbiAgICAgIC8vIHRlbXBsYXRlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLiBUaGUgbGl0ZXJhbCBzZWNyZXQgaXMgY29uc3VtZWQgaGVyZSBmb3JcbiAgICAgIC8vIGl0cyBkaWdlc3QgYW5kIG5ldmVyIGVtaXR0ZWQuXG4gICAgICAuLi4ob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICAgICAgICA/IGZyb250RG9vclBvc3R1cmVNZXRhZGF0YShwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pXG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5hcGkgPyB1bmRlZmluZWQgOiBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgY29uc3QgbG9naWNhbCA9IG5hbWluZ0NvbnRleHRcbiAgICAgICAgPyBwcm9wcy5sb2dpY2FsTmFtZSA/PyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcylcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBkZXJpdmVkVGFibGVOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJkeW5hbW9kYl90YWJsZVwiLCBgJHtsb2dpY2FsfS1zZXNzaW9uc2ApXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IGRlcml2ZWRUYWJsZU5hbWUgJiYgIWRlcml2ZWRUYWJsZU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZFRhYmxlTmFtZS5uYW1lIDogc2Vzc2lvblN0YXRlLnRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwic2Vzc2lvbklkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwiZXhwaXJlc0F0XCIsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHNlc3Npb25TdGF0ZS5yZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjogeyBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICAgIHRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGFibGU7XG4gICAgICB0aGlzLmFkZEVudmlyb25tZW50KHByb3BzLmhhbmRsZXIsIFwiTUNQX1NFU1NJT05fVEFCTEVcIiwgdGFibGUudGFibGVOYW1lKTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UVExfTUlOVVRFU1wiLCBTdHJpbmcoc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXMpKTtcbiAgICB9XG5cbiAgICBsZXQgZW5kcG9pbnRCYXNlOiBzdHJpbmc7XG4gICAgaWYgKG93bmVkT3B0aW9ucy5kb21haW4pIHtcbiAgICAgIGlmICghb3duZWRTdGFnZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiBjb25maWd1cmF0aW9uIHJlcXVpcmVzIGNvbnN0cnVjdC1vd25lZCBBUEkgbW9kZVwiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ob3duZWRPcHRpb25zLmRvbWFpbiwgb3duZWRTdGFnZSk7XG4gICAgICBpZiAoXG4gICAgICAgIG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICAgICAmJiB0aGlzLm93bmVkQXBpICE9PSB1bmRlZmluZWRcbiAgICAgICkge1xuICAgICAgICByZWdpc3Rlck93bmVkTG9ja2VkT3JpZ2luVmFsaWRhdGlvbih0aGlzLCB0aGlzLm93bmVkQXBpKTtcbiAgICAgIH1cbiAgICAgIGVuZHBvaW50QmFzZSA9IGBodHRwczovLyR7b3duZWRPcHRpb25zLmRvbWFpbi5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG4gICAgICBjb25zdCBleGVjdXRlQXBpT3JpZ2luID0gYGh0dHBzOi8vJHt0aGlzLmFwaS5hcGlJZH0uZXhlY3V0ZS1hcGkuJHtzdGFjay5yZWdpb259LiR7c3RhY2sudXJsU3VmZml4fWA7XG4gICAgICBlbmRwb2ludEJhc2UgPSBwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyBleGVjdXRlQXBpT3JpZ2luXG4gICAgICAgIDogYCR7ZXhlY3V0ZUFwaU9yaWdpbn0vJHtwcm9wcy5hdHRhY2hlZEFwaVN0YWdlTmFtZX1gO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbmRwb2ludEJhc2UgPSBvd25lZFN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtvd25lZFN0YWdlTmFtZX1gO1xuICAgIH1cbiAgICB0aGlzLmVuZHBvaW50cyA9IHRoaXMubWNwUGF0aHMubWFwKFxuICAgICAgKHBhdHRlcm4pID0+IGAke3N0cmlwVHJhaWxpbmdTbGFzaChlbmRwb2ludEJhc2UpfSR7cGF0dGVybn1gLFxuICAgICk7XG4gICAgaWYgKFxuICAgICAgcHJvcHMuYXBpID09PSB1bmRlZmluZWRcbiAgICAgICYmIChvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpXG4gICAgICAmJiB0aGlzLmVuZHBvaW50cy5zb21lKChlbmRwb2ludCkgPT4gZW5kcG9pbnQuaW5jbHVkZXMoXCIuZXhlY3V0ZS1hcGkuXCIpKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIG11c3QgYWR2ZXJ0aXNlIHRoZSBvd25lZCBjdXN0b20gZG9tYWluLCBuZXZlciB0aGUgZGlzYWJsZWQgZXhlY3V0ZS1hcGkgZW5kcG9pbnRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnQgPSB0aGlzLmVuZHBvaW50c1swXTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkUnVudGltZVJvdXRlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZCxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgdGhpcy5uZXh0Um91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHBhdGgsIG1ldGhvZCksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIG5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLnJvdXRlSWRNb2RlICE9PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5TRU1BTlRJQykge1xuICAgICAgcmV0dXJuIGBSb3V0ZSR7dGhpcy5yb3V0ZVNlcXVlbmNlKyt9YDtcbiAgICB9XG4gICAgY29uc3QgaWQgPSBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQobWV0aG9kLCBwYXRoKTtcbiAgICBpZiAodGhpcy5yb3V0ZUlkcy5oYXMoaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlSWRNb2RlIHNlbWFudGljIGRlcml2ZXMgdGhlIGR1cGxpY2F0ZSByb3V0ZSBjb25zdHJ1Y3QgaWQgJHtpZH0gZm9yIHJvdXRlIGtleSAke21ldGhvZH0gJHtwYXRofWAsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLnJvdXRlSWRzLmFkZChpZCk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb25zb2xpZGF0ZWRSb3V0ZShcbiAgICBpZDogc3RyaW5nLFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBpbnRlZ3JhdGlvbjogYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24sXG4gICAgYXV0aG9yaXplcjogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplcixcbiAgKTogYXBpZ3d2Mi5IdHRwUm91dGUge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgaWQsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSksXG4gICAgICBpbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZEVudmlyb25tZW50KGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKFwiYWRkRW52aXJvbm1lbnRcIiBpbiBoYW5kbGVyICYmIHR5cGVvZiBoYW5kbGVyLmFkZEVudmlyb25tZW50ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihcbiAgICBvcHRpb25zOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIG10bHM6IG9wdGlvbnMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkb21haW5OYW1lO1xuICAgIGNvbnN0IGFwaU1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgZG9tYWluTmFtZSxcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gYXBpTWFwcGluZztcbiAgICBpZiAob3B0aW9ucy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCBjbmFtZVJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHRvUm91dGU1M1JlY29yZE5hbWUob3B0aW9ucy5kb21haW5OYW1lLCBvcHRpb25zLmhvc3RlZFpvbmUpLFxuICAgICAgICBkb21haW5OYW1lOiBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSBjbmFtZVJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdDogbnVtYmVyO1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIHJlYWRvbmx5IGVuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgdHRsTWludXRlczogbnVtYmVyO1xuICByZWFkb25seSByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICBpZiAocHJvcHMucm91dGVGYW1pbHkgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkgYW5kIGRlcHJlY2F0ZWQgbWNwUGF0aCBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhd1BhdHRlcm5zID0gcHJvcHMucm91dGVGYW1pbHk/LnBhdHRlcm5zXG4gICAgPz8gKHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZFxuICAgICAgPyBbcHJvcHMubWNwUGF0aF1cbiAgICAgIDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWFwKFxuICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICApKTtcbiAgaWYgKHJhd1BhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgY29uc3QgcGF0dGVybnMgPSByYXdQYXR0ZXJucy5tYXAoKHBhdHRlcm4sIGluZGV4KSA9PlxuICAgIG5vcm1hbGl6ZVJvdXRlUGF0aChwYXR0ZXJuLCBgcm91dGVGYW1pbHkucGF0dGVybnNbJHtpbmRleH1dYCkpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGlmIChzZWVuLmhhcyhwYXR0ZXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBjb250YWlucyBkdXBsaWNhdGUgcGF0dGVybiAke0pTT04uc3RyaW5naWZ5KHBhdHRlcm4pfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBzZWVuLmFkZChwYXR0ZXJuKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHBhdHRlcm5zLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OlxuICAgICAgcHJvcHMucm91dGVGYW1pbHk/LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5ID8/IGZhbHNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZVBhdGgodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0dGVybmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIik7XG4gIGlmICghcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgY29uc3Qgc2VnbWVudHMgPSByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwIHx8IHNlZ21lbnRzLnNvbWUoKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiXCIpKSB7XG4gICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIH1cbiAgY29uc3QgbGl0ZXJhbCA9IC9eKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKyQvO1xuICBjb25zdCBwYXJhbWV0ZXIgPSAvXlxceyhbQS1aYS16X11bQS1aYS16MC05X10qKVxcfSQvO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICBpZiAocGFyYW1ldGVyLnRlc3Qoc2VnbWVudCkpIGNvbnRpbnVlO1xuICAgIGlmICghbGl0ZXJhbC50ZXN0KHNlZ21lbnQpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ7XCIpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ9XCIpKSB7XG4gICAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZTogc3RyaW5nKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gYWJzb2x1dGUgc3ludGhlc2lzLXRpbWUgcm91dGUgcGF0dGVybiB3aXRoIG5vbi1lbXB0eSBsaXRlcmFsIG9yIHtwYXJhbWV0ZXJfbmFtZX0gc2VnbWVudHMgYW5kIG5vIGRvdCBzZWdtZW50c2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBzdHJpbmcge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGg7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSDtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGNvbmZpZ3VyZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdGhcIixcbiAgICApO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChjb25maWd1cmVkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgcmVhc29uID0gZXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgID8gZXJyLm1lc3NhZ2UucmVwbGFjZSgvXm1jcHJvdXRlczogLywgXCJcIilcbiAgICAgIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggaXMgaW52YWxpZDogJHtyZWFzb259YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuLFxuICBjYWxsYmFja1BhdHRlcm46IHN0cmluZyxcbik6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJvdXRlczogcGF0dGVybnMubWFwKChtY3BQYXR0ZXJuKSA9PiAoe1xuICAgICAgbWNwUGF0dGVybixcbiAgICAgIG1jcE1ldGhvZHM6IFtcIlBPU1RcIiwgXCJHRVRcIiwgXCJERUxFVEVcIl0sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgcmVnaXN0ZXJQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICB9KSksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFwiL1wiKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkLFxuICAgIGNhbGxiYWNrUGF0dGVybixcbiAgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZUludmVudG9yeShcbiAgaW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgYWRkID0gKG1ldGhvZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHttZXRob2R9ICR7cGF0aH1gO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVyaXZlZCByb3V0ZSBmYW1pbHkgY29sbGlkZXMgYXQgJHtrZXl9YCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGtleSk7XG4gIH07XG4gIGZvciAoY29uc3Qgcm91dGUgb2YgaW52ZW50b3J5LnJvdXRlcykge1xuICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIGFkZChtZXRob2QsIHJvdXRlLm1jcFBhdHRlcm4pO1xuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS50b2tlblBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS5yZWdpc3RlclBhdHRlcm4pO1xuICAgIH1cbiAgfVxuICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5jYWxsYmFja1BhdHRlcm4pO1xuICB9XG4gIGlmIChpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGlmICghcHJvcHMuYXBpKSB7XG4gICAgaWYgKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIHJlcXVpcmVzIGF0dGFjaCBtb2RlIHdpdGggYXBpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWRcbiAgICAmJiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKVxuICAgICAgfHwgIS9eKD86XFwkZGVmYXVsdHxbQS1aYS16MC05Xy1dezEsMTI4fSkkLy50ZXN0KHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIEFQSSBHYXRld2F5IHN0YWdlIG5hbWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9wcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJvd25lZEFwaVwiKTtcbiAgaWYgKHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiYXBpTmFtZVwiKTtcbiAgaWYgKHByb3BzLmNvcnMgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiY29yc1wiKTtcbiAgaWYgKHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJkb21haW5cIik7XG4gIGlmIChwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJzdGFnZVwiKTtcbiAgaWYgKGludmFsaWQubGVuZ3RoICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoIG1vZGUgd2l0aCBhcGkgY2Fubm90IGNvbmZpZ3VyZSBvd25lZC1BUEkgcHJvcHM6ICR7aW52YWxpZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgaWYgKHByb3BzLm93bmVkQXBpPy5hcGlOYW1lICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmFwaU5hbWUgYW5kIGRlcHJlY2F0ZWQgYXBpTmFtZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uZG9tYWluICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIGFuZCBkZXByZWNhdGVkIGRvbWFpbiBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2UgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIGFuZCBkZXByZWNhdGVkIHN0YWdlIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhcGlOYW1lOiBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSA/PyBwcm9wcy5hcGlOYW1lLFxuICAgIGRvbWFpbjogcHJvcHMub3duZWRBcGk/LmRvbWFpbiA/PyBwcm9wcy5kb21haW4sXG4gICAgc3RhZ2U6IHByb3BzLm93bmVkQXBpPy5zdGFnZSA/PyBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMpOiBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgY29uc3QgYWNjZXNzTG9nZ2luZyA9IG9wdGlvbnM/LmFjY2Vzc0xvZ2dpbmcgPz8gdHJ1ZTtcbiAgaWYgKCFhY2Nlc3NMb2dnaW5nICYmIG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ1JldGVudGlvbiByZXF1aXJlcyBhY2Nlc3NMb2dnaW5nIHRvIGJlIGVuYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmdFbmFibGVkID0gb3B0aW9ucz8udGhyb3R0bGluZ0VuYWJsZWQgPz8gdHJ1ZTtcbiAgaWYgKFxuICAgICF0aHJvdHRsaW5nRW5hYmxlZFxuICAgICYmIChvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIHRocm90dGxpbmcgbGltaXRzIHJlcXVpcmUgdGhyb3R0bGluZ0VuYWJsZWQgdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF0ZUxpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVDtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihyYXRlTGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ1JhdGVMaW1pdFwiKTtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihidXJzdExpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdCdXJzdExpbWl0XCIpO1xuICByZXR1cm4ge1xuICAgIHN0YWdlTmFtZTogb3B0aW9ucz8uc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIixcbiAgICBhY2Nlc3NMb2dnaW5nLFxuICAgIGFjY2Vzc0xvZ1JldGVudGlvbjogb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgdGhyb3R0bGluZ0VuYWJsZWQsXG4gICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogcmF0ZUxpbWl0LFxuICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBidXJzdExpbWl0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIGNvbnN0IGhhc0xlZ2FjeSA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZDtcbiAgaWYgKHByb3BzLnNlc3Npb25TdGF0ZSAhPT0gdW5kZWZpbmVkICYmIGhhc0xlZ2FjeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBzZXNzaW9uU3RhdGUgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggZGVwcmVjYXRlZCBzZXNzaW9uLXRhYmxlIHByb3BzXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbmFibGVkID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5lbmFibGVkID8/IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSA/PyB0cnVlO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnRhYmxlTmFtZSA/PyBwcm9wcy5zZXNzaW9uVGFibGVOYW1lO1xuICBjb25zdCB0dGxNaW51dGVzID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzXG4gICAgPz8gcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXNcbiAgICA/PyBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVM7XG4gIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gIGlmIChcbiAgICAhZW5hYmxlZFxuICAgICYmICh0YWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkaXNhYmxlZCBzZXNzaW9uIHN0YXRlIGNhbm5vdCBjb25maWd1cmUgdGFibGVOYW1lLCB0dGxNaW51dGVzLCBvciByZW1vdmFsUG9saWN5XCIsXG4gICAgKTtcbiAgfVxuICB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih0dGxNaW51dGVzLCBcInNlc3Npb25TdGF0ZS50dGxNaW51dGVzXCIpO1xuICByZXR1cm4geyBlbmFibGVkLCB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIHJlbW92YWxQb2xpY3kgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgY29uc3QgaGFzSXNzdWVyID0gcHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNKd2tzVXJpID0gcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzSXNzdWVyICE9PSBoYXNKd2tzVXJpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmkgbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFoYXNJc3N1ZXIgfHwgIWhhc0p3a3NVcmkpIHJldHVybjtcbiAgY29uc3QgaXNzdWVyID0gU3RyaW5nKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIpO1xuICBjb25zdCBqd2tzVXJpID0gU3RyaW5nKHByb3BzLmp3a3NVcmkpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBpc3N1ZXIsXG4gICAgICBmYWxzZSxcbiAgICAgIFwiYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChqd2tzVXJpKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgandrc1VyaSxcbiAgICAgIHRydWUsXG4gICAgICBcImp3a3NVcmkgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyB1c2VyaW5mbyBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudHJhbnNwb3J0QXV0aG9yaXplcjtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiB7XG4gICAgICBpZiAoY29uZmlndXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplciBpcyBvbmx5IHZhbGlkIHdpdGggdHJhbnNwb3J0UG9zdHVyZSBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTVxuICAgICAgICA/IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cElhbUF1dGhvcml6ZXIoKVxuICAgICAgICA6IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgIH1cbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiB7XG4gICAgICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcoY29uZmlndXJlZD8uaXNzdWVyID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmIChpc3N1ZXIgPT09IFwiXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBpcyByZXF1aXJlZCB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChpc3N1ZXIpKSB7XG4gICAgICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgICAgIGlzc3VlcixcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBcInRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGF1ZGllbmNlID0gKGNvbmZpZ3VyZWQ/LmF1ZGllbmNlID8/IFtdKVxuICAgICAgICAubWFwKCh2YWx1ZSkgPT4gU3RyaW5nKHZhbHVlKS50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gXCJcIik7XG4gICAgICBpZiAoYXVkaWVuY2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5hdWRpZW5jZSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgYWNjZXB0ZWQgYXVkaWVuY2Ugd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cEp3dEF1dGhvcml6ZXIoXG4gICAgICAgIE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCxcbiAgICAgICAgaXNzdWVyLFxuICAgICAgICB7XG4gICAgICAgICAgand0QXVkaWVuY2U6IGF1ZGllbmNlLFxuICAgICAgICAgIGlkZW50aXR5U291cmNlOiBjb25maWd1cmVkPy5pZGVudGl0eVNvdXJjZSxcbiAgICAgICAgICBhdXRob3JpemVyTmFtZTogY29uZmlndXJlZD8uYXV0aG9yaXplck5hbWUsXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwb3N0dXJlTGFiZWwocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHN0cmluZyB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06IHJldHVybiBcIklBTVwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHJldHVybiBcIkpXVFwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjogcmV0dXJuIFwiUlVOVElNRV9CRUFSRVJcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHJldHVybiBcIk5PTkVfUFVCTElDXCI7XG4gICAgZGVmYXVsdDogcmV0dXJuIFN0cmluZyhwb3N0dXJlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSk6IHZvaWQge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzpcbiAgICAgIHJldHVybjtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNLCAuSldULCAuUlVOVElNRV9CRUFSRVIsIG9yIC5OT05FX1BVQkxJQ1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVNb2RlbChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlTW9kZWw7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVDtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgIHx8IGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICkge1xuICAgIHJldHVybiBjb25maWd1cmVkO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVQgb3IgLkNPTlNPTElEQVRFRFwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlTW9kZWxQb3N0dXJlKFxuICByb3V0ZU1vZGVsOiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICByb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRFxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIGlzIG9ubHkgdmFsaWQgZm9yIHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgb3IgTk9ORV9QVUJMSUM7IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGtlZXBzIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbCBiZWNhdXNlIGNvbnNvbGlkYXRpb24gbXVzdCBuZXZlciBjaGFuZ2UgZ2F0ZXdheSBhZG1pc3Npb25gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJvdXRlSWRNb2RlKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnJvdXRlSWRNb2RlO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgfVxuICBpZiAoXG4gICAgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuU0VNQU5USUNcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUlkTW9kZSBtdXN0IGJlIEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWSBvciAuU0VNQU5USUNcIixcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgdHdvIGdyZWVkeSByb3V0ZSBrZXlzIGEgY29uc29saWRhdGVkIG1vZGVsIG93bnMuIEEgY29uc3VtZXIgcm91dGUgdGhhdFxuICogcmVkZWNsYXJlcyBvbmUgb2YgdGhlbSB3b3VsZCBtYWtlIHRoZSBBUEkgcmVqZWN0IHRoZSB1cGRhdGUuXG4gKi9cbmNvbnN0IENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUyA9IG5ldyBTZXQoW1wiQU5ZIC9cIiwgXCJBTlkgL3twcm94eSt9XCJdKTtcblxuLyoqXG4gKiBSZXNvbHZlIGFuIGBBcGlJZGAgKG9yIGFueSB0ZW1wbGF0ZSB2YWx1ZSkgdG8gYSBjb21wYXJhYmxlIHN0cmluZywgc28gYVxuICogYFJlZmAgdG9rZW4gYW5kIGl0cyBsb2dpY2FsIGlkIGNvbXBhcmUgZXF1YWwgYWNyb3NzIHR3byB0ZW1wbGF0ZXMgb2YgdGhlIHNhbWVcbiAqIHN0YWNrLlxuICovXG5mdW5jdGlvbiBjb21wYXJhYmxlQXBpSWQoc2NvcGU6IENvbnN0cnVjdCwgdmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoU3RhY2sub2Yoc2NvcGUpLnJlc29sdmUodmFsdWUpKTtcbn1cblxuLyoqXG4gKiBFdmVyeSBBUEkgR2F0ZXdheSB2MiByb3V0ZSBib3VuZCB0byBgYXBpYCwgcmVnYXJkbGVzcyBvZiB3aGljaCBjb25zdHJ1Y3RcbiAqIHNjb3BlIGNyZWF0ZWQgaXQuXG4gKlxuICogYGFwaS5ub2RlLmNoaWxkcmVuYCBvbmx5IHNlZXMgcm91dGVzIHRoZSBBUEkgaXRzZWxmIChvciBhIGNoaWxkIHNjb3BlKVxuICogY3JlYXRlZCwgd2hpY2ggbWlzc2VzIHRoZSBjb21tb24gcGF0dGVybiBvZiBhIHN0YWNrLWxldmVsIGNvbnN0cnVjdCB3aXJpbmcgYVxuICogcm91dGUgb250byBhbiBhdHRhY2hlZCBBUEkuIFdhbGtpbmcgdGhlIHN0YWNrIGFuZCByZXNvbHZpbmcgZWFjaCBgQ2ZuUm91dGVgJ3NcbiAqIGBBcGlJZGAgc2VlcyBib3RoLlxuICovXG5mdW5jdGlvbiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuUm91dGVbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmblJvdXRlW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkh0dHBSb3V0ZSkge1xuICAgICAgaWYgKGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5odHRwQXBpLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICAgIGZvdW5kLnB1c2gobm9kZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSByb3V0ZSdzIG93biBDZm5Sb3V0ZSBjaGlsZCBpcyB0aGUgc2FtZSByb3V0ZTsgZG8gbm90IGRvdWJsZSBjb3VudC5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmblJvdXRlICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kLmZpbHRlcigocm91dGUpID0+IHJvdXRlICE9PSB1bmRlZmluZWQpO1xufVxuXG4vKipcbiAqIFJlZnVzZSBhIGNvbnNvbGlkYXRlZCBhdHRhY2ggb250byBhbiBBUEkgdGhhdCBhbHJlYWR5IGNhcnJpZXMgcm91dGVzLlxuICpcbiAqIFRoZSBjaGVjayBkZWxpYmVyYXRlbHkgd2Fsa3MgdGhlIHdob2xlIHN0YWNrOiBhIHJvdXRlIGJvdW5kIHRvIHRoZSBhdHRhY2hlZFxuICogQVBJIGZyb20gYSBzaWJsaW5nIGNvbnN0cnVjdCBzY29wZSBpcyBqdXN0IGFzIG11Y2ggYSByb3V0ZSBrZXkgdGhlXG4gKiBjb25zb2xpZGF0ZWQgZ3JlZWR5IHJvdXRlcyB3b3VsZCBjb2xsaWRlIHdpdGggYXMgb25lIGNyZWF0ZWQgdW5kZXIgdGhlIEFQSVxuICogaXRzZWxmLlxuICovXG5mdW5jdGlvbiBhc3NlcnRDb25zb2xpZGF0ZWRBdHRhY2hBbGxvd2VkKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZ1JvdXRlcyA9IHJvdXRlc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gIGlmIChleGlzdGluZ1JvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIG1heSBhdHRhY2ggb25seSB0byBhbiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lOyBcIlxuICAgICAgKyBgdGhlIEFQSSBhbHJlYWR5IGNhcnJpZXMgJHtleGlzdGluZ1JvdXRlcy5sZW5ndGh9IHJvdXRlKHMpOiAke2V4aXN0aW5nUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUucGF0aCkuam9pbihcIiwgXCIpfTsgYFxuICAgICAgKyBcImF0dGFjaCB0byBhIG5ldyBvciBlbXB0eSBBUEksIG9yIHVzZSByb3V0ZU1vZGVsIGV4cGxpY2l0XCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBzeW50aC10aW1lIHJ1bGUgZm9yIHJvdXRlcyBhZGRlZCB0byBhIGNvbnNvbGlkYXRlZCBBUEkgYWZ0ZXJcbiAqIHRoZSBjb25zdHJ1Y3QgY3JlYXRlZCBpdHMgZ3JlZWR5IHJvdXRlcy5cbiAqXG4gKiBUaGUgcnVsZSBhcHBsaWVzIGluIGJvdGggY29uc29saWRhdGVkIG1vZGVzOiBhbiBBUEkgdGhlIGNvbnN0cnVjdCBhdHRhY2hlZFxuICogdG8sIGFuZCBvbmUgdGhlIGNvbnN0cnVjdCBvd25zLiBUaGUgZG9jdW1lbnRlZCBleGNlcHRpb24gaXMgd2hhdCBtYWtlc1xuICogY29uc29saWRhdGVkIHJvdXRlcyB1c2FibGUgaW4gYSByZWFsIGZyb250IGRvb3I6IGEgY29uc3VtZXIgbWF5IGFkZFxuICogZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIGFmdGVyd2FyZHMuIEl0IGlzIGFsbG93ZWQgb25seSB3aGVuIHRoZVxuICogcm91dGUgY2FycmllcyBhIG5vbi1OT05FIGF1dGhvcml6ZXIgKHNvIHRoZSBncmVlZHkgcm91dGVzIG5ldmVyIHNpbGVudGx5XG4gKiB3aWRlbiBhIHN0cmljdGVyIHBvc3R1cmUpIGFuZCBkb2VzIG5vdCByZWRlY2xhcmUgYSBncmVlZHkgcm91dGUga2V5ICh3aGljaFxuICogQVBJIEdhdGV3YXkgd291bGQgcmVqZWN0IGFzIGEgZHVwbGljYXRlKS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJDb25zb2xpZGF0ZWRBdHRhY2hWYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4gIG93bmVkUm91dGVzOiBhcGlnd3YyLkh0dHBSb3V0ZVtdLFxuKTogdm9pZCB7XG4gIGNvbnN0IG93bmVkID0gbmV3IFNldChcbiAgICBvd25lZFJvdXRlcy5tYXAoKHJvdXRlKSA9PiByb3V0ZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblJvdXRlKSxcbiAgKTtcbiAgU3RhY2sub2Yoc2NvcGUpLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKSkge1xuICAgICAgICBpZiAob3duZWQuaGFzKHJvdXRlKSkge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlS2V5ID0gcm91dGUucm91dGVLZXk7XG4gICAgICAgIGlmIChDT05TT0xJREFURURfR1JFRURZX1JPVVRFX0tFWVMuaGFzKHJvdXRlS2V5KSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgYWxyZWFkeSBvd25zIHRoZSBncmVlZHkgQVBJIEdhdGV3YXkgcm91dGUga2V5ICR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfSBvbiB0aGlzIEFQSTsgYSByb3V0ZSBhZGRlZCBhZnRlciBjb25zdHJ1Y3Rpb24gbXVzdCBub3QgcmVkZWNsYXJlIGl0ICgke3JvdXRlLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGF1dGhvcml6YXRpb25UeXBlID0gU3RyaW5nKHJvdXRlLmF1dGhvcml6YXRpb25UeXBlID8/IFwiTk9ORVwiKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblR5cGUgPT09IFwiTk9ORVwiKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhIHJvdXRlIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlciBjb25zdHJ1Y3Rpb24gbXVzdCBjYXJyeSBhIG5vbi1OT05FIGF1dGhvcml6ZXIsIGJlY2F1c2UgdGhlIGdyZWVkeSByb3V0ZXMgYWRtaXQgZXZlcnkgbWV0aG9kIGFuZCBwYXRoIGF0IHRoZSBnYXRld2F5ICgke3JvdXRlS2V5fSBmcm9tICR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBlcnJvcnM7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRmFjYWRlQXR0YWNobWVudChmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50KTogdm9pZCB7XG4gIGlmIChmYWNhZGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBjb25zdCBwcm92aWRlcklkID0gKGZhY2FkZSBhcyB7IHByb3ZpZGVySWQ/OiB1bmtub3duIH0pPy5wcm92aWRlcklkO1xuICBpZiAoXG4gICAgdHlwZW9mIHByb3ZpZGVySWQgIT09IFwic3RyaW5nXCJcbiAgICB8fCBwcm92aWRlcklkLnRyaW0oKSA9PT0gXCJcIlxuICAgIHx8IFRva2VuLmlzVW5yZXNvbHZlZChwcm92aWRlcklkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZmFjYWRlLnByb3ZpZGVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHN0cmluZ1wiLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3N0dXJlR3VhcmRzKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHJvdXRlRmFtaWx5OiBOb3JtYWxpemVkUm91dGVGYW1pbHksXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUMpIHtcbiAgICBpZiAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciAhPT0gdW5kZWZpbmVkIHx8IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG9yIGp3a3NVcmlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyb3V0ZUZhbWlseS5yb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZW5hYmxlIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnVwc3RyZWFtQ2FsbGJhY2tQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgdXBzdHJlYW1DYWxsYmFja1BhdGhcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0gY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuICBvd25lZDogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyxcbik6IHZvaWQge1xuICBpZiAoXG4gICAgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGxhYmVsID0gcG9zdHVyZUxhYmVsKHBvc3R1cmUpO1xuICBpZiAoXG4gICAgcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIChwcm9wcy5ydW50aW1lUG9zdHVyZSA9PT0gdW5kZWZpbmVkIHx8IHByb3BzLnJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiAhPT0gdHJ1ZSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgcnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuIHRvIGJlIHRydWVcIixcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICYmIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICYmIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvcmlnaW5SZWFjaGFiaWxpdHkgdG8gYmUgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVELCAuTE9DS0VELCBvciAuRlJPTlRFRGAsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UocHJvcHMub3duaW5nQXBpRGVmZW5zZSwgbGFiZWwpO1xuICB9IGVsc2Uge1xuICAgIGlmIChvd25lZC5zdGFnZT8udGhyb3R0bGluZ0VuYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhbiBleHBsaWNpdCBvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nRW5hYmxlZDogdHJ1ZSB0aHJvdHRsaW5nIGRlY2lzaW9uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvd25lZC5zdGFnZT8uYWNjZXNzTG9nZ2luZyA9PT0gZmFsc2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBhY2Nlc3MgbG9nZ2luZ2AsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUikge1xuICAgIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHByb3BzLmRlbmlhbFNpZ25hbCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBkZWNsYXJlZCBkaXJlY3Qtb3JpZ2luIGRlY2lzaW9uIHRvIGEgcHJvdmVuIHBvc3R1cmUuXG4gKlxuICogRXZlcnkgc3VwcGxpZWQgdmFsdWUgaXMgY2hlY2tlZCwgbm90IG9ubHkgdGhlIHBvc3R1cmVzIHRoYXQgcmVxdWlyZSB0aGVcbiAqIGRlY2lzaW9uLiBESVNBQkxFRCBuZWVkcyB0aGUgb3duZWQgb3JkaW5hcnkgZG9tYWluIHRoYXQgcmVwbGFjZXMgdGhlIGRpc2FibGVkXG4gKiBleGVjdXRlLWFwaSBhdXRob3JpdHkgKG9yIGEgcHJvdmFibGUgY29uY3JldGUgYXR0YWNoKSwgYW5kIExPQ0tFRFxuICogYWRkaXRpb25hbGx5IG5lZWRzIG11dHVhbCBUTFMgb24gZXZlcnkgZG9tYWluIG1hcHBlZCB0byB0aGUgb3duZWQgQVBJLlxuICogQXR0YWNoLW1vZGUgTE9DS0VEIGlzIHVuc3VwcG9ydGVkIGJlY2F1c2UgYW4gZXh0ZXJuYWwgQVBJIGNhcnJpZXMgbm8gaW4tc3RhY2tcbiAqIHRydXN0c3RvcmUgb3IgbWFwcGluZyBldmlkZW5jZS4gRlJPTlRFRCBpcyB0aGUgYXR0YWNoLW1vZGUgY291bnRlcnBhcnQgZm9yIGFuXG4gKiBhcHBsaWNhdGlvbi1vd25lZCBmcm9udCBkb29yOiBpdCBwcm9kdWNlcyBubyBpbi1zdGFjayBldmlkZW5jZSwgc28gaXQgaXNcbiAqIGFjY2VwdGVkIG9ubHkgd2l0aCBhbiBleHBsaWNpdCwgdmFsaWRhdGVkIGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uXG4gKiBhbmQgb25seSBpbiBhdHRhY2ggbW9kZS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBvd25lZDogTm9ybWFsaXplZE93bmVkQXBpT3B0aW9ucyxcbik6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGRlY2lzaW9uID0gcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5O1xuICBjb25zdCBtdXR1YWxUbHMgPSBvd25lZC5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uO1xuICBpZiAoZGVjaXNpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChtdXR1YWxUbHMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URURcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKFxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICAgICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IG11c3QgYmUgQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVELCAuTE9DS0VELCBvciAuRlJPTlRFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG11dHVhbFRscyAhPT0gdW5kZWZpbmVkICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICAgICYmIHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEKSB7XG4gICAgaWYgKHByb3BzLmFwaSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCBpcyB1bnN1cHBvcnRlZCBpbiBvd25lZCBtb2RlOyBhbiBvd25lZCBmcm9udCBkb29yIGlzIHdpcmVkIGJ5IHRoZSBESVNBQkxFRCBvciBMT0NLRUQgcG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdmFsaWRhdGVGcm9udERvb3JWZXJpZmljYXRpb24ocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKGRlY2lzaW9uID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEKSB7XG4gICAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIGlzIHVuc3VwcG9ydGVkIGluIGF0dGFjaCBtb2RlOyBhbiBBUEkgb3duZWQgb3V0c2lkZSB0aGUgY29uc3RydWN0IGNhcnJpZXMgbm8gaW4tc3RhY2sgbXV0dWFsLVRMUyBtYXBwaW5nIGV2aWRlbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3duZWQuZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgYW4gZWZmZWN0aXZlIG93bmVkQXBpLmRvbWFpbiB3aXRoIG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAobXV0dWFsVGxzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uOyBkaXNhYmxlbWVudCBhbG9uZSBpcyB0aGUgRElTQUJMRUQgcG9zdHVyZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghKHByb3BzLmFwaSBpbnN0YW5jZW9mIGFwaWd3djIuSHR0cEFwaSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyBhIHNhbWUtc3RhY2sgY29uY3JldGUgSHR0cEFwaTsgYW4gaW1wb3J0ZWQgQVBJIGV4cG9zZXMgbm8gRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVnaXN0ZXJBdHRhY2hEaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oc2NvcGUsIHByb3BzLmFwaSk7XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChvd25lZC5kb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgcmVxdWlyZXMgYW4gZWZmZWN0aXZlIG93bmVkQXBpLmRvbWFpbjsgdGhlIGRpc2FibGVkIGV4ZWN1dGUtYXBpIGVuZHBvaW50IGlzIG5ldmVyIGEgcHVibGljIGF1dGhvcml0eVwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGRlY2lzaW9uO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIHRoZSBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvbiBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTpcbiAqIEZST05URURgLlxuICpcbiAqIFRoZSBkZWNsYXJhdGlvbiBpcyBtYW5kYXRvcnkgYW5kIGV2ZXJ5IGZpZWxkIGlzIGNoZWNrZWQ6IGFuIGFic2VudFxuICogZGVjbGFyYXRpb24sIGEgbWlzc2luZyBvciByZXNlcnZlZCBoZWFkZXIgbmFtZSwgYSBzZWNyZXQgb3V0c2lkZSB0aGVcbiAqIGhlYWRlci12YWx1ZS1zYWZlIGFscGhhYmV0LCBhbmQgYSBtaXNzaW5nIGBhc3NlcnRlZDogdHJ1ZWAgYWxsIGZhaWwgc3ludGhlc2lzXG4gKiByYXRoZXIgdGhhbiBwcm9kdWNpbmcgYSBkZWNsYXJhdGlvbiB0aGUgcnVudGltZSBjb3VsZCBub3QgaG9ub3IuXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlRnJvbnREb29yVmVyaWZpY2F0aW9uKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBoZWFkZXJOYW1lID0gdmVyaWZpY2F0aW9uLmhlYWRlck5hbWU7XG4gIGlmICh0eXBlb2YgaGVhZGVyTmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhRlJPTlRfRE9PUl9IRUFERVJfTkFNRV9QQVRURVJOLnRlc3QoaGVhZGVyTmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLmhlYWRlck5hbWUgbXVzdCBiZSAxIHRvIDY0IGNoYXJhY3RlcnMgb2YgW0EtWmEtejAtOS1dXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkSGVhZGVyID0gaGVhZGVyTmFtZS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoXG4gICAgUkVTRVJWRURfRlJPTlRfRE9PUl9IRUFERVJTLmhhcyhub3JtYWxpemVkSGVhZGVyKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcIngtYW16LVwiKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcIngtYW16bi1cIilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJjbG91ZGZyb250LVwiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uaGVhZGVyTmFtZSAke2hlYWRlck5hbWV9IGlzIGEgcmVzZXJ2ZWQgb3IgcGxhdGZvcm0tbWFuYWdlZCByZXF1ZXN0IGhlYWRlciBhbmQgY2Fubm90IGNhcnJ5IHRoZSBmcm9udC1kb29yIHZlcmlmaWNhdGlvbmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBzZWNyZXRWYWx1ZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZTtcbiAgY29uc3Qgc2VjcmV0UGFyYW1ldGVyTmFtZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lO1xuICBjb25zdCBoYXNMaXRlcmFsID0gc2VjcmV0VmFsdWUgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzUGFyYW1ldGVyID0gc2VjcmV0UGFyYW1ldGVyTmFtZSAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzTGl0ZXJhbCA9PT0gaGFzUGFyYW1ldGVyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiByZXF1aXJlcyBleGFjdGx5IG9uZSBvZiBzZWNyZXRWYWx1ZSBhbmQgc2VjcmV0UGFyYW1ldGVyTmFtZTsgc3VwcGx5IHRoZSBsaXRlcmFsLCBvciB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSB0aGUgYXBwbGljYXRpb24ncyBpbnN0YWxsZXIgY3JlYXRlc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKGhhc0xpdGVyYWwpIHtcbiAgICBpZiAodHlwZW9mIHNlY3JldFZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICFGUk9OVF9ET09SX1NFQ1JFVF9QQVRURVJOLnRlc3Qoc2VjcmV0VmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0VmFsdWUgbXVzdCBiZSAzMiB0byAxMjggY2hhcmFjdGVycyBvZiBbQS1aYS16MC05Ll9+LV1cIixcbiAgICAgICk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHZhbGlkYXRlRnJvbnREb29yUGFyYW1ldGVyTmFtZShzZWNyZXRQYXJhbWV0ZXJOYW1lKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleSAhPT0gdW5kZWZpbmVkICYmICFoYXNQYXJhbWV0ZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleSBpcyBvbmx5IHZhbGlkIHdpdGggc2VjcmV0UGFyYW1ldGVyTmFtZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHZlcmlmaWNhdGlvbi5hc3NlcnRlZCAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gcmVxdWlyZXMgYXNzZXJ0ZWQ6IHRydWUg4oCUIHRoZSBjYWxsZXIgbXVzdCByZWNvcmQgdGhhdCB0aGUgcnVudGltZSB2ZXJpZmllcyB0aGUgZnJvbnQtZG9vciBoZWFkZXIgb24gZXZlcnkgZGVyaXZlZCByb3V0ZVwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHdlbGwta25vd24gZnJvbnQtZG9vciBwYXJhbWV0ZXIgbmFtZS5cbiAqXG4gKiBUaGUgbmFtZSBtdXN0IGJlIGV4cHJlc3NpYmxlIGluIGEgQ2xvdWRGb3JtYXRpb24gYHNzbWAgZHluYW1pYyByZWZlcmVuY2UgYW5kXG4gKiBhY2NlcHRhYmxlIHRvIFBhcmFtZXRlciBTdG9yZSwgYmVjYXVzZSB0aGUgY29uc3RydWN0IHJlbmRlcnMgdGhlIHJlZmVyZW5jZSBhbmRcbiAqIGdyYW50cyBvbiB0aGUgQVJOLiBBIG5hbWUgb3V0c2lkZSBlaXRoZXIgY29udHJhY3Qgd291bGQgZmFpbCBhdCBkZXBsb3kgdGltZSxcbiAqIHNvIGl0IGZhaWxzIHN5bnRoZXNpcyBpbnN0ZWFkLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUZyb250RG9vclBhcmFtZXRlck5hbWUobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGlmIChcbiAgICB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IG5hbWUubGVuZ3RoID4gRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVOR1RIXG4gICAgfHwgIUZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfUEFUVEVSTi50ZXN0KG5hbWUpXG4gICAgfHwgbmFtZS5lbmRzV2l0aChcIi9cIilcbiAgICB8fCBuYW1lLmluY2x1ZGVzKFwiLy9cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3QgYmUgYSBmdWxseSBxdWFsaWZpZWQgU1NNIHBhcmFtZXRlciBuYW1lIGZyb20gJy8nLCBhdCBtb3N0IDEwMTEgY2hhcmFjdGVycywgb2YgW0EtWmEtejAtOV8uLS9dIHdpdGggbm8gZW1wdHkgc2VnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbGV2ZWxzID0gbmFtZS5zcGxpdChcIi9cIikuZmlsdGVyKChzZWdtZW50KSA9PiBzZWdtZW50Lmxlbmd0aCA+IDApO1xuICBjb25zdCBmaXJzdCA9IGxldmVsc1swXT8udG9Mb3dlckNhc2UoKTtcbiAgaWYgKGxldmVscy5sZW5ndGggPT09IDAgfHwgbGV2ZWxzLmxlbmd0aCA+IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFVkVMUykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSBtdXN0IGhhdmUgYmV0d2VlbiBvbmUgYW5kIGZpZnRlZW4gaGllcmFyY2h5IGxldmVsc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZpcnN0ID09PSBcImF3c1wiIHx8IGZpcnN0ID09PSBcInNzbVwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3Qgbm90IHVzZSB0aGUgcmVzZXJ2ZWQgYXdzIG9yIHNzbSBoaWVyYXJjaHlcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogVGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHAtb3duZWQgZnJvbnQgZG9vciBtdXN0IHNlbmQuXG4gKlxuICogVGhlIHBhcmFtZXRlciBmb3JtIHJlbmRlcnMgdGhlIENsb3VkRm9ybWF0aW9uIGR5bmFtaWMgcmVmZXJlbmNlIHRoZVxuICogZGlzdHJpYnV0aW9uIHByb3BlcnR5IGFjY2VwdHMsIHNvIHRoZSB2YWx1ZSBpcyByZXNvbHZlZCBieSBDbG91ZEZvcm1hdGlvbiBhdFxuICogc3RhY2sgY3JlYXRlL3VwZGF0ZSB0aW1lIGFuZCBuZXZlciBhcHBlYXJzIGluIHRoZSBhcHBsaWNhdGlvbiBzb3VyY2Ugb3IgdGhpc1xuICogY29uc3RydWN0J3MgdGVtcGxhdGUuXG4gKi9cbmZ1bmN0aW9uIGZyb250RG9vck9yaWdpbkhlYWRlcihcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBoZWFkZXJWYWx1ZSA9IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lICE9PSB1bmRlZmluZWRcbiAgICA/IGB7e3Jlc29sdmU6c3NtOiR7dmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWV9fX1gXG4gICAgOiBTdHJpbmcodmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlKTtcbiAgcmV0dXJuIHsgaGVhZGVyTmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsIGhlYWRlclZhbHVlIH07XG59XG5cbi8qKlxuICogR3JhbnQgdGhlIHJ1bnRpbWUgZnVuY3Rpb24gcmVhZCBhY2Nlc3MgdG8gdGhlIHdlbGwta25vd24gZnJvbnQtZG9vciBwYXJhbWV0ZXIuXG4gKlxuICogUGFyYW1ldGVyIFN0b3JlIHJlc29sdmVzIHRoZSBkaXN0cmlidXRpb24ncyBkeW5hbWljIHJlZmVyZW5jZSB3aXRoIHRoZVxuICogZGVwbG95aW5nIHByaW5jaXBhbCdzIHBlcm1pc3Npb25zLCBzbyB0aGlzIGdyYW50IHNlcnZlcyB0aGUgcnVudGltZSdzIGxhenlcbiAqIHJlYWQ6IGBzc206R2V0UGFyYW1ldGVyYCBvbiBleGFjdGx5IHRoYXQgcGFyYW1ldGVyIEFSTiAobmV2ZXIgYSB3aWxkY2FyZCkgYW5kLFxuICogZm9yIGEgU2VjdXJlU3RyaW5nLCBga21zOkRlY3J5cHRgIG9uIHRoZSBkZWNsYXJlZCBrZXkuIFBhcmFtZXRlciBTdG9yZSBuZWVkc1xuICogbm8gS01TIHBlcm1pc3Npb24gZm9yIGEgU3RyaW5nIHBhcmFtZXRlciwgd2hpY2ggaXMgdGhlIHR5cGUgRlJPTlRFRCByZXF1aXJlcy5cbiAqL1xuZnVuY3Rpb24gZ3JhbnRGcm9udERvb3JQYXJhbWV0ZXJSZWFkKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgcGFyYW1ldGVyTmFtZSA9IHZlcmlmaWNhdGlvbj8uc2VjcmV0UGFyYW1ldGVyTmFtZTtcbiAgaWYgKHBhcmFtZXRlck5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBoYW5kbGVyLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgYWN0aW9uczogW1wic3NtOkdldFBhcmFtZXRlclwiXSxcbiAgICByZXNvdXJjZXM6IFtcbiAgICAgIFN0YWNrLm9mKHNjb3BlKS5mb3JtYXRBcm4oe1xuICAgICAgICBzZXJ2aWNlOiBcInNzbVwiLFxuICAgICAgICByZXNvdXJjZTogXCJwYXJhbWV0ZXJcIixcbiAgICAgICAgcmVzb3VyY2VOYW1lOiBwYXJhbWV0ZXJOYW1lLnJlcGxhY2UoL15cXC8rLywgXCJcIiksXG4gICAgICB9KSxcbiAgICBdLFxuICB9KSk7XG4gIGlmICh2ZXJpZmljYXRpb24/LnNlY3JldFBhcmFtZXRlckttc0tleSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlckttc0tleS5ncmFudERlY3J5cHQoaGFuZGxlcik7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgRlJPTlRFRCBmaWVsZHMgb2YgdGhlIGBhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlYCBtYXJrZXIuXG4gKlxuICogVGhlIGxpdGVyYWwgZm9ybSByZWNvcmRzIHRoZSBwb3N0dXJlLCB0aGUgaGVhZGVyIG5hbWUgYW5kIGEgU0hBLTI1NiBkaWdlc3Qgb2ZcbiAqIHRoZSBkZWNsYXJlZCBzZWNyZXQsIGV4YWN0bHkgYXMgdjcuMyBkaWQ7IHRoZSBsaXRlcmFsIGlzIGNvbnN1bWVkIGZvciBpdHNcbiAqIGRpZ2VzdCBvbmx5LCBzbyBpdCBuZXZlciBsYW5kcyBpbiB0aGUgc3ludGhlc2l6ZWQgdGVtcGxhdGUgb3IgaW5cbiAqIENsb3VkRm9ybWF0aW9uLiBUaGUgcGFyYW1ldGVyIGZvcm0gcmVjb3JkcyB0aGUgd2VsbC1rbm93biBwYXJhbWV0ZXIgbmFtZSBhbmRcbiAqIHRoYXQgdGhlIHZhbHVlIGlzIHBhcmFtZXRlci1zb3VyY2VkIGluc3RlYWQgb2YgYSBkaWdlc3QsIGJlY2F1c2UgdGhlcmUgaXMgbm9cbiAqIGxpdGVyYWwgaW4gdGhlIGFwcGxpY2F0aW9uIHRvIGRpZ2VzdC5cbiAqL1xuZnVuY3Rpb24gZnJvbnREb29yUG9zdHVyZU1ldGFkYXRhKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgaWYgKHZlcmlmaWNhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIHJlcXVpcmVzIGZyb250RG9vclZlcmlmaWNhdGlvbjsgdGhlIHJ1bnRpbWUgY2Fubm90IGVuZm9yY2UgYW4gdW5kZWNsYXJlZCBmcm9udCBkb29yXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvcmlnaW5fcmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCxcbiAgICAgIGZyb250X2Rvb3JfaGVhZGVyX25hbWU6IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lLFxuICAgICAgZnJvbnRfZG9vcl9zZWNyZXRfc291cmNlOiBcInNzbS1wYXJhbWV0ZXJcIixcbiAgICAgIGZyb250X2Rvb3Jfc2VjcmV0X3BhcmFtZXRlcl9uYW1lOiB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb3JpZ2luX3JlYWNoYWJpbGl0eTogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQsXG4gICAgZnJvbnRfZG9vcl9oZWFkZXJfbmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsXG4gICAgZnJvbnRfZG9vcl9zZWNyZXRfc2hhMjU2OiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShTdHJpbmcodmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlKSwgXCJ1dGY4XCIpLmRpZ2VzdChcImhleFwiKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBGaW5hbCBzeW50aGVzaXMgcHJvb2YgZm9yIGFuIG93bmVkIERJU0FCTEVEIEFQSTogdGhlIGRlZmF1bHQgZXhlY3V0ZS1hcGlcbiAqIGVuZHBvaW50IG11c3Qgc3RpbGwgYmUgZGlzYWJsZWQgaW4gdGhlIGVtaXR0ZWQgdGVtcGxhdGUsIGV2ZW4gaWYgYSBsYXRlciBMMVxuICogb3ZlcnJpZGUgdHJpZXMgdG8gcmUtZW5hYmxlIGl0LlxuICovXG5mdW5jdGlvbiByZWdpc3Rlck93bmVkRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgY2ZuQXBpID0gYXBpLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuQXBpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGkuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgPT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpLlByb3BlcnRpZXMuRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCB0byByZXNvbHZlIHRvIHRydWVcIixcbiAgICAgIF07XG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKlxuICogRmluYWwgd2hvbGUtc3RhY2sgcHJvb2YgZm9yIGFuIG93bmVkIExPQ0tFRCBBUEkuXG4gKlxuICogTE9DS0VEIGlzIG5vdCBhbiBhbGlhcyBvZiBESVNBQkxFRDogYXQgZmluYWwgc3ludGhlc2lzIHRoZSBkZWZhdWx0IGVuZHBvaW50XG4gKiBtdXN0IHN0aWxsIGJlIGRpc2FibGVkIGFuZCBldmVyeSBgQ2ZuQXBpTWFwcGluZ2AgYm91bmQgdG8gdGhlIG93bmVkIEFQSSxcbiAqIGluY2x1ZGluZyBtYXBwaW5ncyBhbm90aGVyIHNjb3BlIGFkZHMgYWZ0ZXIgY29uc3RydWN0aW9uLCBtdXN0IHJlc29sdmUgdG8gYW5cbiAqIGluLXN0YWNrIGBDZm5Eb21haW5OYW1lYCB3aG9zZSBgTXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGNhcnJpZXMgYSB0cnVzdHN0b3JlXG4gKiBVUkkuIEFuIHVucmVzb2x2YWJsZSBtYXBwaW5nIG9yIGRvbWFpbiBmYWlscyBjbG9zZWQgaW5zdGVhZCBvZiBjb3VudGluZyBhc1xuICogZXZpZGVuY2UuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgY2ZuQXBpID0gYXBpLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuQXBpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGkuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgIT09IHRydWUpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgQVdTOjpBcGlHYXRld2F5VjI6OkFwaS5Qcm9wZXJ0aWVzLkRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgdG8gcmVzb2x2ZSB0byB0cnVlXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBtYXBwaW5ncyA9IGNmbkFwaU1hcHBpbmdzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgICAgIGlmIChtYXBwaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlNYXBwaW5nIGJvdW5kIHRvIHRoZSBvd25lZCBBUElcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRvbWFpbnMgPSBjZm5Eb21haW5OYW1lcyhzY29wZSk7XG4gICAgICBmb3IgKGNvbnN0IG1hcHBpbmcgb2YgbWFwcGluZ3MpIHtcbiAgICAgICAgY29uc3QgZG9tYWluID0gZG9tYWlucy5maW5kKFxuICAgICAgICAgIChjYW5kaWRhdGUpID0+IGNvbXBhcmFibGVBcGlJZChzY29wZSwgY2FuZGlkYXRlLnJlZilcbiAgICAgICAgICAgID09PSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG1hcHBpbmcuZG9tYWluTmFtZSksXG4gICAgICAgICk7XG4gICAgICAgIGlmIChkb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCBjYW5ub3QgcmVzb2x2ZSBtYXBwaW5nICR7bWFwcGluZy5ub2RlLnBhdGh9IHRvIGFuIGluLXN0YWNrIEFXUzo6QXBpR2F0ZXdheVYyOjpEb21haW5OYW1lOyBtdXR1YWwtVExTIGV2aWRlbmNlIGlzIHVudmVyaWZpYWJsZWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWhhc1RydXN0c3RvcmVVcmkoc3RhY2ssIGRvbWFpbikpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgZXZlcnkgbWFwcGluZyB0byB0YXJnZXQgYSBkb21haW4gd2l0aCBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbi5UcnVzdHN0b3JlVXJpICgke21hcHBpbmcubm9kZS5wYXRofSAtPiAke2RvbWFpbi5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGVycm9ycztcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFzVHJ1c3RzdG9yZVVyaShzdGFjazogU3RhY2ssIGRvbWFpbjogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lKTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlc29sdmVkID0gc3RhY2sucmVzb2x2ZShkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24pO1xuICBpZiAocmVzb2x2ZWQgPT09IHVuZGVmaW5lZCB8fCByZXNvbHZlZCA9PT0gbnVsbCB8fCB0eXBlb2YgcmVzb2x2ZWQgIT09IFwib2JqZWN0XCIpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgY29uc3QgYXV0aGVudGljYXRpb24gPSByZXNvbHZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgdHJ1c3RzdG9yZVVyaSA9IGF1dGhlbnRpY2F0aW9uLnRydXN0c3RvcmVVcmkgPz8gYXV0aGVudGljYXRpb24uVHJ1c3RzdG9yZVVyaTtcbiAgcmV0dXJuIHRydXN0c3RvcmVVcmkgIT09IHVuZGVmaW5lZCAmJiB0cnVzdHN0b3JlVXJpICE9PSBudWxsICYmIHRydXN0c3RvcmVVcmkgIT09IFwiXCI7XG59XG5cbi8qKiBFdmVyeSBpbi1zdGFjayBgQ2ZuQXBpTWFwcGluZ2Agd2hvc2UgcmVzb2x2ZWQgYEFwaUlkYCBpcyB0aGUgc3VwcGxpZWQgQVBJLiAqL1xuZnVuY3Rpb24gY2ZuQXBpTWFwcGluZ3NCb3VuZFRvQXBpKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4pOiBhcGlnd3YyLkNmbkFwaU1hcHBpbmdbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkFwaU1hcHBpbmdbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuQXBpTWFwcGluZyAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gY2ZuRG9tYWluTmFtZXMoc2NvcGU6IENvbnN0cnVjdCk6IGFwaWd3djIuQ2ZuRG9tYWluTmFtZVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWVbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuRG9tYWluTmFtZSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKipcbiAqIEZpbmFsIHN5bnRoZXNpcyBwcm9vZiBmb3IgYW4gYXR0YWNoIERJU0FCTEVEIGRlY2xhcmF0aW9uOiB0aGUgY29uY3JldGUgQVBJXG4gKiBtdXN0IGJpbmQgdG8gZXhhY3RseSBvbmUgaW4tc3RhY2sgQ2ZuQXBpIHdob3NlIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRcbiAqIHJlc29sdmVzIHRvIGxpdGVyYWwgdHJ1ZS4gVGhlIGNvbnN0cnVjdCBuZXZlciBtdXRhdGVzIHRoZSBhdHRhY2hlZCBBUEkuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyQXR0YWNoRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBhcGk6IGFwaWd3djIuSUh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGNmbkFwaXMgPSBjZm5BcGlzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgICAgIGlmIChjZm5BcGlzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgZXhhY3RseSBvbmUgc2FtZS1zdGFjayBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpOyB0aGUgYXR0YWNoZWQgQVBJJ3MgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCBjYW5ub3QgYmUgcHJvdmVuXCIsXG4gICAgICAgIF07XG4gICAgICB9XG4gICAgICBpZiAoc3RhY2sucmVzb2x2ZShjZm5BcGlzWzBdLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpICE9PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyB0aGUgYXR0YWNoZWQgQVdTOjpBcGlHYXRld2F5VjI6OkFwaSB0byBzZXQgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludD10cnVlXCIsXG4gICAgICAgIF07XG4gICAgICB9XG4gICAgICByZXR1cm4gW107XG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKiBFdmVyeSBpbi1zdGFjayBgQ2ZuQXBpYCB3aG9zZSBgUmVmYCBpcyB0aGUgc3VwcGxpZWQgQVBJJ3MgaWQuICovXG5mdW5jdGlvbiBjZm5BcGlzQm91bmRUb0FwaShzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiBhcGlnd3YyLkNmbkFwaVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuQXBpW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkFwaSAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUucmVmKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShcbiAgZGVmZW5zZTogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnMgfCB1bmRlZmluZWQsXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGRlZmVuc2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZSB0byByZWNvcmQgdGhlIG93bmluZyBBUEkncyBhY2Nlc3MgbG9nZ2luZyBhbmQgdGhyb3R0bGluZyBkZWNpc2lvbnNgLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlZmVuc2UuYWNjZXNzTG9nZ2luZyAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS5hY2Nlc3NMb2dnaW5nIHRvIGJlIHRydWVgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZzogUGFydGlhbDxBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucz4gfCB1bmRlZmluZWQgPSBkZWZlbnNlLnRocm90dGxpbmc7XG4gIGNvbnN0IHJhdGVMaW1pdCA9IHRocm90dGxpbmc/LnJhdGVMaW1pdDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IHRocm90dGxpbmc/LmJ1cnN0TGltaXQ7XG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdClcbiAgICB8fCAocmF0ZUxpbWl0IGFzIG51bWJlcikgPD0gMFxuICAgIHx8ICFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdClcbiAgICB8fCAoYnVyc3RMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLnRocm90dGxpbmcgcmF0ZUxpbWl0IGFuZCBidXJzdExpbWl0IHRvIGJlIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJzYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVuaWFsU2lnbmFsKHNpZ25hbD86IEFwcFRoZW9yeU1jcERlbmlhbFNpZ25hbE9wdGlvbnMpOiB2b2lkIHtcbiAgaWYgKHNpZ25hbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgUlVOVElNRV9CRUFSRVIgcmVxdWlyZXMgZGVuaWFsU2lnbmFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLm1ldHJpY05hbWUgIT09IHVuZGVmaW5lZCAmJiBzaWduYWwubWV0cmljTmFtZSAhPT0gTUNQX0RFTklBTF9NRVRSSUNfTkFNRSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5tZXRyaWNOYW1lIG11c3QgYmUgJHtNQ1BfREVOSUFMX01FVFJJQ19OQU1FfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2lnbmFsLmRpbWVuc2lvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGRpbWVuc2lvbnMgPSBBcnJheS5pc0FycmF5KHNpZ25hbC5kaW1lbnNpb25zKSA/IHNpZ25hbC5kaW1lbnNpb25zIDogW107XG4gICAgY29uc3QgYm91bmRlZCA9IGRpbWVuc2lvbnMubGVuZ3RoID09PSBNQ1BfREVOSUFMX0RJTUVOU0lPTlMubGVuZ3RoXG4gICAgICAmJiBNQ1BfREVOSUFMX0RJTUVOU0lPTlMuZXZlcnkoXG4gICAgICAgIChkaW1lbnNpb24pID0+IGRpbWVuc2lvbnMuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgPT09IGRpbWVuc2lvbikubGVuZ3RoID09PSAxLFxuICAgICAgKTtcbiAgICBpZiAoIWJvdW5kZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLmRpbWVuc2lvbnMgbXVzdCBiZSBleGFjdGx5ICR7SlNPTi5zdHJpbmdpZnkoTUNQX0RFTklBTF9ESU1FTlNJT05TKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwodmFsdWU6IHN0cmluZywgYWxsb3dRdWVyeTogYm9vbGVhbiwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxpdGVyYWwgPSB2YWx1ZS50cmltKCk7XG4gIGxldCBwYXJzZWQ6IFVSTCB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKGxpdGVyYWwpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgc2hhcmVkIHZhbGlkYXRpb24gZXJyb3IgYmVsb3cgaXMgdGhlIHB1YmxpYyBzeW50aGVzaXMgY29udHJhY3QuXG4gIH1cbiAgaWYgKFxuICAgICFwYXJzZWRcbiAgICB8fCAhbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkobGl0ZXJhbClcbiAgICB8fCBwYXJzZWQucHJvdG9jb2wgIT09IFwiaHR0cHM6XCJcbiAgICB8fCAhcGFyc2VkLmhvc3RuYW1lXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKGxpdGVyYWwpXG4gICAgfHwgKCFhbGxvd1F1ZXJ5ICYmIGxpdGVyYWwuaW5jbHVkZXMoXCI/XCIpKVxuICAgIHx8IGxpdGVyYWwuaW5jbHVkZXMoXCIjXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9IdHRwTWV0aG9kKG1ldGhvZDogc3RyaW5nKTogYXBpZ3d2Mi5IdHRwTWV0aG9kIHtcbiAgc3dpdGNoIChtZXRob2QpIHtcbiAgICBjYXNlIFwiUE9TVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1Q7XG4gICAgY2FzZSBcIkdFVFwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVDtcbiAgICBjYXNlIFwiREVMRVRFXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogdW5zdXBwb3J0ZWQgcnVudGltZSBNQ1AgbWV0aG9kICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVOdW1iZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB6ZXJvYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZUludGVnZXIodmFsdWU6IG51bWJlciwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgcmV0dXJuIGZxZG4uZW5kc1dpdGgoc3VmZml4KSA/IGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpIDogZnFkbjtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15odHRwczpcXC9cXC8oW14vPyNdKykoPzpbLz8jXXwkKS9pLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHkgIT09IHVuZGVmaW5lZCAmJiAhYXV0aG9yaXR5LmluY2x1ZGVzKFwiJVwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEF1dGhvcml0eUhhc1VzZXJpbmZvKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYXV0aG9yaXR5ID0gL15bQS1aYS16XVtBLVphLXowLTkrLi1dKjpcXC9cXC8oW14vPyNdKikvLmV4ZWModmFsdWUpPy5bMV07XG4gIHJldHVybiBhdXRob3JpdHk/LmluY2x1ZGVzKFwiQFwiKSA/PyBmYWxzZTtcbn1cbiJdfQ==