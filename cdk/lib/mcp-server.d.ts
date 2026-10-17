import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type { AppTheoryHttpApiCorsOptions } from "./http-api";
/** Route-emission model for AppTheoryMcpServer. */
export declare enum AppTheoryMcpRouteModel {
    /**
     * One API Gateway HTTP API v2 route per derived route key. This is the
     * construct's historical inventory and stays byte-identical for deployed
     * stacks, so a `routeModel: explicit` upgrade deploys in place. The default.
     */
    EXPLICIT = "explicit",
    /**
     * Two greedy routes, `ANY /` and `ANY /{proxy+}`, backed by one shared
     * integration. The AppTheory runtime router performs method and path
     * dispatch, path-parameter capture, and denial. Consolidation never changes
     * gateway admission, so it is valid only when every gateway route is `NONE`:
     * the `runtime-bearer` and `none-public` transport postures. `iam` and `jwt`
     * are refused at synthesis time.
     */
    CONSOLIDATED = "consolidated"
}
/** Construct-id derivation for the explicit route model. */
export declare enum AppTheoryMcpRouteIdMode {
    /**
     * Positional ids (`Route0`, `Route1`, ...) assigned in emission order. This
     * is the construct's historical inventory and stays byte-identical for
     * deployed stacks. The default.
     */
    LEGACY = "legacy",
    /**
     * Ids derived from the route method and pattern, so inserting, removing, or
     * reordering a route family never renames an unrelated route. Intended for
     * newly created explicit APIs: switching an existing deployed explicit API
     * from `legacy` to `semantic` in place renames every route, which is itself a
     * create-before-delete collision. Adopt it on an existing stack only through
     * the new-API swap described in `UPGRADING.md`.
     */
    SEMANTIC = "semantic"
}
/** Transport-route authorization posture for AppTheoryMcpServer. */
export declare enum AppTheoryMcpTransportPosture {
    /** AWS IAM (SigV4) on the transport routes. The default for a server with no facade attachment. */
    IAM = "iam",
    /** A static JWT authorizer (issuer + audience) on the transport routes. */
    JWT = "jwt",
    /** The gateway authorizer is NONE and the runtime validates RFC 9728 bearer tokens. The default for a facade-configured server. */
    RUNTIME_BEARER = "runtime-bearer",
    /** Deliberately public MCP server: every transport route is public. Never a default. */
    NONE_PUBLIC = "none-public"
}
/** Presence-only skeleton of the upstream-provider attachment that selects the facade-scoped default. */
export interface AppTheoryMcpFacadeAttachment {
    /** Identifies the upstream authorization provider this server fronts (for example `autheory`). Provider wiring lands in M3; this milestone validates the attachment shape and uses its presence to select the `runtime-bearer` default. */
    readonly providerId: string;
}
/** Runtime-side declaration that the transport routes validate RFC 9728 bearer tokens at runtime. */
export interface AppTheoryMcpRuntimePostureOptions {
    /** Assert the runtime registers the transport routes with the runtime-validated bearer posture (Go `FacadeConfig.RequireBearerToken`, TS `requireBearerTokenMiddleware`, Python `require_bearer_token_middleware`). Must be `true`. */
    readonly requireBearerToken: boolean;
}
/** Direct-origin reachability decision required under `runtime-bearer` and `none-public`. */
export declare enum AppTheoryMcpOriginReachability {
    /** The execute-api default endpoint is disabled. */
    DISABLED = "disabled",
    /** The origin is reachable only through a locked front door (CloudFront / VPC origin). */
    LOCKED = "locked"
}
/** Denial-telemetry declaration required under `runtime-bearer`. */
export interface AppTheoryMcpDenialSignalOptions {
    /** Denial metric name. Must be `apptheory.mcp.auth_denied`. @default apptheory.mcp.auth_denied */
    readonly metricName?: string;
    /** Bounded metric dimensions. Must be exactly `outcome` and `route_family`. @default ["outcome", "route_family"] */
    readonly dimensions?: string[];
}
/** Owning-API stage throttling decision. */
export interface AppTheoryMcpOwningApiThrottlingOptions {
    /** Stage rate limit in requests per second. */
    readonly rateLimit: number;
    /** Stage burst limit. */
    readonly burstLimit: number;
}
/** Attach-mode record of the owning API's defense-in-depth decisions (required under `runtime-bearer` and `none-public`). */
export interface AppTheoryMcpOwningApiDefenseOptions {
    /** Whether the owning API's stage has access logging enabled. Must be true. */
    readonly accessLogging: boolean;
    /** The owning API's stage throttling decision. */
    readonly throttling: AppTheoryMcpOwningApiThrottlingOptions;
}
/** Static JWT configuration for `transportPosture: JWT`. */
export interface AppTheoryMcpTransportAuthorizerOptions {
    /** Absolute HTTPS JWT issuer URL. Required under `transportPosture: JWT`. @default undefined */
    readonly issuer?: string;
    /** Accepted JWT audiences. Required under `transportPosture: JWT`. @default undefined */
    readonly audience?: string[];
    /** Identity sources for the JWT authorizer. @default ["$request.header.Authorization"] */
    readonly identitySource?: string[];
    /** JWT authorizer resource name. @default the authorizer construct id */
    readonly authorizerName?: string;
}
/** Custom domain configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerDomainOptions {
    /** The custom domain name (for example, `mcp.example.com`). */
    readonly domainName: string;
    /** ACM certificate for the domain. Provide this or `certificateArn`. */
    readonly certificate?: acm.ICertificate;
    /** ACM certificate ARN. Provide this or `certificate`. */
    readonly certificateArn?: string;
    /**
     * Route53 hosted zone for an automatically created CNAME record.
     * @default undefined
     */
    readonly hostedZone?: route53.IHostedZone;
}
/** Stage configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerStageOptions {
    /** @default "$default" */
    readonly stageName?: string;
    /** @default true */
    readonly accessLogging?: boolean;
    /**
     * Retention period for the access log group. Valid only when access logging
     * is enabled.
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /** @default true */
    readonly throttlingEnabled?: boolean;
    /**
     * Default-stage rate limit in requests per second.
     * @default 100
     */
    readonly throttlingRateLimit?: number;
    /**
     * Default-stage burst limit.
     * @default 200
     */
    readonly throttlingBurstLimit?: number;
}
/** Owned-API specialization for standalone MCP servers. */
export interface AppTheoryMcpServerOwnedApiOptions {
    /** Optional API name. */
    readonly apiName?: string;
    /** Optional custom domain owned by this construct. */
    readonly domain?: AppTheoryMcpServerDomainOptions;
    /**
     * Stage configuration. Access logging and throttling default on.
     * @default production defaults
     */
    readonly stage?: AppTheoryMcpServerStageOptions;
}
/** Ordered MCP route-pattern family wired as one facade. */
export interface AppTheoryMcpRouteFamily {
    /**
     * Ordered synthesis-time MCP route patterns.
     *
     * Each segment is either a literal RFC 3986 path segment or a complete
     * `{parameter_name}` segment. CDK tokens, origins, empty segments, dot
     * segments, greedy parameters, and duplicate patterns are rejected.
     */
    readonly patterns: string[];
    /**
     * Wire the algebra-derived unscoped authorization-server discovery route.
     * The runtime must supply `FacadeConfig.RootAuthorizationServer` too.
     * @default false
     */
    readonly rootAuthorizationServerDiscovery?: boolean;
}
/** DynamoDB-backed MCP session-state configuration. */
export interface AppTheoryMcpSessionStateOptions {
    /** @default true */
    readonly enabled?: boolean;
    /**
     * Session table name. Valid only when session state is enabled.
     * @default auto-generated
     */
    readonly tableName?: string;
    /**
     * TTL in minutes for session records. Valid only when session state is
     * enabled.
     * @default 60
     */
    readonly ttlMinutes?: number;
    /**
     * Session table removal policy. Valid only when session state is enabled.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;
}
/** One derived MCP OAuth facade route family. */
export interface AppTheoryMcpServerFacadeRoute {
    readonly mcpPattern: string;
    readonly mcpMethods: string[];
    readonly protectedResourcePattern: string;
    readonly discoveryCanonicalPattern: string;
    readonly discoverySuffixPattern: string;
    readonly authorizePattern: string;
    readonly tokenPattern: string;
    readonly registerPattern: string;
    readonly authorizationRoutesAttached: boolean;
}
/** Defensive snapshot of the construct's derived facade inventory. */
export interface AppTheoryMcpServerRouteInventory {
    readonly contractVersion: string;
    readonly routes: AppTheoryMcpServerFacadeRoute[];
    readonly rootAuthorizationServerPattern: string;
    readonly rootAuthorizationServerAttached: boolean;
    readonly callbackPattern: string;
}
/** Props for the AppTheoryMcpServer construct. */
export interface AppTheoryMcpServerProps {
    /** Lambda function handling the runtime-composed MCP facade. */
    readonly handler: lambda.IFunction;
    /**
     * Whether Lambda invoke permissions should be scoped to individual HTTP API v2 routes.
     *
     * When false, the construct grants one API-scoped invoke permission per Lambda instead of
     * one permission per route. This is the scalable choice for large MCP facade families that
     * share one Lambda, where the per-route permissions can exhaust the Lambda resource policy
     * size limit.
     *
     * The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
     * to invoke the handler, not only the routes this construct owns.
     *
     * @default true
     */
    readonly scopePermissionToRoute?: boolean;
    /**
     * Route-emission model.
     *
     * `explicit` (the default) wires the full derived route inventory as one HTTP
     * API v2 route per route key and is byte-stable for deployed stacks.
     * `consolidated` wires exactly two greedy routes, `ANY /` and `ANY /{proxy+}`,
     * and is valid only for the `runtime-bearer` and `none-public` transport
     * postures; `iam` and `jwt` are refused at synthesis.
     *
     * Consolidated mode is allowed on a construct-owned API, or on an attached
     * API that has no routes at attach time. "No routes" is enforced over the
     * whole stack, not just the API's own children: a route wired onto the
     * attached API from any sibling construct scope is refused, because it holds
     * a route key the greedy routes would collide with.
     *
     * A consumer may still add explicit, more specific routes to the consolidated
     * API afterwards, in either the attached or the construct-owned mode. That
     * exception is enforced at synthesis time and is allowed only when the added
     * route carries a non-NONE authorizer and does not redeclare the greedy
     * `ANY /` or `ANY /{proxy+}` key. Within it, a full method+path match beats the
     * greedy routes by API Gateway precedence, and a wrong-method hit on such a
     * path falls to the runtime's fail-closed 404/405.
     * @default AppTheoryMcpRouteModel.EXPLICIT
     */
    readonly routeModel?: AppTheoryMcpRouteModel;
    /**
     * Construct-id derivation for the explicit route model.
     *
     * `legacy` (the default) assigns positional ids in emission order and is
     * byte-stable for deployed stacks. `semantic` derives each id from its route
     * method and pattern, so inserting, removing, or reordering a route family
     * never renames an unrelated route; it is intended for newly created explicit
     * APIs.
     *
     * Switching an existing deployed explicit API from `legacy` to `semantic` in
     * place renames every route in one update, which is exactly the
     * create-before-delete route-key collision the migration check refuses. Adopt
     * `semantic` on an existing stack only through the new-API swap documented in
     * `UPGRADING.md`.
     *
     * This prop applies to `routeModel: explicit` only. The `consolidated` model
     * already emits the two fixed semantic ids `RouteAnyRoot` and `RouteAnyProxy`.
     * @default AppTheoryMcpRouteIdMode.LEGACY
     */
    readonly routeIdMode?: AppTheoryMcpRouteIdMode;
    /**
     * CORS preflight for a construct-owned API. Set to `true` for AppTheory
     * defaults or supply an `AppTheoryHttpApiCorsOptions` object. Invalid in
     * attach mode, where the owning API configures CORS.
     * @default undefined
     */
    readonly cors?: boolean | AppTheoryHttpApiCorsOptions;
    /**
     * Existing HTTP API to attach to. Attach mode is the primary front-door
     * topology and never creates an `AWS::ApiGatewayV2::Api` resource.
     * @default a construct-owned HttpApi
     */
    readonly api?: apigwv2.IHttpApi;
    /**
     * Stage name used when deriving attach-mode execute-api endpoint templates.
     * Use `$default` for the API Gateway default stage. When omitted, the stage
     * is not determinable and the templates retain the bare execute-api origin.
     * This prop does not create, import, or mutate a stage.
     * @default undefined
     */
    readonly attachedApiStageName?: string;
    /**
     * Ordered MCP route family.
     *
     * Go `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical default
     * family. Noncanonical patterns require app-owned runtime route registration
     * that matches the construct's `routeInventory`.
     * @default AppTheoryMcpRouteAlgebra.supportedEndpointTemplates()
     */
    readonly routeFamily?: AppTheoryMcpRouteFamily;
    /**
     * Transport-route authorization posture.
     *
     * An explicit selection overrides the facade-scoped default. When it is
     * omitted, a server that attaches `facade` resolves to `runtime-bearer` and a
     * plain transport server resolves to `iam`. `none-public` is never a default
     * and carries the defense-in-depth floor.
     * @default AppTheoryMcpTransportPosture.RUNTIME_BEARER when `facade` is attached, otherwise AppTheoryMcpTransportPosture.IAM
     */
    readonly transportPosture?: AppTheoryMcpTransportPosture;
    /**
     * Upstream-provider attachment that marks this server as facade-configured.
     *
     * The attachment's presence selects the `runtime-bearer` posture default.
     * Provider wiring lands in M3; this milestone validates the attachment shape.
     * @default undefined
     */
    readonly facade?: AppTheoryMcpFacadeAttachment;
    /**
     * Runtime-side RFC 9728 bearer validation declaration.
     *
     * Required by `transportPosture: RUNTIME_BEARER` and refused under every
     * other posture.
     * @default undefined
     */
    readonly runtimePosture?: AppTheoryMcpRuntimePostureOptions;
    /**
     * Direct-origin reachability decision required under RUNTIME_BEARER and
     * NONE_PUBLIC. A directly reachable origin is refused.
     * @default undefined
     */
    readonly originReachability?: AppTheoryMcpOriginReachability;
    /**
     * Denial-telemetry declaration required under RUNTIME_BEARER only.
     * @default undefined
     */
    readonly denialSignal?: AppTheoryMcpDenialSignalOptions;
    /**
     * Attach-mode record of the owning API's throttling and access-logging
     * decisions, required under RUNTIME_BEARER and NONE_PUBLIC.
     * @default undefined
     */
    readonly owningApiDefense?: AppTheoryMcpOwningApiDefenseOptions;
    /**
     * Static JWT configuration for the MCP transport routes.
     *
     * Transport routes are the POST, GET, and DELETE routes on every MCP pattern.
     * This prop is only valid with `transportPosture: JWT`, which requires an
     * issuer and a non-empty audience. Discovery, protected-resource metadata,
     * authorize, and token routes remain explicitly public (`NONE`) because OAuth
     * clients must fetch them before they hold a token.
     * @default undefined
     */
    readonly transportAuthorizer?: AppTheoryMcpTransportAuthorizerOptions;
    /**
     * Stage-global upstream OAuth callback path.
     *
     * The CDK-mounted callback route and the runtime-registered one must not
     * diverge: this prop is resolved by
     * `AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath`, the same algebra
     * the runtime applies to `FacadeConfig.UpstreamCallbackPath`. Supply a
     * synthesis-time literal absolute path with no query, fragment, or dot
     * segment; an empty value keeps the contract default, and a value that
     * collides with another derived route fails synthesis. Refused under
     * `transportPosture: none-public`, which attaches no OAuth surface.
     * @default AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH
     */
    readonly upstreamCallbackPath?: string;
    /**
     * Session-state table configuration. The table defaults on.
     * @default enabled with production defaults
     */
    readonly sessionState?: AppTheoryMcpSessionStateOptions;
    /**
     * Owned-API configuration for standalone mode. Invalid with `api`.
     * @default production-owned API defaults
     */
    readonly ownedApi?: AppTheoryMcpServerOwnedApiOptions;
    /**
     * Single MCP route path from the v3.1.x A6 surface.
     * @deprecated Use `routeFamily.patterns`. The new default is the canonical
     * four-pattern family; use `{ patterns: ['/mcp'] }` for the old singleton.
     */
    readonly mcpPath?: string;
    /**
     * Authorization-server issuer from the v3.1.x A6 environment contract.
     * @deprecated Configure `runtime/mcpfacade.FacadeConfig.IssuerURL` in the
     * application. The construct no longer injects issuer environment values.
     */
    readonly authorizationServerIssuer?: string;
    /**
     * JWKS URI from the v3.1.x A6 environment contract.
     * @deprecated Configure `runtime/mcpfacade.FacadeConfig.JWKSURI` in the
     * application. The construct no longer injects JWKS environment values.
     */
    readonly jwksUri?: string;
    /** @deprecated Use `ownedApi.apiName`. */
    readonly apiName?: string;
    /**
     * @deprecated Use `sessionState.enabled`. Session state now defaults on.
     */
    readonly enableSessionTable?: boolean;
    /** @deprecated Use `sessionState.tableName`. */
    readonly sessionTableName?: string;
    /** @deprecated Use `sessionState.ttlMinutes`. */
    readonly sessionTtlMinutes?: number;
    /**
     * @deprecated Use `ownedApi.domain`. Domains are invalid in attach mode.
     */
    readonly domain?: AppTheoryMcpServerDomainOptions;
    /**
     * @deprecated Use `ownedApi.stage`. Stage options are invalid in attach mode.
     */
    readonly stage?: AppTheoryMcpServerStageOptions;
}
/**
 * Contract-first MCP facade deployment construct.
 *
 * The primary mode attaches the complete route-algebra family to a supplied
 * HTTP API. Omitting `api` specializes the same path into a standalone owned
 * API. The construct routes only: OAuth metadata, scopes, capabilities, and
 * authorize/token behavior remain application-owned through Go
 * `mcpfacade.RegisterMCPFacade`.
 */
export declare class AppTheoryMcpServer extends Construct {
    private routeSequence;
    private routeIdMode;
    private readonly routeIds;
    readonly api: apigwv2.IHttpApi;
    readonly ownedApi?: apigwv2.HttpApi;
    readonly sessionTable?: dynamodb.ITable;
    /**
     * Resolved transport-route authorization posture.
     *
     * Facade-configured servers resolve to `runtime-bearer` unless
     * `transportPosture` overrides the default; plain transport servers resolve
     * to `iam`. Deliberately public servers must select `none-public` explicitly.
     */
    readonly transportPosture: AppTheoryMcpTransportPosture;
    /**
     * Derived endpoint templates for the ordered MCP route family.
     *
     * In attach mode these are execute-api origin templates, not declarations of
     * public authority. An `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted; the origin is derived
     * from `apiId`, the stack region and URL suffix, plus
     * `attachedApiStageName` when supplied.
     */
    readonly endpoints: string[];
    readonly mcpPaths: string[];
    readonly protectedResourceMetadataPaths: string[];
    readonly routeInventory: AppTheoryMcpServerRouteInventory;
    /**
     * First derived endpoint template.
     *
     * In attach mode an `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted. This value is an
     * execute-api origin template derived by the same rules as `endpoints`, not
     * the front door's public authority.
     * @deprecated Use `endpoints`.
     */
    readonly endpoint: string;
    /** @deprecated Use `mcpPaths`. */
    readonly mcpPath: string;
    /** @deprecated Use `protectedResourceMetadataPaths` or `routeInventory`. */
    readonly protectedResourceMetadataPath: string;
    readonly domainName?: apigwv2.DomainName;
    readonly apiMapping?: apigwv2.ApiMapping;
    readonly cnameRecord?: route53.CnameRecord;
    readonly accessLogGroup?: logs.ILogGroup;
    constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps);
    private addRuntimeRoute;
    private nextRouteConstructId;
    private addConsolidatedRoute;
    private addEnvironment;
    private setupCustomDomain;
}
