import type { App } from "./app.js";
import { SecureApp } from "./app.js";
import type { Context, Handler } from "./context.js";
import { type EndpointKind, type IssuerMode } from "./mcproutes.js";
import { type Provider, type RefusalHook, type RequireBearerTokenOptions, type Stores } from "./oauth/index.js";
/**
 * URL mode selects the source of absolute URLs in facade metadata documents.
 *
 * `public_base_url` uses `publicBaseURL`, fixed at registration time, for a
 * front door or CDN that owns the public origin. `request_host` derives the
 * origin from each normalized request for direct API Gateway custom-domain and
 * test deployments.
 */
export type UrlMode = "public_base_url" | "request_host";
export declare const URL_MODE_PUBLIC_BASE_URL: UrlMode;
export declare const URL_MODE_REQUEST_HOST: UrlMode;
/**
 * Transport posture for the MCP transport routes.
 *
 * `iam` and `jwt` are enforced by the gateway; `runtime-bearer` validates an
 * RFC 9728 bearer token in the runtime; `none-public` is the explicit public
 * posture and is never a default.
 */
export type McpTransportPosture = "iam" | "jwt" | "runtime-bearer" | "none-public";
export declare const TRANSPORT_POSTURES: readonly McpTransportPosture[];
/**
 * The declared direct-origin posture of the front door that fronts this facade.
 *
 * The value mirrors the CDK construct's `AppTheoryMcpOriginReachability`
 * decision, so one application-owned constant can feed both the construct prop
 * and this config. Only `fronted` changes runtime behavior: `disabled` and
 * `locked` are enforced at the edge, where the construct proves them, and are
 * recorded here so the runtime can refuse a contradictory front-door
 * declaration instead of silently ignoring it.
 */
export type McpOriginReachability = "disabled" | "locked" | "fronted";
export declare const ORIGIN_REACHABILITIES: readonly McpOriginReachability[];
/**
 * Declares the app-owned front-door header this runtime verifies on every
 * derived route under `originReachability: "fronted"`.
 *
 * The front door (for example an application-owned CloudFront distribution
 * whose origin is the execute-api hostname) injects `headerName: secretValue`
 * on every origin request. Three copies of that value must come from one
 * application-owned constant — the CDK construct prop (digest only), the
 * distribution's origin custom-header configuration, and this config — because
 * the runtime shares routes with the construct, never configuration environment
 * variables.
 */
export interface FrontDoorVerification {
    /**
     * The origin request header the front door injects. 1 to 64 characters of
     * `[A-Za-z0-9-]`, and never a request header that rewrites the origin
     * contract.
     */
    headerName: string;
    /**
     * The literal header value. 32 to 128 characters of `[A-Za-z0-9._~-]`. It is
     * compared in constant time on every request and never appears in a response.
     */
    secretValue: string;
}
/**
 * Returns an application-owned handler for one endpoint kind. Factories run
 * during facade registration, never during request handling.
 */
export type HandlerFactory = (kind: EndpointKind) => Handler;
/** RFC 8414 capability lists advertised by the facade. */
export interface FacadeCapabilities {
    responseTypes?: string[];
    grantTypes?: string[];
    tokenEndpointAuthMethods?: string[];
    codeChallengeMethods?: string[];
}
/** The fully resolved capability lists used when a field is not overridden. */
export interface ResolvedCapabilities {
    responseTypes: string[];
    grantTypes: string[];
    tokenEndpointAuthMethods: string[];
    codeChallengeMethods: string[];
}
/** The golden-path OAuth capabilities. */
export declare function defaultCapabilities(): ResolvedCapabilities;
/**
 * Configures the optional, unscoped authorization-server discovery document.
 * Every endpoint is fixed at registration time and belongs to the upstream
 * authorization server.
 */
