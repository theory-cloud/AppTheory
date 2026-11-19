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
            (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMcpServer", "sessionState.tableName", "dynamodb_table", logical, props.sessionState?.tableName !== undefined || props.sessionTableName !== undefined);
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
                const contractName = namingContext && logical
                    ? (0, standard_logging_1.accessLogGroupName)(namingContext, `logs/access/api/${logical}`)
                    : undefined;
                const logGroup = standard && namingContext && logical
                    ? new logs.LogGroup(this, "AccessLogs", {
                        logGroupName: contractName,
                        retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                    })
                    : contractName !== undefined
                        ? new logs.LogGroup(this, "AccessLogs", {
                            logGroupName: contractName,
                            retention: stageOptions.accessLogRetention,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFFdkMsMkRBQStEO0FBQy9ELHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsaUVBQXNHO0FBRXRHLGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFFdkQsTUFBTSwwQkFBMEIsR0FBRyxjQUFjLENBQUM7QUFDbEQsTUFBTSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7QUFDcEQsTUFBTSw2QkFBNkIsR0FBRyxHQUFHLENBQUM7QUFDMUMsTUFBTSw4QkFBOEIsR0FBRyxHQUFHLENBQUM7QUFDM0MsTUFBTSwyQkFBMkIsR0FBRyxFQUFFLENBQUM7QUFDdkMsTUFBTSwyQkFBMkIsR0FBRyx3QkFBd0IsQ0FBQztBQUM3RCxNQUFNLGtDQUFrQyxHQUFHLGlDQUFpQyxDQUFDO0FBQzdFLE1BQU0saUNBQWlDLEdBQUcsOEJBQThCLENBQUM7QUFDekUsTUFBTSxzQkFBc0IsR0FBRywyQkFBMkIsQ0FBQztBQUMzRCxNQUFNLHFCQUFxQixHQUFHLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxDQUFDO0FBRTFELDJDQUEyQztBQUMzQyxNQUFNLDhCQUE4QixHQUFHLHNCQUFzQixDQUFDO0FBRTlELG9GQUFvRjtBQUNwRixNQUFNLHlCQUF5QixHQUFHLDJCQUEyQixDQUFDO0FBRTlEOzs7OztHQUtHO0FBQ0gsTUFBTSxpQ0FBaUMsR0FBRyx1QkFBdUIsQ0FBQztBQUVsRTs7Ozs7R0FLRztBQUNILE1BQU0sb0NBQW9DLEdBQUcs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QyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGFjY2Vzc0xvZ0dyb3VwTmFtZSwgaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCwgcmV0ZW50aW9uRm9yIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMgfSBmcm9tIFwiLi9odHRwLWFwaVwiO1xuaW1wb3J0IHsgc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkIH0gZnJvbSBcIi4vcm91dGUtaWRzXCI7XG5cbmNvbnN0IENPTlNPTElEQVRFRF9ST09UX1JPVVRFX0lEID0gXCJSb3V0ZUFueVJvb3RcIjtcbmNvbnN0IENPTlNPTElEQVRFRF9QUk9YWV9ST1VURV9JRCA9IFwiUm91dGVBbnlQcm94eVwiO1xuY29uc3QgREVGQVVMVF9USFJPVFRMSU5HX1JBVEVfTElNSVQgPSAxMDA7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfQlVSU1RfTElNSVQgPSAyMDA7XG5jb25zdCBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVMgPSA2MDtcbmNvbnN0IE1DUF9UUkFOU1BPUlRfQVVUSE9SSVpFUl9JRCA9IFwiTWNwVHJhbnNwb3J0QXV0aG9yaXplclwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX01FVEFEQVRBX0tFWSA9IFwiYXBwdGhlb3J5Om1jcC10cmFuc3BvcnQtcG9zdHVyZVwiO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lEID0gXCJtMTcubWNwLXRyYW5zcG9ydC1wb3N0dXJlL3YxXCI7XG5jb25zdCBNQ1BfREVOSUFMX01FVFJJQ19OQU1FID0gXCJhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkXCI7XG5jb25zdCBNQ1BfREVOSUFMX0RJTUVOU0lPTlMgPSBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdO1xuXG4vKiogVGhlIGZyb250LWRvb3IgaGVhZGVyIG5hbWUgYWxwaGFiZXQuICovXG5jb25zdCBGUk9OVF9ET09SX0hFQURFUl9OQU1FX1BBVFRFUk4gPSAvXltBLVphLXowLTktXXsxLDY0fSQvO1xuXG4vKiogVGhlIGZyb250LWRvb3Igc2VjcmV0IGFscGhhYmV0OiBoZWFkZXItdmFsdWUtc2FmZSwgbm8gd2hpdGVzcGFjZSBvciBjb250cm9scy4gKi9cbmNvbnN0IEZST05UX0RPT1JfU0VDUkVUX1BBVFRFUk4gPSAvXltBLVphLXowLTkuX34tXXszMiwxMjh9JC87XG5cbi8qKlxuICogQSB3ZWxsLWtub3duIFNTTSBwYXJhbWV0ZXIgbmFtZSwgaW4gdGhlIGFscGhhYmV0IGEgQ2xvdWRGb3JtYXRpb24gYHNzbWBcbiAqIGR5bmFtaWMgcmVmZXJlbmNlIGFjY2VwdHMuXG4gKlxuICogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL0FXU0Nsb3VkRm9ybWF0aW9uL2xhdGVzdC9Vc2VyR3VpZGUvZHluYW1pYy1yZWZlcmVuY2VzLXNzbS5odG1sXG4gKi9cbmNvbnN0IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfUEFUVEVSTiA9IC9eXFwvW0EtWmEtejAtOV8uXFwtL10rJC87XG5cbi8qKlxuICogVGhlIFNTTSBwYXJhbWV0ZXItbmFtZSBsaW1pdHM6IDEwMTEgY2hhcmFjdGVycyBpbmNsdWRpbmcgdGhlIEFSTiBwcmVmaXgsIGFcbiAqIGZpZnRlZW4tbGV2ZWwgaGllcmFyY2h5LCBhbmQgbm8gYGF3c2AvYHNzbWAgcHJlZml4LlxuICpcbiAqIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9zeXN0ZW1zLW1hbmFnZXIvbGF0ZXN0L0FQSVJlZmVyZW5jZS9BUElfUHV0UGFyYW1ldGVyLmh0bWxcbiAqL1xuY29uc3QgRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVOR1RIID0gMTAxMTtcbmNvbnN0IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFVkVMUyA9IDE1O1xuXG4vKipcbiAqIFJlcXVlc3QgaGVhZGVycyBhIGZyb250IGRvb3IgY2FuIG5ldmVyIGNhcnJ5IHRoZSB2ZXJpZmljYXRpb24gaW46IHRoZXkgZWl0aGVyXG4gKiByZXdyaXRlIHRoZSBvcmlnaW4gcmVxdWVzdCBjb250cmFjdCBvciBhcmUgcGxhdGZvcm0tbWFuYWdlZCwgc28gYSBkZWNsYXJlZFxuICogdmFsdWUgY291bGQgbm90IGJlIHZlcmlmaWVkIHRoZSB3YXkgdGhlIHJ1bnRpbWUgcmVhZHMgaXQuXG4gKi9cbmNvbnN0IFJFU0VSVkVEX0ZST05UX0RPT1JfSEVBREVSUyA9IG5ldyBTZXQoW1xuICBcImF1dGhvcml6YXRpb25cIixcbiAgXCJjb25uZWN0aW9uXCIsXG4gIFwiY29udGVudC1sZW5ndGhcIixcbiAgXCJjb29raWVcIixcbiAgXCJob3N0XCIsXG4gIFwidHJhbnNmZXItZW5jb2RpbmdcIixcbiAgXCJ3d3ctYXV0aGVudGljYXRlXCIsXG4gIFwieC1mb3J3YXJkZWQtZm9yXCIsXG5dKTtcblxuXG4vKiogUm91dGUtZW1pc3Npb24gbW9kZWwgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICAvKipcbiAgICogT25lIEFQSSBHYXRld2F5IEhUVFAgQVBJIHYyIHJvdXRlIHBlciBkZXJpdmVkIHJvdXRlIGtleS4gVGhpcyBpcyB0aGVcbiAgICogY29uc3RydWN0J3MgaGlzdG9yaWNhbCBpbnZlbnRvcnkgYW5kIHN0YXlzIGJ5dGUtaWRlbnRpY2FsIGZvciBkZXBsb3llZFxuICAgKiBzdGFja3MsIHNvIGEgYHJvdXRlTW9kZWw6IGV4cGxpY2l0YCB1cGdyYWRlIGRlcGxveXMgaW4gcGxhY2UuIFRoZSBkZWZhdWx0LlxuICAgKi9cbiAgRVhQTElDSVQgPSBcImV4cGxpY2l0XCIsXG4gIC8qKlxuICAgKiBUd28gZ3JlZWR5IHJvdXRlcywgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gLCBiYWNrZWQgYnkgb25lIHNoYXJlZFxuICAgKiBpbnRlZ3JhdGlvbi4gVGhlIEFwcFRoZW9yeSBydW50aW1lIHJvdXRlciBwZXJmb3JtcyBtZXRob2QgYW5kIHBhdGhcbiAgICogZGlzcGF0Y2gsIHBhdGgtcGFyYW1ldGVyIGNhcHR1cmUsIGFuZCBkZW5pYWwuIENvbnNvbGlkYXRpb24gbmV2ZXIgY2hhbmdlc1xuICAgKiBnYXRld2F5IGFkbWlzc2lvbiwgc28gaXQgaXMgdmFsaWQgb25seSB3aGVuIGV2ZXJ5IGdhdGV3YXkgcm91dGUgaXMgYE5PTkVgOlxuICAgKiB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCB0cmFuc3BvcnQgcG9zdHVyZXMuIGBpYW1gIGFuZCBgand0YFxuICAgKiBhcmUgcmVmdXNlZCBhdCBzeW50aGVzaXMgdGltZS5cbiAgICovXG4gIENPTlNPTElEQVRFRCA9IFwiY29uc29saWRhdGVkXCIsXG59XG5cbi8qKiBDb25zdHJ1Y3QtaWQgZGVyaXZhdGlvbiBmb3IgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUge1xuICAvKipcbiAgICogUG9zaXRpb25hbCBpZHMgKGBSb3V0ZTBgLCBgUm91dGUxYCwgLi4uKSBhc3NpZ25lZCBpbiBlbWlzc2lvbiBvcmRlci4gVGhpc1xuICAgKiBpcyB0aGUgY29uc3RydWN0J3MgaGlzdG9yaWNhbCBpbnZlbnRvcnkgYW5kIHN0YXlzIGJ5dGUtaWRlbnRpY2FsIGZvclxuICAgKiBkZXBsb3llZCBzdGFja3MuIFRoZSBkZWZhdWx0LlxuICAgKi9cbiAgTEVHQUNZID0gXCJsZWdhY3lcIixcbiAgLyoqXG4gICAqIElkcyBkZXJpdmVkIGZyb20gdGhlIHJvdXRlIG1ldGhvZCBhbmQgcGF0dGVybiwgc28gaW5zZXJ0aW5nLCByZW1vdmluZywgb3JcbiAgICogcmVvcmRlcmluZyBhIHJvdXRlIGZhbWlseSBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZS4gSW50ZW5kZWQgZm9yXG4gICAqIG5ld2x5IGNyZWF0ZWQgZXhwbGljaXQgQVBJczogc3dpdGNoaW5nIGFuIGV4aXN0aW5nIGRlcGxveWVkIGV4cGxpY2l0IEFQSVxuICAgKiBmcm9tIGBsZWdhY3lgIHRvIGBzZW1hbnRpY2AgaW4gcGxhY2UgcmVuYW1lcyBldmVyeSByb3V0ZSwgd2hpY2ggaXMgaXRzZWxmIGFcbiAgICogY3JlYXRlLWJlZm9yZS1kZWxldGUgY29sbGlzaW9uLiBBZG9wdCBpdCBvbiBhbiBleGlzdGluZyBzdGFjayBvbmx5IHRocm91Z2hcbiAgICogdGhlIG5ldy1BUEkgc3dhcCBkZXNjcmliZWQgaW4gYFVQR1JBRElORy5tZGAuXG4gICAqL1xuICBTRU1BTlRJQyA9IFwic2VtYW50aWNcIixcbn1cblxuLyoqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIEFwcFRoZW9yeU1jcFNlcnZlci4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSB0cmFuc3BvcnQgcm91dGVzLiBUaGUgZGVmYXVsdCBmb3IgYSBzZXJ2ZXIgd2l0aCBubyBmYWNhZGUgYXR0YWNobWVudC4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIEEgc3RhdGljIEpXVCBhdXRob3JpemVyIChpc3N1ZXIgKyBhdWRpZW5jZSkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuICovXG4gIEpXVCA9IFwiand0XCIsXG4gIC8qKiBUaGUgZ2F0ZXdheSBhdXRob3JpemVyIGlzIE5PTkUgYW5kIHRoZSBydW50aW1lIHZhbGlkYXRlcyBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zLiBUaGUgZGVmYXVsdCBmb3IgYSBmYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXIuICovXG4gIFJVTlRJTUVfQkVBUkVSID0gXCJydW50aW1lLWJlYXJlclwiLFxuICAvKiogRGVsaWJlcmF0ZWx5IHB1YmxpYyBNQ1Agc2VydmVyOiBldmVyeSB0cmFuc3BvcnQgcm91dGUgaXMgcHVibGljLiBOZXZlciBhIGRlZmF1bHQuICovXG4gIE5PTkVfUFVCTElDID0gXCJub25lLXB1YmxpY1wiLFxufVxuXG4vKiogUHJlc2VuY2Utb25seSBza2VsZXRvbiBvZiB0aGUgdXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IHNlbGVjdHMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCB7XG4gIC8qKiBJZGVudGlmaWVzIHRoZSB1cHN0cmVhbSBhdXRob3JpemF0aW9uIHByb3ZpZGVyIHRoaXMgc2VydmVyIGZyb250cyAoZm9yIGV4YW1wbGUgYGF1dGhlb3J5YCkuIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlIGFuZCB1c2VzIGl0cyBwcmVzZW5jZSB0byBzZWxlY3QgdGhlIGBydW50aW1lLWJlYXJlcmAgZGVmYXVsdC4gKi9cbiAgcmVhZG9ubHkgcHJvdmlkZXJJZDogc3RyaW5nO1xufVxuXG4vKiogUnVudGltZS1zaWRlIGRlY2xhcmF0aW9uIHRoYXQgdGhlIHRyYW5zcG9ydCByb3V0ZXMgdmFsaWRhdGUgUkZDIDk3MjggYmVhcmVyIHRva2VucyBhdCBydW50aW1lLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSdW50aW1lUG9zdHVyZU9wdGlvbnMge1xuICAvKiogQXNzZXJ0IHRoZSBydW50aW1lIHJlZ2lzdGVycyB0aGUgdHJhbnNwb3J0IHJvdXRlcyB3aXRoIHRoZSBydW50aW1lLXZhbGlkYXRlZCBiZWFyZXIgcG9zdHVyZSAoR28gYEZhY2FkZUNvbmZpZy5SZXF1aXJlQmVhcmVyVG9rZW5gLCBUUyBgcmVxdWlyZUJlYXJlclRva2VuTWlkZGxld2FyZWAsIFB5dGhvbiBgcmVxdWlyZV9iZWFyZXJfdG9rZW5fbWlkZGxld2FyZWApLiBNdXN0IGJlIGB0cnVlYC4gKi9cbiAgcmVhZG9ubHkgcmVxdWlyZUJlYXJlclRva2VuOiBib29sZWFuO1xufVxuXG4vKiogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYC4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eSB7XG4gIC8qKlxuICAgKiBEaXNhYmxlIHRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGFuZCBhZHZlcnRpc2UgYW4gb3duZWQgb3JkaW5hcnlcbiAgICogY3VzdG9tIGRvbWFpbiBhcyB0aGUgb25seSBNQ1AgYXV0aG9yaXR5LlxuICAgKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKlxuICAgKiBEaXNhYmxlIHRoZSBleGVjdXRlLWFwaSBkZWZhdWx0IGVuZHBvaW50IGFuZCByZXF1aXJlIG11dHVhbCBUTFMgb24gZXZlcnlcbiAgICogY3VzdG9tIGRvbWFpbiBtYXBwZWQgdG8gdGhlIGNvbnN0cnVjdC1vd25lZCBBUEkuIFRoZSBvd25lZCBkb21haW4nc1xuICAgKiBgbXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHRoZSBjb25jcmV0ZSBsb2NrOyBhbiBlbnVtIGFsb25lIG9yIGFuXG4gICAqIGV4dGVybmFsL2F0dGFjaGVkIGZyb250IGRvb3IgbmV2ZXIgc2F0aXNmaWVzIGl0LlxuICAgKi9cbiAgTE9DS0VEID0gXCJsb2NrZWRcIixcbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gc3RheXMgZGlyZWN0bHkgcmVhY2hhYmxlIGF0IGl0cyBleGVjdXRlLWFwaSBlbmRwb2ludCBhbmQgaXNcbiAgICogc2VydmVkIG9ubHkgdGhyb3VnaCBhbiBhcHBsaWNhdGlvbi1vd25lZCBmcm9udCBkb29yIHRoYXQgaW5qZWN0c1xuICAgKiBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBvbiBldmVyeSBvcmlnaW4gcmVxdWVzdC5cbiAgICpcbiAgICogVGhpcyBpcyB0aGUgcG9zdHVyZSBmb3IgYW4gYXBwLW93bmVkIGRpc3RyaWJ1dGlvbiB3aG9zZSBvcmlnaW4gaXMgdGhlXG4gICAqIGV4ZWN1dGUtYXBpIGhvc3RuYW1lOiB0aGUgY29uc3RydWN0IHNlZXMgbmVpdGhlciB0aGUgZGlzdHJpYnV0aW9uIG5vciB0aGVcbiAgICogQVBJJ3MgZW5kcG9pbnQgY29uZmlndXJhdGlvbiwgc28gaXQgY2Fubm90IHByb2R1Y2UgaW4tc3RhY2sgZXZpZGVuY2UgdGhlXG4gICAqIHdheSBgRElTQUJMRURgIGFuZCBgTE9DS0VEYCBkby4gVmFsaWQgb25seSBpbiBhdHRhY2ggbW9kZSwgYWNjZXB0ZWQgd2l0aFxuICAgKiBgUlVOVElNRV9CRUFSRVJgIGFuZCBgTk9ORV9QVUJMSUNgIGxpa2UgdGhlIG90aGVyIGRlY2lzaW9ucywgYW5kIGl0XG4gICAqIHJlcXVpcmVzIHRoZSBtYW5kYXRvcnkgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIGBGUk9OVEVEYCBpcyBhIGRlZmVuc2UtaW4tZGVwdGggZGVjbGFyYXRpb24gd2l0aCBydW50aW1lIGVuZm9yY2VtZW50LCBub3RcbiAgICogbXV0dWFsLVRMUyBhc3N1cmFuY2UgYW5kIG5vdCBvcmlnaW4gdW5yZWFjaGFiaWxpdHkuIFRoZSBlbmZvcmNlbWVudCBpcyB0aGVcbiAgICogcnVudGltZSdzIGZyb250LWRvb3IgaGVhZGVyIGNoZWNrIChgbWNwZmFjYWRlLkZhY2FkZUNvbmZpZ2BcbiAgICogYEZyb250RG9vclZlcmlmaWNhdGlvbmAgaW4gR28sIGBmcm9udERvb3JWZXJpZmljYXRpb25gIGluIFR5cGVTY3JpcHQsXG4gICAqIGBmcm9udF9kb29yX3ZlcmlmaWNhdGlvbmAgaW4gUHl0aG9uKTogaXQgcmVmdXNlcyBldmVyeSBkZXJpdmVkIHJvdXRlIHdoZW5cbiAgICogdGhlIGRlY2xhcmVkIGhlYWRlciBpcyBhYnNlbnQgb3Igd3JvbmcsIGFuZCBmYWlscyByZWdpc3RyYXRpb24gd2hlblxuICAgKiBgRlJPTlRFRGAgaXMgZGVjbGFyZWQgd2l0aG91dCBpdC4gQW4gdW53aXJlZCBydW50aW1lIGVuZm9yY2VzIG5vdGhpbmcuXG4gICAqL1xuICBGUk9OVEVEID0gXCJmcm9udGVkXCIsXG59XG5cbi8qKlxuICogRnJvbnQtZG9vciB2ZXJpZmljYXRpb24gZm9yIGBvcmlnaW5SZWFjaGFiaWxpdHk6IEZST05URURgLlxuICpcbiAqIEF0dGFjaCBtb2RlIG1lYW5zIHRoZSBmcm9udCBkb29yIGlzIGFwcGxpY2F0aW9uLW93bmVkLCBzbyB0aGUgY29uc3RydWN0XG4gKiBjYW5ub3QgaW5qZWN0IHRoZSBoZWFkZXIgaXRzZWxmIGFuZCBjYW5ub3Qgb2JzZXJ2ZSB0aGUgZGlzdHJpYnV0aW9uLiBUaGVcbiAqIGRlY2xhcmF0aW9uIHRoZXJlZm9yZSBjYXJyaWVzIHRocmVlIGluZGVwZW5kZW50bHkgd2lyZWQgY29waWVzIHRoYXQgbXVzdCBjb21lXG4gKiBmcm9tIG9uZSBhcHBsaWNhdGlvbi1vd25lZCBjb25zdGFudDogdGhpcyBwcm9wLCB0aGUgZGlzdHJpYnV0aW9uJ3Mgb3JpZ2luXG4gKiBjdXN0b20taGVhZGVyIGNvbmZpZ3VyYXRpb24sIGFuZCB0aGUgcnVudGltZSdzIGZyb250LWRvb3IgdmVyaWZpY2F0aW9uXG4gKiBjb25maWcuIFRoZSBjb25zdHJ1Y3QgcHJvdmVzIG9ubHkgaXRzIG93biBjb3B5LlxuICpcbiAqIFN1cHBseSBleGFjdGx5IG9uZSBvZiBgc2VjcmV0VmFsdWVgIGFuZCBgc2VjcmV0UGFyYW1ldGVyTmFtZWA6XG4gKlxuICogLSBgc2VjcmV0VmFsdWVgIGlzIHRoZSB2Ny4zIGxpdGVyYWwgZm9ybS4gSXQgaXMgY29uc3VtZWQgYXQgc3ludGhlc2lzIGZvclxuICogICB2YWxpZGF0aW9uIGFuZCB0aGUgcmVjb3JkZWQgU0hBLTI1NiBkaWdlc3Qgb25seSwgYW5kIGl0IG5ldmVyIGxhbmRzIGluIHRoZVxuICogICBjb25zdHJ1Y3QncyBvd24gc3ludGhlc2l6ZWQgdGVtcGxhdGUuXG4gKiAtIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYCBuYW1lcyBhIHdlbGwta25vd24sIHN0YWdlLXF1YWxpZmllZCBQYXJhbWV0ZXIgU3RvcmVcbiAqICAgcGFyYW1ldGVyIHRoYXQgdGhlIGFwcGxpY2F0aW9uJ3MgaW5zdGFsbGVyIGNyZWF0ZXMgaWYgYWJzZW50LiBUaGUgdmFsdWVcbiAqICAgbmV2ZXIgZW50ZXJzIHRoZSBhcHBsaWNhdGlvbiBzb3VyY2U6IHRoZSBjb25zdHJ1Y3QgcmVuZGVycyB0aGUgaGVhZGVyIHZhbHVlXG4gKiAgIGFzIGEgQ2xvdWRGb3JtYXRpb24gYHNzbWAgZHluYW1pYyByZWZlcmVuY2UgYW5kIHJlY29yZHMgdGhlIHBhcmFtZXRlciBuYW1lXG4gKiAgIGluc3RlYWQgb2YgYSBkaWdlc3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIHJlcXVlc3QgaGVhZGVyIHRoZSBmcm9udCBkb29yIGluamVjdHMgb24gZXZlcnkgcmVxdWVzdCBpdCBzZW5kc1xuICAgKiB0byB0aGUgb3JpZ2luLlxuICAgKlxuICAgKiAxIHRvIDY0IGNoYXJhY3RlcnMgb2YgYFtBLVphLXowLTktXWAsIGFuZCBuZXZlciBhIHJlcXVlc3QgaGVhZGVyIHRoYXRcbiAgICogcmV3cml0ZXMgdGhlIG9yaWdpbiBjb250cmFjdCAoYEhvc3RgLCBgQXV0aG9yaXphdGlvbmAsIGBDb29raWVgLFxuICAgKiBgQ29udGVudC1MZW5ndGhgLCBgVHJhbnNmZXItRW5jb2RpbmdgLCBgQ29ubmVjdGlvbmAsIGBXV1ctQXV0aGVudGljYXRlYCxcbiAgICogYFgtRm9yd2FyZGVkLUZvcmApLCBhbnkgYHgtYW16LSpgL2B4LWFtem4tKmAvYGNsb3VkZnJvbnQtKmAgbmFtZSwgb3IgYVxuICAgKiBob3AtYnktaG9wIG5hbWUuXG4gICAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBsaXRlcmFsIHNlY3JldCBpbmplY3RlZCBhcyB0aGUgZnJvbnQtZG9vciBoZWFkZXIgdmFsdWUuXG4gICAqXG4gICAqIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05Ll9+LV1gOiBhIGhlYWRlci12YWx1ZS1zYWZlIGFscGhhYmV0XG4gICAqIHdpdGggbm8gd2hpdGVzcGFjZSBhbmQgbm8gY29udHJvbCBjaGFyYWN0ZXJzLiBUaGUgdmFsdWUgaXMgY29uc3VtZWQgYXRcbiAgICogc3ludGhlc2lzIGZvciB2YWxpZGF0aW9uIGFuZCB0aGUgcmVjb3JkZWQgU0hBLTI1NiBkaWdlc3Qgb25seSDigJQgdGhlIGxpdGVyYWxcbiAgICogbmV2ZXIgbGFuZHMgaW4gdGhlIGNvbnN0cnVjdCdzIHN5bnRoZXNpemVkIHRlbXBsYXRlIG9yIGluIENsb3VkRm9ybWF0aW9uLlxuICAgKiBJdCBpcyBub3QgYSBjcmVkZW50aWFsIHN0b3JlOyByb3RhdGlvbiBtZWFucyBjaGFuZ2luZyB0aGUgdmFsdWUgYW5kXG4gICAqIHJlZGVwbG95aW5nLCBhbmQgaXQgbXVzdCBub3QgYmUgKG9yIGNvbnRhaW4pIGEgc2VjcmV0IHRoYXQgcHJvdGVjdHNcbiAgICogYW55dGhpbmcgZWxzZS5cbiAgICpcbiAgICogTXV0dWFsbHkgZXhjbHVzaXZlIHdpdGggYHNlY3JldFBhcmFtZXRlck5hbWVgLiBQcmVmZXIgdGhlIHBhcmFtZXRlciBmb3JtOlxuICAgKiBhIGNvbW1pdHRlZCBsaXRlcmFsIGlzIGV4YWN0bHkgd2hhdCB0aGUgcGFyYW1ldGVyIGZvcm0gcmVtb3Zlcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzZWNyZXRWYWx1ZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHdlbGwta25vd24sIHN0YWdlLXF1YWxpZmllZCBQYXJhbWV0ZXIgU3RvcmUgcGFyYW1ldGVyIHRoYXQgaG9sZHMgdGhlXG4gICAqIGZyb250LWRvb3Igc2VjcmV0LlxuICAgKlxuICAgKiBBIGZ1bGx5IHF1YWxpZmllZCBuYW1lIGZyb20gYC9gLCBhdCBtb3N0IDEwMTEgY2hhcmFjdGVycyBhbmQgZmlmdGVlblxuICAgKiBsZXZlbHMsIGluIHRoZSBgW0EtWmEtejAtOV8uXFwtL11gIGFscGhhYmV0IGEgQ2xvdWRGb3JtYXRpb24gYHNzbWAgZHluYW1pY1xuICAgKiByZWZlcmVuY2UgYWNjZXB0cywgYW5kIG5ldmVyIGluIHRoZSByZXNlcnZlZCBgYXdzYC9gc3NtYCBoaWVyYXJjaHkuXG4gICAqXG4gICAqIFRoZSBwYXJhbWV0ZXIgbXVzdCBiZSB0eXBlICoqU3RyaW5nKiosIG5vdCBTZWN1cmVTdHJpbmc6IENsb3VkRnJvbnQnc1xuICAgKiBgT3JpZ2luQ3VzdG9tSGVhZGVyc2Agc3VwcG9ydHMgdGhlIHBsYWludGV4dCBgc3NtYCByZWZlcmVuY2Ugb25seSwgYW5kIEFXU1xuICAgKiBsaXN0cyB0aGUgcHJvcGVydGllcyB0aGF0IHN1cHBvcnQgYHNzbS1zZWN1cmVgIGV4aGF1c3RpdmVseSAoQ2xvdWRGcm9udCBpc1xuICAgKiBub3Qgb25lIG9mIHRoZW0pLiBUaGUgdmFsdWUgaXMgdGhlcmVmb3JlIGRlZmVuc2UtaW4tZGVwdGggYWdhaW5zdCBkaXJlY3RcbiAgICogb3JpZ2luIGFjY2Vzcywgbm90IGEgY29uZmlkZW50aWFsaXR5IGNvbnRyb2wg4oCUIHRoZSBzYW1lIHBvc3R1cmUgYXMgdGhlXG4gICAqIGxpdGVyYWwgZm9ybSwgd2hpY2ggQ2xvdWRGcm9udCBhbHJlYWR5IGV4cG9zZXMgdGhyb3VnaFxuICAgKiBgR2V0RGlzdHJpYnV0aW9uQ29uZmlnYC5cbiAgICpcbiAgICogYGZyb250RG9vck9yaWdpbkhlYWRlcmAgcmVuZGVycyB0aGUgZHluYW1pYyByZWZlcmVuY2UgZm9yIHRoZSBkaXN0cmlidXRpb25cbiAgICogdGhlIGFwcCB3aXJlcywgZS5nLiBge3tyZXNvbHZlOnNzbTovdGhlb3J5Y2xvdWQvdG1zL2xhYi9mcm9udGVkLXRva2VufX1gLFxuICAgKiBhbmQgdGhlIGNvbnN0cnVjdCBncmFudHMgYHNzbTpHZXRQYXJhbWV0ZXJgIG9uIGV4YWN0bHkgdGhpcyBwYXJhbWV0ZXIgdG9cbiAgICogYGhhbmRsZXJgLiBBIHN0YWNrIHVwZGF0ZSByZS1yZXNvbHZlcyB0aGUgbGF0ZXN0IHBhcmFtZXRlciB2ZXJzaW9uOyBkcmlmdFxuICAgKiBkZXRlY3Rpb24gZG9lcyBub3Qgc2VlIGR5bmFtaWMgcmVmZXJlbmNlcy5cbiAgICpcbiAgICogTXV0dWFsbHkgZXhjbHVzaXZlIHdpdGggYHNlY3JldFZhbHVlYC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzZWNyZXRQYXJhbWV0ZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VzdG9tZXIgbWFuYWdlZCBrZXkgdGhhdCBlbmNyeXB0cyB0aGUgcGFyYW1ldGVyIHdoZW4gaXQgaXMgYVxuICAgKiBTZWN1cmVTdHJpbmcuXG4gICAqXG4gICAqIEZST05URUQgY2Fubm90IHVzZSBhIFNlY3VyZVN0cmluZyBmb3IgdGhlIGRpc3RyaWJ1dGlvbiBoZWFkZXIgKHNlZVxuICAgKiBgc2VjcmV0UGFyYW1ldGVyTmFtZWApLCBzbyB0aGlzIGlzIG9ubHkgbWVhbmluZ2Z1bCB3aGVuIHRoZSBzYW1lIHdlbGwta25vd25cbiAgICogbmFtZSBpcyBhbHNvIHJlYWQgZm9yIGEgcHVycG9zZSBvdGhlciB0aGFuIHRoZSBvcmlnaW4gaGVhZGVyLiBXaGVuIGl0IGlzXG4gICAqIHNldCB0aGUgY29uc3RydWN0IGdyYW50cyBga21zOkRlY3J5cHRgIG9uIHRoZSBrZXkgdG8gYGhhbmRsZXJgLiBMZWF2ZSBpdFxuICAgKiB1bnNldCBmb3IgYSBTdHJpbmcgcGFyYW1ldGVyOiBQYXJhbWV0ZXIgU3RvcmUgbmVlZHMgbm8gS01TIHBlcm1pc3Npb24gZm9yXG4gICAqIHBsYWludGV4dCB2YWx1ZXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0UGFyYW1ldGVyS21zS2V5Pzoga21zLklLZXk7XG5cbiAgLyoqXG4gICAqIFRoZSBhc3NlcnRpb24gdGhhdCB0aGUgcnVudGltZSB2ZXJpZmllcyB0aGUgZnJvbnQtZG9vciBoZWFkZXIgb24gZXZlcnlcbiAgICogZGVyaXZlZCByb3V0ZS5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCBjYW5ub3QgYXR0YWNoIHRoYXQgdmVyaWZpY2F0aW9uIHRvIGFuIGFwcGxpY2F0aW9uLW93bmVkIGZyb250XG4gICAqIGRvb3Igb3IgYSBydW50aW1lIGl0IGRvZXMgbm90IG93biwgc28gaXQgcmVmdXNlcyB0byBzeW50aGVzaXplIHVudGlsIHRoZVxuICAgKiBjYWxsZXIgcmVjb3JkcyB0aGF0IHRoZSB2ZXJpZmljYXRpb24gZXhpc3RzLiBNdXN0IGJlIGB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGFzc2VydGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIFRoZSBvcmlnaW4gY3VzdG9tIGhlYWRlciB0aGUgYXBwbGljYXRpb24gd2lyZXMgaW50byBpdHMgZnJvbnQgZG9vci5cbiAqXG4gKiBgaGVhZGVyVmFsdWVgIGlzIHRoZSBsaXRlcmFsIGZvciB0aGUgbGl0ZXJhbCBmb3JtIGFuZCBhIENsb3VkRm9ybWF0aW9uXG4gKiBgc3NtYCBkeW5hbWljIHJlZmVyZW5jZSBmb3IgdGhlIHBhcmFtZXRlciBmb3JtLCBzbyB0aGUgcGFyYW1ldGVyIHZhbHVlIG5ldmVyXG4gKiBlbnRlcnMgdGhlIGFwcGxpY2F0aW9uIHNvdXJjZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXIge1xuICAvKiogVGhlIG9yaWdpbiByZXF1ZXN0IGhlYWRlciBuYW1lIHRvIHNlbmQgdG8gdGhlIG9yaWdpbi4gKi9cbiAgcmVhZG9ubHkgaGVhZGVyTmFtZTogc3RyaW5nO1xuICAvKiogVGhlIGhlYWRlciB2YWx1ZTogYSBsaXRlcmFsLCBvciBhIGB7e3Jlc29sdmU6c3NtOi4uLn19YCBkeW5hbWljIHJlZmVyZW5jZS4gKi9cbiAgcmVhZG9ubHkgaGVhZGVyVmFsdWU6IHN0cmluZztcbn1cblxuLyoqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyB7XG4gIC8qKiBEZW5pYWwgbWV0cmljIG5hbWUuIE11c3QgYmUgYGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRgLiBAZGVmYXVsdCBhcHB0aGVvcnkubWNwLmF1dGhfZGVuaWVkICovXG4gIHJlYWRvbmx5IG1ldHJpY05hbWU/OiBzdHJpbmc7XG4gIC8qKiBCb3VuZGVkIG1ldHJpYyBkaW1lbnNpb25zLiBNdXN0IGJlIGV4YWN0bHkgYG91dGNvbWVgIGFuZCBgcm91dGVfZmFtaWx5YC4gQGRlZmF1bHQgW1wib3V0Y29tZVwiLCBcInJvdXRlX2ZhbWlseVwiXSAqL1xuICByZWFkb25seSBkaW1lbnNpb25zPzogc3RyaW5nW107XG59XG5cbi8qKiBPd25pbmctQVBJIHN0YWdlIHRocm90dGxpbmcgZGVjaXNpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zIHtcbiAgLyoqIFN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC4gKi9cbiAgcmVhZG9ubHkgcmF0ZUxpbWl0OiBudW1iZXI7XG4gIC8qKiBTdGFnZSBidXJzdCBsaW1pdC4gKi9cbiAgcmVhZG9ubHkgYnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG4vKiogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgZGVmZW5zZS1pbi1kZXB0aCBkZWNpc2lvbnMgKHJlcXVpcmVkIHVuZGVyIGBydW50aW1lLWJlYXJlcmAgYW5kIGBub25lLXB1YmxpY2ApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB7XG4gIC8qKiBXaGV0aGVyIHRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgaGFzIGFjY2VzcyBsb2dnaW5nIGVuYWJsZWQuIE11c3QgYmUgdHJ1ZS4gKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgLyoqIFRoZSBvd25pbmcgQVBJJ3Mgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZzogQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM7XG59XG5cbi8qKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSBIVFRQUyBKV1QgaXNzdWVyIFVSTC4gUmVxdWlyZWQgdW5kZXIgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuIEBkZWZhdWx0IHVuZGVmaW5lZCAqL1xuICByZWFkb25seSBpc3N1ZXI/OiBzdHJpbmc7XG4gIC8qKiBBY2NlcHRlZCBKV1QgYXVkaWVuY2VzLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGF1ZGllbmNlPzogc3RyaW5nW107XG4gIC8qKiBJZGVudGl0eSBzb3VyY2VzIGZvciB0aGUgSldUIGF1dGhvcml6ZXIuIEBkZWZhdWx0IFtcIiRyZXF1ZXN0LmhlYWRlci5BdXRob3JpemF0aW9uXCJdICovXG4gIHJlYWRvbmx5IGlkZW50aXR5U291cmNlPzogc3RyaW5nW107XG4gIC8qKiBKV1QgYXV0aG9yaXplciByZXNvdXJjZSBuYW1lLiBAZGVmYXVsdCB0aGUgYXV0aG9yaXplciBjb25zdHJ1Y3QgaWQgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKiogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZm9yIGV4YW1wbGUsIGBtY3AuZXhhbXBsZS5jb21gKS4gKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVBcm5gLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uIFByb3ZpZGUgdGhpcyBvciBgY2VydGlmaWNhdGVgLiAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYW4gYXV0b21hdGljYWxseSBjcmVhdGVkIENOQU1FIHJlY29yZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyB0cnVzdHN0b3JlIGZvciB0aGUgb3duZWQgY3VzdG9tIGRvbWFpbi5cbiAgICpcbiAgICogU3VwcGx5aW5nIHRoaXMgaXMgdGhlIGNvbmNyZXRlIGBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEYFxuICAgKiBldmlkZW5jZTogdGhlIGNvbnN0cnVjdCBkaXNhYmxlcyB0aGUgZGVmYXVsdCBleGVjdXRlLWFwaSBlbmRwb2ludCBhbmRcbiAgICogcmVxdWlyZXMgZXZlcnkgQVBJIG1hcHBpbmcgYm91bmQgdG8gdGhlIG93bmVkIEFQSSB0byB0YXJnZXQgYSBkb21haW4gd2hvc2VcbiAgICogYE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBjYXJyaWVzIGEgdHJ1c3RzdG9yZSBVUkkuIFN1cHBseWluZyBpdCB3aXRoIGFueVxuICAgKiBvdGhlciBvcmlnaW4gZGVjaXNpb24sIG9yIHNlbGVjdGluZyBgTE9DS0VEYCB3aXRob3V0IGl0LCBmYWlscyBzeW50aGVzaXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbXV0dWFsVGxzQXV0aGVudGljYXRpb24/OiBhcGlnd3YyLk1UTFNDb25maWc7XG59XG5cbi8qKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciBhbiBBcHBUaGVvcnktb3duZWQgTUNQIEhUVFAgQVBJLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgXCIkZGVmYXVsdFwiICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgdGhlIGFjY2VzcyBsb2cgZ3JvdXAuIFZhbGlkIG9ubHkgd2hlbiBhY2Nlc3MgbG9nZ2luZ1xuICAgKiBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0VuYWJsZWQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIHJhdGUgbGltaXQgaW4gcmVxdWVzdHMgcGVyIHNlY29uZC5cbiAgICogQGRlZmF1bHQgMTAwXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0LXN0YWdlIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCAyMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKiogT3duZWQtQVBJIHNwZWNpYWxpemF0aW9uIGZvciBzdGFuZGFsb25lIE1DUCBzZXJ2ZXJzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJPd25lZEFwaU9wdGlvbnMge1xuICAvKiogT3B0aW9uYWwgQVBJIG5hbWUuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIE9wdGlvbmFsIGN1c3RvbSBkb21haW4gb3duZWQgYnkgdGhpcyBjb25zdHJ1Y3QuICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uIEFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlZmF1bHQgb24uXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKiogT3JkZXJlZCBNQ1Agcm91dGUtcGF0dGVybiBmYW1pbHkgd2lyZWQgYXMgb25lIGZhY2FkZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUm91dGVGYW1pbHkge1xuICAvKipcbiAgICogT3JkZXJlZCBzeW50aGVzaXMtdGltZSBNQ1Agcm91dGUgcGF0dGVybnMuXG4gICAqXG4gICAqIEVhY2ggc2VnbWVudCBpcyBlaXRoZXIgYSBsaXRlcmFsIFJGQyAzOTg2IHBhdGggc2VnbWVudCBvciBhIGNvbXBsZXRlXG4gICAqIGB7cGFyYW1ldGVyX25hbWV9YCBzZWdtZW50LiBDREsgdG9rZW5zLCBvcmlnaW5zLCBlbXB0eSBzZWdtZW50cywgZG90XG4gICAqIHNlZ21lbnRzLCBncmVlZHkgcGFyYW1ldGVycywgYW5kIGR1cGxpY2F0ZSBwYXR0ZXJucyBhcmUgcmVqZWN0ZWQuXG4gICAqL1xuICByZWFkb25seSBwYXR0ZXJuczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdpcmUgdGhlIGFsZ2VicmEtZGVyaXZlZCB1bnNjb3BlZCBhdXRob3JpemF0aW9uLXNlcnZlciBkaXNjb3Zlcnkgcm91dGUuXG4gICAqIFRoZSBydW50aW1lIG11c3Qgc3VwcGx5IGBGYWNhZGVDb25maWcuUm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJgIHRvby5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5PzogYm9vbGVhbjtcbn1cblxuLyoqIER5bmFtb0RCLWJhY2tlZCBNQ1Agc2Vzc2lvbi1zdGF0ZSBjb25maWd1cmF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zIHtcbiAgLyoqIEBkZWZhdWx0IHRydWUgKi9cbiAgcmVhZG9ubHkgZW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgbmFtZS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgYXV0by1nZW5lcmF0ZWRcbiAgICovXG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVFRMIGluIG1pbnV0ZXMgZm9yIHNlc3Npb24gcmVjb3Jkcy4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXNcbiAgICogZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gdGFibGUgcmVtb3ZhbCBwb2xpY3kuIFZhbGlkIG9ubHkgd2hlbiBzZXNzaW9uIHN0YXRlIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbn1cblxuLyoqIE9uZSBkZXJpdmVkIE1DUCBPQXV0aCBmYWNhZGUgcm91dGUgZmFtaWx5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJGYWNhZGVSb3V0ZSB7XG4gIHJlYWRvbmx5IG1jcFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgbWNwTWV0aG9kczogc3RyaW5nW107XG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSB0b2tlblBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgcmVnaXN0ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZDogYm9vbGVhbjtcbn1cblxuLyoqIERlZmVuc2l2ZSBzbmFwc2hvdCBvZiB0aGUgY29uc3RydWN0J3MgZGVyaXZlZCBmYWNhZGUgaW52ZW50b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSB7XG4gIHJlYWRvbmx5IGNvbnRyYWN0VmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSByb3V0ZXM6IEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlW107XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuO1xuICByZWFkb25seSBjYWxsYmFja1BhdHRlcm46IHN0cmluZztcbn1cblxuLyoqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMge1xuICAvKiogTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIHRoZSBydW50aW1lLWNvbXBvc2VkIE1DUCBmYWNhZGUuICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIGxhcmdlIE1DUCBmYWNhZGUgZmFtaWxpZXMgdGhhdFxuICAgKiBzaGFyZSBvbmUgTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5XG4gICAqIHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSb3V0ZS1lbWlzc2lvbiBtb2RlbC5cbiAgICpcbiAgICogYGV4cGxpY2l0YCAodGhlIGRlZmF1bHQpIHdpcmVzIHRoZSBmdWxsIGRlcml2ZWQgcm91dGUgaW52ZW50b3J5IGFzIG9uZSBIVFRQXG4gICAqIEFQSSB2MiByb3V0ZSBwZXIgcm91dGUga2V5IGFuZCBpcyBieXRlLXN0YWJsZSBmb3IgZGVwbG95ZWQgc3RhY2tzLlxuICAgKiBgY29uc29saWRhdGVkYCB3aXJlcyBleGFjdGx5IHR3byBncmVlZHkgcm91dGVzLCBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAsXG4gICAqIGFuZCBpcyB2YWxpZCBvbmx5IGZvciB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCB0cmFuc3BvcnRcbiAgICogcG9zdHVyZXM7IGBpYW1gIGFuZCBgand0YCBhcmUgcmVmdXNlZCBhdCBzeW50aGVzaXMuXG4gICAqXG4gICAqIENvbnNvbGlkYXRlZCBtb2RlIGlzIGFsbG93ZWQgb24gYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLCBvciBvbiBhbiBhdHRhY2hlZFxuICAgKiBBUEkgdGhhdCBoYXMgbm8gcm91dGVzIGF0IGF0dGFjaCB0aW1lLiBcIk5vIHJvdXRlc1wiIGlzIGVuZm9yY2VkIG92ZXIgdGhlXG4gICAqIHdob2xlIHN0YWNrLCBub3QganVzdCB0aGUgQVBJJ3Mgb3duIGNoaWxkcmVuOiBhIHJvdXRlIHdpcmVkIG9udG8gdGhlXG4gICAqIGF0dGFjaGVkIEFQSSBmcm9tIGFueSBzaWJsaW5nIGNvbnN0cnVjdCBzY29wZSBpcyByZWZ1c2VkLCBiZWNhdXNlIGl0IGhvbGRzXG4gICAqIGEgcm91dGUga2V5IHRoZSBncmVlZHkgcm91dGVzIHdvdWxkIGNvbGxpZGUgd2l0aC5cbiAgICpcbiAgICogQSBjb25zdW1lciBtYXkgc3RpbGwgYWRkIGV4cGxpY2l0LCBtb3JlIHNwZWNpZmljIHJvdXRlcyB0byB0aGUgY29uc29saWRhdGVkXG4gICAqIEFQSSBhZnRlcndhcmRzLCBpbiBlaXRoZXIgdGhlIGF0dGFjaGVkIG9yIHRoZSBjb25zdHJ1Y3Qtb3duZWQgbW9kZS4gVGhhdFxuICAgKiBleGNlcHRpb24gaXMgZW5mb3JjZWQgYXQgc3ludGhlc2lzIHRpbWUgYW5kIGlzIGFsbG93ZWQgb25seSB3aGVuIHRoZSBhZGRlZFxuICAgKiByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciBhbmQgZG9lcyBub3QgcmVkZWNsYXJlIHRoZSBncmVlZHlcbiAgICogYEFOWSAvYCBvciBgQU5ZIC97cHJveHkrfWAga2V5LiBXaXRoaW4gaXQsIGEgZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBiZWF0cyB0aGVcbiAgICogZ3JlZWR5IHJvdXRlcyBieSBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlLCBhbmQgYSB3cm9uZy1tZXRob2QgaGl0IG9uIHN1Y2ggYVxuICAgKiBwYXRoIGZhbGxzIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVNb2RlbD86IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWw7XG5cbiAgLyoqXG4gICAqIENvbnN0cnVjdC1pZCBkZXJpdmF0aW9uIGZvciB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwuXG4gICAqXG4gICAqIGBsZWdhY3lgICh0aGUgZGVmYXVsdCkgYXNzaWducyBwb3NpdGlvbmFsIGlkcyBpbiBlbWlzc2lvbiBvcmRlciBhbmQgaXNcbiAgICogYnl0ZS1zdGFibGUgZm9yIGRlcGxveWVkIHN0YWNrcy4gYHNlbWFudGljYCBkZXJpdmVzIGVhY2ggaWQgZnJvbSBpdHMgcm91dGVcbiAgICogbWV0aG9kIGFuZCBwYXR0ZXJuLCBzbyBpbnNlcnRpbmcsIHJlbW92aW5nLCBvciByZW9yZGVyaW5nIGEgcm91dGUgZmFtaWx5XG4gICAqIG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlOyBpdCBpcyBpbnRlbmRlZCBmb3IgbmV3bHkgY3JlYXRlZCBleHBsaWNpdFxuICAgKiBBUElzLlxuICAgKlxuICAgKiBTd2l0Y2hpbmcgYW4gZXhpc3RpbmcgZGVwbG95ZWQgZXhwbGljaXQgQVBJIGZyb20gYGxlZ2FjeWAgdG8gYHNlbWFudGljYCBpblxuICAgKiBwbGFjZSByZW5hbWVzIGV2ZXJ5IHJvdXRlIGluIG9uZSB1cGRhdGUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlXG4gICAqIGNyZWF0ZS1iZWZvcmUtZGVsZXRlIHJvdXRlLWtleSBjb2xsaXNpb24gdGhlIG1pZ3JhdGlvbiBjaGVjayByZWZ1c2VzLiBBZG9wdFxuICAgKiBgc2VtYW50aWNgIG9uIGFuIGV4aXN0aW5nIHN0YWNrIG9ubHkgdGhyb3VnaCB0aGUgbmV3LUFQSSBzd2FwIGRvY3VtZW50ZWQgaW5cbiAgICogYFVQR1JBRElORy5tZGAuXG4gICAqXG4gICAqIFRoaXMgcHJvcCBhcHBsaWVzIHRvIGByb3V0ZU1vZGVsOiBleHBsaWNpdGAgb25seS4gVGhlIGBjb25zb2xpZGF0ZWRgIG1vZGVsXG4gICAqIGFscmVhZHkgZW1pdHMgdGhlIHR3byBmaXhlZCBzZW1hbnRpYyBpZHMgYFJvdXRlQW55Um9vdGAgYW5kIGBSb3V0ZUFueVByb3h5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZXG4gICAqL1xuICByZWFkb25seSByb3V0ZUlkTW9kZT86IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlO1xuXG4gIC8qKlxuICAgKiBDT1JTIHByZWZsaWdodCBmb3IgYSBjb25zdHJ1Y3Qtb3duZWQgQVBJLiBTZXQgdG8gYHRydWVgIGZvciBBcHBUaGVvcnlcbiAgICogZGVmYXVsdHMgb3Igc3VwcGx5IGFuIGBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnNgIG9iamVjdC4gSW52YWxpZCBpblxuICAgKiBhdHRhY2ggbW9kZSwgd2hlcmUgdGhlIG93bmluZyBBUEkgY29uZmlndXJlcyBDT1JTLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeGlzdGluZyBIVFRQIEFQSSB0byBhdHRhY2ggdG8uIEF0dGFjaCBtb2RlIGlzIHRoZSBwcmltYXJ5IGZyb250LWRvb3JcbiAgICogdG9wb2xvZ3kgYW5kIG5ldmVyIGNyZWF0ZXMgYW4gYEFXUzo6QXBpR2F0ZXdheVYyOjpBcGlgIHJlc291cmNlLlxuICAgKiBAZGVmYXVsdCBhIGNvbnN0cnVjdC1vd25lZCBIdHRwQXBpXG4gICAqL1xuICByZWFkb25seSBhcGk/OiBhcGlnd3YyLklIdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lIHVzZWQgd2hlbiBkZXJpdmluZyBhdHRhY2gtbW9kZSBleGVjdXRlLWFwaSBlbmRwb2ludCB0ZW1wbGF0ZXMuXG4gICAqIFVzZSBgJGRlZmF1bHRgIGZvciB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdCBzdGFnZS4gV2hlbiBvbWl0dGVkLCB0aGUgc3RhZ2VcbiAgICogaXMgbm90IGRldGVybWluYWJsZSBhbmQgdGhlIHRlbXBsYXRlcyByZXRhaW4gdGhlIGJhcmUgZXhlY3V0ZS1hcGkgb3JpZ2luLlxuICAgKiBUaGlzIHByb3AgZG9lcyBub3QgY3JlYXRlLCBpbXBvcnQsIG9yIG11dGF0ZSBhIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF0dGFjaGVkQXBpU3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEdvIGBydW50aW1lL21jcGZhY2FkZS5SZWdpc3Rlck1DUEZhY2FkZWAgc2VydmVzIG9ubHkgdGhlIGNhbm9uaWNhbCBkZWZhdWx0XG4gICAqIGZhbWlseS4gTm9uY2Fub25pY2FsIHBhdHRlcm5zIHJlcXVpcmUgYXBwLW93bmVkIHJ1bnRpbWUgcm91dGUgcmVnaXN0cmF0aW9uXG4gICAqIHRoYXQgbWF0Y2hlcyB0aGUgY29uc3RydWN0J3MgYHJvdXRlSW52ZW50b3J5YC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKClcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlRmFtaWx5PzogQXBwVGhlb3J5TWNwUm91dGVGYW1pbHk7XG5cbiAgLyoqXG4gICAqIFRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEFuIGV4cGxpY2l0IHNlbGVjdGlvbiBvdmVycmlkZXMgdGhlIGZhY2FkZS1zY29wZWQgZGVmYXVsdC4gV2hlbiBpdCBpc1xuICAgKiBvbWl0dGVkLCBhIHNlcnZlciB0aGF0IGF0dGFjaGVzIGBmYWNhZGVgIHJlc29sdmVzIHRvIGBydW50aW1lLWJlYXJlcmAgYW5kIGFcbiAgICogcGxhaW4gdHJhbnNwb3J0IHNlcnZlciByZXNvbHZlcyB0byBgaWFtYC4gYG5vbmUtcHVibGljYCBpcyBuZXZlciBhIGRlZmF1bHRcbiAgICogYW5kIGNhcnJpZXMgdGhlIGRlZmVuc2UtaW4tZGVwdGggZmxvb3IuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIgd2hlbiBgZmFjYWRlYCBpcyBhdHRhY2hlZCwgb3RoZXJ3aXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAqL1xuICByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlPzogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZTtcblxuICAvKipcbiAgICogVXBzdHJlYW0tcHJvdmlkZXIgYXR0YWNobWVudCB0aGF0IG1hcmtzIHRoaXMgc2VydmVyIGFzIGZhY2FkZS1jb25maWd1cmVkLlxuICAgKlxuICAgKiBUaGUgYXR0YWNobWVudCdzIHByZXNlbmNlIHNlbGVjdHMgdGhlIGBydW50aW1lLWJlYXJlcmAgcG9zdHVyZSBkZWZhdWx0LlxuICAgKiBQcm92aWRlciB3aXJpbmcgbGFuZHMgaW4gTTM7IHRoaXMgbWlsZXN0b25lIHZhbGlkYXRlcyB0aGUgYXR0YWNobWVudCBzaGFwZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmYWNhZGU/OiBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50O1xuXG4gIC8qKlxuICAgKiBSdW50aW1lLXNpZGUgUkZDIDk3MjggYmVhcmVyIHZhbGlkYXRpb24gZGVjbGFyYXRpb24uXG4gICAqXG4gICAqIFJlcXVpcmVkIGJ5IGB0cmFuc3BvcnRQb3N0dXJlOiBSVU5USU1FX0JFQVJFUmAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnlcbiAgICogb3RoZXIgcG9zdHVyZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBydW50aW1lUG9zdHVyZT86IEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucztcblxuICAvKipcbiAgICogRGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgYW5kXG4gICAqIE5PTkVfUFVCTElDLiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gaXMgcmVmdXNlZCB1bmxlc3MgaXQgaXMgZGVjbGFyZWRcbiAgICogYEZST05URURgLCB3aGljaCByZXF1aXJlcyBgZnJvbnREb29yVmVyaWZpY2F0aW9uYC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk/OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIEZyb250LWRvb3IgdmVyaWZpY2F0aW9uIGRlY2xhcmF0aW9uLCByZXF1aXJlZCB3aXRoXG4gICAqIGBvcmlnaW5SZWFjaGFiaWxpdHk6IEZST05URURgIGFuZCByZWZ1c2VkIHVuZGVyIGV2ZXJ5IG90aGVyIGRlY2lzaW9uLlxuICAgKlxuICAgKiBUaGUgY29uc3RydWN0IHJlY29yZHMgdGhlIHBvc3R1cmUsIHRoZSBoZWFkZXIgbmFtZSwgYW5kIGVpdGhlciBhIFNIQS0yNTZcbiAgICogZGlnZXN0IG9mIHRoZSBkZWNsYXJlZCBsaXRlcmFsIG9yIHRoZSB3ZWxsLWtub3duIHBhcmFtZXRlciBuYW1lIGluIHRoZVxuICAgKiBgYXBwdGhlb3J5Om1jcC10cmFuc3BvcnQtcG9zdHVyZWAgbWV0YWRhdGE7IGl0IG5ldmVyIGVtaXRzIHRoZSBzZWNyZXRcbiAgICogdmFsdWUuIGBmcm9udERvb3JPcmlnaW5IZWFkZXJgIGlzIHRoZSBvcmlnaW4gY3VzdG9tIGhlYWRlciB0aGUgYXBwbGljYXRpb25cbiAgICogd2lyZXMsIGFuZCBmb3IgdGhlIHBhcmFtZXRlciBmb3JtIGl0cyB2YWx1ZSBpcyBhIENsb3VkRm9ybWF0aW9uIGR5bmFtaWNcbiAgICogcmVmZXJlbmNlLiBFbmZvcmNlbWVudCBpcyB0aGUgcnVudGltZSdzIGZyb250LWRvb3IgaGVhZGVyIGNoZWNrLCBzbyBhblxuICAgKiB1bndpcmVkIHJ1bnRpbWUgZW5mb3JjZXMgbm90aGluZy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBmcm9udERvb3JWZXJpZmljYXRpb24/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBEZW5pYWwtdGVsZW1ldHJ5IGRlY2xhcmF0aW9uIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIG9ubHkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVuaWFsU2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucztcblxuICAvKipcbiAgICogQXR0YWNoLW1vZGUgcmVjb3JkIG9mIHRoZSBvd25pbmcgQVBJJ3MgdGhyb3R0bGluZyBhbmQgYWNjZXNzLWxvZ2dpbmdcbiAgICogZGVjaXNpb25zLCByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmQgTk9ORV9QVUJMSUMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgb3duaW5nQXBpRGVmZW5zZT86IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGF0aWMgSldUIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1AgdHJhbnNwb3J0IHJvdXRlcy5cbiAgICpcbiAgICogVHJhbnNwb3J0IHJvdXRlcyBhcmUgdGhlIFBPU1QsIEdFVCwgYW5kIERFTEVURSByb3V0ZXMgb24gZXZlcnkgTUNQIHBhdHRlcm4uXG4gICAqIFRoaXMgcHJvcCBpcyBvbmx5IHZhbGlkIHdpdGggYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAsIHdoaWNoIHJlcXVpcmVzIGFuXG4gICAqIGlzc3VlciBhbmQgYSBub24tZW1wdHkgYXVkaWVuY2UuIERpc2NvdmVyeSwgcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhLFxuICAgKiBhdXRob3JpemUsIGFuZCB0b2tlbiByb3V0ZXMgcmVtYWluIGV4cGxpY2l0bHkgcHVibGljIChgTk9ORWApIGJlY2F1c2UgT0F1dGhcbiAgICogY2xpZW50cyBtdXN0IGZldGNoIHRoZW0gYmVmb3JlIHRoZXkgaG9sZCBhIHRva2VuLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydEF1dGhvcml6ZXI/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRBdXRob3JpemVyT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UtZ2xvYmFsIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrIHBhdGguXG4gICAqXG4gICAqIFRoZSBDREstbW91bnRlZCBjYWxsYmFjayByb3V0ZSBhbmQgdGhlIHJ1bnRpbWUtcmVnaXN0ZXJlZCBvbmUgbXVzdCBub3RcbiAgICogZGl2ZXJnZTogdGhpcyBwcm9wIGlzIHJlc29sdmVkIGJ5XG4gICAqIGBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGhgLCB0aGUgc2FtZSBhbGdlYnJhXG4gICAqIHRoZSBydW50aW1lIGFwcGxpZXMgdG8gYEZhY2FkZUNvbmZpZy5VcHN0cmVhbUNhbGxiYWNrUGF0aGAuIFN1cHBseSBhXG4gICAqIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHF1ZXJ5LCBmcmFnbWVudCwgb3IgZG90XG4gICAqIHNlZ21lbnQ7IGFuIGVtcHR5IHZhbHVlIGtlZXBzIHRoZSBjb250cmFjdCBkZWZhdWx0LCBhbmQgYSB2YWx1ZSB0aGF0XG4gICAqIGNvbGxpZGVzIHdpdGggYW5vdGhlciBkZXJpdmVkIHJvdXRlIGZhaWxzIHN5bnRoZXNpcy4gUmVmdXNlZCB1bmRlclxuICAgKiBgdHJhbnNwb3J0UG9zdHVyZTogbm9uZS1wdWJsaWNgLCB3aGljaCBhdHRhY2hlcyBubyBPQXV0aCBzdXJmYWNlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIXG4gICAqL1xuICByZWFkb25seSB1cHN0cmVhbUNhbGxiYWNrUGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogU2Vzc2lvbi1zdGF0ZSB0YWJsZSBjb25maWd1cmF0aW9uLiBUaGUgdGFibGUgZGVmYXVsdHMgb24uXG4gICAqIEBkZWZhdWx0IGVuYWJsZWQgd2l0aCBwcm9kdWN0aW9uIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uU3RhdGU/OiBBcHBUaGVvcnlNY3BTZXNzaW9uU3RhdGVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPd25lZC1BUEkgY29uZmlndXJhdGlvbiBmb3Igc3RhbmRhbG9uZSBtb2RlLiBJbnZhbGlkIHdpdGggYGFwaWAuXG4gICAqIEBkZWZhdWx0IHByb2R1Y3Rpb24tb3duZWQgQVBJIGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBvd25lZEFwaT86IEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucztcblxuICAvKipcbiAgICogU2luZ2xlIE1DUCByb3V0ZSBwYXRoIGZyb20gdGhlIHYzLjEueCBBNiBzdXJmYWNlLlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHJvdXRlRmFtaWx5LnBhdHRlcm5zYC4gVGhlIG5ldyBkZWZhdWx0IGlzIHRoZSBjYW5vbmljYWxcbiAgICogZm91ci1wYXR0ZXJuIGZhbWlseTsgdXNlIGB7IHBhdHRlcm5zOiBbJy9tY3AnXSB9YCBmb3IgdGhlIG9sZCBzaW5nbGV0b24uXG4gICAqL1xuICByZWFkb25seSBtY3BQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBdXRob3JpemF0aW9uLXNlcnZlciBpc3N1ZXIgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5Jc3N1ZXJVUkxgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBpc3N1ZXIgZW52aXJvbm1lbnQgdmFsdWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcj86IHN0cmluZztcblxuICAvKipcbiAgICogSldLUyBVUkkgZnJvbSB0aGUgdjMuMS54IEE2IGVudmlyb25tZW50IGNvbnRyYWN0LlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJ1bnRpbWUvbWNwZmFjYWRlLkZhY2FkZUNvbmZpZy5KV0tTVVJJYCBpbiB0aGVcbiAgICogYXBwbGljYXRpb24uIFRoZSBjb25zdHJ1Y3Qgbm8gbG9uZ2VyIGluamVjdHMgSldLUyBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBqd2tzVXJpPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYG93bmVkQXBpLmFwaU5hbWVgLiAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dCBmb3IgdGhlIG93bmVkIEhUVFAgQVBJLlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgdGhlIGFjY2VzcyBsb2cgZ3JvdXAgaXMgbmFtZWRcbiAgICogYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBhbmQgY2FycmllcyB0aGUgY29udHJhY3QncyBKU09OIGZpZWxkIHNldC5cbiAgICogQWNjZXNzIGxvZ2dpbmcgYWxyZWFkeSBkZWZhdWx0cyBvbjsgcGFzcyBgb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nZ2luZzpcbiAgICogZmFsc2VgIHRvIG9wdCBvdXQuIEF0dGFjaCBtb2RlIGlnbm9yZXMgdGhpcyBwcm9wLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgb3duZWQgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW5cbiAgICogYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS5lbmFibGVkYC4gU2Vzc2lvbiBzdGF0ZSBub3cgZGVmYXVsdHMgb24uXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50YWJsZU5hbWVgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHNlc3Npb25TdGF0ZS50dGxNaW51dGVzYC4gKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblR0bE1pbnV0ZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuZG9tYWluYC4gRG9tYWlucyBhcmUgaW52YWxpZCBpbiBhdHRhY2ggbW9kZS5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuc3RhZ2VgLiBTdGFnZSBvcHRpb25zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogQ29udHJhY3QtZmlyc3QgTUNQIGZhY2FkZSBkZXBsb3ltZW50IGNvbnN0cnVjdC5cbiAqXG4gKiBUaGUgcHJpbWFyeSBtb2RlIGF0dGFjaGVzIHRoZSBjb21wbGV0ZSByb3V0ZS1hbGdlYnJhIGZhbWlseSB0byBhIHN1cHBsaWVkXG4gKiBIVFRQIEFQSS4gT21pdHRpbmcgYGFwaWAgc3BlY2lhbGl6ZXMgdGhlIHNhbWUgcGF0aCBpbnRvIGEgc3RhbmRhbG9uZSBvd25lZFxuICogQVBJLiBUaGUgY29uc3RydWN0IHJvdXRlcyBvbmx5OiBPQXV0aCBtZXRhZGF0YSwgc2NvcGVzLCBjYXBhYmlsaXRpZXMsIGFuZFxuICogYXV0aG9yaXplL3Rva2VuIGJlaGF2aW9yIHJlbWFpbiBhcHBsaWNhdGlvbi1vd25lZCB0aHJvdWdoIEdvXG4gKiBgbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFNlcnZlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHByaXZhdGUgcm91dGVTZXF1ZW5jZSA9IDA7XG4gIHByaXZhdGUgcm91dGVJZE1vZGUgPSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1k7XG4gIHByaXZhdGUgcmVhZG9ubHkgcm91dGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLklIdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIC8qKlxuICAgKiBSZXNvbHZlZCB0cmFuc3BvcnQtcm91dGUgYXV0aG9yaXphdGlvbiBwb3N0dXJlLlxuICAgKlxuICAgKiBGYWNhZGUtY29uZmlndXJlZCBzZXJ2ZXJzIHJlc29sdmUgdG8gYHJ1bnRpbWUtYmVhcmVyYCB1bmxlc3NcbiAgICogYHRyYW5zcG9ydFBvc3R1cmVgIG92ZXJyaWRlcyB0aGUgZGVmYXVsdDsgcGxhaW4gdHJhbnNwb3J0IHNlcnZlcnMgcmVzb2x2ZVxuICAgKiB0byBgaWFtYC4gRGVsaWJlcmF0ZWx5IHB1YmxpYyBzZXJ2ZXJzIG11c3Qgc2VsZWN0IGBub25lLXB1YmxpY2AgZXhwbGljaXRseS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB0cmFuc3BvcnRQb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuICAvKipcbiAgICogRGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZXMgZm9yIHRoZSBvcmRlcmVkIE1DUCByb3V0ZSBmYW1pbHkuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIHRoZXNlIGFyZSBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGVzLCBub3QgZGVjbGFyYXRpb25zIG9mXG4gICAqIHB1YmxpYyBhdXRob3JpdHkuIEFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZDsgdGhlIG9yaWdpbiBpcyBkZXJpdmVkXG4gICAqIGZyb20gYGFwaUlkYCwgdGhlIHN0YWNrIHJlZ2lvbiBhbmQgVVJMIHN1ZmZpeCwgcGx1c1xuICAgKiBgYXR0YWNoZWRBcGlTdGFnZU5hbWVgIHdoZW4gc3VwcGxpZWQuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnRzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IG1jcFBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoczogc3RyaW5nW107XG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUludmVudG9yeTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnk7XG5cbiAgLyoqXG4gICAqIEZpcnN0IGRlcml2ZWQgZW5kcG9pbnQgdGVtcGxhdGUuXG4gICAqXG4gICAqIEluIGF0dGFjaCBtb2RlIGFuIGBhcGlFbmRwb2ludGAgc3VwcGxpZWQgdGhyb3VnaFxuICAgKiBgSHR0cEFwaS5mcm9tSHR0cEFwaUF0dHJpYnV0ZXNgIGlzIG5ldmVyIGNvbnN1bHRlZC4gVGhpcyB2YWx1ZSBpcyBhblxuICAgKiBleGVjdXRlLWFwaSBvcmlnaW4gdGVtcGxhdGUgZGVyaXZlZCBieSB0aGUgc2FtZSBydWxlcyBhcyBgZW5kcG9pbnRzYCwgbm90XG4gICAqIHRoZSBmcm9udCBkb29yJ3MgcHVibGljIGF1dGhvcml0eS5cbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBlbmRwb2ludHNgLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgbWNwUGF0aHNgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aDogc3RyaW5nO1xuXG4gIC8qKiBAZGVwcmVjYXRlZCBVc2UgYHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoc2Agb3IgYHJvdXRlSW52ZW50b3J5YC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoOiBzdHJpbmc7XG5cbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICAvKipcbiAgICogVGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHAtb3duZWQgZnJvbnQgZG9vciBtdXN0IHNlbmQgb24gZXZlcnkgb3JpZ2luXG4gICAqIHJlcXVlc3QsIHByZXNlbnQgb25seSB1bmRlciBgb3JpZ2luUmVhY2hhYmlsaXR5OiBGUk9OVEVEYC5cbiAgICpcbiAgICogV2lyZSBpdCBpbnRvIHRoZSBkaXN0cmlidXRpb24gb3JpZ2luOlxuICAgKiBgb3JpZ2lucy5IdHRwT3JpZ2luKGhvc3QsIHsgY3VzdG9tSGVhZGVyczogeyBbaC5oZWFkZXJOYW1lXTogaC5oZWFkZXJWYWx1ZSB9IH0pYC5cbiAgICogVW5kZXIgdGhlIHBhcmFtZXRlciBmb3JtIGBoZWFkZXJWYWx1ZWAgaXMgYSBge3tyZXNvbHZlOnNzbTouLi59fWBcbiAgICogQ2xvdWRGb3JtYXRpb24gZHluYW1pYyByZWZlcmVuY2UsIHNvIHRoZSB2YWx1ZSBuZXZlciBlbnRlcnMgdGhlXG4gICAqIGFwcGxpY2F0aW9uIHNvdXJjZSBvciB0aGUgY29uc3RydWN0J3MgdGVtcGxhdGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZnJvbnREb29yT3JpZ2luSGVhZGVyPzogQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHMpO1xuICAgIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHMpO1xuICAgIGNvbnN0IHJvdXRlRmFtaWx5ID0gbm9ybWFsaXplUm91dGVGYW1pbHkocHJvcHMpO1xuICAgIGNvbnN0IG93bmVkT3B0aW9ucyA9IG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wcyk7XG5cbiAgICBjb25zdCBwb3N0dXJlID0gcHJvcHMudHJhbnNwb3J0UG9zdHVyZVxuICAgICAgPz8gKHByb3BzLmZhY2FkZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICAgICA6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNKTtcbiAgICB2YWxpZGF0ZVRyYW5zcG9ydFBvc3R1cmUocG9zdHVyZSk7XG4gICAgdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KHByb3BzLmZhY2FkZSk7XG4gICAgdmFsaWRhdGVQb3N0dXJlR3VhcmRzKHByb3BzLCByb3V0ZUZhbWlseSwgcG9zdHVyZSk7XG4gICAgdmFsaWRhdGVEZWZlbnNlSW5EZXB0aChwcm9wcywgcG9zdHVyZSwgb3duZWRPcHRpb25zKTtcbiAgICBjb25zdCBvcmlnaW5SZWFjaGFiaWxpdHkgPSByZXNvbHZlT3JpZ2luUmVhY2hhYmlsaXR5KHRoaXMsIHByb3BzLCBvd25lZE9wdGlvbnMpO1xuICAgIGlmIChvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEKSB7XG4gICAgICAodGhpcyBhcyB7IGZyb250RG9vck9yaWdpbkhlYWRlcj86IEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlciB9KS5mcm9udERvb3JPcmlnaW5IZWFkZXIgPVxuICAgICAgICBmcm9udERvb3JPcmlnaW5IZWFkZXIocHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uKTtcbiAgICAgIGdyYW50RnJvbnREb29yUGFyYW1ldGVyUmVhZCh0aGlzLCBwcm9wcy5oYW5kbGVyLCBwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pO1xuICAgIH1cbiAgICBjb25zdCByb3V0ZU1vZGVsID0gcmVzb2x2ZVJvdXRlTW9kZWwocHJvcHMpO1xuICAgIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUocm91dGVNb2RlbCwgcG9zdHVyZSk7XG4gICAgY29uc3Qgcm91dGVJZE1vZGUgPSByZXNvbHZlUm91dGVJZE1vZGUocHJvcHMpO1xuICAgIHRoaXMucm91dGVJZE1vZGUgPSByb3V0ZUlkTW9kZTtcbiAgICBpZiAocm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURUQgJiYgcHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFzc2VydENvbnNvbGlkYXRlZEF0dGFjaEFsbG93ZWQodGhpcywgcHJvcHMuYXBpKTtcbiAgICB9XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkID0gcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQztcbiAgICBjb25zdCB1cHN0cmVhbUNhbGxiYWNrUGF0aCA9IHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wcyk7XG5cbiAgICB0aGlzLnRyYW5zcG9ydFBvc3R1cmUgPSBwb3N0dXJlO1xuICAgIHRoaXMubWNwUGF0aHMgPSBbLi4ucm91dGVGYW1pbHkucGF0dGVybnNdO1xuICAgIHRoaXMucm91dGVJbnZlbnRvcnkgPSBidWlsZFJvdXRlSW52ZW50b3J5KFxuICAgICAgdGhpcy5tY3BQYXRocyxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICAgIHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5LFxuICAgICAgdXBzdHJlYW1DYWxsYmFja1BhdGgsXG4gICAgKTtcbiAgICB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KHRoaXMucm91dGVJbnZlbnRvcnksIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCk7XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHMgPSB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5tYXAoXG4gICAgICAocm91dGUpID0+IHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybixcbiAgICApO1xuICAgIHRoaXMubWNwUGF0aCA9IHRoaXMubWNwUGF0aHNbMF07XG4gICAgdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aCA9IHRoaXMucHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzWzBdO1xuXG4gICAgbGV0IG93bmVkU3RhZ2U6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkO1xuICAgIGxldCBvd25lZFN0YWdlTmFtZSA9IFwiJGRlZmF1bHRcIjtcbiAgICBpZiAocHJvcHMuYXBpKSB7XG4gICAgICB0aGlzLmFwaSA9IHByb3BzLmFwaTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3RhZ2VPcHRpb25zID0gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG93bmVkT3B0aW9ucy5zdGFnZSk7XG4gICAgICBvd25lZFN0YWdlTmFtZSA9IHN0YWdlT3B0aW9ucy5zdGFnZU5hbWU7XG4gICAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgICBjb25zdCBzdGFuZGFyZCA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICAgIGNvbnN0IGFwaU5hbWVQcm9wID0gcHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCA/IFwib3duZWRBcGkuYXBpTmFtZVwiIDogXCJhcGlOYW1lXCI7XG4gICAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlNY3BTZXJ2ZXJcIiwgYXBpTmFtZVByb3AsIFwiYXBpX2h0dHBcIiwgbG9naWNhbCwgb3duZWRPcHRpb25zLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyXCIsXG4gICAgICAgIFwic2Vzc2lvblN0YXRlLnRhYmxlTmFtZVwiLFxuICAgICAgICBcImR5bmFtb2RiX3RhYmxlXCIsXG4gICAgICAgIGxvZ2ljYWwsXG4gICAgICAgIHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfaHR0cFwiLCBsb2dpY2FsKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IG93bmVkT3B0aW9ucy5hcGlOYW1lLFxuICAgICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogZmFsc2UsXG4gICAgICAgIGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQ6IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgICAgfHwgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICAgPyB0cnVlXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgb3duZWRBcGk/OiBhcGlnd3YyLkh0dHBBcGkgfSkub3duZWRBcGkgPSBhcGk7XG4gICAgICB0aGlzLmFwaSA9IGFwaTtcbiAgICAgIGlmIChvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCkge1xuICAgICAgICByZWdpc3Rlck93bmVkRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIGFwaSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICBodHRwQXBpOiBhcGksXG4gICAgICAgIHN0YWdlTmFtZTogc3RhZ2VPcHRpb25zLnN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nRW5hYmxlZFxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdGlvbnMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICAgIG93bmVkU3RhZ2UgPSBzdGFnZTtcblxuICAgICAgaWYgKHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgIGlmIChzdGFuZGFyZCAmJiAhbG9naWNhbCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlciBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNvbnRyYWN0TmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgID8gYWNjZXNzTG9nR3JvdXBOYW1lKG5hbWluZ0NvbnRleHQsIGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gc3RhbmRhcmQgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICBsb2dHcm91cE5hbWU6IGNvbnRyYWN0TmFtZSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgOiBjb250cmFjdE5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogY29udHJhY3ROYW1lLFxuICAgICAgICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ1JldGVudGlvbixcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIDogbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dSZXRlbnRpb24sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgICAgZm9ybWF0OiBzdGFuZGFyZCA/IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgXCJNY3BIYW5kbGVyXCIsXG4gICAgICBwcm9wcy5oYW5kbGVyLFxuICAgICAge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSxcbiAgICApO1xuICAgIGNvbnN0IHRyYW5zcG9ydEF1dGhvcml6ZXIgPSByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihwcm9wcywgcG9zdHVyZSk7XG4gICAgbGV0IGZpcnN0VHJhbnNwb3J0Um91dGU6IGFwaWd3djIuSHR0cFJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCkge1xuICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9ST09UX1JPVVRFX0lELFxuICAgICAgICBcIi9cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgcHJveHlSb3V0ZSA9IHRoaXMuYWRkQ29uc29saWRhdGVkUm91dGUoXG4gICAgICAgIENPTlNPTElEQVRFRF9QUk9YWV9ST1VURV9JRCxcbiAgICAgICAgXCIve3Byb3h5K31cIixcbiAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICApO1xuICAgICAgcmVnaXN0ZXJDb25zb2xpZGF0ZWRBdHRhY2hWYWxpZGF0aW9uKHRoaXMsIHRoaXMuYXBpLCBbZmlyc3RUcmFuc3BvcnRSb3V0ZSwgcHJveHlSb3V0ZV0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBydW50aW1lT3duZWRBdXRoID0gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzKSB7XG4gICAgICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIHtcbiAgICAgICAgICBjb25zdCBjcmVhdGVkID0gdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgICByb3V0ZS5tY3BQYXR0ZXJuLFxuICAgICAgICAgICAgdG9IdHRwTWV0aG9kKG1ldGhvZCksXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICAgIHRyYW5zcG9ydEF1dGhvcml6ZXIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBmaXJzdFRyYW5zcG9ydFJvdXRlID0gZmlyc3RUcmFuc3BvcnRSb3V0ZSA/PyBjcmVhdGVkO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5kaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS50b2tlblBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucmVnaXN0ZXJQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBUaGUgdXBzdHJlYW0gY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBub3QgcGVyIGtpbmQ6IHdpcmUgaXQgZXhhY3RseSBvbmNlLlxuICAgICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5yb3V0ZUludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgIHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuLFxuICAgICAgICAgIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgcnVudGltZU93bmVkQXV0aCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwb3N0dXJlTWFya2VyVGFyZ2V0ID0gKHRoaXMub3duZWRBcGk/Lm5vZGUuZGVmYXVsdENoaWxkXG4gICAgICA/PyBmaXJzdFRyYW5zcG9ydFJvdXRlPy5ub2RlLmRlZmF1bHRDaGlsZCkgYXMgYXBpZ3d2Mi5DZm5BcGkgfCBhcGlnd3YyLkNmblJvdXRlIHwgdW5kZWZpbmVkO1xuICAgIHBvc3R1cmVNYXJrZXJUYXJnZXQ/LmFkZE1ldGFkYXRhKE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9NRVRBREFUQV9LRVksIHtcbiAgICAgIHBvc3R1cmUsXG4gICAgICBjb250cmFjdF9pZDogTUNQX1RSQU5TUE9SVF9QT1NUVVJFX0NPTlRSQUNUX0lELFxuICAgICAgcm91dGVfY291bnQ6IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLmxlbmd0aCxcbiAgICAgIHJ1bnRpbWVfcG9zdHVyZV9kZWNsYXJlZDogcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZCxcbiAgICAgIC8vIE9ubHkgYSBGUk9OVEVEIGRlY2lzaW9uIGV4dGVuZHMgdGhlIG1hcmtlciwgc28gRElTQUJMRUQgYW5kIExPQ0tFRFxuICAgICAgLy8gdGVtcGxhdGVzIHN0YXkgYnl0ZS1pZGVudGljYWwuIFRoZSBsaXRlcmFsIHNlY3JldCBpcyBjb25zdW1lZCBoZXJlIGZvclxuICAgICAgLy8gaXRzIGRpZ2VzdCBhbmQgbmV2ZXIgZW1pdHRlZC5cbiAgICAgIC4uLihvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICAgICAgID8gZnJvbnREb29yUG9zdHVyZU1ldGFkYXRhKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbilcbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uU3RhdGUgPSBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHMpO1xuICAgIGlmIChzZXNzaW9uU3RhdGUuZW5hYmxlZCkge1xuICAgICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLmFwaSA/IHVuZGVmaW5lZCA6IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICBjb25zdCBsb2dpY2FsID0gbmFtaW5nQ29udGV4dFxuICAgICAgICA/IHByb3BzLmxvZ2ljYWxOYW1lID8/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGRlcml2ZWRUYWJsZU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImR5bmFtb2RiX3RhYmxlXCIsIGAke2xvZ2ljYWx9LXNlc3Npb25zYClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogZGVyaXZlZFRhYmxlTmFtZSAmJiAhZGVyaXZlZFRhYmxlTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkVGFibGVOYW1lLm5hbWUgOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlKTtcbiAgICAgIGlmIChcbiAgICAgICAgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICYmIHRoaXMub3duZWRBcGkgIT09IHVuZGVmaW5lZFxuICAgICAgKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIHRoaXMub3duZWRBcGkpO1xuICAgICAgfVxuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICBwcm9wcy5hcGkgPT09IHVuZGVmaW5lZFxuICAgICAgJiYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgIHx8IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRClcbiAgICAgICYmIHRoaXMuZW5kcG9pbnRzLnNvbWUoKGVuZHBvaW50KSA9PiBlbmRwb2ludC5pbmNsdWRlcyhcIi5leGVjdXRlLWFwaS5cIikpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgbXVzdCBhZHZlcnRpc2UgdGhlIG93bmVkIGN1c3RvbSBkb21haW4sIG5ldmVyIHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCB0aGlzLm5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCksIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgbmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMucm91dGVJZE1vZGUgIT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDKSB7XG4gICAgICByZXR1cm4gYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpO1xuICAgIGlmICh0aGlzLnJvdXRlSWRzLmhhcyhpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgc2VtYW50aWMgZGVyaXZlcyB0aGUgZHVwbGljYXRlIHJvdXRlIGNvbnN0cnVjdCBpZCAke2lkfSBmb3Igcm91dGUga2V5ICR7bWV0aG9kfSAke3BhdGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMucm91dGVJZHMuYWRkKGlkKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBpZCwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgbXRsczogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2UsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nIH0pLmFwaU1hcHBpbmcgPSBhcGlNYXBwaW5nO1xuICAgIGlmIChvcHRpb25zLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IGNuYW1lUmVjb3JkID0gbmV3IHJvdXRlNTMuQ25hbWVSZWNvcmQodGhpcywgXCJDbmFtZVJlY29yZFwiLCB7XG4gICAgICAgIHpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgICAgcmVjb3JkTmFtZTogdG9Sb3V0ZTUzUmVjb3JkTmFtZShvcHRpb25zLmRvbWFpbk5hbWUsIG9wdGlvbnMuaG9zdGVkWm9uZSksXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IGNuYW1lUmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFJvdXRlRmFtaWx5IHtcbiAgcmVhZG9ubHkgcGF0dGVybnM6IHN0cmluZ1tdO1xuICByZWFkb25seSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeTogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zO1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICByZWFkb25seSBzdGFnZU5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdFbmFibGVkOiBib29sZWFuO1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0OiBudW1iZXI7XG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgcmVhZG9ubHkgZW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSB0dGxNaW51dGVzOiBudW1iZXI7XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3k7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlRmFtaWx5KHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIGlmIChwcm9wcy5yb3V0ZUZhbWlseSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseSBhbmQgZGVwcmVjYXRlZCBtY3BQYXRoIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF3UGF0dGVybnMgPSBwcm9wcy5yb3V0ZUZhbWlseT8ucGF0dGVybnNcbiAgICA/PyAocHJvcHMubWNwUGF0aCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IFtwcm9wcy5tY3BQYXRoXVxuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICkpO1xuICBpZiAocmF3UGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuICBjb25zdCBwYXR0ZXJucyA9IHJhd1BhdHRlcm5zLm1hcCgocGF0dGVybiwgaW5kZXgpID0+XG4gICAgbm9ybWFsaXplUm91dGVQYXRoKHBhdHRlcm4sIGByb3V0ZUZhbWlseS5wYXR0ZXJuc1ske2luZGV4fV1gKSk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIHBhdHRlcm5zKSB7XG4gICAgaWYgKHNlZW4uaGFzKHBhdHRlcm4pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlRmFtaWx5LnBhdHRlcm5zIGNvbnRhaW5zIGR1cGxpY2F0ZSBwYXR0ZXJuICR7SlNPTi5zdHJpbmdpZnkocGF0dGVybil9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHBhdHRlcm4pO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGF0dGVybnMsXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6XG4gICAgICBwcm9wcy5yb3V0ZUZhbWlseT8ucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkgPz8gZmFsc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCByb3V0ZSBwYXR0ZXJuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgaWYgKCFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICBjb25zdCBzZWdtZW50cyA9IHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDAgfHwgc2VnbWVudHMuc29tZSgoc2VnbWVudCkgPT4gc2VnbWVudCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgfVxuICBjb25zdCBsaXRlcmFsID0gL14oPzpbQS1aYS16MC05Ll9+ISQmJygpKissOz06QC1dfCVbMC05QS1GYS1mXXsyfSkrJC87XG4gIGNvbnN0IHBhcmFtZXRlciA9IC9eXFx7KFtBLVphLXpfXVtBLVphLXowLTlfXSopXFx9JC87XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIGlmIChwYXJhbWV0ZXIudGVzdChzZWdtZW50KSkgY29udGludWU7XG4gICAgaWYgKCFsaXRlcmFsLnRlc3Qoc2VnbWVudCkgfHwgc2VnbWVudC5pbmNsdWRlcyhcIntcIikgfHwgc2VnbWVudC5pbmNsdWRlcyhcIn1cIikpIHtcbiAgICAgIHRocm93IGludmFsaWRSb3V0ZVBhdHRlcm4ocHJvcE5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lOiBzdHJpbmcpOiBFcnJvciB7XG4gIHJldHVybiBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhbiBhYnNvbHV0ZSBzeW50aGVzaXMtdGltZSByb3V0ZSBwYXR0ZXJuIHdpdGggbm9uLWVtcHR5IGxpdGVyYWwgb3Ige3BhcmFtZXRlcl9uYW1lfSBzZWdtZW50cyBhbmQgbm8gZG90IHNlZ21lbnRzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHN0cmluZyB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRIO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoY29uZmlndXJlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0aFwiLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKGNvbmZpZ3VyZWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvclxuICAgICAgPyBlcnIubWVzc2FnZS5yZXBsYWNlKC9ebWNwcm91dGVzOiAvLCBcIlwiKVxuICAgICAgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB1cHN0cmVhbUNhbGxiYWNrUGF0aCBpcyBpbnZhbGlkOiAke3JlYXNvbn1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSb3V0ZUludmVudG9yeShcbiAgcGF0dGVybnM6IHN0cmluZ1tdLFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW4sXG4gIGNhbGxiYWNrUGF0dGVybjogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWNwU2VydmVyUm91dGVJbnZlbnRvcnkge1xuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkNPTlRSQUNUX1ZFUlNJT04sXG4gICAgcm91dGVzOiBwYXR0ZXJucy5tYXAoKG1jcFBhdHRlcm4pID0+ICh7XG4gICAgICBtY3BQYXR0ZXJuLFxuICAgICAgbWNwTWV0aG9kczogW1wiUE9TVFwiLCBcIkdFVFwiLCBcIkRFTEVURVwiXSxcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGRpc2NvdmVyeVN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgIH0pKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm46XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXCIvXCIpLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQsXG4gICAgY2FsbGJhY2tQYXR0ZXJuLFxuICB9O1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJvdXRlSW52ZW50b3J5KFxuICBpbnZlbnRvcnk6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5LFxuICBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQ6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBhZGQgPSAobWV0aG9kOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke21ldGhvZH0gJHtwYXRofWA7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiBkZXJpdmVkIHJvdXRlIGZhbWlseSBjb2xsaWRlcyBhdCAke2tleX1gKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfTtcbiAgZm9yIChjb25zdCByb3V0ZSBvZiBpbnZlbnRvcnkucm91dGVzKSB7XG4gICAgZm9yIChjb25zdCBtZXRob2Qgb2Ygcm91dGUubWNwTWV0aG9kcykgYWRkKG1ldGhvZCwgcm91dGUubWNwUGF0dGVybik7XG4gICAgaWYgKGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCkge1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLnByb3RlY3RlZFJlc291cmNlUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuZGlzY292ZXJ5U3VmZml4UGF0dGVybik7XG4gICAgICBhZGQoXCJHRVRcIiwgcm91dGUuYXV0aG9yaXplUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnRva2VuUGF0dGVybik7XG4gICAgICBhZGQoXCJQT1NUXCIsIHJvdXRlLnJlZ2lzdGVyUGF0dGVybik7XG4gICAgfVxuICB9XG4gIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICBhZGQoXCJHRVRcIiwgaW52ZW50b3J5LmNhbGxiYWNrUGF0dGVybik7XG4gIH1cbiAgaWYgKGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5yb290QXV0aG9yaXphdGlvblNlcnZlclBhdHRlcm4pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiB2b2lkIHtcbiAgaWYgKCFwcm9wcy5hcGkpIHtcbiAgICBpZiAocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgcmVxdWlyZXMgYXR0YWNoIG1vZGUgd2l0aCBhcGlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICYmIChUb2tlbi5pc1VucmVzb2x2ZWQocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpXG4gICAgICB8fCAhL14oPzpcXCRkZWZhdWx0fFtBLVphLXowLTlfLV17MSwxMjh9KSQvLnRlc3QocHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUpKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoZWRBcGlTdGFnZU5hbWUgbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgQVBJIEdhdGV3YXkgc3RhZ2UgbmFtZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHByb3BzLm93bmVkQXBpICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcIm93bmVkQXBpXCIpO1xuICBpZiAocHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJhcGlOYW1lXCIpO1xuICBpZiAocHJvcHMuY29ycyAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJjb3JzXCIpO1xuICBpZiAocHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcImRvbWFpblwiKTtcbiAgaWYgKHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIGludmFsaWQucHVzaChcInN0YWdlXCIpO1xuICBpZiAoaW52YWxpZC5sZW5ndGggIT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBhdHRhY2ggbW9kZSB3aXRoIGFwaSBjYW5ub3QgY29uZmlndXJlIG93bmVkLUFQSSBwcm9wczogJHtpbnZhbGlkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMge1xuICBpZiAocHJvcHMub3duZWRBcGk/LmFwaU5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuYXBpTmFtZSBhbmQgZGVwcmVjYXRlZCBhcGlOYW1lIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5kb21haW4gIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW4gIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4gYW5kIGRlcHJlY2F0ZWQgZG9tYWluIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLm93bmVkQXBpPy5zdGFnZSAhPT0gdW5kZWZpbmVkICYmIHByb3BzLnN0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgYW5kIGRlcHJlY2F0ZWQgc3RhZ2UgY2Fubm90IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFwaU5hbWU6IHByb3BzLm93bmVkQXBpPy5hcGlOYW1lID8/IHByb3BzLmFwaU5hbWUsXG4gICAgZG9tYWluOiBwcm9wcy5vd25lZEFwaT8uZG9tYWluID8/IHByb3BzLmRvbWFpbixcbiAgICBzdGFnZTogcHJvcHMub3duZWRBcGk/LnN0YWdlID8/IHByb3BzLnN0YWdlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU9wdGlvbnMob3B0aW9ucz86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyk6IE5vcm1hbGl6ZWRTdGFnZU9wdGlvbnMge1xuICBjb25zdCBhY2Nlc3NMb2dnaW5nID0gb3B0aW9ucz8uYWNjZXNzTG9nZ2luZyA/PyB0cnVlO1xuICBpZiAoIWFjY2Vzc0xvZ2dpbmcgJiYgb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UuYWNjZXNzTG9nUmV0ZW50aW9uIHJlcXVpcmVzIGFjY2Vzc0xvZ2dpbmcgdG8gYmUgZW5hYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdGhyb3R0bGluZ0VuYWJsZWQgPSBvcHRpb25zPy50aHJvdHRsaW5nRW5hYmxlZCA/PyB0cnVlO1xuICBpZiAoXG4gICAgIXRocm90dGxpbmdFbmFibGVkXG4gICAgJiYgKG9wdGlvbnM/LnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBvcHRpb25zPy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuc3RhZ2UgdGhyb3R0bGluZyBsaW1pdHMgcmVxdWlyZSB0aHJvdHRsaW5nRW5hYmxlZCB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByYXRlTGltaXQgPSBvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19SQVRFX0xJTUlUO1xuICBjb25zdCBidXJzdExpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgPz8gREVGQVVMVF9USFJPVFRMSU5HX0JVUlNUX0xJTUlUO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHJhdGVMaW1pdCwgXCJvd25lZEFwaS5zdGFnZS50aHJvdHRsaW5nUmF0ZUxpbWl0XCIpO1xuICB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKGJ1cnN0TGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0J1cnN0TGltaXRcIik7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VOYW1lOiBvcHRpb25zPy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiLFxuICAgIGFjY2Vzc0xvZ2dpbmcsXG4gICAgYWNjZXNzTG9nUmV0ZW50aW9uOiBvcHRpb25zPy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICB0aHJvdHRsaW5nRW5hYmxlZCxcbiAgICB0aHJvdHRsaW5nUmF0ZUxpbWl0OiByYXRlTGltaXQsXG4gICAgdGhyb3R0bGluZ0J1cnN0TGltaXQ6IGJ1cnN0TGltaXQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25TdGF0ZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkU2Vzc2lvblN0YXRlIHtcbiAgY29uc3QgaGFzTGVnYWN5ID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICB8fCBwcm9wcy5zZXNzaW9uVHRsTWludXRlcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAocHJvcHMuc2Vzc2lvblN0YXRlICE9PSB1bmRlZmluZWQgJiYgaGFzTGVnYWN5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHNlc3Npb25TdGF0ZSBjYW5ub3QgYmUgY29tYmluZWQgd2l0aCBkZXByZWNhdGVkIHNlc3Npb24tdGFibGUgcHJvcHNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGVuYWJsZWQgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LmVuYWJsZWQgPz8gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlID8/IHRydWU7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25TdGF0ZT8udGFibGVOYW1lID8/IHByb3BzLnNlc3Npb25UYWJsZU5hbWU7XG4gIGNvbnN0IHR0bE1pbnV0ZXMgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXNcbiAgICA/PyBwcm9wcy5zZXNzaW9uVHRsTWludXRlc1xuICAgID8/IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUztcbiAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgaWYgKFxuICAgICFlbmFibGVkXG4gICAgJiYgKHRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LnR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy5yZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRpc2FibGVkIHNlc3Npb24gc3RhdGUgY2Fubm90IGNvbmZpZ3VyZSB0YWJsZU5hbWUsIHR0bE1pbnV0ZXMsIG9yIHJlbW92YWxQb2xpY3lcIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7IGVuYWJsZWQsIHRhYmxlTmFtZSwgdHRsTWludXRlcywgcmVtb3ZhbFBvbGljeSB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMZWdhY3lBdXRoQ29uZmlnKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IHZvaWQge1xuICBjb25zdCBoYXNJc3N1ZXIgPSBwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc0p3a3NVcmkgPSBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNJc3N1ZXIgIT09IGhhc0p3a3NVcmkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBhbmQgandrc1VyaSBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoIWhhc0lzc3VlciB8fCAhaGFzSndrc1VyaSkgcmV0dXJuO1xuICBjb25zdCBpc3N1ZXIgPSBTdHJpbmcocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcklzc3Vlcik7XG4gIGNvbnN0IGp3a3NVcmkgPSBTdHJpbmcocHJvcHMuandrc1VyaSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGlzc3VlcixcbiAgICAgIGZhbHNlLFxuICAgICAgXCJhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gcXVlcnkgb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGp3a3NVcmkpKSB7XG4gICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICBqd2tzVXJpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiandrc1VyaSBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHVzZXJpbmZvIG9yIGZyYWdtZW50XCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHJhbnNwb3J0QXV0aG9yaXplcihcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy50cmFuc3BvcnRBdXRob3JpemVyO1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6IHtcbiAgICAgIGlmIChjb25maWd1cmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyIGlzIG9ubHkgdmFsaWQgd2l0aCB0cmFuc3BvcnRQb3N0dXJlIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNXG4gICAgICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgICAgIDogbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgfVxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5KV1Q6IHtcbiAgICAgIGNvbnN0IGlzc3VlciA9IFN0cmluZyhjb25maWd1cmVkPy5pc3N1ZXIgPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKGlzc3VlciA9PT0gXCJcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuaXNzdWVyIGlzIHJlcXVpcmVkIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKGlzc3VlcikpIHtcbiAgICAgICAgdmFsaWRhdGVMaXRlcmFsT0F1dGhVUkwoXG4gICAgICAgICAgaXNzdWVyLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIFwidHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgYXVkaWVuY2UgPSAoY29uZmlndXJlZD8uYXVkaWVuY2UgPz8gW10pXG4gICAgICAgIC5tYXAoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcigodmFsdWUpID0+IHZhbHVlICE9PSBcIlwiKTtcbiAgICAgIGlmIChhdWRpZW5jZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRBdXRob3JpemVyLmF1ZGllbmNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhY2NlcHRlZCBhdWRpZW5jZSB3aGVuIHRyYW5zcG9ydFBvc3R1cmUgaXMgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSnd0QXV0aG9yaXplcihcbiAgICAgICAgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lELFxuICAgICAgICBpc3N1ZXIsXG4gICAgICAgIHtcbiAgICAgICAgICBqd3RBdWRpZW5jZTogYXVkaWVuY2UsXG4gICAgICAgICAgaWRlbnRpdHlTb3VyY2U6IGNvbmZpZ3VyZWQ/LmlkZW50aXR5U291cmNlLFxuICAgICAgICAgIGF1dGhvcml6ZXJOYW1lOiBjb25maWd1cmVkPy5hdXRob3JpemVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBvc3R1cmVMYWJlbChwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTogcmV0dXJuIFwiSUFNXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDogcmV0dXJuIFwiSldUXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOiByZXR1cm4gXCJSVU5USU1FX0JFQVJFUlwiO1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzogcmV0dXJuIFwiTk9ORV9QVUJMSUNcIjtcbiAgICBkZWZhdWx0OiByZXR1cm4gU3RyaW5nKHBvc3R1cmUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlKTogdm9pZCB7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOlxuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIG11c3QgYmUgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0sIC5KV1QsIC5SVU5USU1FX0JFQVJFUiwgb3IgLk5PTkVfUFVCTElDXCIsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZU1vZGVsKHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyk6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVNb2RlbDtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAgfHwgY29uZmlndXJlZCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgKSB7XG4gICAgcmV0dXJuIGNvbmZpZ3VyZWQ7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5FWFBMSUNJVCBvciAuQ09OU09MSURBVEVEXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUm91dGVNb2RlbFBvc3R1cmUoXG4gIHJvdXRlTW9kZWw6IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHJvdXRlTW9kZWwgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuQ09OU09MSURBVEVEXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUlxuICAgICYmIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUNcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgaXMgb25seSB2YWxpZCBmb3IgdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiBvciBOT05FX1BVQkxJQzsgdHJhbnNwb3J0UG9zdHVyZSAke3Bvc3R1cmVMYWJlbChwb3N0dXJlKX0ga2VlcHMgdGhlIGV4cGxpY2l0IHJvdXRlIG1vZGVsIGJlY2F1c2UgY29uc29saWRhdGlvbiBtdXN0IG5ldmVyIGNoYW5nZSBnYXRld2F5IGFkbWlzc2lvbmAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUm91dGVJZE1vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMucm91dGVJZE1vZGU7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZO1xuICB9XG4gIGlmIChcbiAgICBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1lcbiAgICB8fCBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5TRU1BTlRJQ1xuICApIHtcbiAgICByZXR1cm4gY29uZmlndXJlZDtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlSWRNb2RlIG11c3QgYmUgQXBwVGhlb3J5TWNwUm91dGVJZE1vZGUuTEVHQUNZIG9yIC5TRU1BTlRJQ1wiLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSB0d28gZ3JlZWR5IHJvdXRlIGtleXMgYSBjb25zb2xpZGF0ZWQgbW9kZWwgb3ducy4gQSBjb25zdW1lciByb3V0ZSB0aGF0XG4gKiByZWRlY2xhcmVzIG9uZSBvZiB0aGVtIHdvdWxkIG1ha2UgdGhlIEFQSSByZWplY3QgdGhlIHVwZGF0ZS5cbiAqL1xuY29uc3QgQ09OU09MSURBVEVEX0dSRUVEWV9ST1VURV9LRVlTID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4vKipcbiAqIFJlc29sdmUgYW4gYEFwaUlkYCAob3IgYW55IHRlbXBsYXRlIHZhbHVlKSB0byBhIGNvbXBhcmFibGUgc3RyaW5nLCBzbyBhXG4gKiBgUmVmYCB0b2tlbiBhbmQgaXRzIGxvZ2ljYWwgaWQgY29tcGFyZSBlcXVhbCBhY3Jvc3MgdHdvIHRlbXBsYXRlcyBvZiB0aGUgc2FtZVxuICogc3RhY2suXG4gKi9cbmZ1bmN0aW9uIGNvbXBhcmFibGVBcGlJZChzY29wZTogQ29uc3RydWN0LCB2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShTdGFjay5vZihzY29wZSkucmVzb2x2ZSh2YWx1ZSkpO1xufVxuXG4vKipcbiAqIEV2ZXJ5IEFQSSBHYXRld2F5IHYyIHJvdXRlIGJvdW5kIHRvIGBhcGlgLCByZWdhcmRsZXNzIG9mIHdoaWNoIGNvbnN0cnVjdFxuICogc2NvcGUgY3JlYXRlZCBpdC5cbiAqXG4gKiBgYXBpLm5vZGUuY2hpbGRyZW5gIG9ubHkgc2VlcyByb3V0ZXMgdGhlIEFQSSBpdHNlbGYgKG9yIGEgY2hpbGQgc2NvcGUpXG4gKiBjcmVhdGVkLCB3aGljaCBtaXNzZXMgdGhlIGNvbW1vbiBwYXR0ZXJuIG9mIGEgc3RhY2stbGV2ZWwgY29uc3RydWN0IHdpcmluZyBhXG4gKiByb3V0ZSBvbnRvIGFuIGF0dGFjaGVkIEFQSS4gV2Fsa2luZyB0aGUgc3RhY2sgYW5kIHJlc29sdmluZyBlYWNoIGBDZm5Sb3V0ZWAnc1xuICogYEFwaUlkYCBzZWVzIGJvdGguXG4gKi9cbmZ1bmN0aW9uIHJvdXRlc0JvdW5kVG9BcGkoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogYXBpZ3d2Mi5DZm5Sb3V0ZVtdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuUm91dGVbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuSHR0cFJvdXRlKSB7XG4gICAgICBpZiAoY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmh0dHBBcGkuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgICAgZm91bmQucHVzaChub2RlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpO1xuICAgICAgfVxuICAgICAgLy8gVGhlIHJvdXRlJ3Mgb3duIENmblJvdXRlIGNoaWxkIGlzIHRoZSBzYW1lIHJvdXRlOyBkbyBub3QgZG91YmxlIGNvdW50LlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuUm91dGUgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQuZmlsdGVyKChyb3V0ZSkgPT4gcm91dGUgIT09IHVuZGVmaW5lZCk7XG59XG5cbi8qKlxuICogUmVmdXNlIGEgY29uc29saWRhdGVkIGF0dGFjaCBvbnRvIGFuIEFQSSB0aGF0IGFscmVhZHkgY2FycmllcyByb3V0ZXMuXG4gKlxuICogVGhlIGNoZWNrIGRlbGliZXJhdGVseSB3YWxrcyB0aGUgd2hvbGUgc3RhY2s6IGEgcm91dGUgYm91bmQgdG8gdGhlIGF0dGFjaGVkXG4gKiBBUEkgZnJvbSBhIHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIGp1c3QgYXMgbXVjaCBhIHJvdXRlIGtleSB0aGVcbiAqIGNvbnNvbGlkYXRlZCBncmVlZHkgcm91dGVzIHdvdWxkIGNvbGxpZGUgd2l0aCBhcyBvbmUgY3JlYXRlZCB1bmRlciB0aGUgQVBJXG4gKiBpdHNlbGYuXG4gKi9cbmZ1bmN0aW9uIGFzc2VydENvbnNvbGlkYXRlZEF0dGFjaEFsbG93ZWQoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nUm91dGVzID0gcm91dGVzQm91bmRUb0FwaShzY29wZSwgYXBpKTtcbiAgaWYgKGV4aXN0aW5nUm91dGVzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVNb2RlbCBjb25zb2xpZGF0ZWQgbWF5IGF0dGFjaCBvbmx5IHRvIGFuIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWU7IFwiXG4gICAgICArIGB0aGUgQVBJIGFscmVhZHkgY2FycmllcyAke2V4aXN0aW5nUm91dGVzLmxlbmd0aH0gcm91dGUocyk6ICR7ZXhpc3RpbmdSb3V0ZXMubWFwKChyb3V0ZSkgPT4gcm91dGUubm9kZS5wYXRoKS5qb2luKFwiLCBcIil9OyBgXG4gICAgICArIFwiYXR0YWNoIHRvIGEgbmV3IG9yIGVtcHR5IEFQSSwgb3IgdXNlIHJvdXRlTW9kZWwgZXhwbGljaXRcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogUmVnaXN0ZXIgdGhlIHN5bnRoLXRpbWUgcnVsZSBmb3Igcm91dGVzIGFkZGVkIHRvIGEgY29uc29saWRhdGVkIEFQSSBhZnRlclxuICogdGhlIGNvbnN0cnVjdCBjcmVhdGVkIGl0cyBncmVlZHkgcm91dGVzLlxuICpcbiAqIFRoZSBydWxlIGFwcGxpZXMgaW4gYm90aCBjb25zb2xpZGF0ZWQgbW9kZXM6IGFuIEFQSSB0aGUgY29uc3RydWN0IGF0dGFjaGVkXG4gKiB0bywgYW5kIG9uZSB0aGUgY29uc3RydWN0IG93bnMuIFRoZSBkb2N1bWVudGVkIGV4Y2VwdGlvbiBpcyB3aGF0IG1ha2VzXG4gKiBjb25zb2xpZGF0ZWQgcm91dGVzIHVzYWJsZSBpbiBhIHJlYWwgZnJvbnQgZG9vcjogYSBjb25zdW1lciBtYXkgYWRkXG4gKiBleHBsaWNpdCwgbW9yZSBzcGVjaWZpYyByb3V0ZXMgYWZ0ZXJ3YXJkcy4gSXQgaXMgYWxsb3dlZCBvbmx5IHdoZW4gdGhlXG4gKiByb3V0ZSBjYXJyaWVzIGEgbm9uLU5PTkUgYXV0aG9yaXplciAoc28gdGhlIGdyZWVkeSByb3V0ZXMgbmV2ZXIgc2lsZW50bHlcbiAqIHdpZGVuIGEgc3RyaWN0ZXIgcG9zdHVyZSkgYW5kIGRvZXMgbm90IHJlZGVjbGFyZSBhIGdyZWVkeSByb3V0ZSBrZXkgKHdoaWNoXG4gKiBBUEkgR2F0ZXdheSB3b3VsZCByZWplY3QgYXMgYSBkdXBsaWNhdGUpLlxuICovXG5mdW5jdGlvbiByZWdpc3RlckNvbnNvbGlkYXRlZEF0dGFjaFZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbiAgb3duZWRSb3V0ZXM6IGFwaWd3djIuSHR0cFJvdXRlW10sXG4pOiB2b2lkIHtcbiAgY29uc3Qgb3duZWQgPSBuZXcgU2V0KFxuICAgIG93bmVkUm91dGVzLm1hcCgocm91dGUpID0+IHJvdXRlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuUm91dGUpLFxuICApO1xuICBTdGFjay5vZihzY29wZSkubm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpKSB7XG4gICAgICAgIGlmIChvd25lZC5oYXMocm91dGUpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm91dGVLZXkgPSByb3V0ZS5yb3V0ZUtleTtcbiAgICAgICAgaWYgKENPTlNPTElEQVRFRF9HUkVFRFlfUk9VVEVfS0VZUy5oYXMocm91dGVLZXkpKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBhbHJlYWR5IG93bnMgdGhlIGdyZWVkeSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9IG9uIHRoaXMgQVBJOyBhIHJvdXRlIGFkZGVkIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IG5vdCByZWRlY2xhcmUgaXQgKCR7cm91dGUubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYXV0aG9yaXphdGlvblR5cGUgPSBTdHJpbmcocm91dGUuYXV0aG9yaXphdGlvblR5cGUgPz8gXCJOT05FXCIpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIGlmIChhdXRob3JpemF0aW9uVHlwZSA9PT0gXCJOT05FXCIpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGEgcm91dGUgYWRkZWQgdG8gYSBjb25zb2xpZGF0ZWQgQVBJIGFmdGVyIGNvbnN0cnVjdGlvbiBtdXN0IGNhcnJ5IGEgbm9uLU5PTkUgYXV0aG9yaXplciwgYmVjYXVzZSB0aGUgZ3JlZWR5IHJvdXRlcyBhZG1pdCBldmVyeSBtZXRob2QgYW5kIHBhdGggYXQgdGhlIGdhdGV3YXkgKCR7cm91dGVLZXl9IGZyb20gJHtyb3V0ZS5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGVycm9ycztcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVGYWNhZGVBdHRhY2htZW50KGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQpOiB2b2lkIHtcbiAgaWYgKGZhY2FkZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gIGNvbnN0IHByb3ZpZGVySWQgPSAoZmFjYWRlIGFzIHsgcHJvdmlkZXJJZD86IHVua25vd24gfSk/LnByb3ZpZGVySWQ7XG4gIGlmIChcbiAgICB0eXBlb2YgcHJvdmlkZXJJZCAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHByb3ZpZGVySWQudHJpbSgpID09PSBcIlwiXG4gICAgfHwgVG9rZW4uaXNVbnJlc29sdmVkKHByb3ZpZGVySWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmYWNhZGUucHJvdmlkZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcm91dGVGYW1pbHk6IE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAocG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQykge1xuICAgIGlmIChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyICE9PSB1bmRlZmluZWQgfHwgcHJvcHMuandrc1VyaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBiZSBjb21iaW5lZCB3aXRoIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgb3Igandrc1VyaVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJvdXRlRmFtaWx5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBlbmFibGUgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnlcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBOT05FX1BVQkxJQyBjYW5ub3QgZGVjbGFyZSB1cHN0cmVhbUNhbGxiYWNrUGF0aFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcHJvcHMucnVudGltZVBvc3R1cmUgIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBjYW5ub3QgZGVjbGFyZSBydW50aW1lUG9zdHVyZWAsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4gIG93bmVkOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zLFxuKTogdm9pZCB7XG4gIGlmIChcbiAgICBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbGFiZWwgPSBwb3N0dXJlTGFiZWwocG9zdHVyZSk7XG4gIGlmIChcbiAgICBwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlID09PSB1bmRlZmluZWQgfHwgcHJvcHMucnVudGltZVBvc3R1cmUucmVxdWlyZUJlYXJlclRva2VuICE9PSB0cnVlKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eSAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgJiYgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG9yaWdpblJlYWNoYWJpbGl0eSB0byBiZSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQsIC5MT0NLRUQsIG9yIC5GUk9OVEVEYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZhbGlkYXRlT3duaW5nQXBpRGVmZW5zZShwcm9wcy5vd25pbmdBcGlEZWZlbnNlLCBsYWJlbCk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKG93bmVkLnN0YWdlPy50aHJvdHRsaW5nRW5hYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFuIGV4cGxpY2l0IG93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdFbmFibGVkOiB0cnVlIHRocm90dGxpbmcgZGVjaXNpb25gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG93bmVkLnN0YWdlPy5hY2Nlc3NMb2dnaW5nID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIGFjY2VzcyBsb2dnaW5nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSKSB7XG4gICAgdmFsaWRhdGVEZW5pYWxTaWduYWwocHJvcHMuZGVuaWFsU2lnbmFsKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGRlY2xhcmVkIGRpcmVjdC1vcmlnaW4gZGVjaXNpb24gdG8gYSBwcm92ZW4gcG9zdHVyZS5cbiAqXG4gKiBFdmVyeSBzdXBwbGllZCB2YWx1ZSBpcyBjaGVja2VkLCBub3Qgb25seSB0aGUgcG9zdHVyZXMgdGhhdCByZXF1aXJlIHRoZVxuICogZGVjaXNpb24uIERJU0FCTEVEIG5lZWRzIHRoZSBvd25lZCBvcmRpbmFyeSBkb21haW4gdGhhdCByZXBsYWNlcyB0aGUgZGlzYWJsZWRcbiAqIGV4ZWN1dGUtYXBpIGF1dGhvcml0eSAob3IgYSBwcm92YWJsZSBjb25jcmV0ZSBhdHRhY2gpLCBhbmQgTE9DS0VEXG4gKiBhZGRpdGlvbmFsbHkgbmVlZHMgbXV0dWFsIFRMUyBvbiBldmVyeSBkb21haW4gbWFwcGVkIHRvIHRoZSBvd25lZCBBUEkuXG4gKiBBdHRhY2gtbW9kZSBMT0NLRUQgaXMgdW5zdXBwb3J0ZWQgYmVjYXVzZSBhbiBleHRlcm5hbCBBUEkgY2FycmllcyBubyBpbi1zdGFja1xuICogdHJ1c3RzdG9yZSBvciBtYXBwaW5nIGV2aWRlbmNlLiBGUk9OVEVEIGlzIHRoZSBhdHRhY2gtbW9kZSBjb3VudGVycGFydCBmb3IgYW5cbiAqIGFwcGxpY2F0aW9uLW93bmVkIGZyb250IGRvb3I6IGl0IHByb2R1Y2VzIG5vIGluLXN0YWNrIGV2aWRlbmNlLCBzbyBpdCBpc1xuICogYWNjZXB0ZWQgb25seSB3aXRoIGFuIGV4cGxpY2l0LCB2YWxpZGF0ZWQgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgZGVjbGFyYXRpb25cbiAqIGFuZCBvbmx5IGluIGF0dGFjaCBtb2RlLlxuICovXG5mdW5jdGlvbiByZXNvbHZlT3JpZ2luUmVhY2hhYmlsaXR5KFxuICBzY29wZTogQ29uc3RydWN0LFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIG93bmVkOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zLFxuKTogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZGVjaXNpb24gPSBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHk7XG4gIGNvbnN0IG11dHVhbFRscyA9IG93bmVkLmRvbWFpbj8ubXV0dWFsVGxzQXV0aGVudGljYXRpb247XG4gIGlmIChkZWNpc2lvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKG11dHVhbFRscyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRURcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFxuICAgICYmIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgbXVzdCBiZSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQsIC5MT0NLRUQsIG9yIC5GUk9OVEVEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAobXV0dWFsVGxzICE9PSB1bmRlZmluZWQgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICAgJiYgcHJvcHMuZnJvbnREb29yVmVyaWZpY2F0aW9uICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URURcIixcbiAgICApO1xuICB9XG4gIGlmIChkZWNpc2lvbiA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQpIHtcbiAgICBpZiAocHJvcHMuYXBpID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEIGlzIHVuc3VwcG9ydGVkIGluIG93bmVkIG1vZGU7IGFuIG93bmVkIGZyb250IGRvb3IgaXMgd2lyZWQgYnkgdGhlIERJU0FCTEVEIG9yIExPQ0tFRCBwb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB2YWxpZGF0ZUZyb250RG9vclZlcmlmaWNhdGlvbihwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pO1xuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRUQpIHtcbiAgICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgaXMgdW5zdXBwb3J0ZWQgaW4gYXR0YWNoIG1vZGU7IGFuIEFQSSBvd25lZCBvdXRzaWRlIHRoZSBjb25zdHJ1Y3QgY2FycmllcyBubyBpbi1zdGFjayBtdXR1YWwtVExTIG1hcHBpbmcgZXZpZGVuY2VcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvd25lZC5kb21haW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluIHdpdGggbXV0dWFsVGxzQXV0aGVudGljYXRpb25cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChtdXR1YWxUbHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb247IGRpc2FibGVtZW50IGFsb25lIGlzIHRoZSBESVNBQkxFRCBwb3N0dXJlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCEocHJvcHMuYXBpIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwQXBpKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIGEgc2FtZS1zdGFjayBjb25jcmV0ZSBIdHRwQXBpOyBhbiBpbXBvcnRlZCBBUEkgZXhwb3NlcyBubyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGV2aWRlbmNlXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZWdpc3RlckF0dGFjaERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihzY29wZSwgcHJvcHMuYXBpKTtcbiAgICByZXR1cm4gZGVjaXNpb247XG4gIH1cbiAgaWYgKG93bmVkLmRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBhbiBlZmZlY3RpdmUgb3duZWRBcGkuZG9tYWluOyB0aGUgZGlzYWJsZWQgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgaXMgbmV2ZXIgYSBwdWJsaWMgYXV0aG9yaXR5XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gZGVjaXNpb247XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhlIGBmcm9udERvb3JWZXJpZmljYXRpb25gIGRlY2xhcmF0aW9uIGZvciBgb3JpZ2luUmVhY2hhYmlsaXR5OlxuICogRlJPTlRFRGAuXG4gKlxuICogVGhlIGRlY2xhcmF0aW9uIGlzIG1hbmRhdG9yeSBhbmQgZXZlcnkgZmllbGQgaXMgY2hlY2tlZDogYW4gYWJzZW50XG4gKiBkZWNsYXJhdGlvbiwgYSBtaXNzaW5nIG9yIHJlc2VydmVkIGhlYWRlciBuYW1lLCBhIHNlY3JldCBvdXRzaWRlIHRoZVxuICogaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXQsIGFuZCBhIG1pc3NpbmcgYGFzc2VydGVkOiB0cnVlYCBhbGwgZmFpbCBzeW50aGVzaXNcbiAqIHJhdGhlciB0aGFuIHByb2R1Y2luZyBhIGRlY2xhcmF0aW9uIHRoZSBydW50aW1lIGNvdWxkIG5vdCBob25vci5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVGcm9udERvb3JWZXJpZmljYXRpb24oXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGhlYWRlck5hbWUgPSB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZTtcbiAgaWYgKHR5cGVvZiBoZWFkZXJOYW1lICE9PSBcInN0cmluZ1wiIHx8ICFGUk9OVF9ET09SX0hFQURFUl9OQU1FX1BBVFRFUk4udGVzdChoZWFkZXJOYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uaGVhZGVyTmFtZSBtdXN0IGJlIDEgdG8gNjQgY2hhcmFjdGVycyBvZiBbQS1aYS16MC05LV1cIixcbiAgICApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRIZWFkZXIgPSBoZWFkZXJOYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChcbiAgICBSRVNFUlZFRF9GUk9OVF9ET09SX0hFQURFUlMuaGFzKG5vcm1hbGl6ZWRIZWFkZXIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwieC1hbXotXCIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwieC1hbXpuLVwiKVxuICAgIHx8IG5vcm1hbGl6ZWRIZWFkZXIuc3RhcnRzV2l0aChcImNsb3VkZnJvbnQtXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lICR7aGVhZGVyTmFtZX0gaXMgYSByZXNlcnZlZCBvciBwbGF0Zm9ybS1tYW5hZ2VkIHJlcXVlc3QgaGVhZGVyIGFuZCBjYW5ub3QgY2FycnkgdGhlIGZyb250LWRvb3IgdmVyaWZpY2F0aW9uYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHNlY3JldFZhbHVlID0gdmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlO1xuICBjb25zdCBzZWNyZXRQYXJhbWV0ZXJOYW1lID0gdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWU7XG4gIGNvbnN0IGhhc0xpdGVyYWwgPSBzZWNyZXRWYWx1ZSAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCBoYXNQYXJhbWV0ZXIgPSBzZWNyZXRQYXJhbWV0ZXJOYW1lICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNMaXRlcmFsID09PSBoYXNQYXJhbWV0ZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIHJlcXVpcmVzIGV4YWN0bHkgb25lIG9mIHNlY3JldFZhbHVlIGFuZCBzZWNyZXRQYXJhbWV0ZXJOYW1lOyBzdXBwbHkgdGhlIGxpdGVyYWwsIG9yIHRoZSB3ZWxsLWtub3duIHBhcmFtZXRlciBuYW1lIHRoZSBhcHBsaWNhdGlvbidzIGluc3RhbGxlciBjcmVhdGVzXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzTGl0ZXJhbCkge1xuICAgIGlmICh0eXBlb2Ygc2VjcmV0VmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIUZST05UX0RPT1JfU0VDUkVUX1BBVFRFUk4udGVzdChzZWNyZXRWYWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZSBtdXN0IGJlIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIFtBLVphLXowLTkuX34tXVwiLFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdmFsaWRhdGVGcm9udERvb3JQYXJhbWV0ZXJOYW1lKHNlY3JldFBhcmFtZXRlck5hbWUpO1xuICB9XG4gIGlmICh2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5ICE9PSB1bmRlZmluZWQgJiYgIWhhc1BhcmFtZXRlcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5IGlzIG9ubHkgdmFsaWQgd2l0aCBzZWNyZXRQYXJhbWV0ZXJOYW1lXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodmVyaWZpY2F0aW9uLmFzc2VydGVkICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbiByZXF1aXJlcyBhc3NlcnRlZDogdHJ1ZSDigJQgdGhlIGNhbGxlciBtdXN0IHJlY29yZCB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeSBkZXJpdmVkIHJvdXRlXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFZhbGlkYXRlIGEgd2VsbC1rbm93biBmcm9udC1kb29yIHBhcmFtZXRlciBuYW1lLlxuICpcbiAqIFRoZSBuYW1lIG11c3QgYmUgZXhwcmVzc2libGUgaW4gYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljIHJlZmVyZW5jZSBhbmRcbiAqIGFjY2VwdGFibGUgdG8gUGFyYW1ldGVyIFN0b3JlLCBiZWNhdXNlIHRoZSBjb25zdHJ1Y3QgcmVuZGVycyB0aGUgcmVmZXJlbmNlIGFuZFxuICogZ3JhbnRzIG9uIHRoZSBBUk4uIEEgbmFtZSBvdXRzaWRlIGVpdGhlciBjb250cmFjdCB3b3VsZCBmYWlsIGF0IGRlcGxveSB0aW1lLFxuICogc28gaXQgZmFpbHMgc3ludGhlc2lzIGluc3RlYWQuXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlRnJvbnREb29yUGFyYW1ldGVyTmFtZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKFxuICAgIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiXG4gICAgfHwgbmFtZS5sZW5ndGggPiBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRU5HVEhcbiAgICB8fCAhRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9QQVRURVJOLnRlc3QobmFtZSlcbiAgICB8fCBuYW1lLmVuZHNXaXRoKFwiL1wiKVxuICAgIHx8IG5hbWUuaW5jbHVkZXMoXCIvL1wiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgbXVzdCBiZSBhIGZ1bGx5IHF1YWxpZmllZCBTU00gcGFyYW1ldGVyIG5hbWUgZnJvbSAnLycsIGF0IG1vc3QgMTAxMSBjaGFyYWN0ZXJzLCBvZiBbQS1aYS16MC05Xy4tL10gd2l0aCBubyBlbXB0eSBzZWdtZW50XCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBsZXZlbHMgPSBuYW1lLnNwbGl0KFwiL1wiKS5maWx0ZXIoKHNlZ21lbnQpID0+IHNlZ21lbnQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IGZpcnN0ID0gbGV2ZWxzWzBdPy50b0xvd2VyQ2FzZSgpO1xuICBpZiAobGV2ZWxzLmxlbmd0aCA9PT0gMCB8fCBsZXZlbHMubGVuZ3RoID4gRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVWRUxTKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lIG11c3QgaGF2ZSBiZXR3ZWVuIG9uZSBhbmQgZmlmdGVlbiBoaWVyYXJjaHkgbGV2ZWxzXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoZmlyc3QgPT09IFwiYXdzXCIgfHwgZmlyc3QgPT09IFwic3NtXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgbXVzdCBub3QgdXNlIHRoZSByZXNlcnZlZCBhd3Mgb3Igc3NtIGhpZXJhcmNoeVwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcC1vd25lZCBmcm9udCBkb29yIG11c3Qgc2VuZC5cbiAqXG4gKiBUaGUgcGFyYW1ldGVyIGZvcm0gcmVuZGVycyB0aGUgQ2xvdWRGb3JtYXRpb24gZHluYW1pYyByZWZlcmVuY2UgdGhlXG4gKiBkaXN0cmlidXRpb24gcHJvcGVydHkgYWNjZXB0cywgc28gdGhlIHZhbHVlIGlzIHJlc29sdmVkIGJ5IENsb3VkRm9ybWF0aW9uIGF0XG4gKiBzdGFjayBjcmVhdGUvdXBkYXRlIHRpbWUgYW5kIG5ldmVyIGFwcGVhcnMgaW4gdGhlIGFwcGxpY2F0aW9uIHNvdXJjZSBvciB0aGlzXG4gKiBjb25zdHJ1Y3QncyB0ZW1wbGF0ZS5cbiAqL1xuZnVuY3Rpb24gZnJvbnREb29yT3JpZ2luSGVhZGVyKFxuICB2ZXJpZmljYXRpb246IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnMgfCB1bmRlZmluZWQsXG4pOiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXIge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGhlYWRlclZhbHVlID0gdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgIT09IHVuZGVmaW5lZFxuICAgID8gYHt7cmVzb2x2ZTpzc206JHt2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZX19fWBcbiAgICA6IFN0cmluZyh2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWUpO1xuICByZXR1cm4geyBoZWFkZXJOYW1lOiB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZSwgaGVhZGVyVmFsdWUgfTtcbn1cblxuLyoqXG4gKiBHcmFudCB0aGUgcnVudGltZSBmdW5jdGlvbiByZWFkIGFjY2VzcyB0byB0aGUgd2VsbC1rbm93biBmcm9udC1kb29yIHBhcmFtZXRlci5cbiAqXG4gKiBQYXJhbWV0ZXIgU3RvcmUgcmVzb2x2ZXMgdGhlIGRpc3RyaWJ1dGlvbidzIGR5bmFtaWMgcmVmZXJlbmNlIHdpdGggdGhlXG4gKiBkZXBsb3lpbmcgcHJpbmNpcGFsJ3MgcGVybWlzc2lvbnMsIHNvIHRoaXMgZ3JhbnQgc2VydmVzIHRoZSBydW50aW1lJ3MgbGF6eVxuICogcmVhZDogYHNzbTpHZXRQYXJhbWV0ZXJgIG9uIGV4YWN0bHkgdGhhdCBwYXJhbWV0ZXIgQVJOIChuZXZlciBhIHdpbGRjYXJkKSBhbmQsXG4gKiBmb3IgYSBTZWN1cmVTdHJpbmcsIGBrbXM6RGVjcnlwdGAgb24gdGhlIGRlY2xhcmVkIGtleS4gUGFyYW1ldGVyIFN0b3JlIG5lZWRzXG4gKiBubyBLTVMgcGVybWlzc2lvbiBmb3IgYSBTdHJpbmcgcGFyYW1ldGVyLCB3aGljaCBpcyB0aGUgdHlwZSBGUk9OVEVEIHJlcXVpcmVzLlxuICovXG5mdW5jdGlvbiBncmFudEZyb250RG9vclBhcmFtZXRlclJlYWQoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBjb25zdCBwYXJhbWV0ZXJOYW1lID0gdmVyaWZpY2F0aW9uPy5zZWNyZXRQYXJhbWV0ZXJOYW1lO1xuICBpZiAocGFyYW1ldGVyTmFtZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGhhbmRsZXIuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICBhY3Rpb25zOiBbXCJzc206R2V0UGFyYW1ldGVyXCJdLFxuICAgIHJlc291cmNlczogW1xuICAgICAgU3RhY2sub2Yoc2NvcGUpLmZvcm1hdEFybih7XG4gICAgICAgIHNlcnZpY2U6IFwic3NtXCIsXG4gICAgICAgIHJlc291cmNlOiBcInBhcmFtZXRlclwiLFxuICAgICAgICByZXNvdXJjZU5hbWU6IHBhcmFtZXRlck5hbWUucmVwbGFjZSgvXlxcLysvLCBcIlwiKSxcbiAgICAgIH0pLFxuICAgIF0sXG4gIH0pKTtcbiAgaWYgKHZlcmlmaWNhdGlvbj8uc2VjcmV0UGFyYW1ldGVyS21zS2V5ICE9PSB1bmRlZmluZWQpIHtcbiAgICB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyS21zS2V5LmdyYW50RGVjcnlwdChoYW5kbGVyKTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBGUk9OVEVEIGZpZWxkcyBvZiB0aGUgYGFwcHRoZW9yeTptY3AtdHJhbnNwb3J0LXBvc3R1cmVgIG1hcmtlci5cbiAqXG4gKiBUaGUgbGl0ZXJhbCBmb3JtIHJlY29yZHMgdGhlIHBvc3R1cmUsIHRoZSBoZWFkZXIgbmFtZSBhbmQgYSBTSEEtMjU2IGRpZ2VzdCBvZlxuICogdGhlIGRlY2xhcmVkIHNlY3JldCwgZXhhY3RseSBhcyB2Ny4zIGRpZDsgdGhlIGxpdGVyYWwgaXMgY29uc3VtZWQgZm9yIGl0c1xuICogZGlnZXN0IG9ubHksIHNvIGl0IG5ldmVyIGxhbmRzIGluIHRoZSBzeW50aGVzaXplZCB0ZW1wbGF0ZSBvciBpblxuICogQ2xvdWRGb3JtYXRpb24uIFRoZSBwYXJhbWV0ZXIgZm9ybSByZWNvcmRzIHRoZSB3ZWxsLWtub3duIHBhcmFtZXRlciBuYW1lIGFuZFxuICogdGhhdCB0aGUgdmFsdWUgaXMgcGFyYW1ldGVyLXNvdXJjZWQgaW5zdGVhZCBvZiBhIGRpZ2VzdCwgYmVjYXVzZSB0aGVyZSBpcyBub1xuICogbGl0ZXJhbCBpbiB0aGUgYXBwbGljYXRpb24gdG8gZGlnZXN0LlxuICovXG5mdW5jdGlvbiBmcm9udERvb3JQb3N0dXJlTWV0YWRhdGEoXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBpZiAodmVyaWZpY2F0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgcmVxdWlyZXMgZnJvbnREb29yVmVyaWZpY2F0aW9uOyB0aGUgcnVudGltZSBjYW5ub3QgZW5mb3JjZSBhbiB1bmRlY2xhcmVkIGZyb250IGRvb3JcIixcbiAgICApO1xuICB9XG4gIGlmICh2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9yaWdpbl9yZWFjaGFiaWxpdHk6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVELFxuICAgICAgZnJvbnRfZG9vcl9oZWFkZXJfbmFtZTogdmVyaWZpY2F0aW9uLmhlYWRlck5hbWUsXG4gICAgICBmcm9udF9kb29yX3NlY3JldF9zb3VyY2U6IFwic3NtLXBhcmFtZXRlclwiLFxuICAgICAgZnJvbnRfZG9vcl9zZWNyZXRfcGFyYW1ldGVyX25hbWU6IHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvcmlnaW5fcmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCxcbiAgICBmcm9udF9kb29yX2hlYWRlcl9uYW1lOiB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZSxcbiAgICBmcm9udF9kb29yX3NlY3JldF9zaGEyNTY6IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKFN0cmluZyh2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWUpLCBcInV0ZjhcIikuZGlnZXN0KFwiaGV4XCIpLFxuICB9O1xufVxuXG4vKipcbiAqIEZpbmFsIHN5bnRoZXNpcyBwcm9vZiBmb3IgYW4gb3duZWQgRElTQUJMRUQgQVBJOiB0aGUgZGVmYXVsdCBleGVjdXRlLWFwaVxuICogZW5kcG9pbnQgbXVzdCBzdGlsbCBiZSBkaXNhYmxlZCBpbiB0aGUgZW1pdHRlZCB0ZW1wbGF0ZSwgZXZlbiBpZiBhIGxhdGVyIEwxXG4gKiBvdmVycmlkZSB0cmllcyB0byByZS1lbmFibGUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSA9PT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gW107XG4gICAgICB9XG4gICAgICByZXR1cm4gW1xuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkuUHJvcGVydGllcy5EaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IHRvIHJlc29sdmUgdG8gdHJ1ZVwiLFxuICAgICAgXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqXG4gKiBGaW5hbCB3aG9sZS1zdGFjayBwcm9vZiBmb3IgYW4gb3duZWQgTE9DS0VEIEFQSS5cbiAqXG4gKiBMT0NLRUQgaXMgbm90IGFuIGFsaWFzIG9mIERJU0FCTEVEOiBhdCBmaW5hbCBzeW50aGVzaXMgdGhlIGRlZmF1bHQgZW5kcG9pbnRcbiAqIG11c3Qgc3RpbGwgYmUgZGlzYWJsZWQgYW5kIGV2ZXJ5IGBDZm5BcGlNYXBwaW5nYCBib3VuZCB0byB0aGUgb3duZWQgQVBJLFxuICogaW5jbHVkaW5nIG1hcHBpbmdzIGFub3RoZXIgc2NvcGUgYWRkcyBhZnRlciBjb25zdHJ1Y3Rpb24sIG11c3QgcmVzb2x2ZSB0byBhblxuICogaW4tc3RhY2sgYENmbkRvbWFpbk5hbWVgIHdob3NlIGBNdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgY2FycmllcyBhIHRydXN0c3RvcmVcbiAqIFVSSS4gQW4gdW5yZXNvbHZhYmxlIG1hcHBpbmcgb3IgZG9tYWluIGZhaWxzIGNsb3NlZCBpbnN0ZWFkIG9mIGNvdW50aW5nIGFzXG4gKiBldmlkZW5jZS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJPd25lZExvY2tlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5IdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBjZm5BcGkgPSBhcGkubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5BcGk7XG4gIHN0YWNrLm5vZGUuYWRkVmFsaWRhdGlvbih7XG4gICAgdmFsaWRhdGU6ICgpID0+IHtcbiAgICAgIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSAhPT0gdHJ1ZSkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpLlByb3BlcnRpZXMuRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCB0byByZXNvbHZlIHRvIHRydWVcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1hcHBpbmdzID0gY2ZuQXBpTWFwcGluZ3NCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKG1hcHBpbmdzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBhdCBsZWFzdCBvbmUgQVdTOjpBcGlHYXRld2F5VjI6OkFwaU1hcHBpbmcgYm91bmQgdG8gdGhlIG93bmVkIEFQSVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgZG9tYWlucyA9IGNmbkRvbWFpbk5hbWVzKHNjb3BlKTtcbiAgICAgIGZvciAoY29uc3QgbWFwcGluZyBvZiBtYXBwaW5ncykge1xuICAgICAgICBjb25zdCBkb21haW4gPSBkb21haW5zLmZpbmQoXG4gICAgICAgICAgKGNhbmRpZGF0ZSkgPT4gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBjYW5kaWRhdGUucmVmKVxuICAgICAgICAgICAgPT09IGNvbXBhcmFibGVBcGlJZChzY29wZSwgbWFwcGluZy5kb21haW5OYW1lKSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIGNhbm5vdCByZXNvbHZlIG1hcHBpbmcgJHttYXBwaW5nLm5vZGUucGF0aH0gdG8gYW4gaW4tc3RhY2sgQVdTOjpBcGlHYXRld2F5VjI6OkRvbWFpbk5hbWU7IG11dHVhbC1UTFMgZXZpZGVuY2UgaXMgdW52ZXJpZmlhYmxlYCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaGFzVHJ1c3RzdG9yZVVyaShzdGFjaywgZG9tYWluKSkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBldmVyeSBtYXBwaW5nIHRvIHRhcmdldCBhIGRvbWFpbiB3aXRoIE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLlRydXN0c3RvcmVVcmkgKCR7bWFwcGluZy5ub2RlLnBhdGh9IC0+ICR7ZG9tYWluLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZXJyb3JzO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBoYXNUcnVzdHN0b3JlVXJpKHN0YWNrOiBTdGFjaywgZG9tYWluOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWUpOiBib29sZWFuIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBzdGFjay5yZXNvbHZlKGRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbik7XG4gIGlmIChyZXNvbHZlZCA9PT0gdW5kZWZpbmVkIHx8IHJlc29sdmVkID09PSBudWxsIHx8IHR5cGVvZiByZXNvbHZlZCAhPT0gXCJvYmplY3RcIikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBhdXRoZW50aWNhdGlvbiA9IHJlc29sdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCB0cnVzdHN0b3JlVXJpID0gYXV0aGVudGljYXRpb24udHJ1c3RzdG9yZVVyaSA/PyBhdXRoZW50aWNhdGlvbi5UcnVzdHN0b3JlVXJpO1xuICByZXR1cm4gdHJ1c3RzdG9yZVVyaSAhPT0gdW5kZWZpbmVkICYmIHRydXN0c3RvcmVVcmkgIT09IG51bGwgJiYgdHJ1c3RzdG9yZVVyaSAhPT0gXCJcIjtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlNYXBwaW5nYCB3aG9zZSByZXNvbHZlZCBgQXBpSWRgIGlzIHRoZSBzdXBwbGllZCBBUEkuICovXG5mdW5jdGlvbiBjZm5BcGlNYXBwaW5nc0JvdW5kVG9BcGkoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFwaUtleSA9IGNvbXBhcmFibGVBcGlJZChzY29wZSwgYXBpLmFwaUlkKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuQXBpTWFwcGluZ1tdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG5mdW5jdGlvbiBjZm5Eb21haW5OYW1lcyhzY29wZTogQ29uc3RydWN0KTogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgZm91bmQ6IGFwaWd3djIuQ2ZuRG9tYWluTmFtZVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5Eb21haW5OYW1lKSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbi8qKlxuICogRmluYWwgc3ludGhlc2lzIHByb29mIGZvciBhbiBhdHRhY2ggRElTQUJMRUQgZGVjbGFyYXRpb246IHRoZSBjb25jcmV0ZSBBUElcbiAqIG11c3QgYmluZCB0byBleGFjdGx5IG9uZSBpbi1zdGFjayBDZm5BcGkgd2hvc2UgRGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludFxuICogcmVzb2x2ZXMgdG8gbGl0ZXJhbCB0cnVlLiBUaGUgY29uc3RydWN0IG5ldmVyIG11dGF0ZXMgdGhlIGF0dGFjaGVkIEFQSS5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJBdHRhY2hEaXNhYmxlZE9yaWdpblZhbGlkYXRpb24oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSxcbik6IHZvaWQge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgY2ZuQXBpcyA9IGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICAgICAgaWYgKGNmbkFwaXMubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCBpbiBhdHRhY2ggbW9kZSByZXF1aXJlcyBleGFjdGx5IG9uZSBzYW1lLXN0YWNrIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGk7IHRoZSBhdHRhY2hlZCBBUEkncyBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGNhbm5vdCBiZSBwcm92ZW5cIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFjay5yZXNvbHZlKGNmbkFwaXNbMF0uZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCkgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIHRoZSBhdHRhY2hlZCBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpIHRvIHNldCBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50PXRydWVcIixcbiAgICAgICAgXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqIEV2ZXJ5IGluLXN0YWNrIGBDZm5BcGlgIHdob3NlIGBSZWZgIGlzIHRoZSBzdXBwbGllZCBBUEkncyBpZC4gKi9cbmZ1bmN0aW9uIGNmbkFwaXNCb3VuZFRvQXBpKHNjb3BlOiBDb25zdHJ1Y3QsIGFwaTogYXBpZ3d2Mi5JSHR0cEFwaSk6IGFwaWd3djIuQ2ZuQXBpW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5BcGlbXSA9IFtdO1xuICBjb25zdCB2aXNpdCA9IChub2RlOiBDb25zdHJ1Y3QpOiB2b2lkID0+IHtcbiAgICBpZiAobm9kZSBpbnN0YW5jZW9mIGFwaWd3djIuQ2ZuQXBpICYmIGNvbXBhcmFibGVBcGlJZChzY29wZSwgbm9kZS5yZWYpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKFxuICBkZWZlbnNlOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlEZWZlbnNlT3B0aW9ucyB8IHVuZGVmaW5lZCxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoZGVmZW5zZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlIHRvIHJlY29yZCB0aGUgb3duaW5nIEFQSSdzIGFjY2VzcyBsb2dnaW5nIGFuZCB0aHJvdHRsaW5nIGRlY2lzaW9uc2AsXG4gICAgKTtcbiAgfVxuICBpZiAoZGVmZW5zZS5hY2Nlc3NMb2dnaW5nICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSAke2xhYmVsfSByZXF1aXJlcyBvd25pbmdBcGlEZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgdG8gYmUgdHJ1ZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB0aHJvdHRsaW5nOiBQYXJ0aWFsPEFwcFRoZW9yeU1jcE93bmluZ0FwaVRocm90dGxpbmdPcHRpb25zPiB8IHVuZGVmaW5lZCA9IGRlZmVuc2UudGhyb3R0bGluZztcbiAgY29uc3QgcmF0ZUxpbWl0ID0gdGhyb3R0bGluZz8ucmF0ZUxpbWl0O1xuICBjb25zdCBidXJzdExpbWl0ID0gdGhyb3R0bGluZz8uYnVyc3RMaW1pdDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KVxuICAgIHx8IChyYXRlTGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICAgfHwgIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KVxuICAgIHx8IChidXJzdExpbWl0IGFzIG51bWJlcikgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UudGhyb3R0bGluZyByYXRlTGltaXQgYW5kIGJ1cnN0TGltaXQgdG8gYmUgcG9zaXRpdmUgZmluaXRlIG51bWJlcnNgLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVEZW5pYWxTaWduYWwoc2lnbmFsPzogQXBwVGhlb3J5TWNwRGVuaWFsU2lnbmFsT3B0aW9ucyk6IHZvaWQge1xuICBpZiAoc2lnbmFsID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0UG9zdHVyZSBSVU5USU1FX0JFQVJFUiByZXF1aXJlcyBkZW5pYWxTaWduYWxcIixcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwubWV0cmljTmFtZSAhPT0gdW5kZWZpbmVkICYmIHNpZ25hbC5tZXRyaWNOYW1lICE9PSBNQ1BfREVOSUFMX01FVFJJQ19OQU1FKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVuaWFsU2lnbmFsLm1ldHJpY05hbWUgbXVzdCBiZSAke01DUF9ERU5JQUxfTUVUUklDX05BTUV9YCxcbiAgICApO1xuICB9XG4gIGlmIChzaWduYWwuZGltZW5zaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGltZW5zaW9ucyA9IEFycmF5LmlzQXJyYXkoc2lnbmFsLmRpbWVuc2lvbnMpID8gc2lnbmFsLmRpbWVuc2lvbnMgOiBbXTtcbiAgICBjb25zdCBib3VuZGVkID0gZGltZW5zaW9ucy5sZW5ndGggPT09IE1DUF9ERU5JQUxfRElNRU5TSU9OUy5sZW5ndGhcbiAgICAgICYmIE1DUF9ERU5JQUxfRElNRU5TSU9OUy5ldmVyeShcbiAgICAgICAgKGRpbWVuc2lvbikgPT4gZGltZW5zaW9ucy5maWx0ZXIoKHZhbHVlKSA9PiB2YWx1ZSA9PT0gZGltZW5zaW9uKS5sZW5ndGggPT09IDEsXG4gICAgICApO1xuICAgIGlmICghYm91bmRlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwuZGltZW5zaW9ucyBtdXN0IGJlIGV4YWN0bHkgJHtKU09OLnN0cmluZ2lmeShNQ1BfREVOSUFMX0RJTUVOU0lPTlMpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTCh2YWx1ZTogc3RyaW5nLCBhbGxvd1F1ZXJ5OiBib29sZWFuLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbGl0ZXJhbCA9IHZhbHVlLnRyaW0oKTtcbiAgbGV0IHBhcnNlZDogVVJMIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwobGl0ZXJhbCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFRoZSBzaGFyZWQgdmFsaWRhdGlvbiBlcnJvciBiZWxvdyBpcyB0aGUgcHVibGljIHN5bnRoZXNpcyBjb250cmFjdC5cbiAgfVxuICBpZiAoXG4gICAgIXBhcnNlZFxuICAgIHx8ICFsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eShsaXRlcmFsKVxuICAgIHx8IHBhcnNlZC5wcm90b2NvbCAhPT0gXCJodHRwczpcIlxuICAgIHx8ICFwYXJzZWQuaG9zdG5hbWVcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8obGl0ZXJhbClcbiAgICB8fCAoIWFsbG93UXVlcnkgJiYgbGl0ZXJhbC5pbmNsdWRlcyhcIj9cIikpXG4gICAgfHwgbGl0ZXJhbC5pbmNsdWRlcyhcIiNcIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7bWVzc2FnZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0b0h0dHBNZXRob2QobWV0aG9kOiBzdHJpbmcpOiBhcGlnd3YyLkh0dHBNZXRob2Qge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJQT1NUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVDtcbiAgICBjYXNlIFwiR0VUXCI6IHJldHVybiBhcGlnd3YyLkh0dHBNZXRob2QuR0VUO1xuICAgIGNhc2UgXCJERUxFVEVcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEU7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiB1bnN1cHBvcnRlZCBydW50aW1lIE1DUCBtZXRob2QgJHttZXRob2R9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQb3NpdGl2ZU51bWJlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgZ3JlYXRlciB0aGFuIHplcm9gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogbnVtYmVyLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWNwU2VydmVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcmApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICByZXR1cm4gZnFkbi5lbmRzV2l0aChzdWZmaXgpID8gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCkgOiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbFVSTEhhc1JGQzM5ODZBdXRob3JpdHkodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXmh0dHBzOlxcL1xcLyhbXi8/I10rKSg/OlsvPyNdfCQpL2kuZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmICFhdXRob3JpdHkuaW5jbHVkZXMoXCIlXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMQXV0aG9yaXR5SGFzVXNlcmluZm8odmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBhdXRob3JpdHkgPSAvXltBLVphLXpdW0EtWmEtejAtOSsuLV0qOlxcL1xcLyhbXi8/I10qKS8uZXhlYyh2YWx1ZSk/LlsxXTtcbiAgcmV0dXJuIGF1dGhvcml0eT8uaW5jbHVkZXMoXCJAXCIpID8/IGZhbHNlO1xufVxuIl19