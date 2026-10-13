import type { App } from "./app.js";
import type { Handler } from "./context.js";
import { type EndpointKind, type IssuerMode } from "./mcproutes.js";
import { type RequireBearerTokenOptions } from "./oauth/index.js";
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
 * Validates and canonicalizes a request-derived origin. Accepts HTTPS, plus
 * HTTP only for loopback hosts, and removes scheme-default ports.
 */
export declare function normalizeRequestOrigin(raw: string): string | null;
//# sourceMappingURL=mcpfacade.d.ts.map