export interface RootDiscoveryConfig {
    issuerURL: string;
    authorizationEndpointURL: string;
    tokenEndpointURL: string;
    registrationEndpointURL: string;
    jwksURI: string;
    scopes: string[];
}
/**
 * The encoded static policy of the brokered route refresh handle (DESIGN §8.4).
 * It is a `FacadeConfig` field, never an environment variable, and it is
 * required whenever the framework-owned front channel is configured: a missing
 * or zero value is a registration error, not a silent fallback.
 *
 * - `handleTTLSeconds` is the local lifetime of a route refresh handle, in
 *   seconds, and must lie in `[60, 2592000]`. The store applies it; a broker
 *   store that reports its own lifetime through
 *   `routeRefreshBrokerHandleTTLSeconds()` must agree with it.
 * - `graceWindowSeconds` is the lost-response replay window measured from the
 *   winning rotation. Absent or zero selects `DEFAULT_REFRESH_GRACE_WINDOW_SECONDS`;
 *   inside the window the rotated handle replays the full stored successor body.
 *   At and beyond the window the family is revoked with no token material.
 * - `reuseRateCeiling` is retained for configuration compatibility and must lie
 *   in `[9, 120]`; no refresh path uses it now that the beyond-grace serve was
 *   removed.
 * - `refreshBudgetSeconds` is the encoded time budget of one upstream refresh
 *   call. Absent selects `DEFAULT_REFRESH_BUDGET_SECONDS`; it must lie in
 *   `[MIN_REFRESH_BUDGET_SECONDS, MAX_REFRESH_BUDGET_SECONDS]`, where the
 *   ceiling keeps the budget inside the broker lock TTL it has to outlive. It is
 *   a configuration field, never an environment variable.
 */
