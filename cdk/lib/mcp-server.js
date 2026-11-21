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
const secure_defaults_1 = require("./private/secure-defaults");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "7.5.0-rc.2" };
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
            // Only an owned API derives the session-table name. The secure-default
            // decision is separate: an attached API still receives the deletion
            // protection (DynamoDB.6) that the AppTheory-created table needs.
            const sessionNamingContext = props.api ? undefined : props.namingContext;
            const logical = sessionNamingContext
                ? props.logicalName ?? (0, logical_name_1.defaultLogicalName)(this)
                : undefined;
            const derivedTableName = sessionNamingContext && logical
                ? sessionNamingContext.physicalName("dynamodb_table", `${logical}-sessions`)
                : undefined;
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: derivedTableName && !derivedTableName.generated ? derivedTableName.name : sessionState.tableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: sessionState.removalPolicy,
                deletionProtection: (0, secure_defaults_1.defaultDeletionProtection)(props.namingContext, sessionState.removalPolicy, sessionState.deletionProtection),
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
            this.setupCustomDomain(ownedOptions.domain, ownedStage, props.api ? undefined : props.namingContext);
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
    setupCustomDomain(options, stage, namingContext) {
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
            securityPolicy: options.securityPolicy
                ?? ((0, secure_defaults_1.secureDefaults)(namingContext) ? secure_defaults_1.RECOMMENDED_HTTP_API_SECURITY_POLICY : undefined),
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
            || props.sessionState?.deletionProtection !== undefined
            || props.sessionTableName !== undefined
            || props.sessionTtlMinutes !== undefined)) {
        throw new Error("AppTheoryMcpServer: disabled session state cannot configure tableName, ttlMinutes, removalPolicy, or deletionProtection");
    }
    validatePositiveInteger(ttlMinutes, "sessionState.ttlMinutes");
    return {
        enabled,
        tableName,
        ttlMinutes,
        removalPolicy,
        deletionProtection: props.sessionState?.deletionProtection,
    };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEwRDtBQUMxRCw2Q0FBeUM7QUFDekMsd0VBQTBEO0FBQzFELHNFQUF3RDtBQUN4RCw2RkFBK0U7QUFDL0UsK0ZBQWlGO0FBQ2pGLG1FQUFxRDtBQUNyRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFFdkMsMkRBQStEO0FBQy9ELHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsK0RBSW1DO0FBQ25DLGlFQUFrRjtBQUVsRixpQ0FBNEM7QUFFNUMsMkNBQXVEO0FBRXZELE1BQU0sMEJBQTBCLEdBQUcsY0FBYyxDQUFDO0FBQ2xELE1BQU0sMkJBQTJCLEdBQUcsZUFBZSxDQUFDO0FBQ3BELE1BQU0sNkJBQTZCLEdBQUcsR0FBRyxDQUFDO0FBQzFDLE1BQU0sOEJBQThCLEdBQUcsR0FBRyxDQUFDO0FBQzNDLE1BQU0sMkJBQTJCLEdBQUcsRUFBRSxDQUFDO0FBQ3ZDLE1BQU0sMkJBQTJCLEdBQUcsd0JBQXdCLENBQUM7QUFDN0QsTUFBTSxrQ0FBa0MsR0FBRyxpQ0FBaUMsQ0FBQztBQUM3RSxNQUFNLGlDQUFpQyxHQUFHLDhCQUE4QixDQUFDO0FBQ3pFLE1BQU0sc0JBQXNCLEdBQUcsMkJBQTJCLENBQUM7QUFDM0QsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLFNBQVMsRUFBRSxjQUFjLENBQUMsQ0FBQztBQUUxRCwyQ0FBMkM7QUFDM0MsTUFBTSw4QkFBOEIsR0FBRyxzQkFBc0IsQ0FBQztBQUU5RCxvRkFBb0Y7QUFDcEYsTUFBTSx5QkFBeUIsR0FBRywyQkFBMkIsQ0FBQztBQUU5RDs7Ozs7R0FLRztBQUNILE1BQU0saUNBQWlDLEdBQUcsdUJBQXVCLENBQUM7QUFFbEU7Ozs7O0dBS0c7QUFDSCxNQUFN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QUFDO0FBQ2hDLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLEtBQWE7SUFDbEQsTUFBTSxTQUFTLEdBQUcsa0NBQWtDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsT0FBTyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsU0FBUyw4QkFBOEIsQ0FBQyxLQUFhO0lBQ25ELE1BQU0sU0FBUyxHQUFHLHdDQUF3QyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUM7QUFDM0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7XG4gIFJFQ09NTUVOREVEX0hUVFBfQVBJX1NFQ1VSSVRZX1BPTElDWSxcbiAgZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbixcbiAgc2VjdXJlRGVmYXVsdHMsXG59IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyB9IGZyb20gXCIuL2h0dHAtYXBpXCI7XG5pbXBvcnQgeyBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQgfSBmcm9tIFwiLi9yb3V0ZS1pZHNcIjtcblxuY29uc3QgQ09OU09MSURBVEVEX1JPT1RfUk9VVEVfSUQgPSBcIlJvdXRlQW55Um9vdFwiO1xuY29uc3QgQ09OU09MSURBVEVEX1BST1hZX1JPVVRFX0lEID0gXCJSb3V0ZUFueVByb3h5XCI7XG5jb25zdCBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVCA9IDEwMDtcbmNvbnN0IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVCA9IDIwMDtcbmNvbnN0IERFRkFVTFRfU0VTU0lPTl9UVExfTUlOVVRFUyA9IDYwO1xuY29uc3QgTUNQX1RSQU5TUE9SVF9BVVRIT1JJWkVSX0lEID0gXCJNY3BUcmFuc3BvcnRBdXRob3JpemVyXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZID0gXCJhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlXCI7XG5jb25zdCBNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfQ09OVFJBQ1RfSUQgPSBcIm0xNy5tY3AtdHJhbnNwb3J0LXBvc3R1cmUvdjFcIjtcbmNvbnN0IE1DUF9ERU5JQUxfTUVUUklDX05BTUUgPSBcImFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWRcIjtcbmNvbnN0IE1DUF9ERU5JQUxfRElNRU5TSU9OUyA9IFtcIm91dGNvbWVcIiwgXCJyb3V0ZV9mYW1pbHlcIl07XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IEZST05UX0RPT1JfSEVBREVSX05BTUVfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS1dezEsNjR9JC87XG5cbi8qKiBUaGUgZnJvbnQtZG9vciBzZWNyZXQgYWxwaGFiZXQ6IGhlYWRlci12YWx1ZS1zYWZlLCBubyB3aGl0ZXNwYWNlIG9yIGNvbnRyb2xzLiAqL1xuY29uc3QgRlJPTlRfRE9PUl9TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqXG4gKiBBIHdlbGwta25vd24gU1NNIHBhcmFtZXRlciBuYW1lLCBpbiB0aGUgYWxwaGFiZXQgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYFxuICogZHluYW1pYyByZWZlcmVuY2UgYWNjZXB0cy5cbiAqXG4gKiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vQVdTQ2xvdWRGb3JtYXRpb24vbGF0ZXN0L1VzZXJHdWlkZS9keW5hbWljLXJlZmVyZW5jZXMtc3NtLmh0bWxcbiAqL1xuY29uc3QgRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9QQVRURVJOID0gL15cXC9bQS1aYS16MC05Xy5cXC0vXSskLztcblxuLyoqXG4gKiBUaGUgU1NNIHBhcmFtZXRlci1uYW1lIGxpbWl0czogMTAxMSBjaGFyYWN0ZXJzIGluY2x1ZGluZyB0aGUgQVJOIHByZWZpeCwgYVxuICogZmlmdGVlbi1sZXZlbCBoaWVyYXJjaHksIGFuZCBubyBgYXdzYC9gc3NtYCBwcmVmaXguXG4gKlxuICogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL3N5c3RlbXMtbWFuYWdlci9sYXRlc3QvQVBJUmVmZXJlbmNlL0FQSV9QdXRQYXJhbWV0ZXIuaHRtbFxuICovXG5jb25zdCBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRU5HVEggPSAxMDExO1xuY29uc3QgRlJPTlRfRE9PUl9QQVJBTUVURVJfTkFNRV9NQVhfTEVWRUxTID0gMTU7XG5cbi8qKlxuICogUmVxdWVzdCBoZWFkZXJzIGEgZnJvbnQgZG9vciBjYW4gbmV2ZXIgY2FycnkgdGhlIHZlcmlmaWNhdGlvbiBpbjogdGhleSBlaXRoZXJcbiAqIHJld3JpdGUgdGhlIG9yaWdpbiByZXF1ZXN0IGNvbnRyYWN0IG9yIGFyZSBwbGF0Zm9ybS1tYW5hZ2VkLCBzbyBhIGRlY2xhcmVkXG4gKiB2YWx1ZSBjb3VsZCBub3QgYmUgdmVyaWZpZWQgdGhlIHdheSB0aGUgcnVudGltZSByZWFkcyBpdC5cbiAqL1xuY29uc3QgUkVTRVJWRURfRlJPTlRfRE9PUl9IRUFERVJTID0gbmV3IFNldChbXG4gIFwiYXV0aG9yaXphdGlvblwiLFxuICBcImNvbm5lY3Rpb25cIixcbiAgXCJjb250ZW50LWxlbmd0aFwiLFxuICBcImNvb2tpZVwiLFxuICBcImhvc3RcIixcbiAgXCJ0cmFuc2Zlci1lbmNvZGluZ1wiLFxuICBcInd3dy1hdXRoZW50aWNhdGVcIixcbiAgXCJ4LWZvcndhcmRlZC1mb3JcIixcbl0pO1xuXG5cbi8qKiBSb3V0ZS1lbWlzc2lvbiBtb2RlbCBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbCB7XG4gIC8qKlxuICAgKiBPbmUgQVBJIEdhdGV3YXkgSFRUUCBBUEkgdjIgcm91dGUgcGVyIGRlcml2ZWQgcm91dGUga2V5LiBUaGlzIGlzIHRoZVxuICAgKiBjb25zdHJ1Y3QncyBoaXN0b3JpY2FsIGludmVudG9yeSBhbmQgc3RheXMgYnl0ZS1pZGVudGljYWwgZm9yIGRlcGxveWVkXG4gICAqIHN0YWNrcywgc28gYSBgcm91dGVNb2RlbDogZXhwbGljaXRgIHVwZ3JhZGUgZGVwbG95cyBpbiBwbGFjZS4gVGhlIGRlZmF1bHQuXG4gICAqL1xuICBFWFBMSUNJVCA9IFwiZXhwbGljaXRcIixcbiAgLyoqXG4gICAqIFR3byBncmVlZHkgcm91dGVzLCBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAsIGJhY2tlZCBieSBvbmUgc2hhcmVkXG4gICAqIGludGVncmF0aW9uLiBUaGUgQXBwVGhlb3J5IHJ1bnRpbWUgcm91dGVyIHBlcmZvcm1zIG1ldGhvZCBhbmQgcGF0aFxuICAgKiBkaXNwYXRjaCwgcGF0aC1wYXJhbWV0ZXIgY2FwdHVyZSwgYW5kIGRlbmlhbC4gQ29uc29saWRhdGlvbiBuZXZlciBjaGFuZ2VzXG4gICAqIGdhdGV3YXkgYWRtaXNzaW9uLCBzbyBpdCBpcyB2YWxpZCBvbmx5IHdoZW4gZXZlcnkgZ2F0ZXdheSByb3V0ZSBpcyBgTk9ORWA6XG4gICAqIHRoZSBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgIHRyYW5zcG9ydCBwb3N0dXJlcy4gYGlhbWAgYW5kIGBqd3RgXG4gICAqIGFyZSByZWZ1c2VkIGF0IHN5bnRoZXNpcyB0aW1lLlxuICAgKi9cbiAgQ09OU09MSURBVEVEID0gXCJjb25zb2xpZGF0ZWRcIixcbn1cblxuLyoqIENvbnN0cnVjdC1pZCBkZXJpdmF0aW9uIGZvciB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZSB7XG4gIC8qKlxuICAgKiBQb3NpdGlvbmFsIGlkcyAoYFJvdXRlMGAsIGBSb3V0ZTFgLCAuLi4pIGFzc2lnbmVkIGluIGVtaXNzaW9uIG9yZGVyLiBUaGlzXG4gICAqIGlzIHRoZSBjb25zdHJ1Y3QncyBoaXN0b3JpY2FsIGludmVudG9yeSBhbmQgc3RheXMgYnl0ZS1pZGVudGljYWwgZm9yXG4gICAqIGRlcGxveWVkIHN0YWNrcy4gVGhlIGRlZmF1bHQuXG4gICAqL1xuICBMRUdBQ1kgPSBcImxlZ2FjeVwiLFxuICAvKipcbiAgICogSWRzIGRlcml2ZWQgZnJvbSB0aGUgcm91dGUgbWV0aG9kIGFuZCBwYXR0ZXJuLCBzbyBpbnNlcnRpbmcsIHJlbW92aW5nLCBvclxuICAgKiByZW9yZGVyaW5nIGEgcm91dGUgZmFtaWx5IG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlLiBJbnRlbmRlZCBmb3JcbiAgICogbmV3bHkgY3JlYXRlZCBleHBsaWNpdCBBUElzOiBzd2l0Y2hpbmcgYW4gZXhpc3RpbmcgZGVwbG95ZWQgZXhwbGljaXQgQVBJXG4gICAqIGZyb20gYGxlZ2FjeWAgdG8gYHNlbWFudGljYCBpbiBwbGFjZSByZW5hbWVzIGV2ZXJ5IHJvdXRlLCB3aGljaCBpcyBpdHNlbGYgYVxuICAgKiBjcmVhdGUtYmVmb3JlLWRlbGV0ZSBjb2xsaXNpb24uIEFkb3B0IGl0IG9uIGFuIGV4aXN0aW5nIHN0YWNrIG9ubHkgdGhyb3VnaFxuICAgKiB0aGUgbmV3LUFQSSBzd2FwIGRlc2NyaWJlZCBpbiBgVVBHUkFESU5HLm1kYC5cbiAgICovXG4gIFNFTUFOVElDID0gXCJzZW1hbnRpY1wiLFxufVxuXG4vKiogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgQXBwVGhlb3J5TWNwU2VydmVyLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHRyYW5zcG9ydCByb3V0ZXMuIFRoZSBkZWZhdWx0IGZvciBhIHNlcnZlciB3aXRoIG5vIGZhY2FkZSBhdHRhY2htZW50LiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogQSBzdGF0aWMgSldUIGF1dGhvcml6ZXIgKGlzc3VlciArIGF1ZGllbmNlKSBvbiB0aGUgdHJhbnNwb3J0IHJvdXRlcy4gKi9cbiAgSldUID0gXCJqd3RcIixcbiAgLyoqIFRoZSBnYXRld2F5IGF1dGhvcml6ZXIgaXMgTk9ORSBhbmQgdGhlIHJ1bnRpbWUgdmFsaWRhdGVzIFJGQyA5NzI4IGJlYXJlciB0b2tlbnMuIFRoZSBkZWZhdWx0IGZvciBhIGZhY2FkZS1jb25maWd1cmVkIHNlcnZlci4gKi9cbiAgUlVOVElNRV9CRUFSRVIgPSBcInJ1bnRpbWUtYmVhcmVyXCIsXG4gIC8qKiBEZWxpYmVyYXRlbHkgcHVibGljIE1DUCBzZXJ2ZXI6IGV2ZXJ5IHRyYW5zcG9ydCByb3V0ZSBpcyBwdWJsaWMuIE5ldmVyIGEgZGVmYXVsdC4gKi9cbiAgTk9ORV9QVUJMSUMgPSBcIm5vbmUtcHVibGljXCIsXG59XG5cbi8qKiBQcmVzZW5jZS1vbmx5IHNrZWxldG9uIG9mIHRoZSB1cHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgc2VsZWN0cyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGYWNhZGVBdHRhY2htZW50IHtcbiAgLyoqIElkZW50aWZpZXMgdGhlIHVwc3RyZWFtIGF1dGhvcml6YXRpb24gcHJvdmlkZXIgdGhpcyBzZXJ2ZXIgZnJvbnRzIChmb3IgZXhhbXBsZSBgYXV0aGVvcnlgKS4gUHJvdmlkZXIgd2lyaW5nIGxhbmRzIGluIE0zOyB0aGlzIG1pbGVzdG9uZSB2YWxpZGF0ZXMgdGhlIGF0dGFjaG1lbnQgc2hhcGUgYW5kIHVzZXMgaXRzIHByZXNlbmNlIHRvIHNlbGVjdCB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBkZWZhdWx0LiAqL1xuICByZWFkb25seSBwcm92aWRlcklkOiBzdHJpbmc7XG59XG5cbi8qKiBSdW50aW1lLXNpZGUgZGVjbGFyYXRpb24gdGhhdCB0aGUgdHJhbnNwb3J0IHJvdXRlcyB2YWxpZGF0ZSBSRkMgOTcyOCBiZWFyZXIgdG9rZW5zIGF0IHJ1bnRpbWUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFJ1bnRpbWVQb3N0dXJlT3B0aW9ucyB7XG4gIC8qKiBBc3NlcnQgdGhlIHJ1bnRpbWUgcmVnaXN0ZXJzIHRoZSB0cmFuc3BvcnQgcm91dGVzIHdpdGggdGhlIHJ1bnRpbWUtdmFsaWRhdGVkIGJlYXJlciBwb3N0dXJlIChHbyBgRmFjYWRlQ29uZmlnLlJlcXVpcmVCZWFyZXJUb2tlbmAsIFRTIGByZXF1aXJlQmVhcmVyVG9rZW5NaWRkbGV3YXJlYCwgUHl0aG9uIGByZXF1aXJlX2JlYXJlcl90b2tlbl9taWRkbGV3YXJlYCkuIE11c3QgYmUgYHRydWVgLiAqL1xuICByZWFkb25seSByZXF1aXJlQmVhcmVyVG9rZW46IGJvb2xlYW47XG59XG5cbi8qKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGV4ZWN1dGUtYXBpIGRlZmF1bHQgZW5kcG9pbnQgYW5kIGFkdmVydGlzZSBhbiBvd25lZCBvcmRpbmFyeVxuICAgKiBjdXN0b20gZG9tYWluIGFzIHRoZSBvbmx5IE1DUCBhdXRob3JpdHkuXG4gICAqL1xuICBESVNBQkxFRCA9IFwiZGlzYWJsZWRcIixcbiAgLyoqXG4gICAqIERpc2FibGUgdGhlIGV4ZWN1dGUtYXBpIGRlZmF1bHQgZW5kcG9pbnQgYW5kIHJlcXVpcmUgbXV0dWFsIFRMUyBvbiBldmVyeVxuICAgKiBjdXN0b20gZG9tYWluIG1hcHBlZCB0byB0aGUgY29uc3RydWN0LW93bmVkIEFQSS4gVGhlIG93bmVkIGRvbWFpbidzXG4gICAqIGBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgaXMgdGhlIGNvbmNyZXRlIGxvY2s7IGFuIGVudW0gYWxvbmUgb3IgYW5cbiAgICogZXh0ZXJuYWwvYXR0YWNoZWQgZnJvbnQgZG9vciBuZXZlciBzYXRpc2ZpZXMgaXQuXG4gICAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxuICAvKipcbiAgICogVGhlIG9yaWdpbiBzdGF5cyBkaXJlY3RseSByZWFjaGFibGUgYXQgaXRzIGV4ZWN1dGUtYXBpIGVuZHBvaW50IGFuZCBpc1xuICAgKiBzZXJ2ZWQgb25seSB0aHJvdWdoIGFuIGFwcGxpY2F0aW9uLW93bmVkIGZyb250IGRvb3IgdGhhdCBpbmplY3RzXG4gICAqIGBmcm9udERvb3JWZXJpZmljYXRpb25gIG9uIGV2ZXJ5IG9yaWdpbiByZXF1ZXN0LlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBwb3N0dXJlIGZvciBhbiBhcHAtb3duZWQgZGlzdHJpYnV0aW9uIHdob3NlIG9yaWdpbiBpcyB0aGVcbiAgICogZXhlY3V0ZS1hcGkgaG9zdG5hbWU6IHRoZSBjb25zdHJ1Y3Qgc2VlcyBuZWl0aGVyIHRoZSBkaXN0cmlidXRpb24gbm9yIHRoZVxuICAgKiBBUEkncyBlbmRwb2ludCBjb25maWd1cmF0aW9uLCBzbyBpdCBjYW5ub3QgcHJvZHVjZSBpbi1zdGFjayBldmlkZW5jZSB0aGVcbiAgICogd2F5IGBESVNBQkxFRGAgYW5kIGBMT0NLRURgIGRvLiBWYWxpZCBvbmx5IGluIGF0dGFjaCBtb2RlLCBhY2NlcHRlZCB3aXRoXG4gICAqIGBSVU5USU1FX0JFQVJFUmAgYW5kIGBOT05FX1BVQkxJQ2AgbGlrZSB0aGUgb3RoZXIgZGVjaXNpb25zLCBhbmQgaXRcbiAgICogcmVxdWlyZXMgdGhlIG1hbmRhdG9yeSBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvbi5cbiAgICpcbiAgICogYEZST05URURgIGlzIGEgZGVmZW5zZS1pbi1kZXB0aCBkZWNsYXJhdGlvbiB3aXRoIHJ1bnRpbWUgZW5mb3JjZW1lbnQsIG5vdFxuICAgKiBtdXR1YWwtVExTIGFzc3VyYW5jZSBhbmQgbm90IG9yaWdpbiB1bnJlYWNoYWJpbGl0eS4gVGhlIGVuZm9yY2VtZW50IGlzIHRoZVxuICAgKiBydW50aW1lJ3MgZnJvbnQtZG9vciBoZWFkZXIgY2hlY2sgKGBtY3BmYWNhZGUuRmFjYWRlQ29uZmlnYFxuICAgKiBgRnJvbnREb29yVmVyaWZpY2F0aW9uYCBpbiBHbywgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgaW4gVHlwZVNjcmlwdCxcbiAgICogYGZyb250X2Rvb3JfdmVyaWZpY2F0aW9uYCBpbiBQeXRob24pOiBpdCByZWZ1c2VzIGV2ZXJ5IGRlcml2ZWQgcm91dGUgd2hlblxuICAgKiB0aGUgZGVjbGFyZWQgaGVhZGVyIGlzIGFic2VudCBvciB3cm9uZywgYW5kIGZhaWxzIHJlZ2lzdHJhdGlvbiB3aGVuXG4gICAqIGBGUk9OVEVEYCBpcyBkZWNsYXJlZCB3aXRob3V0IGl0LiBBbiB1bndpcmVkIHJ1bnRpbWUgZW5mb3JjZXMgbm90aGluZy5cbiAgICovXG4gIEZST05URUQgPSBcImZyb250ZWRcIixcbn1cblxuLyoqXG4gKiBGcm9udC1kb29yIHZlcmlmaWNhdGlvbiBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAuXG4gKlxuICogQXR0YWNoIG1vZGUgbWVhbnMgdGhlIGZyb250IGRvb3IgaXMgYXBwbGljYXRpb24tb3duZWQsIHNvIHRoZSBjb25zdHJ1Y3RcbiAqIGNhbm5vdCBpbmplY3QgdGhlIGhlYWRlciBpdHNlbGYgYW5kIGNhbm5vdCBvYnNlcnZlIHRoZSBkaXN0cmlidXRpb24uIFRoZVxuICogZGVjbGFyYXRpb24gdGhlcmVmb3JlIGNhcnJpZXMgdGhyZWUgaW5kZXBlbmRlbnRseSB3aXJlZCBjb3BpZXMgdGhhdCBtdXN0IGNvbWVcbiAqIGZyb20gb25lIGFwcGxpY2F0aW9uLW93bmVkIGNvbnN0YW50OiB0aGlzIHByb3AsIHRoZSBkaXN0cmlidXRpb24ncyBvcmlnaW5cbiAqIGN1c3RvbS1oZWFkZXIgY29uZmlndXJhdGlvbiwgYW5kIHRoZSBydW50aW1lJ3MgZnJvbnQtZG9vciB2ZXJpZmljYXRpb25cbiAqIGNvbmZpZy4gVGhlIGNvbnN0cnVjdCBwcm92ZXMgb25seSBpdHMgb3duIGNvcHkuXG4gKlxuICogU3VwcGx5IGV4YWN0bHkgb25lIG9mIGBzZWNyZXRWYWx1ZWAgYW5kIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYDpcbiAqXG4gKiAtIGBzZWNyZXRWYWx1ZWAgaXMgdGhlIHY3LjMgbGl0ZXJhbCBmb3JtLiBJdCBpcyBjb25zdW1lZCBhdCBzeW50aGVzaXMgZm9yXG4gKiAgIHZhbGlkYXRpb24gYW5kIHRoZSByZWNvcmRlZCBTSEEtMjU2IGRpZ2VzdCBvbmx5LCBhbmQgaXQgbmV2ZXIgbGFuZHMgaW4gdGhlXG4gKiAgIGNvbnN0cnVjdCdzIG93biBzeW50aGVzaXplZCB0ZW1wbGF0ZS5cbiAqIC0gYHNlY3JldFBhcmFtZXRlck5hbWVgIG5hbWVzIGEgd2VsbC1rbm93biwgc3RhZ2UtcXVhbGlmaWVkIFBhcmFtZXRlciBTdG9yZVxuICogICBwYXJhbWV0ZXIgdGhhdCB0aGUgYXBwbGljYXRpb24ncyBpbnN0YWxsZXIgY3JlYXRlcyBpZiBhYnNlbnQuIFRoZSB2YWx1ZVxuICogICBuZXZlciBlbnRlcnMgdGhlIGFwcGxpY2F0aW9uIHNvdXJjZTogdGhlIGNvbnN0cnVjdCByZW5kZXJzIHRoZSBoZWFkZXIgdmFsdWVcbiAqICAgYXMgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljIHJlZmVyZW5jZSBhbmQgcmVjb3JkcyB0aGUgcGFyYW1ldGVyIG5hbWVcbiAqICAgaW5zdGVhZCBvZiBhIGRpZ2VzdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4gcmVxdWVzdCBoZWFkZXIgdGhlIGZyb250IGRvb3IgaW5qZWN0cyBvbiBldmVyeSByZXF1ZXN0IGl0IHNlbmRzXG4gICAqIHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDEgdG8gNjQgY2hhcmFjdGVycyBvZiBgW0EtWmEtejAtOS1dYCwgYW5kIG5ldmVyIGEgcmVxdWVzdCBoZWFkZXIgdGhhdFxuICAgKiByZXdyaXRlcyB0aGUgb3JpZ2luIGNvbnRyYWN0IChgSG9zdGAsIGBBdXRob3JpemF0aW9uYCwgYENvb2tpZWAsXG4gICAqIGBDb250ZW50LUxlbmd0aGAsIGBUcmFuc2Zlci1FbmNvZGluZ2AsIGBDb25uZWN0aW9uYCwgYFdXVy1BdXRoZW50aWNhdGVgLFxuICAgKiBgWC1Gb3J3YXJkZWQtRm9yYCksIGFueSBgeC1hbXotKmAvYHgtYW16bi0qYC9gY2xvdWRmcm9udC0qYCBuYW1lLCBvciBhXG4gICAqIGhvcC1ieS1ob3AgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGhlYWRlck5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBmcm9udC1kb29yIGhlYWRlciB2YWx1ZS5cbiAgICpcbiAgICogMzIgdG8gMTI4IGNoYXJhY3RlcnMgb2YgYFtBLVphLXowLTkuX34tXWA6IGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXRcbiAgICogd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBubyBjb250cm9sIGNoYXJhY3RlcnMuIFRoZSB2YWx1ZSBpcyBjb25zdW1lZCBhdFxuICAgKiBzeW50aGVzaXMgZm9yIHZhbGlkYXRpb24gYW5kIHRoZSByZWNvcmRlZCBTSEEtMjU2IGRpZ2VzdCBvbmx5IOKAlCB0aGUgbGl0ZXJhbFxuICAgKiBuZXZlciBsYW5kcyBpbiB0aGUgY29uc3RydWN0J3Mgc3ludGhlc2l6ZWQgdGVtcGxhdGUgb3IgaW4gQ2xvdWRGb3JtYXRpb24uXG4gICAqIEl0IGlzIG5vdCBhIGNyZWRlbnRpYWwgc3RvcmU7IHJvdGF0aW9uIG1lYW5zIGNoYW5naW5nIHRoZSB2YWx1ZSBhbmRcbiAgICogcmVkZXBsb3lpbmcsIGFuZCBpdCBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBzZWNyZXQgdGhhdCBwcm90ZWN0c1xuICAgKiBhbnl0aGluZyBlbHNlLlxuICAgKlxuICAgKiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBgc2VjcmV0UGFyYW1ldGVyTmFtZWAuIFByZWZlciB0aGUgcGFyYW1ldGVyIGZvcm06XG4gICAqIGEgY29tbWl0dGVkIGxpdGVyYWwgaXMgZXhhY3RseSB3aGF0IHRoZSBwYXJhbWV0ZXIgZm9ybSByZW1vdmVzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFZhbHVlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgd2VsbC1rbm93biwgc3RhZ2UtcXVhbGlmaWVkIFBhcmFtZXRlciBTdG9yZSBwYXJhbWV0ZXIgdGhhdCBob2xkcyB0aGVcbiAgICogZnJvbnQtZG9vciBzZWNyZXQuXG4gICAqXG4gICAqIEEgZnVsbHkgcXVhbGlmaWVkIG5hbWUgZnJvbSBgL2AsIGF0IG1vc3QgMTAxMSBjaGFyYWN0ZXJzIGFuZCBmaWZ0ZWVuXG4gICAqIGxldmVscywgaW4gdGhlIGBbQS1aYS16MC05Xy5cXC0vXWAgYWxwaGFiZXQgYSBDbG91ZEZvcm1hdGlvbiBgc3NtYCBkeW5hbWljXG4gICAqIHJlZmVyZW5jZSBhY2NlcHRzLCBhbmQgbmV2ZXIgaW4gdGhlIHJlc2VydmVkIGBhd3NgL2Bzc21gIGhpZXJhcmNoeS5cbiAgICpcbiAgICogVGhlIHBhcmFtZXRlciBtdXN0IGJlIHR5cGUgKipTdHJpbmcqKiwgbm90IFNlY3VyZVN0cmluZzogQ2xvdWRGcm9udCdzXG4gICAqIGBPcmlnaW5DdXN0b21IZWFkZXJzYCBzdXBwb3J0cyB0aGUgcGxhaW50ZXh0IGBzc21gIHJlZmVyZW5jZSBvbmx5LCBhbmQgQVdTXG4gICAqIGxpc3RzIHRoZSBwcm9wZXJ0aWVzIHRoYXQgc3VwcG9ydCBgc3NtLXNlY3VyZWAgZXhoYXVzdGl2ZWx5IChDbG91ZEZyb250IGlzXG4gICAqIG5vdCBvbmUgb2YgdGhlbSkuIFRoZSB2YWx1ZSBpcyB0aGVyZWZvcmUgZGVmZW5zZS1pbi1kZXB0aCBhZ2FpbnN0IGRpcmVjdFxuICAgKiBvcmlnaW4gYWNjZXNzLCBub3QgYSBjb25maWRlbnRpYWxpdHkgY29udHJvbCDigJQgdGhlIHNhbWUgcG9zdHVyZSBhcyB0aGVcbiAgICogbGl0ZXJhbCBmb3JtLCB3aGljaCBDbG91ZEZyb250IGFscmVhZHkgZXhwb3NlcyB0aHJvdWdoXG4gICAqIGBHZXREaXN0cmlidXRpb25Db25maWdgLlxuICAgKlxuICAgKiBgZnJvbnREb29yT3JpZ2luSGVhZGVyYCByZW5kZXJzIHRoZSBkeW5hbWljIHJlZmVyZW5jZSBmb3IgdGhlIGRpc3RyaWJ1dGlvblxuICAgKiB0aGUgYXBwIHdpcmVzLCBlLmcuIGB7e3Jlc29sdmU6c3NtOi90aGVvcnljbG91ZC90bXMvbGFiL2Zyb250ZWQtdG9rZW59fWAsXG4gICAqIGFuZCB0aGUgY29uc3RydWN0IGdyYW50cyBgc3NtOkdldFBhcmFtZXRlcmAgb24gZXhhY3RseSB0aGlzIHBhcmFtZXRlciB0b1xuICAgKiBgaGFuZGxlcmAuIEEgc3RhY2sgdXBkYXRlIHJlLXJlc29sdmVzIHRoZSBsYXRlc3QgcGFyYW1ldGVyIHZlcnNpb247IGRyaWZ0XG4gICAqIGRldGVjdGlvbiBkb2VzIG5vdCBzZWUgZHluYW1pYyByZWZlcmVuY2VzLlxuICAgKlxuICAgKiBNdXR1YWxseSBleGNsdXNpdmUgd2l0aCBgc2VjcmV0VmFsdWVgLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3JldFBhcmFtZXRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjdXN0b21lciBtYW5hZ2VkIGtleSB0aGF0IGVuY3J5cHRzIHRoZSBwYXJhbWV0ZXIgd2hlbiBpdCBpcyBhXG4gICAqIFNlY3VyZVN0cmluZy5cbiAgICpcbiAgICogRlJPTlRFRCBjYW5ub3QgdXNlIGEgU2VjdXJlU3RyaW5nIGZvciB0aGUgZGlzdHJpYnV0aW9uIGhlYWRlciAoc2VlXG4gICAqIGBzZWNyZXRQYXJhbWV0ZXJOYW1lYCksIHNvIHRoaXMgaXMgb25seSBtZWFuaW5nZnVsIHdoZW4gdGhlIHNhbWUgd2VsbC1rbm93blxuICAgKiBuYW1lIGlzIGFsc28gcmVhZCBmb3IgYSBwdXJwb3NlIG90aGVyIHRoYW4gdGhlIG9yaWdpbiBoZWFkZXIuIFdoZW4gaXQgaXNcbiAgICogc2V0IHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIGBrbXM6RGVjcnlwdGAgb24gdGhlIGtleSB0byBgaGFuZGxlcmAuIExlYXZlIGl0XG4gICAqIHVuc2V0IGZvciBhIFN0cmluZyBwYXJhbWV0ZXI6IFBhcmFtZXRlciBTdG9yZSBuZWVkcyBubyBLTVMgcGVybWlzc2lvbiBmb3JcbiAgICogcGxhaW50ZXh0IHZhbHVlcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzZWNyZXRQYXJhbWV0ZXJLbXNLZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogVGhlIGFzc2VydGlvbiB0aGF0IHRoZSBydW50aW1lIHZlcmlmaWVzIHRoZSBmcm9udC1kb29yIGhlYWRlciBvbiBldmVyeVxuICAgKiBkZXJpdmVkIHJvdXRlLlxuICAgKlxuICAgKiBUaGUgY29uc3RydWN0IGNhbm5vdCBhdHRhY2ggdGhhdCB2ZXJpZmljYXRpb24gdG8gYW4gYXBwbGljYXRpb24tb3duZWQgZnJvbnRcbiAgICogZG9vciBvciBhIHJ1bnRpbWUgaXQgZG9lcyBub3Qgb3duLCBzbyBpdCByZWZ1c2VzIHRvIHN5bnRoZXNpemUgdW50aWwgdGhlXG4gICAqIGNhbGxlciByZWNvcmRzIHRoYXQgdGhlIHZlcmlmaWNhdGlvbiBleGlzdHMuIE11c3QgYmUgYHRydWVgLlxuICAgKi9cbiAgcmVhZG9ubHkgYXNzZXJ0ZWQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHBsaWNhdGlvbiB3aXJlcyBpbnRvIGl0cyBmcm9udCBkb29yLlxuICpcbiAqIGBoZWFkZXJWYWx1ZWAgaXMgdGhlIGxpdGVyYWwgZm9yIHRoZSBsaXRlcmFsIGZvcm0gYW5kIGEgQ2xvdWRGb3JtYXRpb25cbiAqIGBzc21gIGR5bmFtaWMgcmVmZXJlbmNlIGZvciB0aGUgcGFyYW1ldGVyIGZvcm0sIHNvIHRoZSBwYXJhbWV0ZXIgdmFsdWUgbmV2ZXJcbiAqIGVudGVycyB0aGUgYXBwbGljYXRpb24gc291cmNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlciB7XG4gIC8qKiBUaGUgb3JpZ2luIHJlcXVlc3QgaGVhZGVyIG5hbWUgdG8gc2VuZCB0byB0aGUgb3JpZ2luLiAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lOiBzdHJpbmc7XG4gIC8qKiBUaGUgaGVhZGVyIHZhbHVlOiBhIGxpdGVyYWwsIG9yIGEgYHt7cmVzb2x2ZTpzc206Li4ufX1gIGR5bmFtaWMgcmVmZXJlbmNlLiAqL1xuICByZWFkb25seSBoZWFkZXJWYWx1ZTogc3RyaW5nO1xufVxuXG4vKiogRGVuaWFsLXRlbGVtZXRyeSBkZWNsYXJhdGlvbiByZXF1aXJlZCB1bmRlciBgcnVudGltZS1iZWFyZXJgLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zIHtcbiAgLyoqIERlbmlhbCBtZXRyaWMgbmFtZS4gTXVzdCBiZSBgYXBwdGhlb3J5Lm1jcC5hdXRoX2RlbmllZGAuIEBkZWZhdWx0IGFwcHRoZW9yeS5tY3AuYXV0aF9kZW5pZWQgKi9cbiAgcmVhZG9ubHkgbWV0cmljTmFtZT86IHN0cmluZztcbiAgLyoqIEJvdW5kZWQgbWV0cmljIGRpbWVuc2lvbnMuIE11c3QgYmUgZXhhY3RseSBgb3V0Y29tZWAgYW5kIGByb3V0ZV9mYW1pbHlgLiBAZGVmYXVsdCBbXCJvdXRjb21lXCIsIFwicm91dGVfZmFtaWx5XCJdICovXG4gIHJlYWRvbmx5IGRpbWVuc2lvbnM/OiBzdHJpbmdbXTtcbn1cblxuLyoqIE93bmluZy1BUEkgc3RhZ2UgdGhyb3R0bGluZyBkZWNpc2lvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnMge1xuICAvKiogU3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLiAqL1xuICByZWFkb25seSByYXRlTGltaXQ6IG51bWJlcjtcbiAgLyoqIFN0YWdlIGJ1cnN0IGxpbWl0LiAqL1xuICByZWFkb25seSBidXJzdExpbWl0OiBudW1iZXI7XG59XG5cbi8qKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyBkZWZlbnNlLWluLWRlcHRoIGRlY2lzaW9ucyAocmVxdWlyZWQgdW5kZXIgYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYG5vbmUtcHVibGljYCkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHtcbiAgLyoqIFdoZXRoZXIgdGhlIG93bmluZyBBUEkncyBzdGFnZSBoYXMgYWNjZXNzIGxvZ2dpbmcgZW5hYmxlZC4gTXVzdCBiZSB0cnVlLiAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nOiBib29sZWFuO1xuICAvKiogVGhlIG93bmluZyBBUEkncyBzdGFnZSB0aHJvdHRsaW5nIGRlY2lzaW9uLiAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nOiBBcHBUaGVvcnlNY3BPd25pbmdBcGlUaHJvdHRsaW5nT3B0aW9ucztcbn1cblxuLyoqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgYHRyYW5zcG9ydFBvc3R1cmU6IEpXVGAuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIEhUVFBTIEpXVCBpc3N1ZXIgVVJMLiBSZXF1aXJlZCB1bmRlciBgdHJhbnNwb3J0UG9zdHVyZTogSldUYC4gQGRlZmF1bHQgdW5kZWZpbmVkICovXG4gIHJlYWRvbmx5IGlzc3Vlcj86IHN0cmluZztcbiAgLyoqIEFjY2VwdGVkIEpXVCBhdWRpZW5jZXMuIFJlcXVpcmVkIHVuZGVyIGB0cmFuc3BvcnRQb3N0dXJlOiBKV1RgLiBAZGVmYXVsdCB1bmRlZmluZWQgKi9cbiAgcmVhZG9ubHkgYXVkaWVuY2U/OiBzdHJpbmdbXTtcbiAgLyoqIElkZW50aXR5IHNvdXJjZXMgZm9yIHRoZSBKV1QgYXV0aG9yaXplci4gQGRlZmF1bHQgW1wiJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb25cIl0gKi9cbiAgcmVhZG9ubHkgaWRlbnRpdHlTb3VyY2U/OiBzdHJpbmdbXTtcbiAgLyoqIEpXVCBhdXRob3JpemVyIHJlc291cmNlIG5hbWUuIEBkZWZhdWx0IHRoZSBhdXRob3JpemVyIGNvbnN0cnVjdCBpZCAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcbn1cblxuLyoqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbiBmb3IgYW4gQXBwVGhlb3J5LW93bmVkIE1DUCBIVFRQIEFQSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucyB7XG4gIC8qKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSwgYG1jcC5leGFtcGxlLmNvbWApLiAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZUFybmAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKiogQUNNIGNlcnRpZmljYXRlIEFSTi4gUHJvdmlkZSB0aGlzIG9yIGBjZXJ0aWZpY2F0ZWAuICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhbiBhdXRvbWF0aWNhbGx5IGNyZWF0ZWQgQ05BTUUgcmVjb3JkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBNdXR1YWwgVExTIHRydXN0c3RvcmUgZm9yIHRoZSBvd25lZCBjdXN0b20gZG9tYWluLlxuICAgKlxuICAgKiBTdXBwbHlpbmcgdGhpcyBpcyB0aGUgY29uY3JldGUgYEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURgXG4gICAqIGV2aWRlbmNlOiB0aGUgY29uc3RydWN0IGRpc2FibGVzIHRoZSBkZWZhdWx0IGV4ZWN1dGUtYXBpIGVuZHBvaW50IGFuZFxuICAgKiByZXF1aXJlcyBldmVyeSBBUEkgbWFwcGluZyBib3VuZCB0byB0aGUgb3duZWQgQVBJIHRvIHRhcmdldCBhIGRvbWFpbiB3aG9zZVxuICAgKiBgTXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGNhcnJpZXMgYSB0cnVzdHN0b3JlIFVSSS4gU3VwcGx5aW5nIGl0IHdpdGggYW55XG4gICAqIG90aGVyIG9yaWdpbiBkZWNpc2lvbiwgb3Igc2VsZWN0aW5nIGBMT0NLRURgIHdpdGhvdXQgaXQsIGZhaWxzIHN5bnRoZXNpcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcblxuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeSBmb3IgdGhlIG93bmVkIGN1c3RvbSBkb21haW4uXG4gICAqXG4gICAqIFVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB0aGUgZGVmYXVsdCBpcyBUTFMgMS4yLCB0aGUgc3Ryb25nZXN0IHBvbGljeVxuICAgKiBBUEkgR2F0ZXdheSB2MiBvZmZlcnMuIFNlY3VyaXR5IEh1YiBBUElHYXRld2F5LjExIGFsd2F5cyBmYWlscyBhIGN1c3RvbVxuICAgKiBkb21haW4gYXR0YWNoZWQgdG8gYW4gSFRUUCBBUEksIHNvIG5vIHBvbGljeSBzYXRpc2ZpZXMgaXQgdGhlcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFRMUyAxLjIgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LCBvdGhlcndpc2UgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3d2Mi5TZWN1cml0eVBvbGljeTtcbn1cblxuLyoqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIGFuIEFwcFRoZW9yeS1vd25lZCBNQ1AgSFRUUCBBUEkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucyB7XG4gIC8qKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCIgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKiBAZGVmYXVsdCB0cnVlICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciB0aGUgYWNjZXNzIGxvZyBncm91cC4gVmFsaWQgb25seSB3aGVuIGFjY2VzcyBsb2dnaW5nXG4gICAqIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgcmF0ZSBsaW1pdCBpbiByZXF1ZXN0cyBwZXIgc2Vjb25kLlxuICAgKiBAZGVmYXVsdCAxMDBcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIERlZmF1bHQtc3RhZ2UgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IDIwMFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKiBPd25lZC1BUEkgc3BlY2lhbGl6YXRpb24gZm9yIHN0YW5kYWxvbmUgTUNQIHNlcnZlcnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlck93bmVkQXBpT3B0aW9ucyB7XG4gIC8qKiBPcHRpb25hbCBBUEkgbmFtZS4gKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKiogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBvd25lZCBieSB0aGlzIGNvbnN0cnVjdC4gKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi4gQWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVmYXVsdCBvbi5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbiBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbi8qKiBPcmRlcmVkIE1DUCByb3V0ZS1wYXR0ZXJuIGZhbWlseSB3aXJlZCBhcyBvbmUgZmFjYWRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseSB7XG4gIC8qKlxuICAgKiBPcmRlcmVkIHN5bnRoZXNpcy10aW1lIE1DUCByb3V0ZSBwYXR0ZXJucy5cbiAgICpcbiAgICogRWFjaCBzZWdtZW50IGlzIGVpdGhlciBhIGxpdGVyYWwgUkZDIDM5ODYgcGF0aCBzZWdtZW50IG9yIGEgY29tcGxldGVcbiAgICogYHtwYXJhbWV0ZXJfbmFtZX1gIHNlZ21lbnQuIENESyB0b2tlbnMsIG9yaWdpbnMsIGVtcHR5IHNlZ21lbnRzLCBkb3RcbiAgICogc2VnbWVudHMsIGdyZWVkeSBwYXJhbWV0ZXJzLCBhbmQgZHVwbGljYXRlIHBhdHRlcm5zIGFyZSByZWplY3RlZC5cbiAgICovXG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2lyZSB0aGUgYWxnZWJyYS1kZXJpdmVkIHVuc2NvcGVkIGF1dGhvcml6YXRpb24tc2VydmVyIGRpc2NvdmVyeSByb3V0ZS5cbiAgICogVGhlIHJ1bnRpbWUgbXVzdCBzdXBwbHkgYEZhY2FkZUNvbmZpZy5Sb290QXV0aG9yaXphdGlvblNlcnZlcmAgdG9vLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk/OiBib29sZWFuO1xufVxuXG4vKiogRHluYW1vREItYmFja2VkIE1DUCBzZXNzaW9uLXN0YXRlIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnMge1xuICAvKiogQGRlZmF1bHQgdHJ1ZSAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSBuYW1lLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCBhdXRvLWdlbmVyYXRlZFxuICAgKi9cbiAgcmVhZG9ubHkgdGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUVEwgaW4gbWludXRlcyBmb3Igc2Vzc2lvbiByZWNvcmRzLiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpc1xuICAgKiBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCA2MFxuICAgKi9cbiAgcmVhZG9ubHkgdHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogU2Vzc2lvbiB0YWJsZSByZW1vdmFsIHBvbGljeS4gVmFsaWQgb25seSB3aGVuIHNlc3Npb24gc3RhdGUgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICovXG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGRlbGV0aW9uIHByb3RlY3Rpb24gc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSBzZXNzaW9uIHRhYmxlLlxuICAgKiBWYWxpZCBvbmx5IHdoZW4gc2Vzc2lvbiBzdGF0ZSBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHdpdGggbm8gbmFtaW5nIGNvbnRleHQ6IHRoZSBBV1MgZGVmYXVsdCwgbm8gZGVsZXRpb25cbiAgICogcHJvdGVjdGlvbjsgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0OiBvbiBmb3IgYSBSRVRBSU4gdGFibGUsIG9mZiBvdGhlcndpc2UpXG4gICAqL1xuICByZWFkb25seSBkZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xufVxuXG4vKiogT25lIGRlcml2ZWQgTUNQIE9BdXRoIGZhY2FkZSByb3V0ZSBmYW1pbHkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckZhY2FkZVJvdXRlIHtcbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBtY3BNZXRob2RzOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgZGlzY292ZXJ5U3VmZml4UGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xuICByZWFkb25seSByZWdpc3RlclBhdHRlcm46IHN0cmluZztcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuO1xufVxuXG4vKiogRGVmZW5zaXZlIHNuYXBzaG90IG9mIHRoZSBjb25zdHJ1Y3QncyBkZXJpdmVkIGZhY2FkZSBpbnZlbnRvcnkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmVhZG9ubHkgY29udHJhY3RWZXJzaW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvdXRlczogQXBwVGhlb3J5TWNwU2VydmVyRmFjYWRlUm91dGVbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJvb3RBdXRob3JpemF0aW9uU2VydmVyQXR0YWNoZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNhbGxiYWNrUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogUHJvcHMgZm9yIHRoZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgY29uc3RydWN0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKiBMYW1iZGEgZnVuY3Rpb24gaGFuZGxpbmcgdGhlIHJ1bnRpbWUtY29tcG9zZWQgTUNQIGZhY2FkZS4gKi9cbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgTUNQIGZhY2FkZSBmYW1pbGllcyB0aGF0XG4gICAqIHNoYXJlIG9uZSBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3lcbiAgICogc2l6ZSBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJvdXRlLWVtaXNzaW9uIG1vZGVsLlxuICAgKlxuICAgKiBgZXhwbGljaXRgICh0aGUgZGVmYXVsdCkgd2lyZXMgdGhlIGZ1bGwgZGVyaXZlZCByb3V0ZSBpbnZlbnRvcnkgYXMgb25lIEhUVFBcbiAgICogQVBJIHYyIHJvdXRlIHBlciByb3V0ZSBrZXkgYW5kIGlzIGJ5dGUtc3RhYmxlIGZvciBkZXBsb3llZCBzdGFja3MuXG4gICAqIGBjb25zb2xpZGF0ZWRgIHdpcmVzIGV4YWN0bHkgdHdvIGdyZWVkeSByb3V0ZXMsIGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCxcbiAgICogYW5kIGlzIHZhbGlkIG9ubHkgZm9yIHRoZSBgcnVudGltZS1iZWFyZXJgIGFuZCBgbm9uZS1wdWJsaWNgIHRyYW5zcG9ydFxuICAgKiBwb3N0dXJlczsgYGlhbWAgYW5kIGBqd3RgIGFyZSByZWZ1c2VkIGF0IHN5bnRoZXNpcy5cbiAgICpcbiAgICogQ29uc29saWRhdGVkIG1vZGUgaXMgYWxsb3dlZCBvbiBhIGNvbnN0cnVjdC1vd25lZCBBUEksIG9yIG9uIGFuIGF0dGFjaGVkXG4gICAqIEFQSSB0aGF0IGhhcyBubyByb3V0ZXMgYXQgYXR0YWNoIHRpbWUuIFwiTm8gcm91dGVzXCIgaXMgZW5mb3JjZWQgb3ZlciB0aGVcbiAgICogd2hvbGUgc3RhY2ssIG5vdCBqdXN0IHRoZSBBUEkncyBvd24gY2hpbGRyZW46IGEgcm91dGUgd2lyZWQgb250byB0aGVcbiAgICogYXR0YWNoZWQgQVBJIGZyb20gYW55IHNpYmxpbmcgY29uc3RydWN0IHNjb3BlIGlzIHJlZnVzZWQsIGJlY2F1c2UgaXQgaG9sZHNcbiAgICogYSByb3V0ZSBrZXkgdGhlIGdyZWVkeSByb3V0ZXMgd291bGQgY29sbGlkZSB3aXRoLlxuICAgKlxuICAgKiBBIGNvbnN1bWVyIG1heSBzdGlsbCBhZGQgZXhwbGljaXQsIG1vcmUgc3BlY2lmaWMgcm91dGVzIHRvIHRoZSBjb25zb2xpZGF0ZWRcbiAgICogQVBJIGFmdGVyd2FyZHMsIGluIGVpdGhlciB0aGUgYXR0YWNoZWQgb3IgdGhlIGNvbnN0cnVjdC1vd25lZCBtb2RlLiBUaGF0XG4gICAqIGV4Y2VwdGlvbiBpcyBlbmZvcmNlZCBhdCBzeW50aGVzaXMgdGltZSBhbmQgaXMgYWxsb3dlZCBvbmx5IHdoZW4gdGhlIGFkZGVkXG4gICAqIHJvdXRlIGNhcnJpZXMgYSBub24tTk9ORSBhdXRob3JpemVyIGFuZCBkb2VzIG5vdCByZWRlY2xhcmUgdGhlIGdyZWVkeVxuICAgKiBgQU5ZIC9gIG9yIGBBTlkgL3twcm94eSt9YCBrZXkuIFdpdGhpbiBpdCwgYSBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIGJlYXRzIHRoZVxuICAgKiBncmVlZHkgcm91dGVzIGJ5IEFQSSBHYXRld2F5IHByZWNlZGVuY2UsIGFuZCBhIHdyb25nLW1ldGhvZCBoaXQgb24gc3VjaCBhXG4gICAqIHBhdGggZmFsbHMgdG8gdGhlIHJ1bnRpbWUncyBmYWlsLWNsb3NlZCA0MDQvNDA1LlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUXG4gICAqL1xuICByZWFkb25seSByb3V0ZU1vZGVsPzogQXBwVGhlb3J5TWNwUm91dGVNb2RlbDtcblxuICAvKipcbiAgICogQ29uc3RydWN0LWlkIGRlcml2YXRpb24gZm9yIHRoZSBleHBsaWNpdCByb3V0ZSBtb2RlbC5cbiAgICpcbiAgICogYGxlZ2FjeWAgKHRoZSBkZWZhdWx0KSBhc3NpZ25zIHBvc2l0aW9uYWwgaWRzIGluIGVtaXNzaW9uIG9yZGVyIGFuZCBpc1xuICAgKiBieXRlLXN0YWJsZSBmb3IgZGVwbG95ZWQgc3RhY2tzLiBgc2VtYW50aWNgIGRlcml2ZXMgZWFjaCBpZCBmcm9tIGl0cyByb3V0ZVxuICAgKiBtZXRob2QgYW5kIHBhdHRlcm4sIHNvIGluc2VydGluZywgcmVtb3ZpbmcsIG9yIHJlb3JkZXJpbmcgYSByb3V0ZSBmYW1pbHlcbiAgICogbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGU7IGl0IGlzIGludGVuZGVkIGZvciBuZXdseSBjcmVhdGVkIGV4cGxpY2l0XG4gICAqIEFQSXMuXG4gICAqXG4gICAqIFN3aXRjaGluZyBhbiBleGlzdGluZyBkZXBsb3llZCBleHBsaWNpdCBBUEkgZnJvbSBgbGVnYWN5YCB0byBgc2VtYW50aWNgIGluXG4gICAqIHBsYWNlIHJlbmFtZXMgZXZlcnkgcm91dGUgaW4gb25lIHVwZGF0ZSwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAgICogY3JlYXRlLWJlZm9yZS1kZWxldGUgcm91dGUta2V5IGNvbGxpc2lvbiB0aGUgbWlncmF0aW9uIGNoZWNrIHJlZnVzZXMuIEFkb3B0XG4gICAqIGBzZW1hbnRpY2Agb24gYW4gZXhpc3Rpbmcgc3RhY2sgb25seSB0aHJvdWdoIHRoZSBuZXctQVBJIHN3YXAgZG9jdW1lbnRlZCBpblxuICAgKiBgVVBHUkFESU5HLm1kYC5cbiAgICpcbiAgICogVGhpcyBwcm9wIGFwcGxpZXMgdG8gYHJvdXRlTW9kZWw6IGV4cGxpY2l0YCBvbmx5LiBUaGUgYGNvbnNvbGlkYXRlZGAgbW9kZWxcbiAgICogYWxyZWFkeSBlbWl0cyB0aGUgdHdvIGZpeGVkIHNlbWFudGljIGlkcyBgUm91dGVBbnlSb290YCBhbmQgYFJvdXRlQW55UHJveHlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1lcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlSWRNb2RlPzogQXBwVGhlb3J5TWNwUm91dGVJZE1vZGU7XG5cbiAgLyoqXG4gICAqIENPUlMgcHJlZmxpZ2h0IGZvciBhIGNvbnN0cnVjdC1vd25lZCBBUEkuIFNldCB0byBgdHJ1ZWAgZm9yIEFwcFRoZW9yeVxuICAgKiBkZWZhdWx0cyBvciBzdXBwbHkgYW4gYEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9uc2Agb2JqZWN0LiBJbnZhbGlkIGluXG4gICAqIGF0dGFjaCBtb2RlLCB3aGVyZSB0aGUgb3duaW5nIEFQSSBjb25maWd1cmVzIENPUlMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEV4aXN0aW5nIEhUVFAgQVBJIHRvIGF0dGFjaCB0by4gQXR0YWNoIG1vZGUgaXMgdGhlIHByaW1hcnkgZnJvbnQtZG9vclxuICAgKiB0b3BvbG9neSBhbmQgbmV2ZXIgY3JlYXRlcyBhbiBgQVdTOjpBcGlHYXRld2F5VjI6OkFwaWAgcmVzb3VyY2UuXG4gICAqIEBkZWZhdWx0IGEgY29uc3RydWN0LW93bmVkIEh0dHBBcGlcbiAgICovXG4gIHJlYWRvbmx5IGFwaT86IGFwaWd3djIuSUh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUgdXNlZCB3aGVuIGRlcml2aW5nIGF0dGFjaC1tb2RlIGV4ZWN1dGUtYXBpIGVuZHBvaW50IHRlbXBsYXRlcy5cbiAgICogVXNlIGAkZGVmYXVsdGAgZm9yIHRoZSBBUEkgR2F0ZXdheSBkZWZhdWx0IHN0YWdlLiBXaGVuIG9taXR0ZWQsIHRoZSBzdGFnZVxuICAgKiBpcyBub3QgZGV0ZXJtaW5hYmxlIGFuZCB0aGUgdGVtcGxhdGVzIHJldGFpbiB0aGUgYmFyZSBleGVjdXRlLWFwaSBvcmlnaW4uXG4gICAqIFRoaXMgcHJvcCBkb2VzIG5vdCBjcmVhdGUsIGltcG9ydCwgb3IgbXV0YXRlIGEgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXR0YWNoZWRBcGlTdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogR28gYHJ1bnRpbWUvbWNwZmFjYWRlLlJlZ2lzdGVyTUNQRmFjYWRlYCBzZXJ2ZXMgb25seSB0aGUgY2Fub25pY2FsIGRlZmF1bHRcbiAgICogZmFtaWx5LiBOb25jYW5vbmljYWwgcGF0dGVybnMgcmVxdWlyZSBhcHAtb3duZWQgcnVudGltZSByb3V0ZSByZWdpc3RyYXRpb25cbiAgICogdGhhdCBtYXRjaGVzIHRoZSBjb25zdHJ1Y3QncyBgcm91dGVJbnZlbnRvcnlgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKVxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVGYW1pbHk/OiBBcHBUaGVvcnlNY3BSb3V0ZUZhbWlseTtcblxuICAvKipcbiAgICogVHJhbnNwb3J0LXJvdXRlIGF1dGhvcml6YXRpb24gcG9zdHVyZS5cbiAgICpcbiAgICogQW4gZXhwbGljaXQgc2VsZWN0aW9uIG92ZXJyaWRlcyB0aGUgZmFjYWRlLXNjb3BlZCBkZWZhdWx0LiBXaGVuIGl0IGlzXG4gICAqIG9taXR0ZWQsIGEgc2VydmVyIHRoYXQgYXR0YWNoZXMgYGZhY2FkZWAgcmVzb2x2ZXMgdG8gYHJ1bnRpbWUtYmVhcmVyYCBhbmQgYVxuICAgKiBwbGFpbiB0cmFuc3BvcnQgc2VydmVyIHJlc29sdmVzIHRvIGBpYW1gLiBgbm9uZS1wdWJsaWNgIGlzIG5ldmVyIGEgZGVmYXVsdFxuICAgKiBhbmQgY2FycmllcyB0aGUgZGVmZW5zZS1pbi1kZXB0aCBmbG9vci5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUiB3aGVuIGBmYWNhZGVgIGlzIGF0dGFjaGVkLCBvdGhlcndpc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICovXG4gIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU/OiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlO1xuXG4gIC8qKlxuICAgKiBVcHN0cmVhbS1wcm92aWRlciBhdHRhY2htZW50IHRoYXQgbWFya3MgdGhpcyBzZXJ2ZXIgYXMgZmFjYWRlLWNvbmZpZ3VyZWQuXG4gICAqXG4gICAqIFRoZSBhdHRhY2htZW50J3MgcHJlc2VuY2Ugc2VsZWN0cyB0aGUgYHJ1bnRpbWUtYmVhcmVyYCBwb3N0dXJlIGRlZmF1bHQuXG4gICAqIFByb3ZpZGVyIHdpcmluZyBsYW5kcyBpbiBNMzsgdGhpcyBtaWxlc3RvbmUgdmFsaWRhdGVzIHRoZSBhdHRhY2htZW50IHNoYXBlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGZhY2FkZT86IEFwcFRoZW9yeU1jcEZhY2FkZUF0dGFjaG1lbnQ7XG5cbiAgLyoqXG4gICAqIFJ1bnRpbWUtc2lkZSBSRkMgOTcyOCBiZWFyZXIgdmFsaWRhdGlvbiBkZWNsYXJhdGlvbi5cbiAgICpcbiAgICogUmVxdWlyZWQgYnkgYHRyYW5zcG9ydFBvc3R1cmU6IFJVTlRJTUVfQkVBUkVSYCBhbmQgcmVmdXNlZCB1bmRlciBldmVyeVxuICAgKiBvdGhlciBwb3N0dXJlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJ1bnRpbWVQb3N0dXJlPzogQXBwVGhlb3J5TWNwUnVudGltZVBvc3R1cmVPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBEaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbiByZXF1aXJlZCB1bmRlciBSVU5USU1FX0JFQVJFUiBhbmRcbiAgICogTk9ORV9QVUJMSUMuIEEgZGlyZWN0bHkgcmVhY2hhYmxlIG9yaWdpbiBpcyByZWZ1c2VkIHVubGVzcyBpdCBpcyBkZWNsYXJlZFxuICAgKiBgRlJPTlRFRGAsIHdoaWNoIHJlcXVpcmVzIGBmcm9udERvb3JWZXJpZmljYXRpb25gLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG9yaWdpblJlYWNoYWJpbGl0eT86IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eTtcblxuICAvKipcbiAgICogRnJvbnQtZG9vciB2ZXJpZmljYXRpb24gZGVjbGFyYXRpb24sIHJlcXVpcmVkIHdpdGhcbiAgICogYG9yaWdpblJlYWNoYWJpbGl0eTogRlJPTlRFRGAgYW5kIHJlZnVzZWQgdW5kZXIgZXZlcnkgb3RoZXIgZGVjaXNpb24uXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgcmVjb3JkcyB0aGUgcG9zdHVyZSwgdGhlIGhlYWRlciBuYW1lLCBhbmQgZWl0aGVyIGEgU0hBLTI1NlxuICAgKiBkaWdlc3Qgb2YgdGhlIGRlY2xhcmVkIGxpdGVyYWwgb3IgdGhlIHdlbGwta25vd24gcGFyYW1ldGVyIG5hbWUgaW4gdGhlXG4gICAqIGBhcHB0aGVvcnk6bWNwLXRyYW5zcG9ydC1wb3N0dXJlYCBtZXRhZGF0YTsgaXQgbmV2ZXIgZW1pdHMgdGhlIHNlY3JldFxuICAgKiB2YWx1ZS4gYGZyb250RG9vck9yaWdpbkhlYWRlcmAgaXMgdGhlIG9yaWdpbiBjdXN0b20gaGVhZGVyIHRoZSBhcHBsaWNhdGlvblxuICAgKiB3aXJlcywgYW5kIGZvciB0aGUgcGFyYW1ldGVyIGZvcm0gaXRzIHZhbHVlIGlzIGEgQ2xvdWRGb3JtYXRpb24gZHluYW1pY1xuICAgKiByZWZlcmVuY2UuIEVuZm9yY2VtZW50IGlzIHRoZSBydW50aW1lJ3MgZnJvbnQtZG9vciBoZWFkZXIgY2hlY2ssIHNvIGFuXG4gICAqIHVud2lyZWQgcnVudGltZSBlbmZvcmNlcyBub3RoaW5nLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGZyb250RG9vclZlcmlmaWNhdGlvbj86IEFwcFRoZW9yeU1jcEZyb250RG9vclZlcmlmaWNhdGlvbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIERlbmlhbC10ZWxlbWV0cnkgZGVjbGFyYXRpb24gcmVxdWlyZWQgdW5kZXIgUlVOVElNRV9CRUFSRVIgb25seS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZW5pYWxTaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBBdHRhY2gtbW9kZSByZWNvcmQgb2YgdGhlIG93bmluZyBBUEkncyB0aHJvdHRsaW5nIGFuZCBhY2Nlc3MtbG9nZ2luZ1xuICAgKiBkZWNpc2lvbnMsIHJlcXVpcmVkIHVuZGVyIFJVTlRJTUVfQkVBUkVSIGFuZCBOT05FX1BVQkxJQy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBvd25pbmdBcGlEZWZlbnNlPzogQXBwVGhlb3J5TWNwT3duaW5nQXBpRGVmZW5zZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YXRpYyBKV1QgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCB0cmFuc3BvcnQgcm91dGVzLlxuICAgKlxuICAgKiBUcmFuc3BvcnQgcm91dGVzIGFyZSB0aGUgUE9TVCwgR0VULCBhbmQgREVMRVRFIHJvdXRlcyBvbiBldmVyeSBNQ1AgcGF0dGVybi5cbiAgICogVGhpcyBwcm9wIGlzIG9ubHkgdmFsaWQgd2l0aCBgdHJhbnNwb3J0UG9zdHVyZTogSldUYCwgd2hpY2ggcmVxdWlyZXMgYW5cbiAgICogaXNzdWVyIGFuZCBhIG5vbi1lbXB0eSBhdWRpZW5jZS4gRGlzY292ZXJ5LCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEsXG4gICAqIGF1dGhvcml6ZSwgYW5kIHRva2VuIHJvdXRlcyByZW1haW4gZXhwbGljaXRseSBwdWJsaWMgKGBOT05FYCkgYmVjYXVzZSBPQXV0aFxuICAgKiBjbGllbnRzIG11c3QgZmV0Y2ggdGhlbSBiZWZvcmUgdGhleSBob2xkIGEgdG9rZW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdHJhbnNwb3J0QXV0aG9yaXplcj86IEFwcFRoZW9yeU1jcFRyYW5zcG9ydEF1dGhvcml6ZXJPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIENESy1tb3VudGVkIGNhbGxiYWNrIHJvdXRlIGFuZCB0aGUgcnVudGltZS1yZWdpc3RlcmVkIG9uZSBtdXN0IG5vdFxuICAgKiBkaXZlcmdlOiB0aGlzIHByb3AgaXMgcmVzb2x2ZWQgYnlcbiAgICogYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aGAsIHRoZSBzYW1lIGFsZ2VicmFcbiAgICogdGhlIHJ1bnRpbWUgYXBwbGllcyB0byBgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYC4gU3VwcGx5IGFcbiAgICogc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gcXVlcnksIGZyYWdtZW50LCBvciBkb3RcbiAgICogc2VnbWVudDsgYW4gZW1wdHkgdmFsdWUga2VlcHMgdGhlIGNvbnRyYWN0IGRlZmF1bHQsIGFuZCBhIHZhbHVlIHRoYXRcbiAgICogY29sbGlkZXMgd2l0aCBhbm90aGVyIGRlcml2ZWQgcm91dGUgZmFpbHMgc3ludGhlc2lzLiBSZWZ1c2VkIHVuZGVyXG4gICAqIGB0cmFuc3BvcnRQb3N0dXJlOiBub25lLXB1YmxpY2AsIHdoaWNoIGF0dGFjaGVzIG5vIE9BdXRoIHN1cmZhY2UuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEhcbiAgICovXG4gIHJlYWRvbmx5IHVwc3RyZWFtQ2FsbGJhY2tQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uLXN0YXRlIHRhYmxlIGNvbmZpZ3VyYXRpb24uIFRoZSB0YWJsZSBkZWZhdWx0cyBvbi5cbiAgICogQGRlZmF1bHQgZW5hYmxlZCB3aXRoIHByb2R1Y3Rpb24gZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25TdGF0ZT86IEFwcFRoZW9yeU1jcFNlc3Npb25TdGF0ZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE93bmVkLUFQSSBjb25maWd1cmF0aW9uIGZvciBzdGFuZGFsb25lIG1vZGUuIEludmFsaWQgd2l0aCBgYXBpYC5cbiAgICogQGRlZmF1bHQgcHJvZHVjdGlvbi1vd25lZCBBUEkgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IG93bmVkQXBpPzogQXBwVGhlb3J5TWNwU2VydmVyT3duZWRBcGlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTaW5nbGUgTUNQIHJvdXRlIHBhdGggZnJvbSB0aGUgdjMuMS54IEE2IHN1cmZhY2UuXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgcm91dGVGYW1pbHkucGF0dGVybnNgLiBUaGUgbmV3IGRlZmF1bHQgaXMgdGhlIGNhbm9uaWNhbFxuICAgKiBmb3VyLXBhdHRlcm4gZmFtaWx5OyB1c2UgYHsgcGF0dGVybnM6IFsnL21jcCddIH1gIGZvciB0aGUgb2xkIHNpbmdsZXRvbi5cbiAgICovXG4gIHJlYWRvbmx5IG1jcFBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEF1dGhvcml6YXRpb24tc2VydmVyIGlzc3VlciBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLklzc3VlclVSTGAgaW4gdGhlXG4gICAqIGFwcGxpY2F0aW9uLiBUaGUgY29uc3RydWN0IG5vIGxvbmdlciBpbmplY3RzIGlzc3VlciBlbnZpcm9ubWVudCB2YWx1ZXMuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBKV0tTIFVSSSBmcm9tIHRoZSB2My4xLnggQTYgZW52aXJvbm1lbnQgY29udHJhY3QuXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcnVudGltZS9tY3BmYWNhZGUuRmFjYWRlQ29uZmlnLkpXS1NVUklgIGluIHRoZVxuICAgKiBhcHBsaWNhdGlvbi4gVGhlIGNvbnN0cnVjdCBubyBsb25nZXIgaW5qZWN0cyBKV0tTIGVudmlyb25tZW50IHZhbHVlcy5cbiAgICovXG4gIHJlYWRvbmx5IGp3a3NVcmk/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgb3duZWRBcGkuYXBpTmFtZWAuICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0IGZvciB0aGUgb3duZWQgSFRUUCBBUEkuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgYWNjZXNzIGxvZyBncm91cCBpcyBuYW1lZFxuICAgKiBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGFuZCBjYXJyaWVzIHRoZSBjb250cmFjdCdzIEpTT04gZmllbGQgc2V0LlxuICAgKiBBY2Nlc3MgbG9nZ2luZyBhbHJlYWR5IGRlZmF1bHRzIG9uOyBwYXNzIGBvd25lZEFwaS5zdGFnZS5hY2Nlc3NMb2dnaW5nOlxuICAgKiBmYWxzZWAgdG8gb3B0IG91dC4gQXR0YWNoIG1vZGUgaWdub3JlcyB0aGlzIHByb3AuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBvd25lZCBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlblxuICAgKiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLmVuYWJsZWRgLiBTZXNzaW9uIHN0YXRlIG5vdyBkZWZhdWx0cyBvbi5cbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZT86IGJvb2xlYW47XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnRhYmxlTmFtZWAuICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgc2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNgLiAqL1xuICByZWFkb25seSBzZXNzaW9uVHRsTWludXRlcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5kb21haW5gLiBEb21haW5zIGFyZSBpbnZhbGlkIGluIGF0dGFjaCBtb2RlLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBvd25lZEFwaS5zdGFnZWAuIFN0YWdlIG9wdGlvbnMgYXJlIGludmFsaWQgaW4gYXR0YWNoIG1vZGUuXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1jcFNlcnZlclN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBDb250cmFjdC1maXJzdCBNQ1AgZmFjYWRlIGRlcGxveW1lbnQgY29uc3RydWN0LlxuICpcbiAqIFRoZSBwcmltYXJ5IG1vZGUgYXR0YWNoZXMgdGhlIGNvbXBsZXRlIHJvdXRlLWFsZ2VicmEgZmFtaWx5IHRvIGEgc3VwcGxpZWRcbiAqIEhUVFAgQVBJLiBPbWl0dGluZyBgYXBpYCBzcGVjaWFsaXplcyB0aGUgc2FtZSBwYXRoIGludG8gYSBzdGFuZGFsb25lIG93bmVkXG4gKiBBUEkuIFRoZSBjb25zdHJ1Y3Qgcm91dGVzIG9ubHk6IE9BdXRoIG1ldGFkYXRhLCBzY29wZXMsIGNhcGFiaWxpdGllcywgYW5kXG4gKiBhdXRob3JpemUvdG9rZW4gYmVoYXZpb3IgcmVtYWluIGFwcGxpY2F0aW9uLW93bmVkIHRocm91Z2ggR29cbiAqIGBtY3BmYWNhZGUuUmVnaXN0ZXJNQ1BGYWNhZGVgLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHJpdmF0ZSByb3V0ZVNlcXVlbmNlID0gMDtcbiAgcHJpdmF0ZSByb3V0ZUlkTW9kZSA9IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWTtcbiAgcHJpdmF0ZSByZWFkb25seSByb3V0ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgLyoqXG4gICAqIFJlc29sdmVkIHRyYW5zcG9ydC1yb3V0ZSBhdXRob3JpemF0aW9uIHBvc3R1cmUuXG4gICAqXG4gICAqIEZhY2FkZS1jb25maWd1cmVkIHNlcnZlcnMgcmVzb2x2ZSB0byBgcnVudGltZS1iZWFyZXJgIHVubGVzc1xuICAgKiBgdHJhbnNwb3J0UG9zdHVyZWAgb3ZlcnJpZGVzIHRoZSBkZWZhdWx0OyBwbGFpbiB0cmFuc3BvcnQgc2VydmVycyByZXNvbHZlXG4gICAqIHRvIGBpYW1gLiBEZWxpYmVyYXRlbHkgcHVibGljIHNlcnZlcnMgbXVzdCBzZWxlY3QgYG5vbmUtcHVibGljYCBleHBsaWNpdGx5LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHRyYW5zcG9ydFBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmU7XG4gIC8qKlxuICAgKiBEZXJpdmVkIGVuZHBvaW50IHRlbXBsYXRlcyBmb3IgdGhlIG9yZGVyZWQgTUNQIHJvdXRlIGZhbWlseS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgdGhlc2UgYXJlIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZXMsIG5vdCBkZWNsYXJhdGlvbnMgb2ZcbiAgICogcHVibGljIGF1dGhvcml0eS4gQW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkOyB0aGUgb3JpZ2luIGlzIGRlcml2ZWRcbiAgICogZnJvbSBgYXBpSWRgLCB0aGUgc3RhY2sgcmVnaW9uIGFuZCBVUkwgc3VmZml4LCBwbHVzXG4gICAqIGBhdHRhY2hlZEFwaVN0YWdlTmFtZWAgd2hlbiBzdXBwbGllZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgbWNwUGF0aHM6IHN0cmluZ1tdO1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzOiBzdHJpbmdbXTtcbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlSW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeTtcblxuICAvKipcbiAgICogRmlyc3QgZGVyaXZlZCBlbmRwb2ludCB0ZW1wbGF0ZS5cbiAgICpcbiAgICogSW4gYXR0YWNoIG1vZGUgYW4gYGFwaUVuZHBvaW50YCBzdXBwbGllZCB0aHJvdWdoXG4gICAqIGBIdHRwQXBpLmZyb21IdHRwQXBpQXR0cmlidXRlc2AgaXMgbmV2ZXIgY29uc3VsdGVkLiBUaGlzIHZhbHVlIGlzIGFuXG4gICAqIGV4ZWN1dGUtYXBpIG9yaWdpbiB0ZW1wbGF0ZSBkZXJpdmVkIGJ5IHRoZSBzYW1lIHJ1bGVzIGFzIGBlbmRwb2ludHNgLCBub3RcbiAgICogdGhlIGZyb250IGRvb3IncyBwdWJsaWMgYXV0aG9yaXR5LlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYGVuZHBvaW50c2AuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKiogQGRlcHJlY2F0ZWQgVXNlIGBtY3BQYXRoc2AuICovXG4gIHB1YmxpYyByZWFkb25seSBtY3BQYXRoOiBzdHJpbmc7XG5cbiAgLyoqIEBkZXByZWNhdGVkIFVzZSBgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGhzYCBvciBgcm91dGVJbnZlbnRvcnlgLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcHJvdGVjdGVkUmVzb3VyY2VNZXRhZGF0YVBhdGg6IHN0cmluZztcblxuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdGhlIGFwcC1vd25lZCBmcm9udCBkb29yIG11c3Qgc2VuZCBvbiBldmVyeSBvcmlnaW5cbiAgICogcmVxdWVzdCwgcHJlc2VudCBvbmx5IHVuZGVyIGBvcmlnaW5SZWFjaGFiaWxpdHk6IEZST05URURgLlxuICAgKlxuICAgKiBXaXJlIGl0IGludG8gdGhlIGRpc3RyaWJ1dGlvbiBvcmlnaW46XG4gICAqIGBvcmlnaW5zLkh0dHBPcmlnaW4oaG9zdCwgeyBjdXN0b21IZWFkZXJzOiB7IFtoLmhlYWRlck5hbWVdOiBoLmhlYWRlclZhbHVlIH0gfSlgLlxuICAgKiBVbmRlciB0aGUgcGFyYW1ldGVyIGZvcm0gYGhlYWRlclZhbHVlYCBpcyBhIGB7e3Jlc29sdmU6c3NtOi4uLn19YFxuICAgKiBDbG91ZEZvcm1hdGlvbiBkeW5hbWljIHJlZmVyZW5jZSwgc28gdGhlIHZhbHVlIG5ldmVyIGVudGVycyB0aGVcbiAgICogYXBwbGljYXRpb24gc291cmNlIG9yIHRoZSBjb25zdHJ1Y3QncyB0ZW1wbGF0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBmcm9udERvb3JPcmlnaW5IZWFkZXI/OiBBcHBUaGVvcnlNY3BGcm9udERvb3JIZWFkZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHZhbGlkYXRlT3duaW5nTW9kZShwcm9wcyk7XG4gICAgbm9ybWFsaXplTGVnYWN5QXV0aENvbmZpZyhwcm9wcyk7XG4gICAgY29uc3Qgcm91dGVGYW1pbHkgPSBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wcyk7XG4gICAgY29uc3Qgb3duZWRPcHRpb25zID0gbm9ybWFsaXplT3duZWRBcGlPcHRpb25zKHByb3BzKTtcblxuICAgIGNvbnN0IHBvc3R1cmUgPSBwcm9wcy50cmFuc3BvcnRQb3N0dXJlXG4gICAgICA/PyAocHJvcHMuZmFjYWRlICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgICAgIDogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU0pO1xuICAgIHZhbGlkYXRlVHJhbnNwb3J0UG9zdHVyZShwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQocHJvcHMuZmFjYWRlKTtcbiAgICB2YWxpZGF0ZVBvc3R1cmVHdWFyZHMocHJvcHMsIHJvdXRlRmFtaWx5LCBwb3N0dXJlKTtcbiAgICB2YWxpZGF0ZURlZmVuc2VJbkRlcHRoKHByb3BzLCBwb3N0dXJlLCBvd25lZE9wdGlvbnMpO1xuICAgIGNvbnN0IG9yaWdpblJlYWNoYWJpbGl0eSA9IHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkodGhpcywgcHJvcHMsIG93bmVkT3B0aW9ucyk7XG4gICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQpIHtcbiAgICAgICh0aGlzIGFzIHsgZnJvbnREb29yT3JpZ2luSGVhZGVyPzogQXBwVGhlb3J5TWNwRnJvbnREb29ySGVhZGVyIH0pLmZyb250RG9vck9yaWdpbkhlYWRlciA9XG4gICAgICAgIGZyb250RG9vck9yaWdpbkhlYWRlcihwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pO1xuICAgICAgZ3JhbnRGcm9udERvb3JQYXJhbWV0ZXJSZWFkKHRoaXMsIHByb3BzLmhhbmRsZXIsIHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgfVxuICAgIGNvbnN0IHJvdXRlTW9kZWwgPSByZXNvbHZlUm91dGVNb2RlbChwcm9wcyk7XG4gICAgdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShyb3V0ZU1vZGVsLCBwb3N0dXJlKTtcbiAgICBjb25zdCByb3V0ZUlkTW9kZSA9IHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wcyk7XG4gICAgdGhpcy5yb3V0ZUlkTW9kZSA9IHJvdXRlSWRNb2RlO1xuICAgIGlmIChyb3V0ZU1vZGVsID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRCAmJiBwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZCh0aGlzLCBwcm9wcy5hcGkpO1xuICAgIH1cbiAgICBjb25zdCBhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQgPSBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDO1xuICAgIGNvbnN0IHVwc3RyZWFtQ2FsbGJhY2tQYXRoID0gcmVzb2x2ZVVwc3RyZWFtQ2FsbGJhY2tQYXRoKHByb3BzKTtcblxuICAgIHRoaXMudHJhbnNwb3J0UG9zdHVyZSA9IHBvc3R1cmU7XG4gICAgdGhpcy5tY3BQYXRocyA9IFsuLi5yb3V0ZUZhbWlseS5wYXR0ZXJuc107XG4gICAgdGhpcy5yb3V0ZUludmVudG9yeSA9IGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gICAgICB0aGlzLm1jcFBhdGhzLFxuICAgICAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkLFxuICAgICAgcm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnksXG4gICAgICB1cHN0cmVhbUNhbGxiYWNrUGF0aCxcbiAgICApO1xuICAgIHZhbGlkYXRlUm91dGVJbnZlbnRvcnkodGhpcy5yb3V0ZUludmVudG9yeSwgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRocyA9IHRoaXMucm91dGVJbnZlbnRvcnkucm91dGVzLm1hcChcbiAgICAgIChyb3V0ZSkgPT4gcm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLFxuICAgICk7XG4gICAgdGhpcy5tY3BQYXRoID0gdGhpcy5tY3BQYXRoc1swXTtcbiAgICB0aGlzLnByb3RlY3RlZFJlc291cmNlTWV0YWRhdGFQYXRoID0gdGhpcy5wcm90ZWN0ZWRSZXNvdXJjZU1ldGFkYXRhUGF0aHNbMF07XG5cbiAgICBsZXQgb3duZWRTdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgbGV0IG93bmVkU3RhZ2VOYW1lID0gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChwcm9wcy5hcGkpIHtcbiAgICAgIHRoaXMuYXBpID0gcHJvcHMuYXBpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFnZU9wdGlvbnMgPSBub3JtYWxpemVTdGFnZU9wdGlvbnMob3duZWRPcHRpb25zLnN0YWdlKTtcbiAgICAgIG93bmVkU3RhZ2VOYW1lID0gc3RhZ2VPcHRpb25zLnN0YWdlTmFtZTtcbiAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgIGNvbnN0IHN0YW5kYXJkID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgICAgY29uc3QgYXBpTmFtZVByb3AgPSBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSAhPT0gdW5kZWZpbmVkID8gXCJvd25lZEFwaS5hcGlOYW1lXCIgOiBcImFwaU5hbWVcIjtcbiAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeU1jcFNlcnZlclwiLCBhcGlOYW1lUHJvcCwgXCJhcGlfaHR0cFwiLCBsb2dpY2FsLCBvd25lZE9wdGlvbnMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXJcIixcbiAgICAgICAgXCJzZXNzaW9uU3RhdGUudGFibGVOYW1lXCIsXG4gICAgICAgIFwiZHluYW1vZGJfdGFibGVcIixcbiAgICAgICAgbG9naWNhbCA/IGAke2xvZ2ljYWx9LXNlc3Npb25zYCA6IHVuZGVmaW5lZCxcbiAgICAgICAgcHJvcHMuc2Vzc2lvblN0YXRlPy50YWJsZU5hbWUgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWQsXG4gICAgICApO1xuICAgICAgY29uc3QgZGVyaXZlZEFwaU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV9odHRwXCIsIGxvZ2ljYWwpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogb3duZWRPcHRpb25zLmFwaU5hbWUsXG4gICAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiBmYWxzZSxcbiAgICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAgICAgICB8fCBvcmlnaW5SZWFjaGFiaWxpdHkgPT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAgICAgICA/IHRydWVcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBvd25lZEFwaT86IGFwaWd3djIuSHR0cEFwaSB9KS5vd25lZEFwaSA9IGFwaTtcbiAgICAgIHRoaXMuYXBpID0gYXBpO1xuICAgICAgaWYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWREaXNhYmxlZE9yaWdpblZhbGlkYXRpb24odGhpcywgYXBpKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IGFwaSxcbiAgICAgICAgc3RhZ2VOYW1lOiBzdGFnZU9wdGlvbnMuc3RhZ2VOYW1lLFxuICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICB0aHJvdHRsZTogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdFbmFibGVkXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0aW9ucy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRpb25zLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgICAgb3duZWRTdGFnZSA9IHN0YWdlO1xuXG4gICAgICBpZiAoc3RhZ2VPcHRpb25zLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgICAgaWYgKHN0YW5kYXJkICYmICFsb2dpY2FsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwU2VydmVyIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlclxuICAgICAgICAvLyB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpdCB0YWtlcyB0aGUgY29udHJhY3QgbG9nLXNvdXJjZSBuYW1lLCBhbmQgdW5kZXJcbiAgICAgICAgLy8gdGhlIGxlZ2FjeSBwcm9maWxlIGl0IGtlZXBzIHRvZGF5J3MgQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIG5hbWUgYW5kXG4gICAgICAgIC8vIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgICBjb25zdCBsb2dHcm91cCA9IHN0YW5kYXJkICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBuYW1pbmdDb250ZXh0LmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gKSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0aW9ucy5hY2Nlc3NMb2dSZXRlbnRpb24sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogc3RhbmRhcmQgPyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0KCkgOiBhY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgIFwiTWNwSGFuZGxlclwiLFxuICAgICAgcHJvcHMuaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBjb25zdCB0cmFuc3BvcnRBdXRob3JpemVyID0gcmVzb2x2ZVRyYW5zcG9ydEF1dGhvcml6ZXIocHJvcHMsIHBvc3R1cmUpO1xuICAgIGxldCBmaXJzdFRyYW5zcG9ydFJvdXRlOiBhcGlnd3YyLkh0dHBSb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAocm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURUQpIHtcbiAgICAgIGZpcnN0VHJhbnNwb3J0Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUk9PVF9ST1VURV9JRCxcbiAgICAgICAgXCIvXCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHByb3h5Um91dGUgPSB0aGlzLmFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgICAgICBDT05TT0xJREFURURfUFJPWFlfUk9VVEVfSUQsXG4gICAgICAgIFwiL3twcm94eSt9XCIsXG4gICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgKTtcbiAgICAgIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbih0aGlzLCB0aGlzLmFwaSwgW2ZpcnN0VHJhbnNwb3J0Um91dGUsIHByb3h5Um91dGVdKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcnVudGltZU93bmVkQXV0aCA9IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgICAgZm9yIChjb25zdCByb3V0ZSBvZiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcykge1xuICAgICAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiByb3V0ZS5tY3BNZXRob2RzKSB7XG4gICAgICAgICAgY29uc3QgY3JlYXRlZCA9IHRoaXMuYWRkUnVudGltZVJvdXRlKFxuICAgICAgICAgICAgcm91dGUubWNwUGF0dGVybixcbiAgICAgICAgICAgIHRvSHR0cE1ldGhvZChtZXRob2QpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgICB0cmFuc3BvcnRBdXRob3JpemVyLFxuICAgICAgICAgICk7XG4gICAgICAgICAgZmlyc3RUcmFuc3BvcnRSb3V0ZSA9IGZpcnN0VHJhbnNwb3J0Um91dGUgPz8gY3JlYXRlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUucHJvdGVjdGVkUmVzb3VyY2VQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUuZGlzY292ZXJ5Q2Fub25pY2FsUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4sIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShyb3V0ZS5hdXRob3JpemVQYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBpbnRlZ3JhdGlvbiwgcnVudGltZU93bmVkQXV0aCk7XG4gICAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUocm91dGUudG9rZW5QYXR0ZXJuLCBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgaW50ZWdyYXRpb24sIHJ1bnRpbWVPd25lZEF1dGgpO1xuICAgICAgICAgIHRoaXMuYWRkUnVudGltZVJvdXRlKHJvdXRlLnJlZ2lzdGVyUGF0dGVybiwgYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIGludGVncmF0aW9uLCBydW50aW1lT3duZWRBdXRoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIHVwc3RyZWFtIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgbm90IHBlciBraW5kOiB3aXJlIGl0IGV4YWN0bHkgb25jZS5cbiAgICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgICAgdGhpcy5hZGRSdW50aW1lUm91dGUoXG4gICAgICAgICAgdGhpcy5yb3V0ZUludmVudG9yeS5jYWxsYmFja1BhdHRlcm4sXG4gICAgICAgICAgYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBydW50aW1lT3duZWRBdXRoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMucm91dGVJbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgICAgICB0aGlzLmFkZFJ1bnRpbWVSb3V0ZShcbiAgICAgICAgICB0aGlzLnJvdXRlSW52ZW50b3J5LnJvb3RBdXRob3JpemF0aW9uU2VydmVyUGF0dGVybixcbiAgICAgICAgICBhcGlnd3YyLkh0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIHJ1bnRpbWVPd25lZEF1dGgsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcG9zdHVyZU1hcmtlclRhcmdldCA9ICh0aGlzLm93bmVkQXBpPy5ub2RlLmRlZmF1bHRDaGlsZFxuICAgICAgPz8gZmlyc3RUcmFuc3BvcnRSb3V0ZT8ubm9kZS5kZWZhdWx0Q2hpbGQpIGFzIGFwaWd3djIuQ2ZuQXBpIHwgYXBpZ3d2Mi5DZm5Sb3V0ZSB8IHVuZGVmaW5lZDtcbiAgICBwb3N0dXJlTWFya2VyVGFyZ2V0Py5hZGRNZXRhZGF0YShNQ1BfVFJBTlNQT1JUX1BPU1RVUkVfTUVUQURBVEFfS0VZLCB7XG4gICAgICBwb3N0dXJlLFxuICAgICAgY29udHJhY3RfaWQ6IE1DUF9UUkFOU1BPUlRfUE9TVFVSRV9DT05UUkFDVF9JRCxcbiAgICAgIHJvdXRlX2NvdW50OiB0aGlzLnJvdXRlSW52ZW50b3J5LnJvdXRlcy5sZW5ndGgsXG4gICAgICBydW50aW1lX3Bvc3R1cmVfZGVjbGFyZWQ6IHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQsXG4gICAgICAvLyBPbmx5IGEgRlJPTlRFRCBkZWNpc2lvbiBleHRlbmRzIHRoZSBtYXJrZXIsIHNvIERJU0FCTEVEIGFuZCBMT0NLRURcbiAgICAgIC8vIHRlbXBsYXRlcyBzdGF5IGJ5dGUtaWRlbnRpY2FsLiBUaGUgbGl0ZXJhbCBzZWNyZXQgaXMgY29uc3VtZWQgaGVyZSBmb3JcbiAgICAgIC8vIGl0cyBkaWdlc3QgYW5kIG5ldmVyIGVtaXR0ZWQuXG4gICAgICAuLi4ob3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRFxuICAgICAgICA/IGZyb250RG9vclBvc3R1cmVNZXRhZGF0YShwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24pXG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvblN0YXRlID0gbm9ybWFsaXplU2Vzc2lvblN0YXRlKHByb3BzKTtcbiAgICBpZiAoc2Vzc2lvblN0YXRlLmVuYWJsZWQpIHtcbiAgICAgIC8vIE9ubHkgYW4gb3duZWQgQVBJIGRlcml2ZXMgdGhlIHNlc3Npb24tdGFibGUgbmFtZS4gVGhlIHNlY3VyZS1kZWZhdWx0XG4gICAgICAvLyBkZWNpc2lvbiBpcyBzZXBhcmF0ZTogYW4gYXR0YWNoZWQgQVBJIHN0aWxsIHJlY2VpdmVzIHRoZSBkZWxldGlvblxuICAgICAgLy8gcHJvdGVjdGlvbiAoRHluYW1vREIuNikgdGhhdCB0aGUgQXBwVGhlb3J5LWNyZWF0ZWQgdGFibGUgbmVlZHMuXG4gICAgICBjb25zdCBzZXNzaW9uTmFtaW5nQ29udGV4dCA9IHByb3BzLmFwaSA/IHVuZGVmaW5lZCA6IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICBjb25zdCBsb2dpY2FsID0gc2Vzc2lvbk5hbWluZ0NvbnRleHRcbiAgICAgICAgPyBwcm9wcy5sb2dpY2FsTmFtZSA/PyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcylcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBkZXJpdmVkVGFibGVOYW1lID0gc2Vzc2lvbk5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICA/IHNlc3Npb25OYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImR5bmFtb2RiX3RhYmxlXCIsIGAke2xvZ2ljYWx9LXNlc3Npb25zYClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCB0YWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogZGVyaXZlZFRhYmxlTmFtZSAmJiAhZGVyaXZlZFRhYmxlTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkVGFibGVOYW1lLm5hbWUgOiBzZXNzaW9uU3RhdGUudGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogc2Vzc2lvblN0YXRlLnJlbW92YWxQb2xpY3ksXG4gICAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgICAgICAgICBwcm9wcy5uYW1pbmdDb250ZXh0LFxuICAgICAgICAgIHNlc3Npb25TdGF0ZS5yZW1vdmFsUG9saWN5LFxuICAgICAgICAgIHNlc3Npb25TdGF0ZS5kZWxldGlvblByb3RlY3Rpb24sXG4gICAgICAgICksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0YWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhzZXNzaW9uU3RhdGUudHRsTWludXRlcykpO1xuICAgIH1cblxuICAgIGxldCBlbmRwb2ludEJhc2U6IHN0cmluZztcbiAgICBpZiAob3duZWRPcHRpb25zLmRvbWFpbikge1xuICAgICAgaWYgKCFvd25lZFN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogZG9tYWluIGNvbmZpZ3VyYXRpb24gcmVxdWlyZXMgY29uc3RydWN0LW93bmVkIEFQSSBtb2RlXCIpO1xuICAgICAgfVxuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihvd25lZE9wdGlvbnMuZG9tYWluLCBvd25lZFN0YWdlLCBwcm9wcy5hcGkgPyB1bmRlZmluZWQgOiBwcm9wcy5uYW1pbmdDb250ZXh0KTtcbiAgICAgIGlmIChcbiAgICAgICAgb3JpZ2luUmVhY2hhYmlsaXR5ID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICAgICAgICYmIHRoaXMub3duZWRBcGkgIT09IHVuZGVmaW5lZFxuICAgICAgKSB7XG4gICAgICAgIHJlZ2lzdGVyT3duZWRMb2NrZWRPcmlnaW5WYWxpZGF0aW9uKHRoaXMsIHRoaXMub3duZWRBcGkpO1xuICAgICAgfVxuICAgICAgZW5kcG9pbnRCYXNlID0gYGh0dHBzOi8vJHtvd25lZE9wdGlvbnMuZG9tYWluLmRvbWFpbk5hbWV9YDtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmFwaSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcbiAgICAgIGNvbnN0IGV4ZWN1dGVBcGlPcmlnaW4gPSBgaHR0cHM6Ly8ke3RoaXMuYXBpLmFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgICAgIGVuZHBvaW50QmFzZSA9IHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lID09PSB1bmRlZmluZWQgfHwgcHJvcHMuYXR0YWNoZWRBcGlTdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IGV4ZWN1dGVBcGlPcmlnaW5cbiAgICAgICAgOiBgJHtleGVjdXRlQXBpT3JpZ2lufS8ke3Byb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuZHBvaW50QmFzZSA9IG93bmVkU3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke293bmVkU3RhZ2VOYW1lfWA7XG4gICAgfVxuICAgIHRoaXMuZW5kcG9pbnRzID0gdGhpcy5tY3BQYXRocy5tYXAoXG4gICAgICAocGF0dGVybikgPT4gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGVuZHBvaW50QmFzZSl9JHtwYXR0ZXJufWAsXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICBwcm9wcy5hcGkgPT09IHVuZGVmaW5lZFxuICAgICAgJiYgKG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgICAgIHx8IG9yaWdpblJlYWNoYWJpbGl0eSA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRClcbiAgICAgICYmIHRoaXMuZW5kcG9pbnRzLnNvbWUoKGVuZHBvaW50KSA9PiBlbmRwb2ludC5pbmNsdWRlcyhcIi5leGVjdXRlLWFwaS5cIikpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgbXVzdCBhZHZlcnRpc2UgdGhlIG93bmVkIGN1c3RvbSBkb21haW4sIG5ldmVyIHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5lbmRwb2ludCA9IHRoaXMuZW5kcG9pbnRzWzBdO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSdW50aW1lUm91dGUoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCB0aGlzLm5leHRSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcGF0aCksIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocGF0aCwgbWV0aG9kKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgbmV4dFJvdXRlQ29uc3RydWN0SWQobWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QsIHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHRoaXMucm91dGVJZE1vZGUgIT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDKSB7XG4gICAgICByZXR1cm4gYFJvdXRlJHt0aGlzLnJvdXRlU2VxdWVuY2UrK31gO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHBhdGgpO1xuICAgIGlmICh0aGlzLnJvdXRlSWRzLmhhcyhpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgc2VtYW50aWMgZGVyaXZlcyB0aGUgZHVwbGljYXRlIHJvdXRlIGNvbnN0cnVjdCBpZCAke2lkfSBmb3Igcm91dGUga2V5ICR7bWV0aG9kfSAke3BhdGh9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHRoaXMucm91dGVJZHMuYWRkKGlkKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnNvbGlkYXRlZFJvdXRlKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIGludGVncmF0aW9uOiBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbixcbiAgICBhdXRob3JpemVyOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyLFxuICApOiBhcGlnd3YyLkh0dHBSb3V0ZSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCBpZCwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChwYXRoLCBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZKSxcbiAgICAgIGludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkRW52aXJvbm1lbnQoaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbiwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoXCJhZGRFbnZpcm9ubWVudFwiIGluIGhhbmRsZXIgJiYgdHlwZW9mIGhhbmRsZXIuYWRkRW52aXJvbm1lbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgaGFuZGxlci5hZGRFbnZpcm9ubWVudChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwQ3VzdG9tRG9tYWluKFxuICAgIG9wdGlvbnM6IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICAgIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IG5ldyBhcGlnd3YyLkRvbWFpbk5hbWUodGhpcywgXCJEb21haW5OYW1lXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgbXRsczogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBvcHRpb25zLnNlY3VyaXR5UG9saWN5XG4gICAgICAgID8/IChzZWN1cmVEZWZhdWx0cyhuYW1pbmdDb250ZXh0KSA/IFJFQ09NTUVOREVEX0hUVFBfQVBJX1NFQ1VSSVRZX1BPTElDWSA6IHVuZGVmaW5lZCksXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkb21haW5OYW1lO1xuICAgIGNvbnN0IGFwaU1hcHBpbmcgPSBuZXcgYXBpZ3d2Mi5BcGlNYXBwaW5nKHRoaXMsIFwiQXBpTWFwcGluZ1wiLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgZG9tYWluTmFtZSxcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gYXBpTWFwcGluZztcbiAgICBpZiAob3B0aW9ucy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCBjbmFtZVJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHRvUm91dGU1M1JlY29yZE5hbWUob3B0aW9ucy5kb21haW5OYW1lLCBvcHRpb25zLmhvc3RlZFpvbmUpLFxuICAgICAgICBkb21haW5OYW1lOiBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSBjbmFtZVJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRSb3V0ZUZhbWlseSB7XG4gIHJlYWRvbmx5IHBhdHRlcm5zOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3Zlcnk6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5TWNwU2VydmVyRG9tYWluT3B0aW9ucztcbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnM7XG59XG5cbmludGVyZmFjZSBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc6IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSB0aHJvdHRsaW5nRW5hYmxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdDogbnVtYmVyO1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIHJlYWRvbmx5IGVuYWJsZWQ6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgdHRsTWludXRlczogbnVtYmVyO1xuICByZWFkb25seSByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBkZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZUZhbWlseShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkUm91dGVGYW1pbHkge1xuICBpZiAocHJvcHMucm91dGVGYW1pbHkgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5tY3BQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkgYW5kIGRlcHJlY2F0ZWQgbWNwUGF0aCBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJhd1BhdHRlcm5zID0gcHJvcHMucm91dGVGYW1pbHk/LnBhdHRlcm5zXG4gICAgPz8gKHByb3BzLm1jcFBhdGggIT09IHVuZGVmaW5lZFxuICAgICAgPyBbcHJvcHMubWNwUGF0aF1cbiAgICAgIDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWFwKFxuICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICApKTtcbiAgaWYgKHJhd1BhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVGYW1pbHkucGF0dGVybnMgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgY29uc3QgcGF0dGVybnMgPSByYXdQYXR0ZXJucy5tYXAoKHBhdHRlcm4sIGluZGV4KSA9PlxuICAgIG5vcm1hbGl6ZVJvdXRlUGF0aChwYXR0ZXJuLCBgcm91dGVGYW1pbHkucGF0dGVybnNbJHtpbmRleH1dYCkpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgIGlmIChzZWVuLmhhcyhwYXR0ZXJuKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZUZhbWlseS5wYXR0ZXJucyBjb250YWlucyBkdXBsaWNhdGUgcGF0dGVybiAke0pTT04uc3RyaW5naWZ5KHBhdHRlcm4pfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBzZWVuLmFkZChwYXR0ZXJuKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHBhdHRlcm5zLFxuICAgIHJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5OlxuICAgICAgcHJvcHMucm91dGVGYW1pbHk/LnJvb3RBdXRob3JpemF0aW9uU2VydmVyRGlzY292ZXJ5ID8/IGZhbHNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSb3V0ZVBhdGgodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhIHN5bnRoZXNpcy10aW1lIGxpdGVyYWwgcm91dGUgcGF0dGVybmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIik7XG4gIGlmICghcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgY29uc3Qgc2VnbWVudHMgPSByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAwIHx8IHNlZ21lbnRzLnNvbWUoKHNlZ21lbnQpID0+IHNlZ21lbnQgPT09IFwiXCIpKSB7XG4gICAgdGhyb3cgaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZSk7XG4gIH1cbiAgY29uc3QgbGl0ZXJhbCA9IC9eKD86W0EtWmEtejAtOS5ffiEkJicoKSorLDs9OkAtXXwlWzAtOUEtRmEtZl17Mn0pKyQvO1xuICBjb25zdCBwYXJhbWV0ZXIgPSAvXlxceyhbQS1aYS16X11bQS1aYS16MC05X10qKVxcfSQvO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygc2VnbWVudHMpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICBpZiAocGFyYW1ldGVyLnRlc3Qoc2VnbWVudCkpIGNvbnRpbnVlO1xuICAgIGlmICghbGl0ZXJhbC50ZXN0KHNlZ21lbnQpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ7XCIpIHx8IHNlZ21lbnQuaW5jbHVkZXMoXCJ9XCIpKSB7XG4gICAgICB0aHJvdyBpbnZhbGlkUm91dGVQYXR0ZXJuKHByb3BOYW1lKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJvdXRlUGF0dGVybihwcm9wTmFtZTogc3RyaW5nKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYW4gYWJzb2x1dGUgc3ludGhlc2lzLXRpbWUgcm91dGUgcGF0dGVybiB3aXRoIG5vbi1lbXB0eSBsaXRlcmFsIG9yIHtwYXJhbWV0ZXJfbmFtZX0gc2VnbWVudHMgYW5kIG5vIGRvdCBzZWdtZW50c2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVVcHN0cmVhbUNhbGxiYWNrUGF0aChwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBzdHJpbmcge1xuICBjb25zdCBjb25maWd1cmVkID0gcHJvcHMudXBzdHJlYW1DYWxsYmFja1BhdGg7XG4gIGlmIChjb25maWd1cmVkID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSDtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGNvbmZpZ3VyZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVwc3RyZWFtQ2FsbGJhY2tQYXRoIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHJvdXRlIHBhdGhcIixcbiAgICApO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChjb25maWd1cmVkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgcmVhc29uID0gZXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgID8gZXJyLm1lc3NhZ2UucmVwbGFjZSgvXm1jcHJvdXRlczogLywgXCJcIilcbiAgICAgIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogdXBzdHJlYW1DYWxsYmFja1BhdGggaXMgaW52YWxpZDogJHtyZWFzb259YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUm91dGVJbnZlbnRvcnkoXG4gIHBhdHRlcm5zOiBzdHJpbmdbXSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkOiBib29sZWFuLFxuICBjYWxsYmFja1BhdHRlcm46IHN0cmluZyxcbik6IEFwcFRoZW9yeU1jcFNlcnZlclJvdXRlSW52ZW50b3J5IHtcbiAgcmV0dXJuIHtcbiAgICBjb250cmFjdFZlcnNpb246IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5DT05UUkFDVF9WRVJTSU9OLFxuICAgIHJvdXRlczogcGF0dGVybnMubWFwKChtY3BQYXR0ZXJuKSA9PiAoe1xuICAgICAgbWNwUGF0dGVybixcbiAgICAgIG1jcE1ldGhvZHM6IFtcIlBPU1RcIiwgXCJHRVRcIiwgXCJERUxFVEVcIl0sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlDYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBkaXNjb3ZlcnlTdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgobWNwUGF0dGVybiksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdHRlcm4pLFxuICAgICAgcmVnaXN0ZXJQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChtY3BQYXR0ZXJuKSxcbiAgICAgIGF1dGhvcml6YXRpb25Sb3V0ZXNBdHRhY2hlZCxcbiAgICB9KSksXG4gICAgcm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuOlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFwiL1wiKSxcbiAgICByb290QXV0aG9yaXphdGlvblNlcnZlckF0dGFjaGVkLFxuICAgIGNhbGxiYWNrUGF0dGVybixcbiAgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZUludmVudG9yeShcbiAgaW52ZW50b3J5OiBBcHBUaGVvcnlNY3BTZXJ2ZXJSb3V0ZUludmVudG9yeSxcbiAgYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkOiBib29sZWFuLFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgYWRkID0gKG1ldGhvZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHttZXRob2R9ICR7cGF0aH1gO1xuICAgIGlmIChzZWVuLmhhcyhrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogZGVyaXZlZCByb3V0ZSBmYW1pbHkgY29sbGlkZXMgYXQgJHtrZXl9YCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGtleSk7XG4gIH07XG4gIGZvciAoY29uc3Qgcm91dGUgb2YgaW52ZW50b3J5LnJvdXRlcykge1xuICAgIGZvciAoY29uc3QgbWV0aG9kIG9mIHJvdXRlLm1jcE1ldGhvZHMpIGFkZChtZXRob2QsIHJvdXRlLm1jcFBhdHRlcm4pO1xuICAgIGlmIChhdXRob3JpemF0aW9uUm91dGVzQXR0YWNoZWQpIHtcbiAgICAgIGFkZChcIkdFVFwiLCByb3V0ZS5wcm90ZWN0ZWRSZXNvdXJjZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeUNhbm9uaWNhbFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmRpc2NvdmVyeVN1ZmZpeFBhdHRlcm4pO1xuICAgICAgYWRkKFwiR0VUXCIsIHJvdXRlLmF1dGhvcml6ZVBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS50b2tlblBhdHRlcm4pO1xuICAgICAgYWRkKFwiUE9TVFwiLCByb3V0ZS5yZWdpc3RlclBhdHRlcm4pO1xuICAgIH1cbiAgfVxuICBpZiAoYXV0aG9yaXphdGlvblJvdXRlc0F0dGFjaGVkKSB7XG4gICAgYWRkKFwiR0VUXCIsIGludmVudG9yeS5jYWxsYmFja1BhdHRlcm4pO1xuICB9XG4gIGlmIChpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJBdHRhY2hlZCkge1xuICAgIGFkZChcIkdFVFwiLCBpbnZlbnRvcnkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJQYXR0ZXJuKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ01vZGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGlmICghcHJvcHMuYXBpKSB7XG4gICAgaWYgKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIHJlcXVpcmVzIGF0dGFjaCBtb2RlIHdpdGggYXBpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lICE9PSB1bmRlZmluZWRcbiAgICAmJiAoVG9rZW4uaXNVbnJlc29sdmVkKHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKVxuICAgICAgfHwgIS9eKD86XFwkZGVmYXVsdHxbQS1aYS16MC05Xy1dezEsMTI4fSkkLy50ZXN0KHByb3BzLmF0dGFjaGVkQXBpU3RhZ2VOYW1lKSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGF0dGFjaGVkQXBpU3RhZ2VOYW1lIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIEFQSSBHYXRld2F5IHN0YWdlIG5hbWVcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9wcy5vd25lZEFwaSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJvd25lZEFwaVwiKTtcbiAgaWYgKHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiYXBpTmFtZVwiKTtcbiAgaWYgKHByb3BzLmNvcnMgIT09IHVuZGVmaW5lZCkgaW52YWxpZC5wdXNoKFwiY29yc1wiKTtcbiAgaWYgKHByb3BzLmRvbWFpbiAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJkb21haW5cIik7XG4gIGlmIChwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSBpbnZhbGlkLnB1c2goXCJzdGFnZVwiKTtcbiAgaWYgKGludmFsaWQubGVuZ3RoICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYXR0YWNoIG1vZGUgd2l0aCBhcGkgY2Fubm90IGNvbmZpZ3VyZSBvd25lZC1BUEkgcHJvcHM6ICR7aW52YWxpZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU93bmVkQXBpT3B0aW9ucyhwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBOb3JtYWxpemVkT3duZWRBcGlPcHRpb25zIHtcbiAgaWYgKHByb3BzLm93bmVkQXBpPy5hcGlOYW1lICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmFwaU5hbWUgYW5kIGRlcHJlY2F0ZWQgYXBpTmFtZSBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uZG9tYWluICE9PSB1bmRlZmluZWQgJiYgcHJvcHMuZG9tYWluICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3duZWRBcGkuZG9tYWluIGFuZCBkZXByZWNhdGVkIGRvbWFpbiBjYW5ub3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmIChwcm9wcy5vd25lZEFwaT8uc3RhZ2UgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5zdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIGFuZCBkZXByZWNhdGVkIHN0YWdlIGNhbm5vdCBiZSBzdXBwbGllZCB0b2dldGhlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhcGlOYW1lOiBwcm9wcy5vd25lZEFwaT8uYXBpTmFtZSA/PyBwcm9wcy5hcGlOYW1lLFxuICAgIGRvbWFpbjogcHJvcHMub3duZWRBcGk/LmRvbWFpbiA/PyBwcm9wcy5kb21haW4sXG4gICAgc3RhZ2U6IHByb3BzLm93bmVkQXBpPy5zdGFnZSA/PyBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VPcHRpb25zKG9wdGlvbnM/OiBBcHBUaGVvcnlNY3BTZXJ2ZXJTdGFnZU9wdGlvbnMpOiBOb3JtYWxpemVkU3RhZ2VPcHRpb25zIHtcbiAgY29uc3QgYWNjZXNzTG9nZ2luZyA9IG9wdGlvbnM/LmFjY2Vzc0xvZ2dpbmcgPz8gdHJ1ZTtcbiAgaWYgKCFhY2Nlc3NMb2dnaW5nICYmIG9wdGlvbnM/LmFjY2Vzc0xvZ1JldGVudGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlLmFjY2Vzc0xvZ1JldGVudGlvbiByZXF1aXJlcyBhY2Nlc3NMb2dnaW5nIHRvIGJlIGVuYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmdFbmFibGVkID0gb3B0aW9ucz8udGhyb3R0bGluZ0VuYWJsZWQgPz8gdHJ1ZTtcbiAgaWYgKFxuICAgICF0aHJvdHRsaW5nRW5hYmxlZFxuICAgICYmIChvcHRpb25zPy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgb3B0aW9ucz8udGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLnN0YWdlIHRocm90dGxpbmcgbGltaXRzIHJlcXVpcmUgdGhyb3R0bGluZ0VuYWJsZWQgdG8gYmUgdHJ1ZVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmF0ZUxpbWl0ID0gb3B0aW9ucz8udGhyb3R0bGluZ1JhdGVMaW1pdCA/PyBERUZBVUxUX1RIUk9UVExJTkdfUkFURV9MSU1JVDtcbiAgY29uc3QgYnVyc3RMaW1pdCA9IG9wdGlvbnM/LnRocm90dGxpbmdCdXJzdExpbWl0ID8/IERFRkFVTFRfVEhST1RUTElOR19CVVJTVF9MSU1JVDtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihyYXRlTGltaXQsIFwib3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ1JhdGVMaW1pdFwiKTtcbiAgdmFsaWRhdGVQb3NpdGl2ZU51bWJlcihidXJzdExpbWl0LCBcIm93bmVkQXBpLnN0YWdlLnRocm90dGxpbmdCdXJzdExpbWl0XCIpO1xuICByZXR1cm4ge1xuICAgIHN0YWdlTmFtZTogb3B0aW9ucz8uc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIixcbiAgICBhY2Nlc3NMb2dnaW5nLFxuICAgIGFjY2Vzc0xvZ1JldGVudGlvbjogb3B0aW9ucz8uYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgdGhyb3R0bGluZ0VuYWJsZWQsXG4gICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogcmF0ZUxpbWl0LFxuICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiBidXJzdExpbWl0LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uU3RhdGUocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogTm9ybWFsaXplZFNlc3Npb25TdGF0ZSB7XG4gIGNvbnN0IGhhc0xlZ2FjeSA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgfHwgcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXMgIT09IHVuZGVmaW5lZDtcbiAgaWYgKHByb3BzLnNlc3Npb25TdGF0ZSAhPT0gdW5kZWZpbmVkICYmIGhhc0xlZ2FjeSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBzZXNzaW9uU3RhdGUgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggZGVwcmVjYXRlZCBzZXNzaW9uLXRhYmxlIHByb3BzXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbmFibGVkID0gcHJvcHMuc2Vzc2lvblN0YXRlPy5lbmFibGVkID8/IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZSA/PyB0cnVlO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnRhYmxlTmFtZSA/PyBwcm9wcy5zZXNzaW9uVGFibGVOYW1lO1xuICBjb25zdCB0dGxNaW51dGVzID0gcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzXG4gICAgPz8gcHJvcHMuc2Vzc2lvblR0bE1pbnV0ZXNcbiAgICA/PyBERUZBVUxUX1NFU1NJT05fVFRMX01JTlVURVM7XG4gIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uU3RhdGU/LnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gIGlmIChcbiAgICAhZW5hYmxlZFxuICAgICYmICh0YWJsZU5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgcHJvcHMuc2Vzc2lvblN0YXRlPy50dGxNaW51dGVzICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25TdGF0ZT8ucmVtb3ZhbFBvbGljeSAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uU3RhdGU/LmRlbGV0aW9uUHJvdGVjdGlvbiAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb3BzLnNlc3Npb25UdGxNaW51dGVzICE9PSB1bmRlZmluZWQpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBkaXNhYmxlZCBzZXNzaW9uIHN0YXRlIGNhbm5vdCBjb25maWd1cmUgdGFibGVOYW1lLCB0dGxNaW51dGVzLCByZW1vdmFsUG9saWN5LCBvciBkZWxldGlvblByb3RlY3Rpb25cIixcbiAgICApO1xuICB9XG4gIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHR0bE1pbnV0ZXMsIFwic2Vzc2lvblN0YXRlLnR0bE1pbnV0ZXNcIik7XG4gIHJldHVybiB7XG4gICAgZW5hYmxlZCxcbiAgICB0YWJsZU5hbWUsXG4gICAgdHRsTWludXRlcyxcbiAgICByZW1vdmFsUG9saWN5LFxuICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuc2Vzc2lvblN0YXRlPy5kZWxldGlvblByb3RlY3Rpb24sXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxlZ2FjeUF1dGhDb25maWcocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogdm9pZCB7XG4gIGNvbnN0IGhhc0lzc3VlciA9IHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzSndrc1VyaSA9IHByb3BzLmp3a3NVcmkgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0lzc3VlciAhPT0gaGFzSndrc1VyaSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpIG11c3QgYmUgc3VwcGxpZWQgdG9nZXRoZXJcIixcbiAgICApO1xuICB9XG4gIGlmICghaGFzSXNzdWVyIHx8ICFoYXNKd2tzVXJpKSByZXR1cm47XG4gIGNvbnN0IGlzc3VlciA9IFN0cmluZyhwcm9wcy5hdXRob3JpemF0aW9uU2VydmVySXNzdWVyKTtcbiAgY29uc3Qgandrc1VyaSA9IFN0cmluZyhwcm9wcy5qd2tzVXJpKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKFxuICAgICAgaXNzdWVyLFxuICAgICAgZmFsc2UsXG4gICAgICBcImF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgbXVzdCBiZSBhbiBhYnNvbHV0ZSBIVFRQUyBVUkwgd2l0aCBubyBxdWVyeSBvciBmcmFnbWVudFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoandrc1VyaSkpIHtcbiAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgIGp3a3NVcmksXG4gICAgICB0cnVlLFxuICAgICAgXCJqd2tzVXJpIG11c3QgYmUgYW4gYWJzb2x1dGUgSFRUUFMgVVJMIHdpdGggbm8gdXNlcmluZm8gb3IgZnJhZ21lbnRcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVUcmFuc3BvcnRBdXRob3JpemVyKFxuICBwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMsXG4gIHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUsXG4pOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgY29uc3QgY29uZmlndXJlZCA9IHByb3BzLnRyYW5zcG9ydEF1dGhvcml6ZXI7XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU06XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQzoge1xuICAgICAgaWYgKGNvbmZpZ3VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIgaXMgb25seSB2YWxpZCB3aXRoIHRyYW5zcG9ydFBvc3R1cmUgSldUXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcG9zdHVyZSA9PT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5JQU1cbiAgICAgICAgPyBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKClcbiAgICAgICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICB9XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLkpXVDoge1xuICAgICAgY29uc3QgaXNzdWVyID0gU3RyaW5nKGNvbmZpZ3VyZWQ/Lmlzc3VlciA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoaXNzdWVyID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogdHJhbnNwb3J0QXV0aG9yaXplci5pc3N1ZXIgaXMgcmVxdWlyZWQgd2hlbiB0cmFuc3BvcnRQb3N0dXJlIGlzIEpXVFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoaXNzdWVyKSkge1xuICAgICAgICB2YWxpZGF0ZUxpdGVyYWxPQXV0aFVSTChcbiAgICAgICAgICBpc3N1ZXIsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgXCJ0cmFuc3BvcnRBdXRob3JpemVyLmlzc3VlciBtdXN0IGJlIGFuIGFic29sdXRlIEhUVFBTIFVSTCB3aXRoIG5vIHF1ZXJ5IG9yIGZyYWdtZW50XCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBhdWRpZW5jZSA9IChjb25maWd1cmVkPy5hdWRpZW5jZSA/PyBbXSlcbiAgICAgICAgLm1hcCgodmFsdWUpID0+IFN0cmluZyh2YWx1ZSkudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUgIT09IFwiXCIpO1xuICAgICAgaWYgKGF1ZGllbmNlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydEF1dGhvcml6ZXIuYXVkaWVuY2UgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGFjY2VwdGVkIGF1ZGllbmNlIHdoZW4gdHJhbnNwb3J0UG9zdHVyZSBpcyBKV1RcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBKd3RBdXRob3JpemVyKFxuICAgICAgICBNQ1BfVFJBTlNQT1JUX0FVVEhPUklaRVJfSUQsXG4gICAgICAgIGlzc3VlcixcbiAgICAgICAge1xuICAgICAgICAgIGp3dEF1ZGllbmNlOiBhdWRpZW5jZSxcbiAgICAgICAgICBpZGVudGl0eVNvdXJjZTogY29uZmlndXJlZD8uaWRlbnRpdHlTb3VyY2UsXG4gICAgICAgICAgYXV0aG9yaXplck5hbWU6IGNvbmZpZ3VyZWQ/LmF1dGhvcml6ZXJOYW1lLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcG9zdHVyZUxhYmVsKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSUFNOiByZXR1cm4gXCJJQU1cIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOiByZXR1cm4gXCJKV1RcIjtcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVI6IHJldHVybiBcIlJVTlRJTUVfQkVBUkVSXCI7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDOiByZXR1cm4gXCJOT05FX1BVQkxJQ1wiO1xuICAgIGRlZmF1bHQ6IHJldHVybiBTdHJpbmcocG9zdHVyZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVUcmFuc3BvcnRQb3N0dXJlKHBvc3R1cmU6IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUpOiB2b2lkIHtcbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTTpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuSldUOlxuICAgIGNhc2UgQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5SVU5USU1FX0JFQVJFUjpcbiAgICBjYXNlIEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuTk9ORV9QVUJMSUM6XG4gICAgICByZXR1cm47XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgbXVzdCBiZSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLklBTSwgLkpXVCwgLlJVTlRJTUVfQkVBUkVSLCBvciAuTk9ORV9QVUJMSUNcIixcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJvdXRlTW9kZWwocHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzKTogQXBwVGhlb3J5TWNwUm91dGVNb2RlbCB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy5yb3V0ZU1vZGVsO1xuICBpZiAoY29uZmlndXJlZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVQ7XG4gIH1cbiAgaWYgKFxuICAgIGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlTW9kZWwuRVhQTElDSVRcbiAgICB8fCBjb25maWd1cmVkID09PSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkNPTlNPTElEQVRFRFxuICApIHtcbiAgICByZXR1cm4gY29uZmlndXJlZDtcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgbXVzdCBiZSBBcHBUaGVvcnlNY3BSb3V0ZU1vZGVsLkVYUExJQ0lUIG9yIC5DT05TT0xJREFURURcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSb3V0ZU1vZGVsUG9zdHVyZShcbiAgcm91dGVNb2RlbDogQXBwVGhlb3J5TWNwUm91dGVNb2RlbCxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbik6IHZvaWQge1xuICBpZiAoXG4gICAgcm91dGVNb2RlbCA9PT0gQXBwVGhlb3J5TWNwUm91dGVNb2RlbC5DT05TT0xJREFURURcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLlJVTlRJTUVfQkVBUkVSXG4gICAgJiYgcG9zdHVyZSAhPT0gQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZS5OT05FX1BVQkxJQ1xuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBpcyBvbmx5IHZhbGlkIGZvciB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIG9yIE5PTkVfUFVCTElDOyB0cmFuc3BvcnRQb3N0dXJlICR7cG9zdHVyZUxhYmVsKHBvc3R1cmUpfSBrZWVwcyB0aGUgZXhwbGljaXQgcm91dGUgbW9kZWwgYmVjYXVzZSBjb25zb2xpZGF0aW9uIG11c3QgbmV2ZXIgY2hhbmdlIGdhdGV3YXkgYWRtaXNzaW9uYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVSb3V0ZUlkTW9kZShwcm9wczogQXBwVGhlb3J5TWNwU2VydmVyUHJvcHMpOiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZSB7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBwcm9wcy5yb3V0ZUlkTW9kZTtcbiAgaWYgKGNvbmZpZ3VyZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1k7XG4gIH1cbiAgaWYgKFxuICAgIGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLkxFR0FDWVxuICAgIHx8IGNvbmZpZ3VyZWQgPT09IEFwcFRoZW9yeU1jcFJvdXRlSWRNb2RlLlNFTUFOVElDXG4gICkge1xuICAgIHJldHVybiBjb25maWd1cmVkO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogcm91dGVJZE1vZGUgbXVzdCBiZSBBcHBUaGVvcnlNY3BSb3V0ZUlkTW9kZS5MRUdBQ1kgb3IgLlNFTUFOVElDXCIsXG4gICk7XG59XG5cbi8qKlxuICogVGhlIHR3byBncmVlZHkgcm91dGUga2V5cyBhIGNvbnNvbGlkYXRlZCBtb2RlbCBvd25zLiBBIGNvbnN1bWVyIHJvdXRlIHRoYXRcbiAqIHJlZGVjbGFyZXMgb25lIG9mIHRoZW0gd291bGQgbWFrZSB0aGUgQVBJIHJlamVjdCB0aGUgdXBkYXRlLlxuICovXG5jb25zdCBDT05TT0xJREFURURfR1JFRURZX1JPVVRFX0tFWVMgPSBuZXcgU2V0KFtcIkFOWSAvXCIsIFwiQU5ZIC97cHJveHkrfVwiXSk7XG5cbi8qKlxuICogUmVzb2x2ZSBhbiBgQXBpSWRgIChvciBhbnkgdGVtcGxhdGUgdmFsdWUpIHRvIGEgY29tcGFyYWJsZSBzdHJpbmcsIHNvIGFcbiAqIGBSZWZgIHRva2VuIGFuZCBpdHMgbG9naWNhbCBpZCBjb21wYXJlIGVxdWFsIGFjcm9zcyB0d28gdGVtcGxhdGVzIG9mIHRoZSBzYW1lXG4gKiBzdGFjay5cbiAqL1xuZnVuY3Rpb24gY29tcGFyYWJsZUFwaUlkKHNjb3BlOiBDb25zdHJ1Y3QsIHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFN0YWNrLm9mKHNjb3BlKS5yZXNvbHZlKHZhbHVlKSk7XG59XG5cbi8qKlxuICogRXZlcnkgQVBJIEdhdGV3YXkgdjIgcm91dGUgYm91bmQgdG8gYGFwaWAsIHJlZ2FyZGxlc3Mgb2Ygd2hpY2ggY29uc3RydWN0XG4gKiBzY29wZSBjcmVhdGVkIGl0LlxuICpcbiAqIGBhcGkubm9kZS5jaGlsZHJlbmAgb25seSBzZWVzIHJvdXRlcyB0aGUgQVBJIGl0c2VsZiAob3IgYSBjaGlsZCBzY29wZSlcbiAqIGNyZWF0ZWQsIHdoaWNoIG1pc3NlcyB0aGUgY29tbW9uIHBhdHRlcm4gb2YgYSBzdGFjay1sZXZlbCBjb25zdHJ1Y3Qgd2lyaW5nIGFcbiAqIHJvdXRlIG9udG8gYW4gYXR0YWNoZWQgQVBJLiBXYWxraW5nIHRoZSBzdGFjayBhbmQgcmVzb2x2aW5nIGVhY2ggYENmblJvdXRlYCdzXG4gKiBgQXBpSWRgIHNlZXMgYm90aC5cbiAqL1xuZnVuY3Rpb24gcm91dGVzQm91bmRUb0FwaShzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiBhcGlnd3YyLkNmblJvdXRlW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5Sb3V0ZVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5IdHRwUm91dGUpIHtcbiAgICAgIGlmIChjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuaHR0cEFwaS5hcGlJZCkgPT09IGFwaUtleSkge1xuICAgICAgICBmb3VuZC5wdXNoKG5vZGUubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5Sb3V0ZSk7XG4gICAgICB9XG4gICAgICAvLyBUaGUgcm91dGUncyBvd24gQ2ZuUm91dGUgY2hpbGQgaXMgdGhlIHNhbWUgcm91dGU7IGRvIG5vdCBkb3VibGUgY291bnQuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5Sb3V0ZSAmJiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIG5vZGUuYXBpSWQpID09PSBhcGlLZXkpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZC5maWx0ZXIoKHJvdXRlKSA9PiByb3V0ZSAhPT0gdW5kZWZpbmVkKTtcbn1cblxuLyoqXG4gKiBSZWZ1c2UgYSBjb25zb2xpZGF0ZWQgYXR0YWNoIG9udG8gYW4gQVBJIHRoYXQgYWxyZWFkeSBjYXJyaWVzIHJvdXRlcy5cbiAqXG4gKiBUaGUgY2hlY2sgZGVsaWJlcmF0ZWx5IHdhbGtzIHRoZSB3aG9sZSBzdGFjazogYSByb3V0ZSBib3VuZCB0byB0aGUgYXR0YWNoZWRcbiAqIEFQSSBmcm9tIGEgc2libGluZyBjb25zdHJ1Y3Qgc2NvcGUgaXMganVzdCBhcyBtdWNoIGEgcm91dGUga2V5IHRoZVxuICogY29uc29saWRhdGVkIGdyZWVkeSByb3V0ZXMgd291bGQgY29sbGlkZSB3aXRoIGFzIG9uZSBjcmVhdGVkIHVuZGVyIHRoZSBBUElcbiAqIGl0c2VsZi5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0Q29uc29saWRhdGVkQXR0YWNoQWxsb3dlZChzY29wZTogQ29uc3RydWN0LCBhcGk6IGFwaWd3djIuSUh0dHBBcGkpOiB2b2lkIHtcbiAgY29uc3QgZXhpc3RpbmdSb3V0ZXMgPSByb3V0ZXNCb3VuZFRvQXBpKHNjb3BlLCBhcGkpO1xuICBpZiAoZXhpc3RpbmdSb3V0ZXMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiByb3V0ZU1vZGVsIGNvbnNvbGlkYXRlZCBtYXkgYXR0YWNoIG9ubHkgdG8gYW4gQVBJIHRoYXQgaGFzIG5vIHJvdXRlcyBhdCBhdHRhY2ggdGltZTsgXCJcbiAgICAgICsgYHRoZSBBUEkgYWxyZWFkeSBjYXJyaWVzICR7ZXhpc3RpbmdSb3V0ZXMubGVuZ3RofSByb3V0ZShzKTogJHtleGlzdGluZ1JvdXRlcy5tYXAoKHJvdXRlKSA9PiByb3V0ZS5ub2RlLnBhdGgpLmpvaW4oXCIsIFwiKX07IGBcbiAgICAgICsgXCJhdHRhY2ggdG8gYSBuZXcgb3IgZW1wdHkgQVBJLCBvciB1c2Ugcm91dGVNb2RlbCBleHBsaWNpdFwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWdpc3RlciB0aGUgc3ludGgtdGltZSBydWxlIGZvciByb3V0ZXMgYWRkZWQgdG8gYSBjb25zb2xpZGF0ZWQgQVBJIGFmdGVyXG4gKiB0aGUgY29uc3RydWN0IGNyZWF0ZWQgaXRzIGdyZWVkeSByb3V0ZXMuXG4gKlxuICogVGhlIHJ1bGUgYXBwbGllcyBpbiBib3RoIGNvbnNvbGlkYXRlZCBtb2RlczogYW4gQVBJIHRoZSBjb25zdHJ1Y3QgYXR0YWNoZWRcbiAqIHRvLCBhbmQgb25lIHRoZSBjb25zdHJ1Y3Qgb3ducy4gVGhlIGRvY3VtZW50ZWQgZXhjZXB0aW9uIGlzIHdoYXQgbWFrZXNcbiAqIGNvbnNvbGlkYXRlZCByb3V0ZXMgdXNhYmxlIGluIGEgcmVhbCBmcm9udCBkb29yOiBhIGNvbnN1bWVyIG1heSBhZGRcbiAqIGV4cGxpY2l0LCBtb3JlIHNwZWNpZmljIHJvdXRlcyBhZnRlcndhcmRzLiBJdCBpcyBhbGxvd2VkIG9ubHkgd2hlbiB0aGVcbiAqIHJvdXRlIGNhcnJpZXMgYSBub24tTk9ORSBhdXRob3JpemVyIChzbyB0aGUgZ3JlZWR5IHJvdXRlcyBuZXZlciBzaWxlbnRseVxuICogd2lkZW4gYSBzdHJpY3RlciBwb3N0dXJlKSBhbmQgZG9lcyBub3QgcmVkZWNsYXJlIGEgZ3JlZWR5IHJvdXRlIGtleSAod2hpY2hcbiAqIEFQSSBHYXRld2F5IHdvdWxkIHJlamVjdCBhcyBhIGR1cGxpY2F0ZSkuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyQ29uc29saWRhdGVkQXR0YWNoVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuICBvd25lZFJvdXRlczogYXBpZ3d2Mi5IdHRwUm91dGVbXSxcbik6IHZvaWQge1xuICBjb25zdCBvd25lZCA9IG5ldyBTZXQoXG4gICAgb3duZWRSb3V0ZXMubWFwKChyb3V0ZSkgPT4gcm91dGUubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5Sb3V0ZSksXG4gICk7XG4gIFN0YWNrLm9mKHNjb3BlKS5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG4gICAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHJvdXRlc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSkpIHtcbiAgICAgICAgaWYgKG93bmVkLmhhcyhyb3V0ZSkpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3V0ZUtleSA9IHJvdXRlLnJvdXRlS2V5O1xuICAgICAgICBpZiAoQ09OU09MSURBVEVEX0dSRUVEWV9ST1VURV9LRVlTLmhhcyhyb3V0ZUtleSkpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHJvdXRlTW9kZWwgY29uc29saWRhdGVkIGFscmVhZHkgb3ducyB0aGUgZ3JlZWR5IEFQSSBHYXRld2F5IHJvdXRlIGtleSAke0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX0gb24gdGhpcyBBUEk7IGEgcm91dGUgYWRkZWQgYWZ0ZXIgY29uc3RydWN0aW9uIG11c3Qgbm90IHJlZGVjbGFyZSBpdCAoJHtyb3V0ZS5ub2RlLnBhdGh9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBhdXRob3JpemF0aW9uVHlwZSA9IFN0cmluZyhyb3V0ZS5hdXRob3JpemF0aW9uVHlwZSA/PyBcIk5PTkVcIikudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKGF1dGhvcml6YXRpb25UeXBlID09PSBcIk5PTkVcIikge1xuICAgICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogYSByb3V0ZSBhZGRlZCB0byBhIGNvbnNvbGlkYXRlZCBBUEkgYWZ0ZXIgY29uc3RydWN0aW9uIG11c3QgY2FycnkgYSBub24tTk9ORSBhdXRob3JpemVyLCBiZWNhdXNlIHRoZSBncmVlZHkgcm91dGVzIGFkbWl0IGV2ZXJ5IG1ldGhvZCBhbmQgcGF0aCBhdCB0aGUgZ2F0ZXdheSAoJHtyb3V0ZUtleX0gZnJvbSAke3JvdXRlLm5vZGUucGF0aH0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZXJyb3JzO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUZhY2FkZUF0dGFjaG1lbnQoZmFjYWRlPzogQXBwVGhlb3J5TWNwRmFjYWRlQXR0YWNobWVudCk6IHZvaWQge1xuICBpZiAoZmFjYWRlID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgY29uc3QgcHJvdmlkZXJJZCA9IChmYWNhZGUgYXMgeyBwcm92aWRlcklkPzogdW5rbm93biB9KT8ucHJvdmlkZXJJZDtcbiAgaWYgKFxuICAgIHR5cGVvZiBwcm92aWRlcklkICE9PSBcInN0cmluZ1wiXG4gICAgfHwgcHJvdmlkZXJJZC50cmltKCkgPT09IFwiXCJcbiAgICB8fCBUb2tlbi5pc1VucmVzb2x2ZWQocHJvdmlkZXJJZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZhY2FkZS5wcm92aWRlcklkIG11c3QgYmUgYSBub24tZW1wdHkgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBzdHJpbmdcIixcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zdHVyZUd1YXJkcyhcbiAgcHJvcHM6IEFwcFRoZW9yeU1jcFNlcnZlclByb3BzLFxuICByb3V0ZUZhbWlseTogTm9ybWFsaXplZFJvdXRlRmFtaWx5LFxuICBwb3N0dXJlOiBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLFxuKTogdm9pZCB7XG4gIGlmIChwb3N0dXJlID09PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDKSB7XG4gICAgaWYgKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgIT09IHVuZGVmaW5lZCB8fCBwcm9wcy5qd2tzVXJpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGJlIGNvbWJpbmVkIHdpdGggYXV0aG9yaXphdGlvblNlcnZlcklzc3VlciBvciBqd2tzVXJpXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocm91dGVGYW1pbHkucm9vdEF1dGhvcml6YXRpb25TZXJ2ZXJEaXNjb3ZlcnkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGVuYWJsZSByb290QXV0aG9yaXphdGlvblNlcnZlckRpc2NvdmVyeVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnJ1bnRpbWVQb3N0dXJlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgTk9ORV9QVUJMSUMgY2Fubm90IGRlY2xhcmUgcnVudGltZVBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy51cHN0cmVhbUNhbGxiYWNrUGF0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIE5PTkVfUFVCTElDIGNhbm5vdCBkZWNsYXJlIHVwc3RyZWFtQ2FsbGJhY2tQYXRoXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwcm9wcy5ydW50aW1lUG9zdHVyZSAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtwb3N0dXJlTGFiZWwocG9zdHVyZSl9IGNhbm5vdCBkZWNsYXJlIHJ1bnRpbWVQb3N0dXJlYCxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRGVmZW5zZUluRGVwdGgoXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgcG9zdHVyZTogQXBwVGhlb3J5TWNwVHJhbnNwb3J0UG9zdHVyZSxcbiAgb3duZWQ6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMsXG4pOiB2b2lkIHtcbiAgaWYgKFxuICAgIHBvc3R1cmUgIT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiBwb3N0dXJlICE9PSBBcHBUaGVvcnlNY3BUcmFuc3BvcnRQb3N0dXJlLk5PTkVfUFVCTElDXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsYWJlbCA9IHBvc3R1cmVMYWJlbChwb3N0dXJlKTtcbiAgaWYgKFxuICAgIHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVJcbiAgICAmJiAocHJvcHMucnVudGltZVBvc3R1cmUgPT09IHVuZGVmaW5lZCB8fCBwcm9wcy5ydW50aW1lUG9zdHVyZS5yZXF1aXJlQmVhcmVyVG9rZW4gIT09IHRydWUpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIHJ1bnRpbWVQb3N0dXJlLnJlcXVpcmVCZWFyZXJUb2tlbiB0byBiZSB0cnVlXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5ICE9PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcbiAgICAmJiBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAmJiBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHkgIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3JpZ2luUmVhY2hhYmlsaXR5IHRvIGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCwgLkxPQ0tFRCwgb3IgLkZST05URURgLFxuICAgICk7XG4gIH1cbiAgaWYgKHByb3BzLmFwaSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdmFsaWRhdGVPd25pbmdBcGlEZWZlbnNlKHByb3BzLm93bmluZ0FwaURlZmVuc2UsIGxhYmVsKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAob3duZWQuc3RhZ2U/LnRocm90dGxpbmdFbmFibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYW4gZXhwbGljaXQgb3duZWRBcGkuc3RhZ2UudGhyb3R0bGluZ0VuYWJsZWQ6IHRydWUgdGhyb3R0bGluZyBkZWNpc2lvbmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3duZWQuc3RhZ2U/LmFjY2Vzc0xvZ2dpbmcgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgYWNjZXNzIGxvZ2dpbmdgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHBvc3R1cmUgPT09IEFwcFRoZW9yeU1jcFRyYW5zcG9ydFBvc3R1cmUuUlVOVElNRV9CRUFSRVIpIHtcbiAgICB2YWxpZGF0ZURlbmlhbFNpZ25hbChwcm9wcy5kZW5pYWxTaWduYWwpO1xuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVjbGFyZWQgZGlyZWN0LW9yaWdpbiBkZWNpc2lvbiB0byBhIHByb3ZlbiBwb3N0dXJlLlxuICpcbiAqIEV2ZXJ5IHN1cHBsaWVkIHZhbHVlIGlzIGNoZWNrZWQsIG5vdCBvbmx5IHRoZSBwb3N0dXJlcyB0aGF0IHJlcXVpcmUgdGhlXG4gKiBkZWNpc2lvbi4gRElTQUJMRUQgbmVlZHMgdGhlIG93bmVkIG9yZGluYXJ5IGRvbWFpbiB0aGF0IHJlcGxhY2VzIHRoZSBkaXNhYmxlZFxuICogZXhlY3V0ZS1hcGkgYXV0aG9yaXR5IChvciBhIHByb3ZhYmxlIGNvbmNyZXRlIGF0dGFjaCksIGFuZCBMT0NLRURcbiAqIGFkZGl0aW9uYWxseSBuZWVkcyBtdXR1YWwgVExTIG9uIGV2ZXJ5IGRvbWFpbiBtYXBwZWQgdG8gdGhlIG93bmVkIEFQSS5cbiAqIEF0dGFjaC1tb2RlIExPQ0tFRCBpcyB1bnN1cHBvcnRlZCBiZWNhdXNlIGFuIGV4dGVybmFsIEFQSSBjYXJyaWVzIG5vIGluLXN0YWNrXG4gKiB0cnVzdHN0b3JlIG9yIG1hcHBpbmcgZXZpZGVuY2UuIEZST05URUQgaXMgdGhlIGF0dGFjaC1tb2RlIGNvdW50ZXJwYXJ0IGZvciBhblxuICogYXBwbGljYXRpb24tb3duZWQgZnJvbnQgZG9vcjogaXQgcHJvZHVjZXMgbm8gaW4tc3RhY2sgZXZpZGVuY2UsIHNvIGl0IGlzXG4gKiBhY2NlcHRlZCBvbmx5IHdpdGggYW4gZXhwbGljaXQsIHZhbGlkYXRlZCBgZnJvbnREb29yVmVyaWZpY2F0aW9uYCBkZWNsYXJhdGlvblxuICogYW5kIG9ubHkgaW4gYXR0YWNoIG1vZGUuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyxcbiAgb3duZWQ6IE5vcm1hbGl6ZWRPd25lZEFwaU9wdGlvbnMsXG4pOiBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkgfCB1bmRlZmluZWQge1xuICBjb25zdCBkZWNpc2lvbiA9IHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eTtcbiAgY29uc3QgbXV0dWFsVGxzID0gb3duZWQuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbjtcbiAgaWYgKGRlY2lzaW9uID09PSB1bmRlZmluZWQpIHtcbiAgICBpZiAobXV0dWFsVGxzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBGUk9OVEVEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXG4gICAgJiYgZGVjaXNpb24gIT09IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgICAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBtdXN0IGJlIEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCwgLkxPQ0tFRCwgb3IgLkZST05URURcIixcbiAgICApO1xuICB9XG4gIGlmIChtdXR1YWxUbHMgIT09IHVuZGVmaW5lZCAmJiBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvd25lZEFwaS5kb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb24gaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRURcIixcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URURcbiAgICAmJiBwcm9wcy5mcm9udERvb3JWZXJpZmljYXRpb24gIT09IHVuZGVmaW5lZFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGRlY2lzaW9uID09PSBBcHBUaGVvcnlNY3BPcmlnaW5SZWFjaGFiaWxpdHkuRlJPTlRFRCkge1xuICAgIGlmIChwcm9wcy5hcGkgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IEZST05URUQgaXMgdW5zdXBwb3J0ZWQgaW4gb3duZWQgbW9kZTsgYW4gb3duZWQgZnJvbnQgZG9vciBpcyB3aXJlZCBieSB0aGUgRElTQUJMRUQgb3IgTE9DS0VEIHBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHZhbGlkYXRlRnJvbnREb29yVmVyaWZpY2F0aW9uKHByb3BzLmZyb250RG9vclZlcmlmaWNhdGlvbik7XG4gICAgcmV0dXJuIGRlY2lzaW9uO1xuICB9XG4gIGlmIChkZWNpc2lvbiA9PT0gQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRCkge1xuICAgIGlmIChwcm9wcy5hcGkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCBpcyB1bnN1cHBvcnRlZCBpbiBhdHRhY2ggbW9kZTsgYW4gQVBJIG93bmVkIG91dHNpZGUgdGhlIGNvbnN0cnVjdCBjYXJyaWVzIG5vIGluLXN0YWNrIG11dHVhbC1UTFMgbWFwcGluZyBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG93bmVkLmRvbWFpbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGFuIGVmZmVjdGl2ZSBvd25lZEFwaS5kb21haW4gd2l0aCBtdXR1YWxUbHNBdXRoZW50aWNhdGlvblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKG11dHVhbFRscyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIG93bmVkQXBpLmRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbjsgZGlzYWJsZW1lbnQgYWxvbmUgaXMgdGhlIERJU0FCTEVEIHBvc3R1cmVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAocHJvcHMuYXBpICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIShwcm9wcy5hcGkgaW5zdGFuY2VvZiBhcGlnd3YyLkh0dHBBcGkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgYSBzYW1lLXN0YWNrIGNvbmNyZXRlIEh0dHBBcGk7IGFuIGltcG9ydGVkIEFQSSBleHBvc2VzIG5vIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgZXZpZGVuY2VcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJlZ2lzdGVyQXR0YWNoRGlzYWJsZWRPcmlnaW5WYWxpZGF0aW9uKHNjb3BlLCBwcm9wcy5hcGkpO1xuICAgIHJldHVybiBkZWNpc2lvbjtcbiAgfVxuICBpZiAob3duZWQuZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIGFuIGVmZmVjdGl2ZSBvd25lZEFwaS5kb21haW47IHRoZSBkaXNhYmxlZCBleGVjdXRlLWFwaSBlbmRwb2ludCBpcyBuZXZlciBhIHB1YmxpYyBhdXRob3JpdHlcIixcbiAgICApO1xuICB9XG4gIHJldHVybiBkZWNpc2lvbjtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGUgYGZyb250RG9vclZlcmlmaWNhdGlvbmAgZGVjbGFyYXRpb24gZm9yIGBvcmlnaW5SZWFjaGFiaWxpdHk6XG4gKiBGUk9OVEVEYC5cbiAqXG4gKiBUaGUgZGVjbGFyYXRpb24gaXMgbWFuZGF0b3J5IGFuZCBldmVyeSBmaWVsZCBpcyBjaGVja2VkOiBhbiBhYnNlbnRcbiAqIGRlY2xhcmF0aW9uLCBhIG1pc3Npbmcgb3IgcmVzZXJ2ZWQgaGVhZGVyIG5hbWUsIGEgc2VjcmV0IG91dHNpZGUgdGhlXG4gKiBoZWFkZXItdmFsdWUtc2FmZSBhbHBoYWJldCwgYW5kIGEgbWlzc2luZyBgYXNzZXJ0ZWQ6IHRydWVgIGFsbCBmYWlsIHN5bnRoZXNpc1xuICogcmF0aGVyIHRoYW4gcHJvZHVjaW5nIGEgZGVjbGFyYXRpb24gdGhlIHJ1bnRpbWUgY291bGQgbm90IGhvbm9yLlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZUZyb250RG9vclZlcmlmaWNhdGlvbihcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogdm9pZCB7XG4gIGlmICh2ZXJpZmljYXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCByZXF1aXJlcyBmcm9udERvb3JWZXJpZmljYXRpb247IHRoZSBydW50aW1lIGNhbm5vdCBlbmZvcmNlIGFuIHVuZGVjbGFyZWQgZnJvbnQgZG9vclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGVhZGVyTmFtZSA9IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lO1xuICBpZiAodHlwZW9mIGhlYWRlck5hbWUgIT09IFwic3RyaW5nXCIgfHwgIUZST05UX0RPT1JfSEVBREVSX05BTUVfUEFUVEVSTi50ZXN0KGhlYWRlck5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lIG11c3QgYmUgMSB0byA2NCBjaGFyYWN0ZXJzIG9mIFtBLVphLXowLTktXVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZEhlYWRlciA9IGhlYWRlck5hbWUudG9Mb3dlckNhc2UoKTtcbiAgaWYgKFxuICAgIFJFU0VSVkVEX0ZST05UX0RPT1JfSEVBREVSUy5oYXMobm9ybWFsaXplZEhlYWRlcilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJ4LWFtei1cIilcbiAgICB8fCBub3JtYWxpemVkSGVhZGVyLnN0YXJ0c1dpdGgoXCJ4LWFtem4tXCIpXG4gICAgfHwgbm9ybWFsaXplZEhlYWRlci5zdGFydHNXaXRoKFwiY2xvdWRmcm9udC1cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLmhlYWRlck5hbWUgJHtoZWFkZXJOYW1lfSBpcyBhIHJlc2VydmVkIG9yIHBsYXRmb3JtLW1hbmFnZWQgcmVxdWVzdCBoZWFkZXIgYW5kIGNhbm5vdCBjYXJyeSB0aGUgZnJvbnQtZG9vciB2ZXJpZmljYXRpb25gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc2VjcmV0VmFsdWUgPSB2ZXJpZmljYXRpb24uc2VjcmV0VmFsdWU7XG4gIGNvbnN0IHNlY3JldFBhcmFtZXRlck5hbWUgPSB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZTtcbiAgY29uc3QgaGFzTGl0ZXJhbCA9IHNlY3JldFZhbHVlICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGhhc1BhcmFtZXRlciA9IHNlY3JldFBhcmFtZXRlck5hbWUgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0xpdGVyYWwgPT09IGhhc1BhcmFtZXRlcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24gcmVxdWlyZXMgZXhhY3RseSBvbmUgb2Ygc2VjcmV0VmFsdWUgYW5kIHNlY3JldFBhcmFtZXRlck5hbWU7IHN1cHBseSB0aGUgbGl0ZXJhbCwgb3IgdGhlIHdlbGwta25vd24gcGFyYW1ldGVyIG5hbWUgdGhlIGFwcGxpY2F0aW9uJ3MgaW5zdGFsbGVyIGNyZWF0ZXNcIixcbiAgICApO1xuICB9XG4gIGlmIChoYXNMaXRlcmFsKSB7XG4gICAgaWYgKHR5cGVvZiBzZWNyZXRWYWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhRlJPTlRfRE9PUl9TRUNSRVRfUEFUVEVSTi50ZXN0KHNlY3JldFZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFZhbHVlIG11c3QgYmUgMzIgdG8gMTI4IGNoYXJhY3RlcnMgb2YgW0EtWmEtejAtOS5ffi1dXCIsXG4gICAgICApO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB2YWxpZGF0ZUZyb250RG9vclBhcmFtZXRlck5hbWUoc2VjcmV0UGFyYW1ldGVyTmFtZSk7XG4gIH1cbiAgaWYgKHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJLbXNLZXkgIT09IHVuZGVmaW5lZCAmJiAhaGFzUGFyYW1ldGVyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGZyb250RG9vclZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJLbXNLZXkgaXMgb25seSB2YWxpZCB3aXRoIHNlY3JldFBhcmFtZXRlck5hbWVcIixcbiAgICApO1xuICB9XG4gIGlmICh2ZXJpZmljYXRpb24uYXNzZXJ0ZWQgIT09IHRydWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uIHJlcXVpcmVzIGFzc2VydGVkOiB0cnVlIOKAlCB0aGUgY2FsbGVyIG11c3QgcmVjb3JkIHRoYXQgdGhlIHJ1bnRpbWUgdmVyaWZpZXMgdGhlIGZyb250LWRvb3IgaGVhZGVyIG9uIGV2ZXJ5IGRlcml2ZWQgcm91dGVcIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSB3ZWxsLWtub3duIGZyb250LWRvb3IgcGFyYW1ldGVyIG5hbWUuXG4gKlxuICogVGhlIG5hbWUgbXVzdCBiZSBleHByZXNzaWJsZSBpbiBhIENsb3VkRm9ybWF0aW9uIGBzc21gIGR5bmFtaWMgcmVmZXJlbmNlIGFuZFxuICogYWNjZXB0YWJsZSB0byBQYXJhbWV0ZXIgU3RvcmUsIGJlY2F1c2UgdGhlIGNvbnN0cnVjdCByZW5kZXJzIHRoZSByZWZlcmVuY2UgYW5kXG4gKiBncmFudHMgb24gdGhlIEFSTi4gQSBuYW1lIG91dHNpZGUgZWl0aGVyIGNvbnRyYWN0IHdvdWxkIGZhaWwgYXQgZGVwbG95IHRpbWUsXG4gKiBzbyBpdCBmYWlscyBzeW50aGVzaXMgaW5zdGVhZC5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVGcm9udERvb3JQYXJhbWV0ZXJOYW1lKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICBpZiAoXG4gICAgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCJcbiAgICB8fCBuYW1lLmxlbmd0aCA+IEZST05UX0RPT1JfUEFSQU1FVEVSX05BTUVfTUFYX0xFTkdUSFxuICAgIHx8ICFGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX1BBVFRFUk4udGVzdChuYW1lKVxuICAgIHx8IG5hbWUuZW5kc1dpdGgoXCIvXCIpXG4gICAgfHwgbmFtZS5pbmNsdWRlcyhcIi8vXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSBtdXN0IGJlIGEgZnVsbHkgcXVhbGlmaWVkIFNTTSBwYXJhbWV0ZXIgbmFtZSBmcm9tICcvJywgYXQgbW9zdCAxMDExIGNoYXJhY3RlcnMsIG9mIFtBLVphLXowLTlfLi0vXSB3aXRoIG5vIGVtcHR5IHNlZ21lbnRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGxldmVscyA9IG5hbWUuc3BsaXQoXCIvXCIpLmZpbHRlcigoc2VnbWVudCkgPT4gc2VnbWVudC5sZW5ndGggPiAwKTtcbiAgY29uc3QgZmlyc3QgPSBsZXZlbHNbMF0/LnRvTG93ZXJDYXNlKCk7XG4gIGlmIChsZXZlbHMubGVuZ3RoID09PSAwIHx8IGxldmVscy5sZW5ndGggPiBGUk9OVF9ET09SX1BBUkFNRVRFUl9OQU1FX01BWF9MRVZFTFMpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogZnJvbnREb29yVmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUgbXVzdCBoYXZlIGJldHdlZW4gb25lIGFuZCBmaWZ0ZWVuIGhpZXJhcmNoeSBsZXZlbHNcIixcbiAgICApO1xuICB9XG4gIGlmIChmaXJzdCA9PT0gXCJhd3NcIiB8fCBmaXJzdCA9PT0gXCJzc21cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBmcm9udERvb3JWZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSBtdXN0IG5vdCB1c2UgdGhlIHJlc2VydmVkIGF3cyBvciBzc20gaGllcmFyY2h5XCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBvcmlnaW4gY3VzdG9tIGhlYWRlciB0aGUgYXBwLW93bmVkIGZyb250IGRvb3IgbXVzdCBzZW5kLlxuICpcbiAqIFRoZSBwYXJhbWV0ZXIgZm9ybSByZW5kZXJzIHRoZSBDbG91ZEZvcm1hdGlvbiBkeW5hbWljIHJlZmVyZW5jZSB0aGVcbiAqIGRpc3RyaWJ1dGlvbiBwcm9wZXJ0eSBhY2NlcHRzLCBzbyB0aGUgdmFsdWUgaXMgcmVzb2x2ZWQgYnkgQ2xvdWRGb3JtYXRpb24gYXRcbiAqIHN0YWNrIGNyZWF0ZS91cGRhdGUgdGltZSBhbmQgbmV2ZXIgYXBwZWFycyBpbiB0aGUgYXBwbGljYXRpb24gc291cmNlIG9yIHRoaXNcbiAqIGNvbnN0cnVjdCdzIHRlbXBsYXRlLlxuICovXG5mdW5jdGlvbiBmcm9udERvb3JPcmlnaW5IZWFkZXIoXG4gIHZlcmlmaWNhdGlvbjogQXBwVGhlb3J5TWNwRnJvbnREb29yVmVyaWZpY2F0aW9uT3B0aW9ucyB8IHVuZGVmaW5lZCxcbik6IEFwcFRoZW9yeU1jcEZyb250RG9vckhlYWRlciB7XG4gIGlmICh2ZXJpZmljYXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCByZXF1aXJlcyBmcm9udERvb3JWZXJpZmljYXRpb247IHRoZSBydW50aW1lIGNhbm5vdCBlbmZvcmNlIGFuIHVuZGVjbGFyZWQgZnJvbnQgZG9vclwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGVhZGVyVmFsdWUgPSB2ZXJpZmljYXRpb24uc2VjcmV0UGFyYW1ldGVyTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgPyBge3tyZXNvbHZlOnNzbToke3ZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lfX19YFxuICAgIDogU3RyaW5nKHZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZSk7XG4gIHJldHVybiB7IGhlYWRlck5hbWU6IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lLCBoZWFkZXJWYWx1ZSB9O1xufVxuXG4vKipcbiAqIEdyYW50IHRoZSBydW50aW1lIGZ1bmN0aW9uIHJlYWQgYWNjZXNzIHRvIHRoZSB3ZWxsLWtub3duIGZyb250LWRvb3IgcGFyYW1ldGVyLlxuICpcbiAqIFBhcmFtZXRlciBTdG9yZSByZXNvbHZlcyB0aGUgZGlzdHJpYnV0aW9uJ3MgZHluYW1pYyByZWZlcmVuY2Ugd2l0aCB0aGVcbiAqIGRlcGxveWluZyBwcmluY2lwYWwncyBwZXJtaXNzaW9ucywgc28gdGhpcyBncmFudCBzZXJ2ZXMgdGhlIHJ1bnRpbWUncyBsYXp5XG4gKiByZWFkOiBgc3NtOkdldFBhcmFtZXRlcmAgb24gZXhhY3RseSB0aGF0IHBhcmFtZXRlciBBUk4gKG5ldmVyIGEgd2lsZGNhcmQpIGFuZCxcbiAqIGZvciBhIFNlY3VyZVN0cmluZywgYGttczpEZWNyeXB0YCBvbiB0aGUgZGVjbGFyZWQga2V5LiBQYXJhbWV0ZXIgU3RvcmUgbmVlZHNcbiAqIG5vIEtNUyBwZXJtaXNzaW9uIGZvciBhIFN0cmluZyBwYXJhbWV0ZXIsIHdoaWNoIGlzIHRoZSB0eXBlIEZST05URUQgcmVxdWlyZXMuXG4gKi9cbmZ1bmN0aW9uIGdyYW50RnJvbnREb29yUGFyYW1ldGVyUmVhZChcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogdm9pZCB7XG4gIGNvbnN0IHBhcmFtZXRlck5hbWUgPSB2ZXJpZmljYXRpb24/LnNlY3JldFBhcmFtZXRlck5hbWU7XG4gIGlmIChwYXJhbWV0ZXJOYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaGFuZGxlci5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgIGFjdGlvbnM6IFtcInNzbTpHZXRQYXJhbWV0ZXJcIl0sXG4gICAgcmVzb3VyY2VzOiBbXG4gICAgICBTdGFjay5vZihzY29wZSkuZm9ybWF0QXJuKHtcbiAgICAgICAgc2VydmljZTogXCJzc21cIixcbiAgICAgICAgcmVzb3VyY2U6IFwicGFyYW1ldGVyXCIsXG4gICAgICAgIHJlc291cmNlTmFtZTogcGFyYW1ldGVyTmFtZS5yZXBsYWNlKC9eXFwvKy8sIFwiXCIpLFxuICAgICAgfSksXG4gICAgXSxcbiAgfSkpO1xuICBpZiAodmVyaWZpY2F0aW9uPy5zZWNyZXRQYXJhbWV0ZXJLbXNLZXkgIT09IHVuZGVmaW5lZCkge1xuICAgIHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJLbXNLZXkuZ3JhbnREZWNyeXB0KGhhbmRsZXIpO1xuICB9XG59XG5cbi8qKlxuICogVGhlIEZST05URUQgZmllbGRzIG9mIHRoZSBgYXBwdGhlb3J5Om1jcC10cmFuc3BvcnQtcG9zdHVyZWAgbWFya2VyLlxuICpcbiAqIFRoZSBsaXRlcmFsIGZvcm0gcmVjb3JkcyB0aGUgcG9zdHVyZSwgdGhlIGhlYWRlciBuYW1lIGFuZCBhIFNIQS0yNTYgZGlnZXN0IG9mXG4gKiB0aGUgZGVjbGFyZWQgc2VjcmV0LCBleGFjdGx5IGFzIHY3LjMgZGlkOyB0aGUgbGl0ZXJhbCBpcyBjb25zdW1lZCBmb3IgaXRzXG4gKiBkaWdlc3Qgb25seSwgc28gaXQgbmV2ZXIgbGFuZHMgaW4gdGhlIHN5bnRoZXNpemVkIHRlbXBsYXRlIG9yIGluXG4gKiBDbG91ZEZvcm1hdGlvbi4gVGhlIHBhcmFtZXRlciBmb3JtIHJlY29yZHMgdGhlIHdlbGwta25vd24gcGFyYW1ldGVyIG5hbWUgYW5kXG4gKiB0aGF0IHRoZSB2YWx1ZSBpcyBwYXJhbWV0ZXItc291cmNlZCBpbnN0ZWFkIG9mIGEgZGlnZXN0LCBiZWNhdXNlIHRoZXJlIGlzIG5vXG4gKiBsaXRlcmFsIGluIHRoZSBhcHBsaWNhdGlvbiB0byBkaWdlc3QuXG4gKi9cbmZ1bmN0aW9uIGZyb250RG9vclBvc3R1cmVNZXRhZGF0YShcbiAgdmVyaWZpY2F0aW9uOiBBcHBUaGVvcnlNY3BGcm9udERvb3JWZXJpZmljYXRpb25PcHRpb25zIHwgdW5kZWZpbmVkLFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGlmICh2ZXJpZmljYXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRlJPTlRFRCByZXF1aXJlcyBmcm9udERvb3JWZXJpZmljYXRpb247IHRoZSBydW50aW1lIGNhbm5vdCBlbmZvcmNlIGFuIHVuZGVjbGFyZWQgZnJvbnQgZG9vclwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHZlcmlmaWNhdGlvbi5zZWNyZXRQYXJhbWV0ZXJOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb3JpZ2luX3JlYWNoYWJpbGl0eTogQXBwVGhlb3J5TWNwT3JpZ2luUmVhY2hhYmlsaXR5LkZST05URUQsXG4gICAgICBmcm9udF9kb29yX2hlYWRlcl9uYW1lOiB2ZXJpZmljYXRpb24uaGVhZGVyTmFtZSxcbiAgICAgIGZyb250X2Rvb3Jfc2VjcmV0X3NvdXJjZTogXCJzc20tcGFyYW1ldGVyXCIsXG4gICAgICBmcm9udF9kb29yX3NlY3JldF9wYXJhbWV0ZXJfbmFtZTogdmVyaWZpY2F0aW9uLnNlY3JldFBhcmFtZXRlck5hbWUsXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9yaWdpbl9yZWFjaGFiaWxpdHk6IEFwcFRoZW9yeU1jcE9yaWdpblJlYWNoYWJpbGl0eS5GUk9OVEVELFxuICAgIGZyb250X2Rvb3JfaGVhZGVyX25hbWU6IHZlcmlmaWNhdGlvbi5oZWFkZXJOYW1lLFxuICAgIGZyb250X2Rvb3Jfc2VjcmV0X3NoYTI1NjogY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoU3RyaW5nKHZlcmlmaWNhdGlvbi5zZWNyZXRWYWx1ZSksIFwidXRmOFwiKS5kaWdlc3QoXCJoZXhcIiksXG4gIH07XG59XG5cbi8qKlxuICogRmluYWwgc3ludGhlc2lzIHByb29mIGZvciBhbiBvd25lZCBESVNBQkxFRCBBUEk6IHRoZSBkZWZhdWx0IGV4ZWN1dGUtYXBpXG4gKiBlbmRwb2ludCBtdXN0IHN0aWxsIGJlIGRpc2FibGVkIGluIHRoZSBlbWl0dGVkIHRlbXBsYXRlLCBldmVuIGlmIGEgbGF0ZXIgTDFcbiAqIG92ZXJyaWRlIHRyaWVzIHRvIHJlLWVuYWJsZSBpdC5cbiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJPd25lZERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLkh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGNmbkFwaSA9IGFwaS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmbkFwaTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpID09PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXG4gICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgcmVxdWlyZXMgQVdTOjpBcGlHYXRld2F5VjI6OkFwaS5Qcm9wZXJ0aWVzLkRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgdG8gcmVzb2x2ZSB0byB0cnVlXCIsXG4gICAgICBdO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKipcbiAqIEZpbmFsIHdob2xlLXN0YWNrIHByb29mIGZvciBhbiBvd25lZCBMT0NLRUQgQVBJLlxuICpcbiAqIExPQ0tFRCBpcyBub3QgYW4gYWxpYXMgb2YgRElTQUJMRUQ6IGF0IGZpbmFsIHN5bnRoZXNpcyB0aGUgZGVmYXVsdCBlbmRwb2ludFxuICogbXVzdCBzdGlsbCBiZSBkaXNhYmxlZCBhbmQgZXZlcnkgYENmbkFwaU1hcHBpbmdgIGJvdW5kIHRvIHRoZSBvd25lZCBBUEksXG4gKiBpbmNsdWRpbmcgbWFwcGluZ3MgYW5vdGhlciBzY29wZSBhZGRzIGFmdGVyIGNvbnN0cnVjdGlvbiwgbXVzdCByZXNvbHZlIHRvIGFuXG4gKiBpbi1zdGFjayBgQ2ZuRG9tYWluTmFtZWAgd2hvc2UgYE11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBjYXJyaWVzIGEgdHJ1c3RzdG9yZVxuICogVVJJLiBBbiB1bnJlc29sdmFibGUgbWFwcGluZyBvciBkb21haW4gZmFpbHMgY2xvc2VkIGluc3RlYWQgb2YgY291bnRpbmcgYXNcbiAqIGV2aWRlbmNlLlxuICovXG5mdW5jdGlvbiByZWdpc3Rlck93bmVkTG9ja2VkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLkh0dHBBcGksXG4pOiB2b2lkIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGNmbkFwaSA9IGFwaS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmbkFwaTtcbiAgc3RhY2subm9kZS5hZGRWYWxpZGF0aW9uKHtcbiAgICB2YWxpZGF0ZTogKCkgPT4ge1xuICAgICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQpICE9PSB0cnVlKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkuUHJvcGVydGllcy5EaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IHRvIHJlc29sdmUgdG8gdHJ1ZVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgbWFwcGluZ3MgPSBjZm5BcGlNYXBwaW5nc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gICAgICBpZiAobWFwcGluZ3MubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBBV1M6OkFwaUdhdGV3YXlWMjo6QXBpTWFwcGluZyBib3VuZCB0byB0aGUgb3duZWQgQVBJXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBkb21haW5zID0gY2ZuRG9tYWluTmFtZXMoc2NvcGUpO1xuICAgICAgZm9yIChjb25zdCBtYXBwaW5nIG9mIG1hcHBpbmdzKSB7XG4gICAgICAgIGNvbnN0IGRvbWFpbiA9IGRvbWFpbnMuZmluZChcbiAgICAgICAgICAoY2FuZGlkYXRlKSA9PiBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGNhbmRpZGF0ZS5yZWYpXG4gICAgICAgICAgICA9PT0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBtYXBwaW5nLmRvbWFpbk5hbWUpLFxuICAgICAgICApO1xuICAgICAgICBpZiAoZG9tYWluID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgY2Fubm90IHJlc29sdmUgbWFwcGluZyAke21hcHBpbmcubm9kZS5wYXRofSB0byBhbiBpbi1zdGFjayBBV1M6OkFwaUdhdGV3YXlWMjo6RG9tYWluTmFtZTsgbXV0dWFsLVRMUyBldmlkZW5jZSBpcyB1bnZlcmlmaWFibGVgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFoYXNUcnVzdHN0b3JlVXJpKHN0YWNrLCBkb21haW4pKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIGV2ZXJ5IG1hcHBpbmcgdG8gdGFyZ2V0IGEgZG9tYWluIHdpdGggTXV0dWFsVGxzQXV0aGVudGljYXRpb24uVHJ1c3RzdG9yZVVyaSAoJHttYXBwaW5nLm5vZGUucGF0aH0gLT4gJHtkb21haW4ubm9kZS5wYXRofSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBlcnJvcnM7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhc1RydXN0c3RvcmVVcmkoc3RhY2s6IFN0YWNrLCBkb21haW46IGFwaWd3djIuQ2ZuRG9tYWluTmFtZSk6IGJvb2xlYW4ge1xuICBjb25zdCByZXNvbHZlZCA9IHN0YWNrLnJlc29sdmUoZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uKTtcbiAgaWYgKHJlc29sdmVkID09PSB1bmRlZmluZWQgfHwgcmVzb2x2ZWQgPT09IG51bGwgfHwgdHlwZW9mIHJlc29sdmVkICE9PSBcIm9iamVjdFwiKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IGF1dGhlbnRpY2F0aW9uID0gcmVzb2x2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IHRydXN0c3RvcmVVcmkgPSBhdXRoZW50aWNhdGlvbi50cnVzdHN0b3JlVXJpID8/IGF1dGhlbnRpY2F0aW9uLlRydXN0c3RvcmVVcmk7XG4gIHJldHVybiB0cnVzdHN0b3JlVXJpICE9PSB1bmRlZmluZWQgJiYgdHJ1c3RzdG9yZVVyaSAhPT0gbnVsbCAmJiB0cnVzdHN0b3JlVXJpICE9PSBcIlwiO1xufVxuXG4vKiogRXZlcnkgaW4tc3RhY2sgYENmbkFwaU1hcHBpbmdgIHdob3NlIHJlc29sdmVkIGBBcGlJZGAgaXMgdGhlIHN1cHBsaWVkIEFQSS4gKi9cbmZ1bmN0aW9uIGNmbkFwaU1hcHBpbmdzQm91bmRUb0FwaShcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuKTogYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nW10ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYXBpS2V5ID0gY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBhcGkuYXBpSWQpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5BcGlNYXBwaW5nW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkFwaU1hcHBpbmcgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLmFwaUlkKSA9PT0gYXBpS2V5KSB7XG4gICAgICBmb3VuZC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUubm9kZS5jaGlsZHJlbikge1xuICAgICAgdmlzaXQoY2hpbGQpO1xuICAgIH1cbiAgfTtcbiAgdmlzaXQoc3RhY2spO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmZ1bmN0aW9uIGNmbkRvbWFpbk5hbWVzKHNjb3BlOiBDb25zdHJ1Y3QpOiBhcGlnd3YyLkNmbkRvbWFpbk5hbWVbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBmb3VuZDogYXBpZ3d2Mi5DZm5Eb21haW5OYW1lW10gPSBbXTtcbiAgY29uc3QgdmlzaXQgPSAobm9kZTogQ29uc3RydWN0KTogdm9pZCA9PiB7XG4gICAgaWYgKG5vZGUgaW5zdGFuY2VvZiBhcGlnd3YyLkNmbkRvbWFpbk5hbWUpIHtcbiAgICAgIGZvdW5kLnB1c2gobm9kZSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5ub2RlLmNoaWxkcmVuKSB7XG4gICAgICB2aXNpdChjaGlsZCk7XG4gICAgfVxuICB9O1xuICB2aXNpdChzdGFjayk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBGaW5hbCBzeW50aGVzaXMgcHJvb2YgZm9yIGFuIGF0dGFjaCBESVNBQkxFRCBkZWNsYXJhdGlvbjogdGhlIGNvbmNyZXRlIEFQSVxuICogbXVzdCBiaW5kIHRvIGV4YWN0bHkgb25lIGluLXN0YWNrIENmbkFwaSB3aG9zZSBEaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50XG4gKiByZXNvbHZlcyB0byBsaXRlcmFsIHRydWUuIFRoZSBjb25zdHJ1Y3QgbmV2ZXIgbXV0YXRlcyB0aGUgYXR0YWNoZWQgQVBJLlxuICovXG5mdW5jdGlvbiByZWdpc3RlckF0dGFjaERpc2FibGVkT3JpZ2luVmFsaWRhdGlvbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYXBpOiBhcGlnd3YyLklIdHRwQXBpLFxuKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBzdGFjay5ub2RlLmFkZFZhbGlkYXRpb24oe1xuICAgIHZhbGlkYXRlOiAoKSA9PiB7XG4gICAgICBjb25zdCBjZm5BcGlzID0gY2ZuQXBpc0JvdW5kVG9BcGkoc2NvcGUsIGFwaSk7XG4gICAgICBpZiAoY2ZuQXBpcy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICBcIkFwcFRoZW9yeU1jcFNlcnZlcjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIGluIGF0dGFjaCBtb2RlIHJlcXVpcmVzIGV4YWN0bHkgb25lIHNhbWUtc3RhY2sgQVdTOjpBcGlHYXRld2F5VjI6OkFwaTsgdGhlIGF0dGFjaGVkIEFQSSdzIERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgY2Fubm90IGJlIHByb3ZlblwiLFxuICAgICAgICBdO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWNrLnJlc29sdmUoY2ZuQXBpc1swXS5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50KSAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gW1xuICAgICAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgaW4gYXR0YWNoIG1vZGUgcmVxdWlyZXMgdGhlIGF0dGFjaGVkIEFXUzo6QXBpR2F0ZXdheVYyOjpBcGkgdG8gc2V0IERpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQ9dHJ1ZVwiLFxuICAgICAgICBdO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtdO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKiogRXZlcnkgaW4tc3RhY2sgYENmbkFwaWAgd2hvc2UgYFJlZmAgaXMgdGhlIHN1cHBsaWVkIEFQSSdzIGlkLiAqL1xuZnVuY3Rpb24gY2ZuQXBpc0JvdW5kVG9BcGkoc2NvcGU6IENvbnN0cnVjdCwgYXBpOiBhcGlnd3YyLklIdHRwQXBpKTogYXBpZ3d2Mi5DZm5BcGlbXSB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhcGlLZXkgPSBjb21wYXJhYmxlQXBpSWQoc2NvcGUsIGFwaS5hcGlJZCk7XG4gIGNvbnN0IGZvdW5kOiBhcGlnd3YyLkNmbkFwaVtdID0gW107XG4gIGNvbnN0IHZpc2l0ID0gKG5vZGU6IENvbnN0cnVjdCk6IHZvaWQgPT4ge1xuICAgIGlmIChub2RlIGluc3RhbmNlb2YgYXBpZ3d2Mi5DZm5BcGkgJiYgY29tcGFyYWJsZUFwaUlkKHNjb3BlLCBub2RlLnJlZikgPT09IGFwaUtleSkge1xuICAgICAgZm91bmQucHVzaChub2RlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLm5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIHZpc2l0KGNoaWxkKTtcbiAgICB9XG4gIH07XG4gIHZpc2l0KHN0YWNrKTtcbiAgcmV0dXJuIGZvdW5kO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU93bmluZ0FwaURlZmVuc2UoXG4gIGRlZmVuc2U6IEFwcFRoZW9yeU1jcE93bmluZ0FwaURlZmVuc2VPcHRpb25zIHwgdW5kZWZpbmVkLFxuICBsYWJlbDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChkZWZlbnNlID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UgdG8gcmVjb3JkIHRoZSBvd25pbmcgQVBJJ3MgYWNjZXNzIGxvZ2dpbmcgYW5kIHRocm90dGxpbmcgZGVjaXNpb25zYCxcbiAgICApO1xuICB9XG4gIGlmIChkZWZlbnNlLmFjY2Vzc0xvZ2dpbmcgIT09IHRydWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlICR7bGFiZWx9IHJlcXVpcmVzIG93bmluZ0FwaURlZmVuc2UuYWNjZXNzTG9nZ2luZyB0byBiZSB0cnVlYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHRocm90dGxpbmc6IFBhcnRpYWw8QXBwVGhlb3J5TWNwT3duaW5nQXBpVGhyb3R0bGluZ09wdGlvbnM+IHwgdW5kZWZpbmVkID0gZGVmZW5zZS50aHJvdHRsaW5nO1xuICBjb25zdCByYXRlTGltaXQgPSB0aHJvdHRsaW5nPy5yYXRlTGltaXQ7XG4gIGNvbnN0IGJ1cnN0TGltaXQgPSB0aHJvdHRsaW5nPy5idXJzdExpbWl0O1xuICBpZiAoXG4gICAgIU51bWJlci5pc0Zpbml0ZShyYXRlTGltaXQpXG4gICAgfHwgKHJhdGVMaW1pdCBhcyBudW1iZXIpIDw9IDBcbiAgICB8fCAhTnVtYmVyLmlzRmluaXRlKGJ1cnN0TGltaXQpXG4gICAgfHwgKGJ1cnN0TGltaXQgYXMgbnVtYmVyKSA8PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHRyYW5zcG9ydFBvc3R1cmUgJHtsYWJlbH0gcmVxdWlyZXMgb3duaW5nQXBpRGVmZW5zZS50aHJvdHRsaW5nIHJhdGVMaW1pdCBhbmQgYnVyc3RMaW1pdCB0byBiZSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyc2AsXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZURlbmlhbFNpZ25hbChzaWduYWw/OiBBcHBUaGVvcnlNY3BEZW5pYWxTaWduYWxPcHRpb25zKTogdm9pZCB7XG4gIGlmIChzaWduYWwgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWNwU2VydmVyOiB0cmFuc3BvcnRQb3N0dXJlIFJVTlRJTUVfQkVBUkVSIHJlcXVpcmVzIGRlbmlhbFNpZ25hbFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5tZXRyaWNOYW1lICE9PSB1bmRlZmluZWQgJiYgc2lnbmFsLm1ldHJpY05hbWUgIT09IE1DUF9ERU5JQUxfTUVUUklDX05BTUUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWNwU2VydmVyOiBkZW5pYWxTaWduYWwubWV0cmljTmFtZSBtdXN0IGJlICR7TUNQX0RFTklBTF9NRVRSSUNfTkFNRX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpZ25hbC5kaW1lbnNpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBkaW1lbnNpb25zID0gQXJyYXkuaXNBcnJheShzaWduYWwuZGltZW5zaW9ucykgPyBzaWduYWwuZGltZW5zaW9ucyA6IFtdO1xuICAgIGNvbnN0IGJvdW5kZWQgPSBkaW1lbnNpb25zLmxlbmd0aCA9PT0gTUNQX0RFTklBTF9ESU1FTlNJT05TLmxlbmd0aFxuICAgICAgJiYgTUNQX0RFTklBTF9ESU1FTlNJT05TLmV2ZXJ5KFxuICAgICAgICAoZGltZW5zaW9uKSA9PiBkaW1lbnNpb25zLmZpbHRlcigodmFsdWUpID0+IHZhbHVlID09PSBkaW1lbnNpb24pLmxlbmd0aCA9PT0gMSxcbiAgICAgICk7XG4gICAgaWYgKCFib3VuZGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRlbmlhbFNpZ25hbC5kaW1lbnNpb25zIG11c3QgYmUgZXhhY3RseSAke0pTT04uc3RyaW5naWZ5KE1DUF9ERU5JQUxfRElNRU5TSU9OUyl9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlTGl0ZXJhbE9BdXRoVVJMKHZhbHVlOiBzdHJpbmcsIGFsbG93UXVlcnk6IGJvb2xlYW4sIG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBsaXRlcmFsID0gdmFsdWUudHJpbSgpO1xuICBsZXQgcGFyc2VkOiBVUkwgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChsaXRlcmFsKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIHNoYXJlZCB2YWxpZGF0aW9uIGVycm9yIGJlbG93IGlzIHRoZSBwdWJsaWMgc3ludGhlc2lzIGNvbnRyYWN0LlxuICB9XG4gIGlmIChcbiAgICAhcGFyc2VkXG4gICAgfHwgIWxpdGVyYWxVUkxIYXNSRkMzOTg2QXV0aG9yaXR5KGxpdGVyYWwpXG4gICAgfHwgcGFyc2VkLnByb3RvY29sICE9PSBcImh0dHBzOlwiXG4gICAgfHwgIXBhcnNlZC5ob3N0bmFtZVxuICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgIHx8IHBhcnNlZC5wYXNzd29yZCAhPT0gXCJcIlxuICAgIHx8IGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyhsaXRlcmFsKVxuICAgIHx8ICghYWxsb3dRdWVyeSAmJiBsaXRlcmFsLmluY2x1ZGVzKFwiP1wiKSlcbiAgICB8fCBsaXRlcmFsLmluY2x1ZGVzKFwiI1wiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHttZXNzYWdlfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRvSHR0cE1ldGhvZChtZXRob2Q6IHN0cmluZyk6IGFwaWd3djIuSHR0cE1ldGhvZCB7XG4gIHN3aXRjaCAobWV0aG9kKSB7XG4gICAgY2FzZSBcIlBPU1RcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5QT1NUO1xuICAgIGNhc2UgXCJHRVRcIjogcmV0dXJuIGFwaWd3djIuSHR0cE1ldGhvZC5HRVQ7XG4gICAgY2FzZSBcIkRFTEVURVwiOiByZXR1cm4gYXBpZ3d2Mi5IdHRwTWV0aG9kLkRFTEVURTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6IHVuc3VwcG9ydGVkIHJ1bnRpbWUgTUNQIG1ldGhvZCAke21ldGhvZH1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBvc2l0aXZlTnVtYmVyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1jcFNlcnZlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBncmVhdGVyIHRoYW4gemVyb2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9zaXRpdmVJbnRlZ2VyKHZhbHVlOiBudW1iZXIsIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNY3BTZXJ2ZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYSBwb3NpdGl2ZSBpbnRlZ2VyYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIHJldHVybiBmcWRuLmVuZHNXaXRoKHN1ZmZpeCkgPyBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKSA6IGZxZG47XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsVVJMSGFzUkZDMzk4NkF1dGhvcml0eSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eaHR0cHM6XFwvXFwvKFteLz8jXSspKD86Wy8/I118JCkvaS5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5ICE9PSB1bmRlZmluZWQgJiYgIWF1dGhvcml0eS5pbmNsdWRlcyhcIiVcIik7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxVUkxBdXRob3JpdHlIYXNVc2VyaW5mbyh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGF1dGhvcml0eSA9IC9eW0EtWmEtel1bQS1aYS16MC05Ky4tXSo6XFwvXFwvKFteLz8jXSopLy5leGVjKHZhbHVlKT8uWzFdO1xuICByZXR1cm4gYXV0aG9yaXR5Py5pbmNsdWRlcyhcIkBcIikgPz8gZmFsc2U7XG59XG4iXX0=