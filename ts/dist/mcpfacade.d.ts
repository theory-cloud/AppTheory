import type { App } from "./app.js";
import { SecureApp } from "./app.js";
import type { Context, Handler } from "./context.js";
import { type EndpointKind, type IssuerMode } from "./mcproutes.js";
import { type Provider, type RequireBearerTokenOptions, type Stores } from "./oauth/index.js";
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
 * routes, each with a declared posture, and it adds none of them when
 * normalizeConfig rejects the configuration. A route the application never
 * declares remains undeliverable, and the application's own
 * SecurePrincipalResolver, tier, and PolicyHook keep governing every non-facade
 * route on the same app.
 */
export declare function registerMcpFacadeSecure(secureApp: SecureApp, config: FacadeConfig): RouteInventory;
/**
 * Validates and canonicalizes a request-derived origin. Accepts HTTPS, plus
 * HTTP only for loopback hosts, and removes scheme-default ports.
 */
export declare function normalizeRequestOrigin(raw: string): string | null;
//# sourceMappingURL=mcpfacade.d.ts.map