export interface RouteRefreshPolicy {
    handleTTLSeconds: number;
    graceWindowSeconds?: number;
    reuseRateCeiling: number;
    refreshBudgetSeconds?: number;
}
/** Configures the complete route-algebra MCP OAuth facade. */
export interface FacadeConfig {
    /** Absolute HTTPS issuer advertised by both metadata families in family mode. */
    issuerURL: string;
    /** Absolute HTTPS key-set URL advertised by both metadata families. */
    jwksURI: string;
    /** Optional RFC 8414 registration-endpoint override; defaults to issuer + /register. */
    registrationEndpointURL?: string;
    /** Per-route issuer/resource derivation; defaults to family. */
    issuerMode?: IssuerMode;
    urlMode: UrlMode;
    publicBaseURL?: string;
    /** Optional stage-global upstream callback path override. */
    upstreamCallbackPath?: string;
    /** Required in request-host mode; the normalized authority must exact-match. */
    allowedHostnames?: string[];
    /** A non-empty scope set is required for every contract endpoint kind. */
    scopes: Partial<Record<EndpointKind, string[]>>;
    /** Selectively overrides {@link defaultCapabilities}. */
    capabilities?: FacadeCapabilities;
    /** Serves every POST, GET, and DELETE MCP endpoint pattern. */
    mcpHandler: Handler;
    /** All-or-none with tokenHandler; AppTheory mounts only the derived paths. */
    authorizeHandler?: HandlerFactory;
    tokenHandler?: HandlerFactory;
    /** Mounts the derived registration path per kind; absent mounts none. */
    registerHandler?: HandlerFactory;
    /** Mounts the single stage-global upstream callback; absent mounts none. */
    callbackHandler?: Handler;
    /** Optionally installs one static root authorization-server discovery route. */
    rootAuthorizationServer?: RootDiscoveryConfig;
    /** How the MCP transport routes are authorized; defaults to iam. */
    transportPosture?: McpTransportPosture;
    /** Valid only with runtime-bearer; refused under every other posture. */
    requireBearerToken?: RequireBearerTokenOptions;
    /**
     * Records the direct-origin posture the CDK construct declared, so one
     * application-owned constant can feed both surfaces. Omitted leaves the
     * posture unrecorded; `disabled` and `locked` are edge-enforced and add no
     * runtime check. `fronted` requires {@link FacadeConfig.frontDoorVerification}
     * and refuses every derived route whose front-door header is absent or wrong.
     */
    originReachability?: McpOriginReachability;
    /**
     * The app-owned front-door header this runtime verifies on every derived
     * route (transport and OAuth facade paths) under `originReachability:
     * "fronted"`. Registration fails closed when `fronted` is declared without
     * it, and it is rejected under every other posture: an undeclared or
     * unenforced front door would be a silent no-op.
     */
    frontDoorVerification?: FrontDoorVerification;
    /**
     * Anchors the framework-owned front channel (DESIGN §8). When it is set,
     * AppTheory owns `/authorize`, the stage-global upstream callback, and the
     * `/token` authorization_code grant, and the rest of the front-channel field
     * set below is required. An absent provider leaves the front channel
     * unowned: an application either supplies its own
     * `authorizeHandler`/`tokenHandler` pair and `callbackHandler`, or registers
     * no OAuth surface at all. Setting any other front-channel field without
     * `provider` is a registration error.
     */
    provider?: Provider;
    /**
     * The five facade store SPIs the front channel persists through (DESIGN §7):
     * transaction, authorization code, client, route-refresh broker, and rate
     * limit. All five are required when `provider` is set. Each store owns its
     * own TTL (DESIGN §7 TTL column), so no TTL is configured here.
     *
     * The framework's in-memory reference stores are non-durable and do not
     * encrypt: they exist for deterministic tests and local development only. A
     * durable store implementation MUST encrypt the Encrypted* record fields at
     * rest (for example with persistence-layer encryption), because the facade
     * hands the store upstream material, including the upstream-minted access
     * token, exactly as the provider returned it and relies on the store to
     * protect it (DESIGN §7).
     */
    stores?: Stores;
    /**
     * The facade's own OAuth client registration at the upstream provider
     * (DESIGN §8.1): the upstream authorize request carries it and the
     * server-side upstream code exchange presents it. It is also the expected
     * azp/client_id of an upstream access token the facade validates
     * (DESIGN §5.2, §6), so a token minted for another client is refused.
     */
    upstreamClientID?: string;
    /**
     * The expected upstream issuer: the RFC 9207 `iss` value the upstream
     * callback pins before consuming the transaction or exchanging the code
     * (DESIGN §8.2) and the issuer the provider's `discovery` call must verify
     * before any published endpoint is trusted (DESIGN §5.2, §6). It must be an
     * absolute HTTPS URL with no query or fragment, normalized like `issuerURL`,
     * and it is distinct from the client-facing issuer.
     */
    upstreamIssuer?: string;
    /**
     * Scope values the facade adds to every upstream authorize request but never
     * requires from the MCP client, for example the `offline_access` lifecycle
     * scope that lets the upstream issue refresh material (FRAMEWORK_VS_POLICY
     * row 7). Absent adds none. Values are validated like `scopes`: trimmed,
     * non-empty, and well-formed Unicode.
     */
    lifecycleScopes?: string[];
    /**
     * Supplies the opaque provider hints for one authorize request (DESIGN §6):
     * it receives the request context and returns the hint map, for example the
     * `account_id` hint. A hint carries no authority — the provider derives
     * authentication account context from its own validated binding, not from
     * the hint (DESIGN §6). An absent function contributes no hints; a rejected
     * promise is a provider-call failure in the gateway class, so it maps to the
     * 502 upstream_error error page and never redirects (DESIGN §8.2).
     */
    providerHints?: (ctx: Context) => Record<string, string> | Promise<Record<string, string>>;
    /**
     * The static policy of the brokered route refresh handle. Required whenever
     * `provider` is set: a missing or zero policy is a registration error, not a
     * silent fallback.
     */
    routeRefreshPolicy?: RouteRefreshPolicy;
    /**
     * Optionally receives one schema-redacted route refresh broker event per
     * refresh state transition. The hook runs synchronously on the request path;
     * a throwing hook is contained, so telemetry can never fail a refresh. An
     * event carries hashes and route-derived identifiers only — never a token, a
     * handle, an authorization code, an ID token, or cookie material.
     */
    routeRefreshEvents?: RouteRefreshEventHook;
    /**
     * Optionally receives one structured, redacted event for every 400, 401,
     * 403, 404, and 405 the facade renders on its own routes (authorize,
     * callback, token, register, and the metadata documents), so a refusal a real
     * client hit is answerable from telemetry instead of being a bare status. The
     * MCP transport routes report through the MCP handler's own hook, so one
     * refusal is never reported twice. A throwing hook is contained.
     */
    refusalHook?: RefusalHook;
}
/** One endpoint-kind route family installed by the helper. */
export interface FacadeRoute {
    kind: EndpointKind;
    mcpPattern: string;
    mcpMethods: string[];
    protectedResourcePattern: string;
    discoveryCanonicalPattern: string;
    discoverySuffixPattern: string;
    authorizePattern: string;
    tokenPattern: string;
    registerPattern: string;
    /**
     * Reports whether transport authorization is attached to this route family
     * (false under the none-public posture). Mirrors the CDK construct's
     * authorizationRoutesAttached inventory field.
     */
    authorizationRoutesAttached: boolean;
}
/** A defensive snapshot of the installed facade surface. */
export interface RouteInventory {
    contractVersion: string;
    routes: FacadeRoute[];
    rootAuthorizationServerPattern: string;
    rootAuthorizationServerAttached: boolean;
    /** The stage-global upstream callback path. */
    callbackPattern: string;
    /** The resolved per-route issuer derivation mode. */
    issuerMode: IssuerMode;
}
/**
 * Installs the complete MCP OAuth facade described by the route-algebra
 * contract version and returns its route inventory. The helper owns
 * composition only: authorize and token routes are absent unless the
 * application supplies both handler factories.
 *
 * The whole plan is proven installable before the app receives its first facade
 * route, so a configuration the facade rejects, an invalid entry, or a
 * duplicate inside the plan adds no route at all. A collision with a route the
 * application already registered on this plain App is detected by the app's own
 * duplicate check while the plan is mounted: the plain App surface publishes no
 * route table, so the facade cannot pre-check that collision the way
 * {@link registerMcpFacadeSecure} can on a SecureApp.
 */
