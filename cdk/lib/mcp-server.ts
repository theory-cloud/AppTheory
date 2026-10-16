import { RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { AppTheoryMcpRouteAlgebra } from "./mcp-route-algebra";
import { buildCorsPreflight } from "./cors";
import type { AppTheoryHttpApiCorsOptions } from "./http-api";
import { semanticRouteConstructId } from "./route-ids";

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
export enum AppTheoryMcpRouteModel {
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
  CONSOLIDATED = "consolidated",
}

/** Construct-id derivation for the explicit route model. */
export enum AppTheoryMcpRouteIdMode {
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
  SEMANTIC = "semantic",
}

/** Transport-route authorization posture for AppTheoryMcpServer. */
export enum AppTheoryMcpTransportPosture {
  /** AWS IAM (SigV4) on the transport routes. The default for a server with no facade attachment. */
  IAM = "iam",
  /** A static JWT authorizer (issuer + audience) on the transport routes. */
  JWT = "jwt",
  /** The gateway authorizer is NONE and the runtime validates RFC 9728 bearer tokens. The default for a facade-configured server. */
  RUNTIME_BEARER = "runtime-bearer",
  /** Deliberately public MCP server: every transport route is public. Never a default. */
  NONE_PUBLIC = "none-public",
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
export enum AppTheoryMcpOriginReachability {
  /** The execute-api default endpoint is disabled. */
  DISABLED = "disabled",
  /** The origin is reachable only through a locked front door (CloudFront / VPC origin). */
  LOCKED = "locked",
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
   * API that has no routes at attach time. A consumer may add explicit, more
   * specific routes with a stricter authorizer on the same API afterwards; a
   * full method+path match beats the greedy routes by API Gateway precedence,
   * and a wrong-method hit on such a path falls to the runtime's fail-closed
   * 404/405.
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
export class AppTheoryMcpServer extends Construct {
  private routeSequence = 0;
  private routeIdMode = AppTheoryMcpRouteIdMode.LEGACY;
  private readonly routeIds = new Set<string>();

  public readonly api: apigwv2.IHttpApi;
  public readonly ownedApi?: apigwv2.HttpApi;
  public readonly sessionTable?: dynamodb.ITable;
  /**
   * Resolved transport-route authorization posture.
   *
   * Facade-configured servers resolve to `runtime-bearer` unless
   * `transportPosture` overrides the default; plain transport servers resolve
   * to `iam`. Deliberately public servers must select `none-public` explicitly.
   */
  public readonly transportPosture: AppTheoryMcpTransportPosture;
  /**
   * Derived endpoint templates for the ordered MCP route family.
   *
   * In attach mode these are execute-api origin templates, not declarations of
   * public authority. An `apiEndpoint` supplied through
   * `HttpApi.fromHttpApiAttributes` is never consulted; the origin is derived
   * from `apiId`, the stack region and URL suffix, plus
   * `attachedApiStageName` when supplied.
   */
  public readonly endpoints: string[];
  public readonly mcpPaths: string[];
  public readonly protectedResourceMetadataPaths: string[];
  public readonly routeInventory: AppTheoryMcpServerRouteInventory;

  /**
   * First derived endpoint template.
   *
   * In attach mode an `apiEndpoint` supplied through
   * `HttpApi.fromHttpApiAttributes` is never consulted. This value is an
   * execute-api origin template derived by the same rules as `endpoints`, not
   * the front door's public authority.
   * @deprecated Use `endpoints`.
   */
  public readonly endpoint: string;

  /** @deprecated Use `mcpPaths`. */
  public readonly mcpPath: string;

  /** @deprecated Use `protectedResourceMetadataPaths` or `routeInventory`. */
  public readonly protectedResourceMetadataPath: string;

  public readonly domainName?: apigwv2.DomainName;
  public readonly apiMapping?: apigwv2.ApiMapping;
  public readonly cnameRecord?: route53.CnameRecord;
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps) {
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
      assertConsolidatedAttachAllowed(props.api);
    }
    const authorizationRoutesAttached = posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC;
    const upstreamCallbackPath = resolveUpstreamCallbackPath(props);

    this.transportPosture = posture;
    this.mcpPaths = [...routeFamily.patterns];
    this.routeInventory = buildRouteInventory(
      this.mcpPaths,
      authorizationRoutesAttached,
      routeFamily.rootAuthorizationServerDiscovery,
      upstreamCallbackPath,
    );
    validateRouteInventory(this.routeInventory, authorizationRoutesAttached);
    this.protectedResourceMetadataPaths = this.routeInventory.routes.map(
      (route) => route.protectedResourcePattern,
    );
    this.mcpPath = this.mcpPaths[0];
    this.protectedResourceMetadataPath = this.protectedResourceMetadataPaths[0];

    const ownedOptions = normalizeOwnedApiOptions(props);
    let ownedStage: apigwv2.IStage | undefined;
    let ownedStageName = "$default";
    if (props.api) {
      this.api = props.api;
    } else {
      const stageOptions = normalizeStageOptions(ownedOptions.stage);
      ownedStageName = stageOptions.stageName;
      const api = new apigwv2.HttpApi(this, "Api", {
        apiName: ownedOptions.apiName,
        corsPreflight: buildCorsPreflight(props.cors),
        createDefaultStage: false,
      });
      (this as { ownedApi?: apigwv2.HttpApi }).ownedApi = api;
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
        (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = logGroup;
        const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
        cfnStage.accessLogSettings = {
          destinationArn: logGroup.logGroupArn,
          format: accessLogFormat(),
        };
      }
    }

    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      "McpHandler",
      props.handler,
      {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        scopePermissionToRoute: props.scopePermissionToRoute ?? true,
      },
    );
    const transportAuthorizer = resolveTransportAuthorizer(props, posture);
    let firstTransportRoute: apigwv2.HttpRoute | undefined;
    if (routeModel === AppTheoryMcpRouteModel.CONSOLIDATED) {
      firstTransportRoute = this.addConsolidatedRoute(
        CONSOLIDATED_ROOT_ROUTE_ID,
        "/",
        integration,
        transportAuthorizer,
      );
      this.addConsolidatedRoute(
        CONSOLIDATED_PROXY_ROUTE_ID,
        "/{proxy+}",
        integration,
        transportAuthorizer,
      );
    } else {
      const runtimeOwnedAuth = new apigwv2.HttpNoneAuthorizer();
      for (const route of this.routeInventory.routes) {
        for (const method of route.mcpMethods) {
          const created = this.addRuntimeRoute(
            route.mcpPattern,
            toHttpMethod(method),
            integration,
            transportAuthorizer,
          );
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
        this.addRuntimeRoute(
          this.routeInventory.callbackPattern,
          apigwv2.HttpMethod.GET,
          integration,
          runtimeOwnedAuth,
        );
      }
      if (this.routeInventory.rootAuthorizationServerAttached) {
        this.addRuntimeRoute(
          this.routeInventory.rootAuthorizationServerPattern,
          apigwv2.HttpMethod.GET,
          integration,
          runtimeOwnedAuth,
        );
      }
    }

    const postureMarkerTarget = (this.ownedApi?.node.defaultChild
      ?? firstTransportRoute?.node.defaultChild) as apigwv2.CfnApi | apigwv2.CfnRoute | undefined;
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

    let endpointBase: string;
    if (ownedOptions.domain) {
      if (!ownedStage) {
        throw new Error("AppTheoryMcpServer: domain configuration requires construct-owned API mode");
      }
      this.setupCustomDomain(ownedOptions.domain, ownedStage);
      endpointBase = `https://${ownedOptions.domain.domainName}`;
    } else if (props.api) {
      const stack = Stack.of(this);
      const executeApiOrigin = `https://${this.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
      endpointBase = props.attachedApiStageName === undefined || props.attachedApiStageName === "$default"
        ? executeApiOrigin
        : `${executeApiOrigin}/${props.attachedApiStageName}`;
    } else {
      endpointBase = ownedStageName === "$default"
        ? this.api.apiEndpoint
        : `${this.api.apiEndpoint}/${ownedStageName}`;
    }
    this.endpoints = this.mcpPaths.map(
      (pattern) => `${stripTrailingSlash(endpointBase)}${pattern}`,
    );
    this.endpoint = this.endpoints[0];
  }

  private addRuntimeRoute(
    path: string,
    method: apigwv2.HttpMethod,
    integration: apigwv2Integrations.HttpLambdaIntegration,
    authorizer: apigwv2.IHttpRouteAuthorizer,
  ): apigwv2.HttpRoute {
    return new apigwv2.HttpRoute(this, this.nextRouteConstructId(method, path), {
      httpApi: this.api,
      routeKey: apigwv2.HttpRouteKey.with(path, method),
      integration,
      authorizer,
    });
  }

  private nextRouteConstructId(method: apigwv2.HttpMethod, path: string): string {
    if (this.routeIdMode !== AppTheoryMcpRouteIdMode.SEMANTIC) {
      return `Route${this.routeSequence++}`;
    }
    const id = semanticRouteConstructId(method, path);
    if (this.routeIds.has(id)) {
      throw new Error(
        `AppTheoryMcpServer: routeIdMode semantic derives the duplicate route construct id ${id} for route key ${method} ${path}`,
      );
    }
    this.routeIds.add(id);
    return id;
  }

  private addConsolidatedRoute(
    id: string,
    path: string,
    integration: apigwv2Integrations.HttpLambdaIntegration,
    authorizer: apigwv2.IHttpRouteAuthorizer,
  ): apigwv2.HttpRoute {
    return new apigwv2.HttpRoute(this, id, {
      httpApi: this.api,
      routeKey: apigwv2.HttpRouteKey.with(path, apigwv2.HttpMethod.ANY),
      integration,
      authorizer,
    });
  }

  private addEnvironment(handler: lambda.IFunction, key: string, value: string): void {
    if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
      handler.addEnvironment(key, value);
    }
  }

  private setupCustomDomain(
    options: AppTheoryMcpServerDomainOptions,
    stage: apigwv2.IStage,
  ): void {
    const certificate = options.certificate ?? (options.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "ImportedCert", options.certificateArn) as acm.ICertificate
      : undefined);
    if (!certificate) {
      throw new Error(
        "AppTheoryMcpServer: ownedApi.domain requires either certificate or certificateArn",
      );
    }
    const domainName = new apigwv2.DomainName(this, "DomainName", {
      domainName: options.domainName,
      certificate,
    });
    (this as { domainName?: apigwv2.DomainName }).domainName = domainName;
    const apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
      api: this.api,
      domainName,
      stage,
    });
    (this as { apiMapping?: apigwv2.ApiMapping }).apiMapping = apiMapping;
    if (options.hostedZone) {
      const cnameRecord = new route53.CnameRecord(this, "CnameRecord", {
        zone: options.hostedZone,
        recordName: toRoute53RecordName(options.domainName, options.hostedZone),
        domainName: domainName.regionalDomainName,
      });
      (this as { cnameRecord?: route53.CnameRecord }).cnameRecord = cnameRecord;
    }
  }
}

interface NormalizedRouteFamily {
  readonly patterns: string[];
  readonly rootAuthorizationServerDiscovery: boolean;
}

interface NormalizedOwnedApiOptions {
  readonly apiName?: string;
  readonly domain?: AppTheoryMcpServerDomainOptions;
  readonly stage?: AppTheoryMcpServerStageOptions;
}

interface NormalizedStageOptions {
  readonly stageName: string;
  readonly accessLogging: boolean;
  readonly accessLogRetention: logs.RetentionDays;
  readonly throttlingEnabled: boolean;
  readonly throttlingRateLimit: number;
  readonly throttlingBurstLimit: number;
}

interface NormalizedSessionState {
  readonly enabled: boolean;
  readonly tableName?: string;
  readonly ttlMinutes: number;
  readonly removalPolicy: RemovalPolicy;
}

function normalizeRouteFamily(props: AppTheoryMcpServerProps): NormalizedRouteFamily {
  if (props.routeFamily !== undefined && props.mcpPath !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: routeFamily and deprecated mcpPath cannot be supplied together",
    );
  }
  const rawPatterns = props.routeFamily?.patterns
    ?? (props.mcpPath !== undefined
      ? [props.mcpPath]
      : AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map(
        (template) => template.mcpPattern,
      ));
  if (rawPatterns.length === 0) {
    throw new Error("AppTheoryMcpServer: routeFamily.patterns must not be empty");
  }
  const patterns = rawPatterns.map((pattern, index) =>
    normalizeRoutePath(pattern, `routeFamily.patterns[${index}]`));
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (seen.has(pattern)) {
      throw new Error(
        `AppTheoryMcpServer: routeFamily.patterns contains duplicate pattern ${JSON.stringify(pattern)}`,
      );
    }
    seen.add(pattern);
  }
  return {
    patterns,
    rootAuthorizationServerDiscovery:
      props.routeFamily?.rootAuthorizationServerDiscovery ?? false,
  };
}

function normalizeRoutePath(value: string, propName: string): string {
  if (Token.isUnresolved(value)) {
    throw new Error(
      `AppTheoryMcpServer: ${propName} must be a synthesis-time literal route pattern`,
    );
  }
  const routePath = String(value ?? "");
  if (!routePath.startsWith("/")) throw invalidRoutePattern(propName);
  const segments = routePath.slice(1).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    throw invalidRoutePattern(propName);
  }
  const literal = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
  const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw invalidRoutePattern(propName);
    if (parameter.test(segment)) continue;
    if (!literal.test(segment) || segment.includes("{") || segment.includes("}")) {
      throw invalidRoutePattern(propName);
    }
  }
  return routePath;
}

function invalidRoutePattern(propName: string): Error {
  return new Error(
    `AppTheoryMcpServer: ${propName} must be an absolute synthesis-time route pattern with non-empty literal or {parameter_name} segments and no dot segments`,
  );
}

function resolveUpstreamCallbackPath(props: AppTheoryMcpServerProps): string {
  const configured = props.upstreamCallbackPath;
  if (configured === undefined) {
    return AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH;
  }
  if (Token.isUnresolved(configured)) {
    throw new Error(
      "AppTheoryMcpServer: upstreamCallbackPath must be a synthesis-time literal route path",
    );
  }
  try {
    return AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath(configured);
  } catch (err) {
    const reason = err instanceof Error
      ? err.message.replace(/^mcproutes: /, "")
      : String(err);
    throw new Error(
      `AppTheoryMcpServer: upstreamCallbackPath is invalid: ${reason}`,
    );
  }
}

function buildRouteInventory(
  patterns: string[],
  authorizationRoutesAttached: boolean,
  rootAuthorizationServerAttached: boolean,
  callbackPattern: string,
): AppTheoryMcpServerRouteInventory {
  return {
    contractVersion: AppTheoryMcpRouteAlgebra.CONTRACT_VERSION,
    routes: patterns.map((mcpPattern) => ({
      mcpPattern,
      mcpMethods: ["POST", "GET", "DELETE"],
      protectedResourcePattern:
        AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(mcpPattern),
      discoveryCanonicalPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(mcpPattern),
      discoverySuffixPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(mcpPattern),
      authorizePattern:
        AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(mcpPattern),
      tokenPattern:
        AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(mcpPattern),
      registerPattern:
        AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(mcpPattern),
      authorizationRoutesAttached,
    })),
    rootAuthorizationServerPattern:
      AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
    rootAuthorizationServerAttached,
    callbackPattern,
  };
}

function validateRouteInventory(
  inventory: AppTheoryMcpServerRouteInventory,
  authorizationRoutesAttached: boolean,
): void {
  const seen = new Set<string>();
  const add = (method: string, path: string): void => {
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      throw new Error(`AppTheoryMcpServer: derived route family collides at ${key}`);
    }
    seen.add(key);
  };
  for (const route of inventory.routes) {
    for (const method of route.mcpMethods) add(method, route.mcpPattern);
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

function validateOwningMode(props: AppTheoryMcpServerProps): void {
  if (!props.api) {
    if (props.attachedApiStageName !== undefined) {
      throw new Error(
        "AppTheoryMcpServer: attachedApiStageName requires attach mode with api",
      );
    }
    return;
  }
  if (
    props.attachedApiStageName !== undefined
    && (Token.isUnresolved(props.attachedApiStageName)
      || !/^(?:\$default|[A-Za-z0-9_-]{1,128})$/.test(props.attachedApiStageName))
  ) {
    throw new Error(
      "AppTheoryMcpServer: attachedApiStageName must be a synthesis-time literal API Gateway stage name",
    );
  }
  const invalid: string[] = [];
  if (props.ownedApi !== undefined) invalid.push("ownedApi");
  if (props.apiName !== undefined) invalid.push("apiName");
  if (props.cors !== undefined) invalid.push("cors");
  if (props.domain !== undefined) invalid.push("domain");
  if (props.stage !== undefined) invalid.push("stage");
  if (invalid.length !== 0) {
    throw new Error(
      `AppTheoryMcpServer: attach mode with api cannot configure owned-API props: ${invalid.join(", ")}`,
    );
  }
}

function normalizeOwnedApiOptions(props: AppTheoryMcpServerProps): NormalizedOwnedApiOptions {
  if (props.ownedApi?.apiName !== undefined && props.apiName !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.apiName and deprecated apiName cannot be supplied together",
    );
  }
  if (props.ownedApi?.domain !== undefined && props.domain !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.domain and deprecated domain cannot be supplied together",
    );
  }
  if (props.ownedApi?.stage !== undefined && props.stage !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage and deprecated stage cannot be supplied together",
    );
  }
  return {
    apiName: props.ownedApi?.apiName ?? props.apiName,
    domain: props.ownedApi?.domain ?? props.domain,
    stage: props.ownedApi?.stage ?? props.stage,
  };
}

function normalizeStageOptions(options?: AppTheoryMcpServerStageOptions): NormalizedStageOptions {
  const accessLogging = options?.accessLogging ?? true;
  if (!accessLogging && options?.accessLogRetention !== undefined) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage.accessLogRetention requires accessLogging to be enabled",
    );
  }
  const throttlingEnabled = options?.throttlingEnabled ?? true;
  if (
    !throttlingEnabled
    && (options?.throttlingRateLimit !== undefined || options?.throttlingBurstLimit !== undefined)
  ) {
    throw new Error(
      "AppTheoryMcpServer: ownedApi.stage throttling limits require throttlingEnabled to be true",
    );
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

function normalizeSessionState(props: AppTheoryMcpServerProps): NormalizedSessionState {
  const hasLegacy = props.enableSessionTable !== undefined
    || props.sessionTableName !== undefined
    || props.sessionTtlMinutes !== undefined;
  if (props.sessionState !== undefined && hasLegacy) {
    throw new Error(
      "AppTheoryMcpServer: sessionState cannot be combined with deprecated session-table props",
    );
  }
  const enabled = props.sessionState?.enabled ?? props.enableSessionTable ?? true;
  const tableName = props.sessionState?.tableName ?? props.sessionTableName;
  const ttlMinutes = props.sessionState?.ttlMinutes
    ?? props.sessionTtlMinutes
    ?? DEFAULT_SESSION_TTL_MINUTES;
  const removalPolicy = props.sessionState?.removalPolicy ?? RemovalPolicy.RETAIN;
  if (
    !enabled
    && (tableName !== undefined
      || props.sessionState?.ttlMinutes !== undefined
      || props.sessionState?.removalPolicy !== undefined
      || props.sessionTableName !== undefined
      || props.sessionTtlMinutes !== undefined)
  ) {
    throw new Error(
      "AppTheoryMcpServer: disabled session state cannot configure tableName, ttlMinutes, or removalPolicy",
    );
  }
  validatePositiveInteger(ttlMinutes, "sessionState.ttlMinutes");
  return { enabled, tableName, ttlMinutes, removalPolicy };
}

function normalizeLegacyAuthConfig(props: AppTheoryMcpServerProps): void {
  const hasIssuer = props.authorizationServerIssuer !== undefined;
  const hasJwksUri = props.jwksUri !== undefined;
  if (hasIssuer !== hasJwksUri) {
    throw new Error(
      "AppTheoryMcpServer: authorizationServerIssuer and jwksUri must be supplied together",
    );
  }
  if (!hasIssuer || !hasJwksUri) return;
  const issuer = String(props.authorizationServerIssuer);
  const jwksUri = String(props.jwksUri);
  if (!Token.isUnresolved(issuer)) {
    validateLiteralOAuthURL(
      issuer,
      false,
      "authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment",
    );
  }
  if (!Token.isUnresolved(jwksUri)) {
    validateLiteralOAuthURL(
      jwksUri,
      true,
      "jwksUri must be an absolute HTTPS URL with no userinfo or fragment",
    );
  }
}

function resolveTransportAuthorizer(
  props: AppTheoryMcpServerProps,
  posture: AppTheoryMcpTransportPosture,
): apigwv2.IHttpRouteAuthorizer {
  const configured = props.transportAuthorizer;
  switch (posture) {
    case AppTheoryMcpTransportPosture.IAM:
    case AppTheoryMcpTransportPosture.RUNTIME_BEARER:
    case AppTheoryMcpTransportPosture.NONE_PUBLIC: {
      if (configured !== undefined) {
        throw new Error(
          "AppTheoryMcpServer: transportAuthorizer is only valid with transportPosture JWT",
        );
      }
      return posture === AppTheoryMcpTransportPosture.IAM
        ? new apigwv2Authorizers.HttpIamAuthorizer()
        : new apigwv2.HttpNoneAuthorizer();
    }
    case AppTheoryMcpTransportPosture.JWT: {
      const issuer = String(configured?.issuer ?? "").trim();
      if (issuer === "") {
        throw new Error(
          "AppTheoryMcpServer: transportAuthorizer.issuer is required when transportPosture is JWT",
        );
      }
      if (!Token.isUnresolved(issuer)) {
        validateLiteralOAuthURL(
          issuer,
          false,
          "transportAuthorizer.issuer must be an absolute HTTPS URL with no query or fragment",
        );
      }
      const audience = (configured?.audience ?? [])
        .map((value) => String(value).trim())
        .filter((value) => value !== "");
      if (audience.length === 0) {
        throw new Error(
          "AppTheoryMcpServer: transportAuthorizer.audience requires at least one accepted audience when transportPosture is JWT",
        );
      }
      return new apigwv2Authorizers.HttpJwtAuthorizer(
        MCP_TRANSPORT_AUTHORIZER_ID,
        issuer,
        {
          jwtAudience: audience,
          identitySource: configured?.identitySource,
          authorizerName: configured?.authorizerName,
        },
      );
    }
    default:
      throw new Error(
        "AppTheoryMcpServer: transportPosture must be AppTheoryMcpTransportPosture.IAM, .JWT, .RUNTIME_BEARER, or .NONE_PUBLIC",
      );
  }
}

function postureLabel(posture: AppTheoryMcpTransportPosture): string {
  switch (posture) {
    case AppTheoryMcpTransportPosture.IAM: return "IAM";
    case AppTheoryMcpTransportPosture.JWT: return "JWT";
    case AppTheoryMcpTransportPosture.RUNTIME_BEARER: return "RUNTIME_BEARER";
    case AppTheoryMcpTransportPosture.NONE_PUBLIC: return "NONE_PUBLIC";
    default: return String(posture);
  }
}

function validateTransportPosture(posture: AppTheoryMcpTransportPosture): void {
  switch (posture) {
    case AppTheoryMcpTransportPosture.IAM:
    case AppTheoryMcpTransportPosture.JWT:
    case AppTheoryMcpTransportPosture.RUNTIME_BEARER:
    case AppTheoryMcpTransportPosture.NONE_PUBLIC:
      return;
    default:
      throw new Error(
        "AppTheoryMcpServer: transportPosture must be AppTheoryMcpTransportPosture.IAM, .JWT, .RUNTIME_BEARER, or .NONE_PUBLIC",
      );
  }
}

function resolveRouteModel(props: AppTheoryMcpServerProps): AppTheoryMcpRouteModel {
  const configured = props.routeModel;
  if (configured === undefined) {
    return AppTheoryMcpRouteModel.EXPLICIT;
  }
  if (
    configured === AppTheoryMcpRouteModel.EXPLICIT
    || configured === AppTheoryMcpRouteModel.CONSOLIDATED
  ) {
    return configured;
  }
  throw new Error(
    "AppTheoryMcpServer: routeModel must be AppTheoryMcpRouteModel.EXPLICIT or .CONSOLIDATED",
  );
}

function validateRouteModelPosture(
  routeModel: AppTheoryMcpRouteModel,
  posture: AppTheoryMcpTransportPosture,
): void {
  if (
    routeModel === AppTheoryMcpRouteModel.CONSOLIDATED
    && posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
    && posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC
  ) {
    throw new Error(
      `AppTheoryMcpServer: routeModel consolidated is only valid for transportPosture RUNTIME_BEARER or NONE_PUBLIC; transportPosture ${postureLabel(posture)} keeps the explicit route model because consolidation must never change gateway admission`,
    );
  }
}

function resolveRouteIdMode(props: AppTheoryMcpServerProps): AppTheoryMcpRouteIdMode {
  const configured = props.routeIdMode;
  if (configured === undefined) {
    return AppTheoryMcpRouteIdMode.LEGACY;
  }
  if (
    configured === AppTheoryMcpRouteIdMode.LEGACY
    || configured === AppTheoryMcpRouteIdMode.SEMANTIC
  ) {
    return configured;
  }
  throw new Error(
    "AppTheoryMcpServer: routeIdMode must be AppTheoryMcpRouteIdMode.LEGACY or .SEMANTIC",
  );
}

function assertConsolidatedAttachAllowed(api: apigwv2.IHttpApi): void {
  const existingRoutes = api.node.children.filter((child) => child instanceof apigwv2.HttpRoute);
  if (existingRoutes.length > 0) {
    throw new Error(
      "AppTheoryMcpServer: routeModel consolidated may attach only to an API that has no routes at attach time; attach to a new or empty API, or use routeModel explicit",
    );
  }
}

function validateFacadeAttachment(facade?: AppTheoryMcpFacadeAttachment): void {
  if (facade === undefined) return;
  const providerId = (facade as { providerId?: unknown })?.providerId;
  if (
    typeof providerId !== "string"
    || providerId.trim() === ""
    || Token.isUnresolved(providerId)
  ) {
    throw new Error(
      "AppTheoryMcpServer: facade.providerId must be a non-empty synthesis-time literal string",
    );
  }
}

function validatePostureGuards(
  props: AppTheoryMcpServerProps,
  routeFamily: NormalizedRouteFamily,
  posture: AppTheoryMcpTransportPosture,
): void {
  if (posture === AppTheoryMcpTransportPosture.NONE_PUBLIC) {
    if (props.authorizationServerIssuer !== undefined || props.jwksUri !== undefined) {
      throw new Error(
        "AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot be combined with authorizationServerIssuer or jwksUri",
      );
    }
    if (routeFamily.rootAuthorizationServerDiscovery) {
      throw new Error(
        "AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot enable rootAuthorizationServerDiscovery",
      );
    }
    if (props.runtimePosture !== undefined) {
      throw new Error(
        "AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot declare runtimePosture",
      );
    }
    if (props.upstreamCallbackPath !== undefined) {
      throw new Error(
        "AppTheoryMcpServer: transportPosture NONE_PUBLIC cannot declare upstreamCallbackPath",
      );
    }
    return;
  }
  if (
    posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
    && props.runtimePosture !== undefined
  ) {
    throw new Error(
      `AppTheoryMcpServer: transportPosture ${postureLabel(posture)} cannot declare runtimePosture`,
    );
  }
}

function validateDefenseInDepth(
  props: AppTheoryMcpServerProps,
  posture: AppTheoryMcpTransportPosture,
): void {
  if (
    posture !== AppTheoryMcpTransportPosture.RUNTIME_BEARER
    && posture !== AppTheoryMcpTransportPosture.NONE_PUBLIC
  ) {
    return;
  }
  const label = postureLabel(posture);
  if (
    posture === AppTheoryMcpTransportPosture.RUNTIME_BEARER
    && (props.runtimePosture === undefined || props.runtimePosture.requireBearerToken !== true)
  ) {
    throw new Error(
      "AppTheoryMcpServer: transportPosture RUNTIME_BEARER requires runtimePosture.requireBearerToken to be true",
    );
  }
  if (
    props.originReachability !== AppTheoryMcpOriginReachability.DISABLED
    && props.originReachability !== AppTheoryMcpOriginReachability.LOCKED
  ) {
    throw new Error(
      `AppTheoryMcpServer: transportPosture ${label} requires originReachability to be AppTheoryMcpOriginReachability.DISABLED or .LOCKED`,
    );
  }
  if (props.api !== undefined) {
    validateOwningApiDefense(props.owningApiDefense, label);
  } else {
    if (props.ownedApi?.stage?.throttlingEnabled !== true) {
      throw new Error(
        `AppTheoryMcpServer: transportPosture ${label} requires an explicit ownedApi.stage.throttlingEnabled: true throttling decision`,
      );
    }
    if (props.ownedApi?.stage?.accessLogging === false) {
      throw new Error(
        `AppTheoryMcpServer: transportPosture ${label} requires access logging`,
      );
    }
  }
  if (posture === AppTheoryMcpTransportPosture.RUNTIME_BEARER) {
    validateDenialSignal(props.denialSignal);
  }
}

function validateOwningApiDefense(
  defense: AppTheoryMcpOwningApiDefenseOptions | undefined,
  label: string,
): void {
  if (defense === undefined) {
    throw new Error(
      `AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense to record the owning API's access logging and throttling decisions`,
    );
  }
  if (defense.accessLogging !== true) {
    throw new Error(
      `AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense.accessLogging to be true`,
    );
  }
  const throttling: Partial<AppTheoryMcpOwningApiThrottlingOptions> | undefined = defense.throttling;
  const rateLimit = throttling?.rateLimit;
  const burstLimit = throttling?.burstLimit;
  if (
    !Number.isFinite(rateLimit)
    || (rateLimit as number) <= 0
    || !Number.isFinite(burstLimit)
    || (burstLimit as number) <= 0
  ) {
    throw new Error(
      `AppTheoryMcpServer: transportPosture ${label} requires owningApiDefense.throttling rateLimit and burstLimit to be positive finite numbers`,
    );
  }
}

function validateDenialSignal(signal?: AppTheoryMcpDenialSignalOptions): void {
  if (signal === undefined) {
    throw new Error(
      "AppTheoryMcpServer: transportPosture RUNTIME_BEARER requires denialSignal",
    );
  }
  if (signal.metricName !== undefined && signal.metricName !== MCP_DENIAL_METRIC_NAME) {
    throw new Error(
      `AppTheoryMcpServer: denialSignal.metricName must be ${MCP_DENIAL_METRIC_NAME}`,
    );
  }
  if (signal.dimensions !== undefined) {
    const dimensions = Array.isArray(signal.dimensions) ? signal.dimensions : [];
    const bounded = dimensions.length === MCP_DENIAL_DIMENSIONS.length
      && MCP_DENIAL_DIMENSIONS.every(
        (dimension) => dimensions.filter((value) => value === dimension).length === 1,
      );
    if (!bounded) {
      throw new Error(
        `AppTheoryMcpServer: denialSignal.dimensions must be exactly ${JSON.stringify(MCP_DENIAL_DIMENSIONS)}`,
      );
    }
  }
}

function validateLiteralOAuthURL(value: string, allowQuery: boolean, message: string): void {
  const literal = value.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(literal);
  } catch {
    // The shared validation error below is the public synthesis contract.
  }
  if (
    !parsed
    || !literalURLHasRFC3986Authority(literal)
    || parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username !== ""
    || parsed.password !== ""
    || literalURLAuthorityHasUserinfo(literal)
    || (!allowQuery && literal.includes("?"))
    || literal.includes("#")
  ) {
    throw new Error(`AppTheoryMcpServer: ${message}`);
  }
}

function toHttpMethod(method: string): apigwv2.HttpMethod {
  switch (method) {
    case "POST": return apigwv2.HttpMethod.POST;
    case "GET": return apigwv2.HttpMethod.GET;
    case "DELETE": return apigwv2.HttpMethod.DELETE;
    default:
      throw new Error(`AppTheoryMcpServer: unsupported runtime MCP method ${method}`);
  }
}

function validatePositiveNumber(value: number, propName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be greater than zero`);
  }
}

function validatePositiveInteger(value: number, propName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`AppTheoryMcpServer: ${propName} must be a positive integer`);
  }
}

function accessLogFormat(): string {
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

function toRoute53RecordName(domainName: string, zone: route53.IHostedZone): string {
  const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
  const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
  if (!zoneName) return fqdn;
  if (fqdn === zoneName) return "";
  const suffix = `.${zoneName}`;
  return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function literalURLHasRFC3986Authority(value: string): boolean {
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
  return authority !== undefined && !authority.includes("%");
}

function literalURLAuthorityHasUserinfo(value: string): boolean {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  return authority?.includes("@") ?? false;
}