export declare function registerMcpFacade(app: App, config: FacadeConfig): RouteInventory;
/**
 * Installs the complete MCP OAuth facade on a closed-by-default
 * {@link SecureApp} and returns its route inventory.
 *
 * It is the SecureApp counterpart to {@link registerMcpFacade} and produces the
 * same route inventory and the same request-time behavior. The difference is
 * how each route's authority is declared: on the plain App surface the facade
 * expresses transport security with the `authRequired` route option, while here
 * every route must declare an explicit auth posture, so the facade declares the
 * posture each of its routes has always had.
 *
 * The SecureApp stays closed by default: this helper adds only the facade's own
 * routes, each with a declared posture, and it adds none of them when the plan
 * is rejected. The whole plan is proven installable before the app receives its
 * first facade route — every entry, and every collision with a route the app
 * already declares — so a thrown error means zero facade routes were added. A
 * route the application never declares remains undeliverable, and the
 * application's own SecurePrincipalResolver, tier, and PolicyHook keep
 * governing every non-facade route on the same app.
 */
export declare function registerMcpFacadeSecure(secureApp: SecureApp, config: FacadeConfig): RouteInventory;
/**
 * Validates and canonicalizes a request-derived origin. Accepts HTTPS, plus
 * HTTP only for loopback hosts, and removes scheme-default ports.
 */
export declare function normalizeRequestOrigin(raw: string): string | null;
/** The handle lifetime floor of the route refresh policy, in seconds. */
export declare const MIN_ROUTE_REFRESH_HANDLE_TTL_SECONDS = 60;
/** The handle lifetime ceiling of the route refresh policy, in seconds: 30 days. */
export declare const MAX_ROUTE_REFRESH_HANDLE_TTL_SECONDS = 2592000;
/**
 * The lost-response replay window a policy that does not state one selects. It
 * is the pinned maximum, so a lazy client that retries a dropped rotation
 * response inside two minutes recovers without a second upstream call.
 */
export declare const DEFAULT_REFRESH_GRACE_WINDOW_SECONDS = 120;
/** The hard bound on the lossless replay carve-out. */
export declare const MAX_REFRESH_GRACE_WINDOW_SECONDS = 120;
/**
 * The smallest accepted value of the retained reuse-rate ceiling. The field no
 * longer gates a token serve; the floor and cap keep every existing
 * configuration valid.
 */
export declare const MIN_REFRESH_REUSE_RATE_CEILING = 9;
/** The retained reuse-rate ceiling's upper bound. */
export declare const MAX_REFRESH_REUSE_RATE_CEILING = 120;
/**
 * The upstream refresh-call budget a policy that does not state one selects. It
 * is the hardened upstream HTTP deadline the adapter already used, so an
 * unchanged configuration keeps exactly the bound it had.
 */
export declare const DEFAULT_REFRESH_BUDGET_SECONDS = 10;
/** The shortest accepted upstream refresh budget. */
export declare const MIN_REFRESH_BUDGET_SECONDS = 1;
/**
 * The longest accepted upstream refresh budget: the reference broker lock TTL
 * (15 s) less the commit margin, so the winner can still commit its rotation
 * before the lock it holds expires.
 */
export declare const MAX_REFRESH_BUDGET_SECONDS: number;
/**
 * The generation of a handle the facade mints as the root of a new refresh
 * family. Every successor records the presented generation plus one, so depth
 * relative to the head is arithmetic.
 */
export declare const REFRESH_CHAIN_ROOT_GENERATION = 1;
/**
 * The closed class vocabulary of the route refresh broker telemetry the facade
 * emits: broker issuance, local validation rejections, refresh lock
 * acquisition, coalesced service from a stored grace response, successful
 * refresh, reuse classification, upstream rejection attribution, and broker
 * state failures.
 */
export declare const ROUTE_REFRESH_EVENT_ISSUED: "issued";
export declare const ROUTE_REFRESH_EVENT_VALIDATION_REJECTED: "validation_rejected";
export declare const ROUTE_REFRESH_EVENT_LOCK_ACQUIRED: "lock_acquired";
export declare const ROUTE_REFRESH_EVENT_GRACE_SERVED: "grace_served";
export declare const ROUTE_REFRESH_EVENT_REFRESHED: "refreshed";
export declare const ROUTE_REFRESH_EVENT_REUSE: "reuse";
export declare const ROUTE_REFRESH_EVENT_UPSTREAM_REAUTH_REQUIRED: "upstream_reauth_required";
export declare const ROUTE_REFRESH_EVENT_STATE_FAILURE: "state_failure";
/** The reuse outcomes of a {@link ROUTE_REFRESH_EVENT_REUSE} event. */
/** Retained for telemetry compatibility; the beyond-grace serve was removed. */
export declare const ROUTE_REFRESH_OUTCOME_ACCESS_TOKEN_ONLY: "access_token_only";
export declare const ROUTE_REFRESH_OUTCOME_REVOKED_FAMILY: "revoked_family";
/** Retained for telemetry compatibility; the bounded walk was removed. */
export declare const ROUTE_REFRESH_OUTCOME_REVOKED_WALK: "revoked_walk";
/** Retained for telemetry compatibility; the reuse budget no longer gates a serve. */
export declare const ROUTE_REFRESH_OUTCOME_RATE_LIMITED: "rate_limited";
export declare const ROUTE_REFRESH_OUTCOME_BINDING_REJECTED: "binding_rejected";
/**
 * A stale predecessor presentation served by rotating the family's live head.
 * Additive: the client receives fresh credentials and the family is not revoked.
 */
export declare const ROUTE_REFRESH_OUTCOME_ROTATED_FROM_HEAD: "rotated_from_head";
/** The failure or trigger reasons of a validation or state event. */
export declare const ROUTE_REFRESH_REASON_HANDLE_MALFORMED: "handle_malformed";
export declare const ROUTE_REFRESH_REASON_CLIENT_REJECTED: "client_rejected";
export declare const ROUTE_REFRESH_REASON_RECORD_ABSENT: "record_absent";
export declare const ROUTE_REFRESH_REASON_RECORD_EXPIRED: "record_expired";
export declare const ROUTE_REFRESH_REASON_RECORD_REVOKED: "record_revoked";
export declare const ROUTE_REFRESH_REASON_CLIENT_MISMATCH: "client_mismatch";
export declare const ROUTE_REFRESH_REASON_RESOURCE_MISMATCH: "resource_mismatch";
export declare const ROUTE_REFRESH_REASON_BINDING_REJECTED: "binding_rejected";
export declare const ROUTE_REFRESH_REASON_LOCK_CONTENTION: "lock_contention";
export declare const ROUTE_REFRESH_REASON_STORE_FAILURE: "store_failure";
export declare const ROUTE_REFRESH_REASON_REWRITE_FAILURE: "rewrite_failure";
export declare const ROUTE_REFRESH_REASON_FAMILY_REVOKE_UNAVAILABLE: "family_revoke_unavailable";
export declare const ROUTE_REFRESH_REASON_FAMILY_REVOKE_FAILED: "family_revoke_failed";
/** Retained for telemetry compatibility; a beyond-grace presentation reports stale_predecessor and is served. */
export declare const ROUTE_REFRESH_REASON_ALREADY_SERVED: "already_served";
export declare const ROUTE_REFRESH_REASON_UPSTREAM_REJECTED: "upstream_rejected";
export declare const ROUTE_REFRESH_REASON_SUCCESSOR_BODY: "successor_body";
/** Retained for telemetry compatibility; no token is served beyond grace. */
export declare const ROUTE_REFRESH_REASON_ACCESS_TOKEN_ONLY: "access_token_only";
export declare const ROUTE_REFRESH_REASON_ROTATED_REUSE: "rotated_reuse";
export declare const ROUTE_REFRESH_REASON_LEGACY_LINEAGE: "legacy_lineage_unsupported";
export declare const ROUTE_REFRESH_REASON_FAMILY_STATE_UNAVAILABLE: "family_state_unavailable";
/**
 * A rotated-away handle presented beyond its grace window. Ordinary client
 * behaviour - a restart with a stale stored copy, a second process on one login,
 * a lost response - produces exactly this presentation, so it is served and
 * never treated as theft.
 */
export declare const ROUTE_REFRESH_REASON_STALE_PREDECESSOR: "stale_predecessor";
/** A family whose live head aged out, leaving no member that can rotate. */
export declare const ROUTE_REFRESH_REASON_FAMILY_HEAD_ABSENT: "family_head_absent";
/**
 * A presentation resolved by the post-timeout lineage check: the family's live
 * head had already moved past the presented record, so the head was rotated for
 * the client and the stale material was never presented again.
 */
export declare const ROUTE_REFRESH_REASON_LINEAGE_VERIFIED: "lineage_verified";
/**
 * An upstream contract-terminal verdict that is still ambiguous because a
 * rotation attempt of the same record is unconfirmed inside the ambiguity
 * horizon. The family is kept and the client is told to retry.
 */
export declare const ROUTE_REFRESH_REASON_RECOVERY_PENDING: "recovery_pending";
/** A family-less pre-policy record migrated in code onto a fresh family. */
export declare const ROUTE_REFRESH_REASON_LEGACY_LINEAGE_ADOPTED: "legacy_lineage_adopted";
/** The store's absent-versus-expired signal; the client body stays uniform. */
export declare const ROUTE_REFRESH_EXPIRY_SIGNAL_ABSENT: "absent";
export declare const ROUTE_REFRESH_EXPIRY_SIGNAL_EXPIRED: "expired";
export type RouteRefreshEventClass = typeof ROUTE_REFRESH_EVENT_ISSUED | typeof ROUTE_REFRESH_EVENT_VALIDATION_REJECTED | typeof ROUTE_REFRESH_EVENT_LOCK_ACQUIRED | typeof ROUTE_REFRESH_EVENT_GRACE_SERVED | typeof ROUTE_REFRESH_EVENT_REFRESHED | typeof ROUTE_REFRESH_EVENT_REUSE | typeof ROUTE_REFRESH_EVENT_UPSTREAM_REAUTH_REQUIRED | typeof ROUTE_REFRESH_EVENT_STATE_FAILURE;
/**
 * One schema-redacted route refresh broker telemetry event. Every identifier is
 * a hash or a route-derived value; the event never carries an authorization
 * code, an access token, an upstream refresh token, a route refresh handle, an
 * ID token, a cookie, or provider session material.
 */
export interface RouteRefreshEvent {
    class: RouteRefreshEventClass;
    reason?: string;
    outcome?: string;
    errorCode?: string;
    at: Date;
    issuer?: string;
    stage?: string;
    canonicalResource?: string;
    clientNamespace?: string;
    endpointKind?: string;
    partnerId?: string;
    agentId?: string;
    clientIdHash?: string;
    subjectIdHash?: string;
    handleHash?: string;
    familyHash?: string;
    successorHandleHash?: string;
    upstreamRefreshTokenHash?: string;
    previousUpstreamRefreshTokenHash?: string;
    scopeFingerprint?: string;
    statusFrom?: string;
    statusTo?: string;
    /** The presented record's family generation, 0 for a pre-policy record. */
    chainGeneration?: number;
    /** The classified distance from the presented handle to the head, capped at 2. */
    chainDepth?: number;
    /** `absent` or `expired` for a record-state rejection. */
    expirySignal?: string;
    /** The provider error class for upstream attribution. */
    upstreamClass?: string;
    /** How many records a family or walk revocation handled. */
    revokedRecords?: number;
}
/**
 * Receives one route refresh broker event. It runs synchronously on the request
 * path, after the state transition it describes has been decided; a throwing
 * hook is contained so telemetry can never fail a refresh.
 */
export type RouteRefreshEventHook = (event: RouteRefreshEvent) => void;
/**
 * Rotates the live head of one refresh family out of band, so a scheduled
 * trigger (a worker function, a cron entry, a batch invocation) keeps
 * credentials fresh without reimplementing the facade's rotation. It is the
 * exported sweep entrypoint of the rotation-recovery contract's facade rule
 * (theorycloud_refresh_rotation_recovery.v0.1 R7): the same store SPI, the same
 * lock, the same rotation transaction, and the same encoded policy the request
 * path uses.
 *
 * The caller decides which families are due: a scheduler that owns the
 * access-token expiry knows it better than the broker record.
 *
 * # Concurrency contract
 *
 * A sweep-driven rotation is an ordinary rotation competitor, never a second
 * authority over the family:
 *
 * 1. Exclusive lock. The sweep takes the same per-record lock the request path
 *    takes (acquireLock with the version it read) before any upstream call. A
 *    held lock, a lock the sweep cannot take, or a version that moved since the
 *    head was read resolves to `deferred`: no upstream call, no state change, no
 *    family effect. The caller retries on its next tick.
 * 2. Exactly one winner. The rotation commits through the same rotateFamily
 *    transaction, which re-checks the lock owner, the expected version, the
 *    family and generation bindings, and successor uniqueness. A loser (the
 *    request path rotated first, the lock expired, the family was revoked) gets a
 *    typed transient result and never mints a successor: nothing is minted unless
 *    every write landed.
 * 3. The loser keeps working. A request-path presentation racing a committed
 *    sweep rotation finds its handle grace-marked and is served the stored
 *    successor body, or — past the grace window — has the family's new live head
 *    rotated for it. A sweep racing a committed request-path rotation defers and
 *    reads the new head on its next tick. Neither order is family-affecting.
 * 4. The sweep never revokes. Continuity maintenance is not a revocation trigger
 *    (contract R5). A contract-terminal upstream verdict observed by the sweep
 *    releases the lock and returns `terminal_verdict`, leaving the family intact:
 *    revocation and its receipt stay on the request path, where the client-facing
 *    verdict is rendered and lineage is verified.
 * 5. It is bounded. The upstream call carries the same encoded
 *    `refreshBudgetSeconds` as the request path, which stays below the broker lock
 *    TTL, so a sweep can never outlive the lock it holds.
 */
export declare class RefreshSweeper {
    private readonly front;
    private readonly now;
    constructor(config: RefreshSweepConfig);
    /** Rotates the live head of one family. Never revokes; see the class docs. */
    sweepFamily(familyHash: string): Promise<RefreshSweepResult>;
    private deferredLock;
    private deferredRotation;
}
/** Configures a {@link RefreshSweeper}. */
export interface RefreshSweepConfig {
    /** Makes the upstream refresh call. */
    provider: Provider;
    /** The broker store the rotation transacts through; needs the family capability. */
    stores: Stores;
    /** The encoded route refresh policy: grace window, upstream budget, handle TTL. */
    policy: RouteRefreshPolicy;
    /** Optionally receives the same schema-redacted route refresh telemetry. */
    events?: RouteRefreshEventHook;
    /** The sweeper's clock for the stored deadlines and event instants. */
    now?: () => Date;
}
/** The closed result vocabulary of one `sweepFamily` call. */
export type RefreshSweepOutcome = "rotated" | "deferred" | "terminal_verdict" | "revoked_family" | "no_live_head";
/** One sweep result. It carries hashes and a generation only. */
export interface RefreshSweepResult {
    outcome: RefreshSweepOutcome;
    familyHash: string;
    presentedHandleHash?: string;
    successorHandleHash?: string;
    chainGeneration?: number;
    deferredReason?: string;
    upstreamClass?: string;
}
//# sourceMappingURL=mcpfacade.d.ts.map