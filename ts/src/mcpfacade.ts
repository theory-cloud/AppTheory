import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import type { App } from "./app.js";
import { createApp } from "./app.js";
import type { Context, Handler } from "./context.js";
import {
  CONTRACT_VERSION,
  ISSUER_MODE_FAMILY,
  ISSUER_MODE_ROUTE,
  PARAM_AGENT_ID,
  PARAM_CLIENT_NAMESPACE,
  PARAM_PARTNER_ID,
  authorizationServerPathForResourcePath,
  callbackPathForConfiguredPath,
  mcpPath,
  oauthAuthorizationServerPath,
  oauthAuthorizationServerSuffixPath,
  oauthAuthorizePath,
  oauthRegisterPath,
  oauthTokenPath,
  parseMcpPath,
  resourcePathFromProtectedResourcePath,
  supportedEndpointTemplates,
  supportedIssuerModes,
  supportedOAuthDiscoveryTemplates,
  supportedOAuthFacadeTemplates,
  type EndpointKind,
  type EndpointPath,
  type IssuerMode,
  type OAuthDiscoveryTemplate,
  type OAuthFacadeTemplate,
} from "./mcproutes.js";
import {
  authorizationServerMetadataHandler,
  BrokerNotFoundError,
  canonicalizeIssuerURL,
  canonicalResourceURL,
  hashKey,
  newPKCECodeVerifier,
  pkceChallengeS256,
  pkceVerifyS256,
  protectedResourceMetadataHandler,
  requireBearerTokenMiddleware,
  type AuthorizationCodeRecord,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
  type Provider,
  type RequireBearerTokenOptions,
  type RouteRefreshBrokerRecord,
  type RouteRefreshBrokerSeeder,
  type Stores,
  type TokenClaims,
  type TokenSet,
  type TransactionRecord,
} from "./oauth/index.js";
import { originURL } from "./response.js";
import type { Response } from "./types.js";

/**
 * URL mode selects the source of absolute URLs in facade metadata documents.
 *
 * `public_base_url` uses `publicBaseURL`, fixed at registration time, for a
 * front door or CDN that owns the public origin. `request_host` derives the
 * origin from each normalized request for direct API Gateway custom-domain and
 * test deployments.
 */
export type UrlMode = "public_base_url" | "request_host";

export const URL_MODE_PUBLIC_BASE_URL: UrlMode = "public_base_url";
export const URL_MODE_REQUEST_HOST: UrlMode = "request_host";

/**
 * Transport posture for the MCP transport routes.
 *
 * `iam` and `jwt` are enforced by the gateway; `runtime-bearer` validates an
 * RFC 9728 bearer token in the runtime; `none-public` is the explicit public
 * posture and is never a default.
 */
export type McpTransportPosture =
  "iam" | "jwt" | "runtime-bearer" | "none-public";

export const TRANSPORT_POSTURES: readonly McpTransportPosture[] = [
  "iam",
  "jwt",
  "runtime-bearer",
  "none-public",
];

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
export function defaultCapabilities(): ResolvedCapabilities {
  return {
    responseTypes: ["code"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"],
    codeChallengeMethods: ["S256"],
  };
}

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
   * promise is a fail-closed request-class rejection that never redirects.
   */
  providerHints?: (
    ctx: Context,
  ) => Record<string, string> | Promise<Record<string, string>>;
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

const METADATA_VARY_HEADER =
  "Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto";

const ERROR_PREFIX = "AppTheoryMcpFacade:";

const MCP_METHODS = ["POST", "GET", "DELETE"];

interface NormalizedConfig {
  issuerURL: string;
  jwksURI: string;
  registrationEndpointURL: string;
  issuerMode: IssuerMode;
  urlMode: UrlMode;
  publicBaseURL: string;
  upstreamCallbackPath: string;
  allowedHostnames: Set<string>;
  scopes: Record<EndpointKind, string[]>;
  capabilities: ResolvedCapabilities;
  mcpHandler: Handler;
  authorizeHandlers: Record<EndpointKind, Handler> | null;
  tokenHandlers: Record<EndpointKind, Handler> | null;
  registerHandlers: Record<EndpointKind, Handler> | null;
  callbackHandler: Handler | null;
  rootAuthorizationServer: AuthorizationServerMetadata | null;
  rootDiscoveryPath: string;
  transportPosture: McpTransportPosture;
  requireBearerToken: RequireBearerTokenOptions | undefined;
  frontChannel: FrontChannelConfig | null;
}

/**
 * The validated front-channel field set of {@link FacadeConfig} (DESIGN §8):
 * the provider adapter and stores the front channel drives, the facade's own
 * upstream client, the expected upstream issuer, the injectable lifecycle
 * scopes, and the opaque provider-hint seam.
 */
interface FrontChannelConfig {
  provider: Provider;
  stores: Stores;
  upstreamClientID: string;
  upstreamIssuer: string;
  lifecycleScopes: string[];
  providerHints:
    | ((
        ctx: Context,
      ) => Record<string, string> | Promise<Record<string, string>>)
    | null;
}

interface RouteRegistration {
  method: string;
  pattern: string;
  handler: Handler;
  authRequired: boolean;
}

/**
 * Thrown for a metadata request whose origin is missing, unsafe, or not
 * allowlisted. Rendered as HTTP 400 `{"error":"invalid_request_host"}`.
 */
class MetadataRequestError extends Error {
  constructor(message: string) {
    super(`${ERROR_PREFIX} ${message}`);
    this.name = "MetadataRequestError";
  }
}

/**
 * Installs the complete MCP OAuth facade described by the route-algebra
 * contract version and returns its route inventory. The helper owns
 * composition only: authorize and token routes are absent unless the
 * application supplies both handler factories.
 */
export function registerMcpFacade(
  app: App,
  config: FacadeConfig,
): RouteInventory {
  if (app === null || app === undefined) {
    throw new Error(`${ERROR_PREFIX} app is required`);
  }
  const normalized = normalizeConfig(config);
  const inventory = buildInventory(normalized);
  const registrations = buildRegistrations(normalized, inventory);
  registerRoutes(app, registrations);
  return cloneInventory(inventory);
}

function normalizeConfig(config: FacadeConfig): NormalizedConfig {
  if (config === null || config === undefined) {
    throw new Error(`${ERROR_PREFIX} config is required`);
  }
  if (config.mcpHandler === undefined || config.mcpHandler === null) {
    throw new Error(`${ERROR_PREFIX} MCP handler is required`);
  }
  const transportPosture = normalizeTransportPosture(
    config.transportPosture,
    config.requireBearerToken,
  );
  const normalized = normalizeDerivedConfig(config);
  normalized.transportPosture = transportPosture;
  normalized.requireBearerToken = config.requireBearerToken;
  normalized.mcpHandler = config.mcpHandler;
  normalized.callbackHandler = config.callbackHandler ?? null;

  const frontChannel = normalizeFrontChannel(config);
  normalized.frontChannel = frontChannel;

  validatePostureSurfaceConfig(
    transportPosture,
    normalized.authorizeHandlers,
    normalized.registerHandlers,
    normalized.callbackHandler,
    normalized.rootAuthorizationServer,
    frontChannel !== null,
  );
  return normalized;
}

function normalizeDerivedConfig(config: FacadeConfig): NormalizedConfig {
  const issuerURL = normalizeHTTPSURL(config.issuerURL, true);
  if (issuerURL === null) {
    throw new Error(
      `${ERROR_PREFIX} issuer URL must be an absolute HTTPS URL without query or fragment`,
    );
  }
  const jwksURI = normalizeHTTPSURL(config.jwksURI, false);
  if (jwksURI === null) {
    throw new Error(
      `${ERROR_PREFIX} JWKS URI must be an absolute HTTPS URL without fragment`,
    );
  }
  let registrationEndpointURL = config.registrationEndpointURL ?? "";
  if (registrationEndpointURL.trim() === "") {
    const derived = absoluteURLForPath(issuerURL, "/register");
    if (derived === null) {
      throw new Error(
        `${ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment`,
      );
    }
    registrationEndpointURL = derived;
  } else {
    const normalized = normalizeHTTPSURL(registrationEndpointURL, false);
    if (normalized === null) {
      throw new Error(
        `${ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment`,
      );
    }
    registrationEndpointURL = normalized;
  }

  const { publicBaseURL, allowedHostnames } = normalizeURLMode(config);

  const issuerMode = normalizeIssuerMode(config.issuerMode);
  const upstreamCallbackPath = resolveCallbackPath(config.upstreamCallbackPath);

  const scopes = normalizeScopes(config.scopes);
  const capabilities = normalizeCapabilities(config.capabilities);

  const { authorizeHandlers, tokenHandlers } = buildApplicationHandlers(
    config.authorizeHandler,
    config.tokenHandler,
  );
  const registerHandlers = buildRegisterHandlers(config.registerHandler);

  const { rootAuthorizationServer, rootDiscoveryPath } =
    normalizeRootDiscoveryConfig(config.rootAuthorizationServer);

  return {
    issuerURL,
    jwksURI,
    registrationEndpointURL,
    issuerMode,
    urlMode: config.urlMode,
    publicBaseURL,
    upstreamCallbackPath,
    allowedHostnames,
    scopes,
    capabilities,
    mcpHandler: config.mcpHandler,
    authorizeHandlers,
    tokenHandlers,
    registerHandlers,
    callbackHandler: config.callbackHandler ?? null,
    rootAuthorizationServer,
    rootDiscoveryPath,
    transportPosture: "iam",
    requireBearerToken: undefined,
    frontChannel: null,
  };
}

function normalizeIssuerMode(mode: IssuerMode | undefined): IssuerMode {
  if (mode === undefined || mode === null || String(mode) === "") {
    return ISSUER_MODE_FAMILY;
  }
  if (!supportedIssuerModes().includes(mode)) {
    throw new Error(
      `${ERROR_PREFIX} IssuerMode ${JSON.stringify(mode)} must be one of family, route`,
    );
  }
  return mode;
}

function resolveCallbackPath(configured: string | undefined): string {
  try {
    return callbackPathForConfiguredPath(configured ?? "");
  } catch (err) {
    throw new Error(
      `${ERROR_PREFIX} upstream callback path must be an absolute path without query or fragment`,
      { cause: err },
    );
  }
}

/**
 * The posture-derived inventory is authoritative: none-public attaches no OAuth
 * surface, so configuring any of it is a registration error rather than a
 * silently dropped route.
 */
function validatePostureSurfaceConfig(
  posture: McpTransportPosture,
  authorizeHandlers: Record<EndpointKind, Handler> | null,
  registerHandlers: Record<EndpointKind, Handler> | null,
  callbackHandler: Handler | null,
  rootAuthorizationServer: AuthorizationServerMetadata | null,
  frontChannel: boolean,
): void {
  if (posture !== "none-public") {
    return;
  }
  if (authorizeHandlers !== null) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; authorize/token handlers must not be configured`,
    );
  }
  if (registerHandlers !== null) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; RegisterHandler must not be configured`,
    );
  }
  if (callbackHandler !== null) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; CallbackHandler must not be configured`,
    );
  }
  if (frontChannel) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; the front-channel field set must not be configured`,
    );
  }
  if (rootAuthorizationServer !== null) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture none-public cannot enable RootAuthorizationServer`,
    );
  }
}

/**
 * Validates the framework-owned front-channel field set of `FacadeConfig`
 * (DESIGN §8) and returns it. The set is declared by `provider`: when it is
 * set, every other required front-channel field must be present and the
 * application-owned handler factories that would otherwise claim the same
 * routes must be absent. A null result means the front channel is not declared:
 * the application either owns the OAuth surface through its handler factories
 * or registers none. Nothing here mounts a route; it resolves the set that
 * mounting will later use.
 */
function normalizeFrontChannel(
  config: FacadeConfig,
): FrontChannelConfig | null {
  if (config.provider === undefined || config.provider === null) {
    const name = frontChannelFieldOutsideProvider(config);
    if (name !== null) {
      throw new Error(
        `${ERROR_PREFIX} ${name} is set without Provider; the front-channel field set is anchored by Provider`,
      );
    }
    return null;
  }
  const upstreamIssuer = normalizeHTTPSURL(config.upstreamIssuer ?? "", true);
  if (upstreamIssuer === null) {
    throw new Error(
      `${ERROR_PREFIX} front channel upstream issuer must be an absolute HTTPS URL without query or fragment`,
    );
  }
  if (!validUpstreamClientID(config.upstreamClientID ?? "")) {
    throw new Error(
      `${ERROR_PREFIX} front channel upstream client id is required and must be well-formed`,
    );
  }
  const lifecycleScopes = config.lifecycleScopes ?? [];
  if (lifecycleScopes.length > 0) {
    try {
      normalizeNonEmptyList("lifecycle scope", lifecycleScopes);
    } catch (err) {
      throw new Error(`${ERROR_PREFIX} ${errorMessage(err)}`, { cause: err });
    }
  }
  validateFrontChannelStores(config.stores);
  if (isPresent(config.authorizeHandler) || isPresent(config.tokenHandler)) {
    throw new Error(
      `${ERROR_PREFIX} Provider owns the authorize and token routes; AuthorizeHandler and TokenHandler must not be configured with a front channel`,
    );
  }
  if (isPresent(config.callbackHandler)) {
    throw new Error(
      `${ERROR_PREFIX} Provider owns the stage-global callback; CallbackHandler must not be configured with a front channel`,
    );
  }
  return {
    provider: config.provider,
    stores: config.stores as Stores,
    upstreamClientID: String(config.upstreamClientID ?? "").trim(),
    upstreamIssuer,
    lifecycleScopes: [...lifecycleScopes],
    providerHints: config.providerHints ?? null,
  };
}

/**
 * Reports the first front-channel field that is set while `provider` is
 * absent, so a partially configured front channel fails closed instead of
 * half-registering.
 */
function frontChannelFieldOutsideProvider(config: FacadeConfig): string | null {
  if (frontChannelStoreIsDeclared(config.stores)) {
    return "Stores";
  }
  if (String(config.upstreamClientID ?? "").trim() !== "") {
    return "UpstreamClientID";
  }
  if (String(config.upstreamIssuer ?? "").trim() !== "") {
    return "UpstreamIssuer";
  }
  if ((config.lifecycleScopes ?? []).length > 0) {
    return "LifecycleScopes";
  }
  if (isPresent(config.providerHints)) {
    return "ProviderHints";
  }
  return null;
}

function frontChannelStoreIsDeclared(stores: Stores | undefined): boolean {
  const bundle = (stores ?? {}) as Partial<Stores>;
  return (
    isPresent(bundle.transaction) ||
    isPresent(bundle.authorizationCode) ||
    isPresent(bundle.client) ||
    isPresent(bundle.routeRefreshBroker) ||
    isPresent(bundle.rateLimit)
  );
}

/**
 * Requires every one of the five store SPIs DESIGN §7 defines: a facade missing
 * a store cannot persist the state its mechanics depend on, so it fails closed
 * rather than degrading.
 */
function validateFrontChannelStores(stores: Stores | undefined): void {
  const bundle = (stores ?? {}) as Partial<Stores>;
  const missing = (
    [
      ["Transaction", bundle.transaction],
      ["AuthorizationCode", bundle.authorizationCode],
      ["Client", bundle.client],
      ["RouteRefreshBroker", bundle.routeRefreshBroker],
      ["RateLimit", bundle.rateLimit],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => !isPresent(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `${ERROR_PREFIX} front channel requires all five stores; missing ${missing.join(", ")}`,
    );
  }
}

/**
 * Reports whether an upstream client id is usable: a non-empty, well-formed
 * value. It is a registration identifier, not a secret.
 */
function validUpstreamClientID(clientID: string): boolean {
  const value = String(clientID ?? "").trim();
  return (
    value !== "" && !hasUnpairedSurrogate(value) && !value.includes("\u0000")
  );
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function normalizeTransportPosture(
  posture: McpTransportPosture | undefined,
  requireBearerToken: RequireBearerTokenOptions | undefined,
): McpTransportPosture {
  const resolved = posture ?? "iam";
  if (!TRANSPORT_POSTURES.includes(resolved)) {
    throw new Error(
      `${ERROR_PREFIX} TransportPosture ${JSON.stringify(resolved)} must be one of iam, jwt, runtime-bearer, none-public`,
    );
  }
  if (resolved === "runtime-bearer") {
    if (requireBearerToken === undefined || requireBearerToken === null) {
      throw new Error(
        `${ERROR_PREFIX} TransportPosture runtime-bearer requires RequireBearerToken`,
      );
    }
    return resolved;
  }
  if (requireBearerToken !== undefined && requireBearerToken !== null) {
    if (resolved === "none-public") {
      throw new Error(
        `${ERROR_PREFIX} TransportPosture none-public cannot be combined with RequireBearerToken`,
      );
    }
    throw new Error(
      `${ERROR_PREFIX} RequireBearerToken is only valid with TransportPosture runtime-bearer`,
    );
  }
  return resolved;
}

function buildInventory(config: NormalizedConfig): RouteInventory {
  const authorizationRoutesAttached = config.transportPosture !== "none-public";
  const endpoints = supportedEndpointTemplates();
  const facades = indexFacadeTemplates(supportedOAuthFacadeTemplates());
  const discovery = indexDiscoveryTemplates(supportedOAuthDiscoveryTemplates());
  if (
    endpoints.length !== facades.size ||
    endpoints.length !== discovery.size
  ) {
    throw new Error(
      `${ERROR_PREFIX} incomplete ${CONTRACT_VERSION} route template inventory`,
    );
  }

  const inventory: RouteInventory = {
    contractVersion: CONTRACT_VERSION,
    routes: [],
    rootAuthorizationServerPattern: authorizationServerPathForResourcePath("/"),
    rootAuthorizationServerAttached:
      config.rootAuthorizationServer !== null && authorizationRoutesAttached,
    callbackPattern: config.upstreamCallbackPath,
    issuerMode: config.issuerMode,
  };
  for (const endpoint of endpoints) {
    const facade = facades.get(endpoint.kind);
    const discoveryTemplate = discovery.get(endpoint.kind);
    if (facade === undefined || discoveryTemplate === undefined) {
      throw new Error(
        `${ERROR_PREFIX} incomplete ${CONTRACT_VERSION} routes for endpoint kind ${JSON.stringify(endpoint.kind)}`,
      );
    }
    inventory.routes.push({
      kind: endpoint.kind,
      mcpPattern: endpoint.mcpPattern,
      mcpMethods: [...MCP_METHODS],
      protectedResourcePattern: endpoint.protectedResourcePath,
      discoveryCanonicalPattern: discoveryTemplate.canonicalPattern,
      discoverySuffixPattern: discoveryTemplate.suffixPattern,
      authorizePattern: facade.authorizePattern,
      tokenPattern: facade.tokenPattern,
      registerPattern: facade.registerPattern,
      authorizationRoutesAttached,
    });
  }
  return inventory;
}

function normalizeURLMode(config: FacadeConfig): {
  publicBaseURL: string;
  allowedHostnames: Set<string>;
} {
  if (config.urlMode === URL_MODE_PUBLIC_BASE_URL) {
    const publicBaseURL = normalizePublicBaseURL(config.publicBaseURL ?? "");
    if (publicBaseURL === null) {
      throw new Error(
        `${ERROR_PREFIX} public base URL mode requires an absolute HTTPS URL or loopback HTTP URL without a path, query, or fragment`,
      );
    }
    if ((config.allowedHostnames ?? []).length !== 0) {
      throw new Error(
        `${ERROR_PREFIX} public base URL mode cannot configure allowed hostnames`,
      );
    }
    return { publicBaseURL, allowedHostnames: new Set<string>() };
  }
  if (config.urlMode === URL_MODE_REQUEST_HOST) {
    if ((config.publicBaseURL ?? "").trim() !== "") {
      throw new Error(
        `${ERROR_PREFIX} request-host mode cannot also configure a public base URL`,
      );
    }
    return {
      publicBaseURL: "",
      allowedHostnames: normalizeAllowedHostnames(config.allowedHostnames),
    };
  }
  throw new Error(
    `${ERROR_PREFIX} URL mode must be public_base_url or request_host`,
  );
}

function buildRegistrations(
  config: NormalizedConfig,
  inventory: RouteInventory,
): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  const authRequired =
    config.transportPosture === "iam" || config.transportPosture === "jwt";
  for (const route of inventory.routes) {
    const innerHandler = checkedMCPHandler(route.kind, config.mcpHandler);
    let mcpHandler = innerHandler;
    if (config.requireBearerToken !== undefined) {
      const middleware = requireBearerTokenMiddleware(
        config.requireBearerToken,
      );
      mcpHandler = (ctx) => middleware(ctx, innerHandler);
    }
    registrations.push(
      {
        method: "POST",
        pattern: route.mcpPattern,
        handler: mcpHandler,
        authRequired,
      },
      {
        method: "GET",
        pattern: route.mcpPattern,
        handler: mcpHandler,
        authRequired,
      },
      {
        method: "DELETE",
        pattern: route.mcpPattern,
        handler: mcpHandler,
        authRequired,
      },
    );

    // The OAuth surface follows the posture-derived inventory, not mere handler
    // presence: under the none-public posture nothing OAuth-surface registers.
    if (!route.authorizationRoutesAttached) {
      continue;
    }
    registrations.push({
      method: "GET",
      pattern: route.protectedResourcePattern,
      handler: protectedResourceHandler(config, route.kind),
      authRequired: false,
    });

    const discoveryHandler = authorizationServerHandler(config, route.kind);
    registrations.push(
      {
        method: "GET",
        pattern: route.discoveryCanonicalPattern,
        handler: discoveryHandler,
        authRequired: false,
      },
      {
        method: "GET",
        pattern: route.discoverySuffixPattern,
        handler: discoveryHandler,
        authRequired: false,
      },
    );

    if (config.authorizeHandlers !== null && config.tokenHandlers !== null) {
      registrations.push(
        {
          method: "GET",
          pattern: route.authorizePattern,
          handler: checkedOAuthFacadeHandler(
            route.kind,
            true,
            config.authorizeHandlers[route.kind],
          ),
          authRequired: false,
        },
        {
          method: "POST",
          pattern: route.tokenPattern,
          handler: checkedOAuthFacadeHandler(
            route.kind,
            false,
            config.tokenHandlers[route.kind],
          ),
          authRequired: false,
        },
      );
    }
    if (config.frontChannel !== null) {
      registrations.push(
        {
          method: "GET",
          pattern: route.authorizePattern,
          handler: checkedOAuthFacadeHandler(
            route.kind,
            true,
            authorizeHandlerFor(config, route.kind),
          ),
          authRequired: false,
        },
        {
          method: "POST",
          pattern: route.tokenPattern,
          handler: checkedOAuthFacadeHandler(
            route.kind,
            false,
            tokenHandlerFor(config, route.kind),
          ),
          authRequired: false,
        },
      );
    }
    if (config.registerHandlers !== null) {
      registrations.push({
        method: "POST",
        pattern: route.registerPattern,
        handler: checkedRegisterHandler(
          route.kind,
          config.registerHandlers[route.kind],
        ),
        authRequired: false,
      });
    }
  }
  if (inventory.rootAuthorizationServerAttached) {
    if (
      config.rootAuthorizationServer === null ||
      config.rootDiscoveryPath !== inventory.rootAuthorizationServerPattern
    ) {
      throw new Error(
        `${ERROR_PREFIX} root authorization-server inventory is inconsistent`,
      );
    }
    registrations.push({
      method: "GET",
      pattern: inventory.rootAuthorizationServerPattern,
      handler: withMetadataHeaders(
        authorizationServerMetadataHandler(config.rootAuthorizationServer),
      ),
      authRequired: false,
    });
  }
  if (inventory.callbackPattern !== "" && config.callbackHandler !== null) {
    registrations.push({
      method: "GET",
      pattern: inventory.callbackPattern,
      handler: config.callbackHandler,
      authRequired: false,
    });
  }
  if (inventory.callbackPattern !== "" && config.frontChannel !== null) {
    registrations.push({
      method: "GET",
      pattern: inventory.callbackPattern,
      handler: callbackHandlerFor(config),
      authRequired: false,
    });
  }
  validateRouteRegistrations(registrations);
  return registrations;
}

function validateRouteRegistrations(registrations: RouteRegistration[]): void {
  const seen = new Set<string>();
  const probe = createApp({ tier: "p0" });
  for (const registration of registrations) {
    const method = registration.method.trim().toUpperCase();
    const key = `${method} ${registration.pattern}`;
    if (
      method === "" ||
      registration.pattern === "" ||
      registration.handler === undefined ||
      registration.handler === null
    ) {
      throw new Error(
        `${ERROR_PREFIX} invalid route inventory entry ${JSON.stringify(key)}`,
      );
    }
    if (seen.has(key)) {
      throw new Error(`${ERROR_PREFIX} duplicate route inventory entry ${key}`);
    }
    seen.add(key);
    try {
      probe.handle(method, registration.pattern, registration.handler, {
        authRequired: registration.authRequired,
      });
    } catch (err) {
      throw new Error(
        `${ERROR_PREFIX} invalid or duplicate route inventory entry ${key}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

function registerRoutes(app: App, registrations: RouteRegistration[]): void {
  for (const registration of registrations) {
    try {
      app.handle(
        registration.method,
        registration.pattern,
        registration.handler,
        { authRequired: registration.authRequired },
      );
    } catch (err) {
      throw new Error(
        `${ERROR_PREFIX} register ${registration.method} ${registration.pattern}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

function indexFacadeTemplates(
  templates: OAuthFacadeTemplate[],
): Map<EndpointKind, OAuthFacadeTemplate> {
  const indexed = new Map<EndpointKind, OAuthFacadeTemplate>();
  for (const template of templates) {
    indexed.set(template.kind, template);
  }
  return indexed;
}

function indexDiscoveryTemplates(
  templates: OAuthDiscoveryTemplate[],
): Map<EndpointKind, OAuthDiscoveryTemplate> {
  const indexed = new Map<EndpointKind, OAuthDiscoveryTemplate>();
  for (const template of templates) {
    indexed.set(template.kind, template);
  }
  return indexed;
}

function buildApplicationHandlers(
  authorizeFactory: HandlerFactory | undefined,
  tokenFactory: HandlerFactory | undefined,
): {
  authorizeHandlers: Record<EndpointKind, Handler> | null;
  tokenHandlers: Record<EndpointKind, Handler> | null;
} {
  if (
    (authorizeFactory === undefined || authorizeFactory === null) &&
    (tokenFactory === undefined || tokenFactory === null)
  ) {
    return { authorizeHandlers: null, tokenHandlers: null };
  }
  if (
    authorizeFactory === undefined ||
    authorizeFactory === null ||
    tokenFactory === undefined ||
    tokenFactory === null
  ) {
    throw new Error(
      `${ERROR_PREFIX} authorize and token handler factories must be configured together`,
    );
  }
  const authorizeHandlers = {} as Record<EndpointKind, Handler>;
  const tokenHandlers = {} as Record<EndpointKind, Handler>;
  for (const template of supportedEndpointTemplates()) {
    const authorize = authorizeFactory(template.kind);
    const token = tokenFactory(template.kind);
    if (
      authorize === undefined ||
      authorize === null ||
      token === undefined ||
      token === null
    ) {
      throw new Error(
        `${ERROR_PREFIX} application handler factory returned nil for endpoint kind ${JSON.stringify(template.kind)}`,
      );
    }
    authorizeHandlers[template.kind] = authorize;
    tokenHandlers[template.kind] = token;
  }
  return { authorizeHandlers, tokenHandlers };
}

function buildRegisterHandlers(
  factory: HandlerFactory | undefined,
): Record<EndpointKind, Handler> | null {
  if (factory === undefined || factory === null) {
    return null;
  }
  const handlers = {} as Record<EndpointKind, Handler>;
  for (const template of supportedEndpointTemplates()) {
    const handler = factory(template.kind);
    if (handler === undefined || handler === null) {
      throw new Error(
        `${ERROR_PREFIX} register handler factory returned nil for endpoint kind ${JSON.stringify(template.kind)}`,
      );
    }
    handlers[template.kind] = handler;
  }
  return handlers;
}

function normalizeAllowedHostnames(
  configured: string[] | undefined,
): Set<string> {
  if ((configured ?? []).length === 0) {
    throw new Error(
      `${ERROR_PREFIX} request-host mode requires at least one allowed hostname`,
    );
  }
  const normalized = new Set<string>();
  for (const raw of configured ?? []) {
    const hostname = normalizeAllowedHostname(raw);
    if (hostname === null) {
      throw new Error(
        `${ERROR_PREFIX} allowed hostname ${JSON.stringify(raw)} must be a hostname or hostname:port`,
      );
    }
    normalized.add(hostname);
  }
  return normalized;
}

function normalizeRootDiscoveryConfig(
  config: RootDiscoveryConfig | undefined,
): {
  rootAuthorizationServer: AuthorizationServerMetadata | null;
  rootDiscoveryPath: string;
} {
  if (config === undefined || config === null) {
    return { rootAuthorizationServer: null, rootDiscoveryPath: "" };
  }
  const issuer = normalizeHTTPSURL(config.issuerURL, true);
  if (issuer === null) {
    throw new Error(
      `${ERROR_PREFIX} root discovery issuer URL must be an absolute HTTPS URL without query or fragment`,
    );
  }
  const authorize = normalizeHTTPSURL(config.authorizationEndpointURL, false);
  if (authorize === null) {
    throw new Error(
      `${ERROR_PREFIX} root discovery authorization endpoint URL must be an absolute HTTPS URL without fragment`,
    );
  }
  const token = normalizeHTTPSURL(config.tokenEndpointURL, false);
  if (token === null) {
    throw new Error(
      `${ERROR_PREFIX} root discovery token endpoint URL must be an absolute HTTPS URL without fragment`,
    );
  }
  const registration = normalizeHTTPSURL(config.registrationEndpointURL, false);
  if (registration === null) {
    throw new Error(
      `${ERROR_PREFIX} root discovery registration endpoint URL must be an absolute HTTPS URL without fragment`,
    );
  }
  const jwks = normalizeHTTPSURL(config.jwksURI, false);
  if (jwks === null) {
    throw new Error(
      `${ERROR_PREFIX} root discovery JWKS URI must be an absolute HTTPS URL without fragment`,
    );
  }
  const scopes = normalizeNonEmptyList("root discovery scope", config.scopes);
  const capabilities = defaultCapabilities();
  return {
    rootAuthorizationServer: {
      issuer,
      authorization_endpoint: authorize,
      token_endpoint: token,
      registration_endpoint: registration,
      jwks_uri: jwks,
      response_types_supported: capabilities.responseTypes,
      grant_types_supported: capabilities.grantTypes,
      token_endpoint_auth_methods_supported:
        capabilities.tokenEndpointAuthMethods,
      code_challenge_methods_supported: capabilities.codeChallengeMethods,
      scopes_supported: scopes,
    },
    rootDiscoveryPath: authorizationServerPathForResourcePath("/"),
  };
}

function normalizeScopes(
  configured: Partial<Record<EndpointKind, string[]>>,
): Record<EndpointKind, string[]> {
  const templates = supportedEndpointTemplates();
  const supported = new Set(templates.map((template) => template.kind));
  for (const kind of Object.keys(configured ?? {})) {
    if (!supported.has(kind as EndpointKind)) {
      throw new Error(
        `${ERROR_PREFIX} scopes configured for unsupported endpoint kind ${JSON.stringify(kind)}`,
      );
    }
  }

  const normalized = {} as Record<EndpointKind, string[]>;
  for (const template of templates) {
    const scopes = configured?.[template.kind];
    if (scopes === undefined) {
      throw new Error(
        `${ERROR_PREFIX} scopes are required for endpoint kind ${JSON.stringify(template.kind)}`,
      );
    }
    try {
      normalized[template.kind] = normalizeNonEmptyList("scope", scopes);
    } catch (err) {
      throw new Error(
        `${ERROR_PREFIX} endpoint kind ${JSON.stringify(template.kind)}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
  return normalized;
}

function normalizeCapabilities(
  configured: FacadeCapabilities | undefined,
): ResolvedCapabilities {
  const defaults = defaultCapabilities();
  const opts = configured ?? {};
  return {
    responseTypes: normalizeNonEmptyList(
      "response type",
      opts.responseTypes ?? defaults.responseTypes,
    ),
    grantTypes: normalizeNonEmptyList(
      "grant type",
      opts.grantTypes ?? defaults.grantTypes,
    ),
    tokenEndpointAuthMethods: normalizeNonEmptyList(
      "token endpoint auth method",
      opts.tokenEndpointAuthMethods ?? defaults.tokenEndpointAuthMethods,
    ),
    codeChallengeMethods: normalizeNonEmptyList(
      "code challenge method",
      opts.codeChallengeMethods ?? defaults.codeChallengeMethods,
    ),
  };
}

/**
 * True when the value holds an unpaired UTF-16 surrogate, i.e. a value that is
 * not well-formed Unicode and cannot be encoded as well-formed UTF-8.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Trims each value, rejects an empty value, de-duplicates preserving order, and
 * requires at least one value.
 */
function normalizeNonEmptyList(label: string, values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    const value = String(raw ?? "").trim();
    if (value === "") {
      throw new Error(`${label} values cannot be empty`);
    }
    if (hasUnpairedSurrogate(value)) {
      throw new Error(`${label} values must be well-formed Unicode`);
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  if (normalized.length === 0) {
    throw new Error(`at least one ${label} is required`);
  }
  return normalized;
}

function checkedMCPHandler(kind: EndpointKind, next: Handler): Handler {
  return (ctx) => {
    let endpoint: EndpointPath;
    try {
      endpoint = endpointFromMCPRequest(ctx);
    } catch {
      throw new Error(
        `${ERROR_PREFIX} request path does not identify endpoint kind ${JSON.stringify(kind)}`,
      );
    }
    if (endpoint.kind !== kind) {
      throw new Error(
        `${ERROR_PREFIX} request path does not identify endpoint kind ${JSON.stringify(kind)}`,
      );
    }
    return next(ctx);
  };
}

function checkedOAuthFacadeHandler(
  kind: EndpointKind,
  authorize: boolean,
  next: Handler,
): Handler {
  return (ctx) => {
    const endpoint = endpointFromRouteParams(ctx, kind);
    const expectedPath = authorize
      ? oauthAuthorizePath(endpoint)
      : oauthTokenPath(endpoint);
    if (ctx.request.path !== expectedPath) {
      throw new Error(
        `${ERROR_PREFIX} request path is not an OAuth facade path for endpoint kind ${JSON.stringify(kind)}`,
      );
    }
    return next(ctx);
  };
}

function checkedRegisterHandler(kind: EndpointKind, next: Handler): Handler {
  return (ctx) => {
    const endpoint = endpointFromRouteParams(ctx, kind);
    const expectedPath = oauthRegisterPath(endpoint);
    if (ctx.request.path !== expectedPath) {
      throw new Error(
        `${ERROR_PREFIX} request path is not a registration path for endpoint kind ${JSON.stringify(kind)}`,
      );
    }
    return next(ctx);
  };
}

function protectedResourceHandler(
  config: NormalizedConfig,
  kind: EndpointKind,
): Handler {
  return serveMetadata((ctx) => {
    const endpoint = endpointFromProtectedResourceRequest(ctx);
    if (endpoint.kind !== kind) {
      throw new Error(
        `${ERROR_PREFIX} protected-resource path does not identify endpoint kind ${JSON.stringify(kind)}`,
      );
    }
    const resourceURL = buildAbsoluteURL(config, ctx, mcpPath(endpoint));
    const authorizationServers =
      config.issuerMode === ISSUER_MODE_ROUTE
        ? [resourceURL]
        : [config.issuerURL];
    const metadata: ProtectedResourceMetadata = {
      resource: resourceURL,
      authorization_servers: authorizationServers,
    };
    if (config.jwksURI) {
      metadata.jwks_uri = config.jwksURI;
    }
    const scopes = config.scopes[kind];
    if (scopes.length > 0) {
      metadata.scopes_supported = [...scopes];
    }
    return withMetadataHeaders(protectedResourceMetadataHandler(metadata))(ctx);
  });
}

function authorizationServerHandler(
  config: NormalizedConfig,
  kind: EndpointKind,
): Handler {
  return serveMetadata((ctx) => {
    const endpoint = endpointFromDiscoveryRequest(ctx, kind);
    const authorizeURL = buildAbsoluteURL(
      config,
      ctx,
      oauthAuthorizePath(endpoint),
    );
    const tokenURL = buildAbsoluteURL(config, ctx, oauthTokenPath(endpoint));
    const { issuer, registrationEndpoint } = routedIssuerAndRegistration(
      config,
      ctx,
      endpoint,
    );
    const metadata: AuthorizationServerMetadata = {
      issuer,
      authorization_endpoint: authorizeURL,
      token_endpoint: tokenURL,
      registration_endpoint: registrationEndpoint,
      jwks_uri: config.jwksURI,
      response_types_supported: [...config.capabilities.responseTypes],
      grant_types_supported: [...config.capabilities.grantTypes],
      token_endpoint_auth_methods_supported: [
        ...config.capabilities.tokenEndpointAuthMethods,
      ],
      code_challenge_methods_supported: [
        ...config.capabilities.codeChallengeMethods,
      ],
      scopes_supported: [...config.scopes[kind]],
    };
    return withMetadataHeaders(authorizationServerMetadataHandler(metadata))(
      ctx,
    );
  });
}

/**
 * Wraps a metadata handler so a request-origin failure is rendered as its HTTP
 * 400 response instead of propagating as an internal error.
 */
function serveMetadata(
  build: (ctx: Context) => Response | Promise<Response>,
): Handler {
  return async (ctx) => {
    try {
      return await build(ctx);
    } catch (err) {
      const response = metadataRequestFailure(err);
      if (response !== null) {
        return response;
      }
      throw err;
    }
  };
}

/**
 * Returns the issuer and registration endpoint the routed RFC 8414 document
 * advertises. In route issuer mode the route URL is the issuer and the
 * registration endpoint is the route's own derived /register path.
 */
function routedIssuerAndRegistration(
  config: NormalizedConfig,
  ctx: Context,
  endpoint: EndpointPath,
): { issuer: string; registrationEndpoint: string } {
  if (config.issuerMode !== ISSUER_MODE_ROUTE) {
    return {
      issuer: config.issuerURL,
      registrationEndpoint: config.registrationEndpointURL,
    };
  }
  return {
    issuer: buildAbsoluteURL(config, ctx, mcpPath(endpoint)),
    registrationEndpoint: buildAbsoluteURL(
      config,
      ctx,
      oauthRegisterPath(endpoint),
    ),
  };
}

function endpointFromMCPRequest(ctx: Context): EndpointPath {
  if (ctx === null || ctx === undefined) {
    throw new Error(`${ERROR_PREFIX} request context is required`);
  }
  return parseMcpPath(ctx.request.path);
}

function endpointFromProtectedResourceRequest(ctx: Context): EndpointPath {
  if (ctx === null || ctx === undefined) {
    throw new Error(`${ERROR_PREFIX} request context is required`);
  }
  const resourcePath = resourcePathFromProtectedResourcePath(ctx.request.path);
  return parseMcpPath(resourcePath);
}

function endpointFromDiscoveryRequest(
  ctx: Context,
  kind: EndpointKind,
): EndpointPath {
  const endpoint = endpointFromRouteParams(ctx, kind);
  const canonicalPath = oauthAuthorizationServerPath(endpoint);
  const suffixPath = oauthAuthorizationServerSuffixPath(endpoint);
  if (ctx.request.path !== canonicalPath && ctx.request.path !== suffixPath) {
    throw new Error(
      `${ERROR_PREFIX} request path is not a discovery path for endpoint kind ${JSON.stringify(kind)}`,
    );
  }
  return endpoint;
}

function endpointFromRouteParams(
  ctx: Context,
  kind: EndpointKind,
): EndpointPath {
  if (ctx === null || ctx === undefined) {
    throw new Error(`${ERROR_PREFIX} request context is required`);
  }
  const candidate: EndpointPath = {
    kind,
    clientNamespace: ctx.param(PARAM_CLIENT_NAMESPACE),
    partnerId: ctx.param(PARAM_PARTNER_ID),
    agentId: ctx.param(PARAM_AGENT_ID),
  };
  return parseMcpPath(mcpPath(candidate));
}

function buildAbsoluteURL(
  config: NormalizedConfig,
  ctx: Context,
  routePath: string,
): string {
  let baseURL = config.publicBaseURL;
  if (config.urlMode === URL_MODE_REQUEST_HOST) {
    if (ctx === null || ctx === undefined) {
      throw new MetadataRequestError(
        "request context is required for request-host URL mode",
      );
    }
    const normalized = normalizeRequestOrigin(originURL(ctx.request.headers));
    if (normalized === null) {
      throw new MetadataRequestError("request host is missing or unsafe");
    }
    baseURL = normalized;
    const origin = parseAbsoluteURL(baseURL);
    if (origin === null) {
      throw new Error(`${ERROR_PREFIX} normalized request origin is invalid`);
    }
    if (!config.allowedHostnames.has(requestHostAllowlistKey(origin))) {
      throw new MetadataRequestError("request host is not allowlisted");
    }
  }
  const absolute = absoluteURLForPath(baseURL, routePath);
  if (absolute === null) {
    throw new Error(
      `${ERROR_PREFIX} cannot build absolute URL for route path ${JSON.stringify(routePath)}`,
    );
  }
  return absolute;
}

/** Renders a metadata request-origin failure as its HTTP 400 response. */
function metadataRequestFailure(err: unknown): Response | null {
  if (!(err instanceof MetadataRequestError)) {
    return null;
  }
  return {
    status: 400,
    headers: {
      "cache-control": ["no-store"],
      "content-type": ["application/json; charset=utf-8"],
      vary: [METADATA_VARY_HEADER],
    },
    cookies: [],
    body: Buffer.from('{"error":"invalid_request_host"}', "utf8"),
    isBase64: false,
  };
}

function withMetadataHeaders(next: Handler): Handler {
  return async (ctx) => {
    const response = await next(ctx);
    return {
      ...response,
      headers: {
        ...response.headers,
        "cache-control": ["no-store"],
        vary: [METADATA_VARY_HEADER],
      },
    };
  };
}

// ---------------------------------------------------------------------------
// URL helpers (mirroring the Go facade's url normalization)
// ---------------------------------------------------------------------------

interface ParsedURL {
  scheme: string;
  /** Host without userinfo, as given (trailing dot and case preserved). */
  host: string;
  /** Hostname without brackets, as given. */
  hostname: string;
  /**
   * Decoded host as a byte string (one code unit per byte), mirroring Go's
   * decoded `url.URL.Host`. Re-encoding goes through {@link encodeHostBytes}.
   */
  decodedHost: string;
  /** Decoded hostname as a byte string, mirroring Go's decoded `url.URL.Hostname()`. */
  decodedHostname: string;
  port: string;
  /**
   * Percent-decoded path as a byte string: every code unit is one decoded byte
   * (0-255), mirroring Go's decoded `url.URL.Path`. Re-encoding goes through
   * {@link encodePathBytes}, never through the input text.
   */
  path: string;
  /** Raw query including the leading "?", as given. */
  search: string;
  /** Raw fragment including the leading "#", or "" for an absent/empty fragment. */
  hash: string;
  hasUser: boolean;
}

/** UTF-8 bytes that `encodePath` leaves unescaped, matching Go's `net/url`. */
const PATH_LITERAL_BYTES = (() => {
  const table = new Uint8Array(256);
  const literals = "-._~$&+,/:;=@";
  for (let code = 0; code < 256; code += 1) {
    const isAlphanumeric =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    table[code] = isAlphanumeric ? 1 : 0;
  }
  for (const ch of literals) {
    table[ch.charCodeAt(0)] = 1;
  }
  return table;
})();

/** ASCII bytes `net/url` accepts unescaped in a reg-name host. */
const HOST_LITERAL_BYTES = (() => {
  const table = new Uint8Array(256);
  const literals = "!$&'()*+,;=:[]<>\"-._~";
  for (let code = 0; code < 256; code += 1) {
    const isAlphanumeric =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    table[code] = isAlphanumeric ? 1 : 0;
  }
  for (const ch of literals) {
    table[ch.charCodeAt(0)] = 1;
  }
  return table;
})();

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

/** True when the text carries a C0 control byte or DEL, which `net/url` rejects. */
function containsControlByte(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Mirrors Go's `url.Parse` host validation (`unescape(host, encodeHost)`): a
 * malformed percent escape, or an ASCII byte outside the reg-name set, fails
 * the whole parse. Bytes above 0x7f and the redundant `%25` escape pass.
 */
function validHostBytes(host: string): boolean {
  let index = 0;
  while (index < host.length) {
    if (host[index] === "%") {
      if (index + 2 >= host.length) {
        return false;
      }
      const hex = host.slice(index + 1, index + 3);
      if (!HEX_PAIR.test(hex)) {
        return false;
      }
      if (
        Number.parseInt(hex, 16) < 0x80 &&
        host.slice(index, index + 3) !== "%25"
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    const code = host.charCodeAt(index);
    if (code < 0x80 && HOST_LITERAL_BYTES[code] !== 1) {
      return false;
    }
    index += 1;
  }
  return true;
}

/**
 * Percent-decodes a raw path into a byte string (one code unit per byte),
 * mirroring Go's `url.Parse`, which fails the whole parse on a malformed escape
 * such as `%zz`. Returns null on a malformed escape.
 */
function decodePathBytes(rawPath: string): string | null {
  let decoded = "";
  let segment = "";
  let index = 0;
  while (index < rawPath.length) {
    const ch = rawPath[index] ?? "";
    if (ch !== "%") {
      segment += ch;
      index += 1;
      continue;
    }
    if (index + 2 >= rawPath.length) {
      return null;
    }
    const hex = rawPath.slice(index + 1, index + 3);
    if (!HEX_PAIR.test(hex)) {
      return null;
    }
    if (segment !== "") {
      decoded += utf8ByteString(segment);
      segment = "";
    }
    decoded += String.fromCharCode(Number.parseInt(hex, 16));
    index += 3;
  }
  if (segment !== "") {
    decoded += utf8ByteString(segment);
  }
  return decoded;
}

/** Re-encodes UTF-8 text as a byte string (one code unit per byte). */
function utf8ByteString(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    out += String.fromCharCode(byte);
  }
  return out;
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 lead-byte widths; 0 marks a byte that can never start a sequence. */
const UTF8_SEQUENCE_LENGTH = (() => {
  const table = new Uint8Array(256);
  for (let code = 0x00; code < 0x80; code += 1) {
    table[code] = 1;
  }
  for (let code = 0xc2; code <= 0xdf; code += 1) {
    table[code] = 2;
  }
  for (let code = 0xe0; code <= 0xef; code += 1) {
    table[code] = 3;
  }
  for (let code = 0xf0; code <= 0xf4; code += 1) {
    table[code] = 4;
  }
  return table;
})();

/**
 * Decodes a byte string the way Go's `for range` does: a valid UTF-8 sequence
 * becomes its rune, and every invalid byte becomes U+FFFD on its own.
 */
function decodeUtf8Lenient(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const byte = value.charCodeAt(index);
    if (byte < 0x80) {
      out += value[index];
      index += 1;
      continue;
    }
    const size = UTF8_SEQUENCE_LENGTH[byte] ?? 0;
    if (size > 1 && index + size <= value.length) {
      const chunk = value.slice(index, index + size);
      try {
        out += STRICT_UTF8_DECODER.decode(Buffer.from(chunk, "latin1"));
        index += size;
        continue;
      } catch {
        // Fall through to the single replacement character.
      }
    }
    out += "\ufffd";
    index += 1;
  }
  return out;
}

/**
 * Lowercases a decoded host byte string the way Go's `strings.ToLower` does,
 * including its U+FFFD substitution for bytes that are not valid UTF-8.
 */
function lowercaseHostBytes(value: string): string {
  return utf8ByteString(decodeUtf8Lenient(value).toLowerCase());
}

/**
 * Percent-decodes a raw host into a byte string, mirroring Go's
 * `unescape(host, encodeHost)`. The caller has already checked the escapes with
 * {@link validHostBytes}.
 */
function decodeHostBytes(host: string): string {
  return decodePathBytes(host) ?? "";
}

/**
 * Escapes a byte-string host with Go's `encodeHost` rule: literal host bytes
 * pass, and everything else (including a literal percent and UTF-8 bytes) is
 * re-encoded with uppercase hex.
 */
function encodeHostBytes(host: string): string {
  let out = "";
  for (let index = 0; index < host.length; index += 1) {
    const code = host.charCodeAt(index);
    if (code < 0x80 && HOST_LITERAL_BYTES[code] === 1) {
      out += host[index];
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

const HEX_DIGIT = /^[0-9A-Fa-f]$/;
const DECIMAL_FIELD = /^[0-9]{1,3}$/;

/** Mirrors Go's `parseIPv4Fields` for the dotted quad embedded in an IPv6 literal. */
function validIPv4Quad(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!DECIMAL_FIELD.test(part)) {
      return false;
    }
    if (part.length > 1 && part[0] === "0") {
      return false;
    }
    if (Number.parseInt(part, 10) > 255) {
      return false;
    }
  }
  return true;
}

/**
 * True when `text` is a bare IPv6 literal, mirroring `netip.ParseAddr` for the
 * addresses RFC 3986 allows between square brackets.
 */
function validIPv6Address(text: string): boolean {
  if (text === "") {
    return false;
  }
  let remainder = text;
  let ellipsis = -1;
  if (remainder.length >= 2 && remainder[0] === ":" && remainder[1] === ":") {
    ellipsis = 0;
    remainder = remainder.slice(2);
    if (remainder === "") {
      return true;
    }
  }
  let bits = 0;
  while (bits < 16) {
    let digits = 0;
    while (
      digits < remainder.length &&
      HEX_DIGIT.test(remainder[digits] ?? "")
    ) {
      digits += 1;
    }
    if (digits === 0 || digits > 4) {
      return false;
    }
    if (digits < remainder.length && remainder[digits] === ".") {
      // A dotted quad may only replace the final two 16-bit fields.
      if (ellipsis < 0 && bits !== 12) {
        return false;
      }
      if (bits + 4 > 16) {
        return false;
      }
      if (!validIPv4Quad(remainder)) {
        return false;
      }
      remainder = "";
      bits += 4;
      break;
    }
    bits += 2;
    remainder = remainder.slice(digits);
    if (remainder === "") {
      break;
    }
    if (remainder[0] !== ":" || remainder.length === 1) {
      return false;
    }
    remainder = remainder.slice(1);
    if (remainder[0] === ":") {
      if (ellipsis >= 0) {
        return false;
      }
      ellipsis = bits;
      remainder = remainder.slice(1);
      if (remainder === "") {
        break;
      }
    }
  }
  if (remainder !== "") {
    return false;
  }
  if (bits < 16) {
    return ellipsis >= 0;
  }
  return ellipsis < 0;
}

/**
 * Mirrors `net/url`'s IP-literal rule: the text between brackets must be an
 * IPv6 address, optionally with a `%25`-escaped zone identifier.
 */
function validBracketedHostname(raw: string): boolean {
  const zone = raw.indexOf("%25");
  if (zone < 0) {
    return validIPv6Address(raw);
  }
  return raw.slice(zone + 3) !== "" && validIPv6Address(raw.slice(0, zone));
}

/** Escapes a byte-string path with Go's `encodePath` rule (uppercase hex). */
function encodePathBytes(path: string): string {
  let out = "";
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 256 && PATH_LITERAL_BYTES[code] === 1) {
      out += path[index];
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * A minimal absolute-URL parser mirroring the Go facade's `url.Parse` usage.
 * An empty authority (for example `https:///token`) yields an empty host and is
 * rejected by {@link parseAbsoluteURL}.
 */
function parseURL(raw: string): ParsedURL | null {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return null;
  }
  if (containsControlByte(trimmed)) {
    return null;
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch === null) {
    return null;
  }
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  let rest = trimmed.slice(schemeMatch[0].length);

  let authority = "";
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    let end = rest.length;
    for (let index = 0; index < rest.length; index += 1) {
      const ch = rest[index];
      if (ch === "/" || ch === "?" || ch === "#") {
        end = index;
        break;
      }
    }
    authority = rest.slice(0, end);
    rest = rest.slice(end);
  }

  let hostport = authority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    hostport = authority.slice(at + 1);
  }

  let hostname = hostport;
  let port = "";
  // Go's parseHost rejects any host whose last "[" is not the leading byte, so a
  // stray "[" outside a bracketed IP literal fails the whole parse. A stray "]"
  // is an ordinary reg-name byte and still passes.
  const openBracket = hostport.lastIndexOf("[");
  if (openBracket > 0) {
    return null;
  }
  const bracketed = openBracket === 0;
  if (bracketed) {
    const close = hostport.indexOf("]");
    if (close < 0) {
      return null;
    }
    hostname = hostport.slice(1, close);
    const after = hostport.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) {
        return null;
      }
      port = after.slice(1);
    }
  } else {
    const colon = hostport.indexOf(":");
    if (colon >= 0) {
      hostname = hostport.slice(0, colon);
      port = hostport.slice(colon + 1);
    }
  }
  if (port !== "" && !/^\d+$/.test(port)) {
    return null;
  }
  if (hostport !== "" && !validHostBytes(hostport)) {
    return null;
  }
  if (bracketed && !validBracketedHostname(hostname)) {
    return null;
  }

  let rawPath = rest;
  let hash = "";
  const hashIndex = rawPath.indexOf("#");
  if (hashIndex >= 0) {
    const fragment = rawPath.slice(hashIndex + 1);
    hash = fragment === "" ? "" : rawPath.slice(hashIndex);
    rawPath = rawPath.slice(0, hashIndex);
  }
  let search = "";
  const queryIndex = rawPath.indexOf("?");
  if (queryIndex >= 0) {
    search = rawPath.slice(queryIndex);
    rawPath = rawPath.slice(0, queryIndex);
  }
  const path = decodePathBytes(rawPath);
  if (path === null) {
    return null;
  }

  return {
    scheme,
    host: hostport,
    hostname,
    decodedHost: decodeHostBytes(hostport),
    decodedHostname: decodeHostBytes(hostname),
    port,
    path,
    search,
    hash,
    // Go's parseAuthority treats the authority as carrying userinfo whenever it
    // holds an "@", so an empty userinfo ("https://@host/") is userinfo too.
    hasUser: at >= 0,
  };
}

/** Mirrors the Go helper: a scheme, an authority, and no userinfo. */
function parseAbsoluteURL(raw: string): ParsedURL | null {
  const u = parseURL(raw);
  if (u === null) {
    return null;
  }
  if (u.scheme === "" || u.hostname === "" || u.hasUser || u.host === "") {
    return null;
  }
  return u;
}

/**
 * Canonicalizes a decoded hostname: Go lowercases the decoded host and drops
 * one trailing root dot, then re-brackets an IPv6 literal.
 */
function canonicalHostname(decodedHostname: string): string {
  let lower = lowercaseHostBytes(decodedHostname);
  if (lower.endsWith(".")) {
    lower = lower.slice(0, -1);
  }
  if (lower.includes(":")) {
    return `[${lower}]`;
  }
  return lower;
}

/**
 * The allowlist key for a normalized request origin.
 *
 * The allowlist is stored as decoded, canonicalized authorities (see
 * {@link normalizeAllowedHostname}), so the request authority must be
 * canonicalized the same way before the lookup: Go compares the decoded request
 * host against the decoded allowlist set, while a raw comparison would reject
 * every allowed hostname whose raw form differs from its canonical form
 * (non-ASCII, percent-escaped, or an IPv6 zone). {@link normalizeRequestOrigin}
 * has already lowercased the authority and stripped the request scheme's own
 * default port, so only the decoded bytes need canonicalizing here.
 */
function requestHostAllowlistKey(u: ParsedURL): string {
  const hostname = canonicalHostname(u.decodedHostname);
  if (hostname === "") {
    return "";
  }
  if (u.port === "") {
    return hostname;
  }
  return joinHostPort(hostname.replace(/^\[/, "").replace(/\]$/, ""), u.port);
}

function canonicalAuthority(u: ParsedURL): string {
  const hostname = canonicalHostname(u.decodedHostname);
  if (hostname === "") {
    return "";
  }
  let port = u.port;
  if (
    (u.scheme === "https" && port === "443") ||
    (u.scheme === "http" && port === "80")
  ) {
    port = "";
  }
  if (port !== "") {
    return joinHostPort(hostname.replace(/^\[/, "").replace(/\]$/, ""), port);
  }
  return hostname;
}

function joinHostPort(host: string, port: string): string {
  if (host.includes(":")) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

function normalizeHTTPSURL(raw: string, issuer: boolean): string | null {
  const u = parseAbsoluteURL(raw);
  if (u === null || u.scheme !== "https" || u.hash !== "") {
    return null;
  }
  if (issuer && u.search !== "") {
    return null;
  }
  const authority = canonicalAuthority(u);
  if (authority === "") {
    return null;
  }
  // Go clears RawPath and re-serializes the decoded path, so `%41` becomes `A`.
  const decodedPath = issuer ? trimTrailingSlashes(u.path) : u.path;
  const path = encodePathBytes(decodedPath);
  const query = issuer ? "" : u.search;
  // Go re-escapes the decoded host, so `%c3%a9` becomes `%C3%A9`.
  return `${u.scheme}://${encodeHostBytes(authority)}${path}${query}`;
}

function normalizePublicBaseURL(raw: string): string | null {
  return normalizeRequestOrigin(raw);
}

function normalizeAllowedHostname(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (value === "" || value.includes("/") || /[?#@]/.test(value)) {
    return null;
  }
  const u = parseURL(`https://${value}`);
  if (
    u === null ||
    u.hostname === "" ||
    u.hasUser ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    return null;
  }
  const port = u.port;
  if (port === "80" || port === "443") {
    const hostname = canonicalHostname(u.decodedHostname);
    return hostname === "" ? null : hostname;
  }
  const authority = canonicalAuthority(u);
  return authority === "" ? null : authority;
}

function absoluteURLForPath(baseURL: string, routePath: string): string | null {
  const u = parseAbsoluteURL(baseURL);
  if (u === null || !routePath.startsWith("/")) {
    return null;
  }
  // Go keeps the parsed authority's text and re-encodes it from its decoded bytes.
  const path = encodePathBytes(
    trimTrailingSlashes(u.path) + utf8ByteString(routePath),
  );
  return `${u.scheme}://${encodeHostBytes(u.decodedHost)}${path}`;
}

/** Removes every trailing "/" without a backtracking regex (ReDoS-safe). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Validates and canonicalizes a request-derived origin. Accepts HTTPS, plus
 * HTTP only for loopback hosts, and removes scheme-default ports.
 */
export function normalizeRequestOrigin(raw: string): string | null {
  const u = parseAbsoluteURL(raw);
  if (
    u === null ||
    u.hasUser ||
    u.hostname === "" ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    return null;
  }
  if (u.path !== "" && u.path !== "/") {
    return null;
  }
  if (!isAllowedDiscoveryScheme(u.scheme, u.hostname)) {
    return null;
  }
  const authority = canonicalizeRequestOriginAuthority(u);
  if (authority === "") {
    return null;
  }
  return `${u.scheme}://${authority}`;
}

function canonicalizeRequestOriginAuthority(u: ParsedURL): string {
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "") {
    return "";
  }
  let port = u.port;
  if (port === defaultPortForScheme(u.scheme)) {
    port = "";
  }
  if (port !== "") {
    return joinHostPort(hostname, port);
  }
  if (hostname.includes(":")) {
    return `[${hostname}]`;
  }
  return hostname;
}

function defaultPortForScheme(scheme: string): string {
  if (scheme === "https") {
    return "443";
  }
  if (scheme === "http") {
    return "80";
  }
  return "";
}

function isLoopbackHostname(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost" || value === "::1") {
    return true;
  }
  return /^127\./.test(value);
}

function isAllowedDiscoveryScheme(scheme: string, hostname: string): boolean {
  return (
    scheme === "https" || (scheme === "http" && isLoopbackHostname(hostname))
  );
}

function cloneInventory(inventory: RouteInventory): RouteInventory {
  return {
    contractVersion: inventory.contractVersion,
    routes: inventory.routes.map((route) => ({
      ...route,
      mcpMethods: [...route.mcpMethods],
    })),
    rootAuthorizationServerPattern: inventory.rootAuthorizationServerPattern,
    rootAuthorizationServerAttached: inventory.rootAuthorizationServerAttached,
    callbackPattern: inventory.callbackPattern,
    issuerMode: inventory.issuerMode,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Framework-owned OAuth front channel (DESIGN §8)
// ---------------------------------------------------------------------------

/** The store status values the front channel writes into its records. */
const FRONT_CHANNEL_TRANSACTION_STATUS_PENDING = "pending";
const FRONT_CHANNEL_CODE_STATUS_ISSUED = "issued";

/**
 * Bounds every front-channel POST body before it is parsed. The bound is a
 * framework default, deliberately not a FacadeConfig field or an environment
 * variable, so no adopter can widen the door; it applies to the raw request
 * bytes and a body strictly larger than it fails closed with invalid_request.
 * The token endpoint consumes it today and the DCR JSON body will inherit the
 * same bound, so the name stays endpoint-neutral.
 */
const FRONT_CHANNEL_MAX_REQUEST_BODY_BYTES = 16384;

/**
 * The closed, fixed client-facing error vocabulary of the front channel
 * (DESIGN §8). Every rejection of one error code carries the same description,
 * so the response never distinguishes an unknown key from a used one
 * (THREAT_MODEL cross-cutting: no oracle).
 */
const FRONT_CHANNEL_ERROR_DESCRIPTIONS: Record<string, string> = {
  invalid_client: "the client is not registered",
  invalid_request: "the request is missing or has an invalid parameter",
  invalid_target: "the resource is not the resource this route authorizes",
  invalid_grant: "the grant is invalid, expired, or already used",
  unsupported_grant_type: "the grant type is not supported",
  upstream_error:
    "the upstream authorization server could not complete the request",
};

/** One resolved absolute-URL read a front-channel leg may render as a failure. */
interface RouteResolution {
  value: string;
  failure: Response | null;
}

function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Builds the framework-owned per-kind OAuth handlers and the one stage-global
 * callback. They are only built when the front-channel field set is declared.
 */
function authorizeHandlerFor(
  config: NormalizedConfig,
  kind: EndpointKind,
): Handler {
  return (ctx) => handleAuthorize(config, kind, ctx);
}

function tokenHandlerFor(
  config: NormalizedConfig,
  kind: EndpointKind,
): Handler {
  return (ctx) => handleToken(config, kind, ctx);
}

function callbackHandlerFor(config: NormalizedConfig): Handler {
  return (ctx) => handleCallback(config, ctx);
}

/**
 * Terminates the client-facing front channel (DESIGN §8.1): it validates the
 * registered client and its exact redirect URI before any redirect, requires
 * S256 PKCE, records a single-use transaction, and sends the browser upstream
 * with the facade's own client, callback, PKCE verifier, fresh state, resource,
 * hints, and clamped scope set.
 */
async function handleAuthorize(
  config: NormalizedConfig,
  kind: EndpointKind,
  ctx: Context,
): Promise<Response> {
  const front = config.frontChannel;
  if (front === null) {
    throw new Error(`${ERROR_PREFIX} front channel is not configured`);
  }
  const endpoint = endpointFromRouteParams(ctx, kind);
  const resourceResolution = frontChannelRouteResource(config, ctx, endpoint);
  if (resourceResolution.failure !== null) {
    return resourceResolution.failure;
  }
  const resource = resourceResolution.value;
  const issuerResolution = frontChannelRouteIssuer(config, ctx, endpoint);
  if (issuerResolution.failure !== null) {
    return issuerResolution.failure;
  }
  const issuer = issuerResolution.value;

  // Validation order (DESIGN §8.1): client, redirect URI, response_type, S256
  // PKCE, state, resource, scope. Errors raised before the redirect URI is
  // validated render an error page and never redirect.
  const clientID = firstQueryValue(ctx.request.query, "client_id");
  if (clientID.trim() === "") {
    return facadeErrorPage(400, "invalid_request");
  }
  const client = await front.stores.client.get(hashKey(clientID));
  if (client === null) {
    return facadeErrorPage(400, "invalid_client");
  }

  const redirectURI = firstQueryValue(ctx.request.query, "redirect_uri");
  if (!registeredRedirectURI(client.redirectUris, redirectURI)) {
    // Open-redirect defense: an unmatched redirect URI never redirects.
    return facadeErrorPage(400, "invalid_request");
  }
  const clientState = firstQueryValue(ctx.request.query, "state");
  if (firstQueryValue(ctx.request.query, "response_type") !== "code") {
    return facadeClientErrorRedirect(
      redirectURI,
      issuer,
      clientState,
      "invalid_request",
    );
  }
  const challenge = firstQueryValue(ctx.request.query, "code_challenge");
  if (
    firstQueryValue(ctx.request.query, "code_challenge_method") !== "S256" ||
    !validS256Challenge(challenge)
  ) {
    return facadeClientErrorRedirect(
      redirectURI,
      issuer,
      clientState,
      "invalid_request",
    );
  }
  const requestedResource = firstQueryValue(
    ctx.request.query,
    "resource",
  ).trim();
  if (
    requestedResource !== "" &&
    canonicalResourceURL(requestedResource) !== resource
  ) {
    return facadeClientErrorRedirect(
      redirectURI,
      issuer,
      clientState,
      "invalid_target",
    );
  }
  const clamped = clampRequestedScopes(
    ctx.request.query["scope"] ?? [],
    config.scopes[kind],
  );
  if (!clamped.ok) {
    return facadeClientErrorRedirect(
      redirectURI,
      issuer,
      clientState,
      "invalid_request",
    );
  }
  const scopes = clamped.value;
  const upstreamScopes = [...scopes, ...front.lifecycleScopes];

  let hints: Record<string, string> | null = null;
  if (front.providerHints !== null) {
    try {
      hints = await front.providerHints(ctx);
    } catch {
      return facadeErrorPage(400, "invalid_request");
    }
  }

  const upstreamState = newOpaqueToken();
  const codeVerifier = newPKCECodeVerifier();
  const upstreamChallenge = pkceChallengeS256(codeVerifier);
  const callbackResolution = frontChannelCallbackURL(config, ctx);
  if (callbackResolution.failure !== null) {
    return callbackResolution.failure;
  }

  const transaction: TransactionRecord = {
    stateHash: hashKey(upstreamState),
    clientIdHash: hashKey(clientID),
    clientId: clientID,
    redirectUri: redirectURI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    clientState,
    encryptedUpstreamCodeVerifier: codeVerifier,
    scopes: [...scopes],
    canonicalResource: resource,
    endpointKind: String(kind),
    clientNamespace: endpoint.clientNamespace,
    partnerId: endpoint.partnerId ?? "",
    agentId: endpoint.agentId ?? "",
    status: FRONT_CHANNEL_TRANSACTION_STATUS_PENDING,
    version: 0,
  };
  await front.stores.transaction.put(transaction);

  let upstreamURL: string;
  try {
    upstreamURL = await front.provider.authorizationUrl({
      upstreamClientId: front.upstreamClientID,
      callbackUrl: callbackResolution.value,
      codeChallenge: upstreamChallenge,
      codeChallengeMethod: "S256",
      state: upstreamState,
      resource,
      scopes: upstreamScopes,
      ...(hints !== null ? { hints } : {}),
    });
  } catch {
    return facadeUpstreamErrorPage();
  }
  return facadeUpstreamRedirect(upstreamURL);
}

/**
 * Completes the upstream leg (DESIGN §8.2). It verifies the upstream RFC 9207
 * `iss` before consuming the transaction or exchanging the code, so an absent
 * or mismatched `iss` fails closed without touching state; any provider failure
 * after that is the distinct 502 upstream_error class, never the facade's own
 * 400.
 */
async function handleCallback(
  config: NormalizedConfig,
  ctx: Context,
): Promise<Response> {
  const front = config.frontChannel;
  if (front === null) {
    throw new Error(`${ERROR_PREFIX} front channel is not configured`);
  }
  const expectedIssuer = canonicalizeIssuerURL(front.upstreamIssuer);
  if (expectedIssuer === null) {
    throw new Error(
      `${ERROR_PREFIX} front channel upstream issuer is not canonicalizable`,
    );
  }
  const claimedIssuer = canonicalizeIssuerURL(
    firstQueryValue(ctx.request.query, "iss"),
  );
  if (claimedIssuer === null || claimedIssuer !== expectedIssuer) {
    return facadeErrorPage(400, "invalid_request");
  }
  const code = firstQueryValue(ctx.request.query, "code").trim();
  const state = firstQueryValue(ctx.request.query, "state").trim();
  if (code === "" || state === "") {
    return facadeErrorPage(400, "invalid_request");
  }

  const transaction = await front.stores.transaction.consume(hashKey(state));
  if (transaction === null || transaction.status === "expired") {
    // An unminted, replayed, and expired state are one response class: the
    // transaction store burns on first consume, so they are indistinguishable
    // and stay indistinguishable on purpose (T10).
    return facadeErrorPage(400, "invalid_request");
  }

  const callbackResolution = frontChannelCallbackURL(config, ctx);
  if (callbackResolution.failure !== null) {
    return callbackResolution.failure;
  }
  let tokenSet: TokenSet;
  try {
    tokenSet = await front.provider.exchangeCode({
      code,
      upstreamClientId: front.upstreamClientID,
      callbackUrl: callbackResolution.value,
      codeVerifier: transaction.encryptedUpstreamCodeVerifier,
    });
  } catch {
    return facadeUpstreamErrorPage();
  }
  let claims: TokenClaims;
  try {
    claims = await front.provider.validateAccessToken(tokenSet.accessToken, {
      expectedIssuer: front.upstreamIssuer,
      expectedAudience: transaction.canonicalResource,
      allowedAuthorizedParties: [front.upstreamClientID],
    });
  } catch {
    return facadeUpstreamErrorPage();
  }

  const handle = newOpaqueToken();
  const seeder = front.stores
    .routeRefreshBroker as Partial<RouteRefreshBrokerSeeder>;
  if (typeof seeder.put !== "function") {
    throw new Error(
      `${ERROR_PREFIX} route refresh broker store cannot be seeded`,
    );
  }
  const broker: RouteRefreshBrokerRecord = {
    handleHash: hashKey(handle),
    issuer: front.upstreamIssuer,
    stage: "",
    canonicalResource: transaction.canonicalResource,
    clientNamespace: transaction.clientNamespace,
    endpointKind: transaction.endpointKind,
    partnerId: transaction.partnerId,
    agentId: transaction.agentId,
    clientIdHash: transaction.clientIdHash,
    subjectIdHash: hashKey(claims.subject),
    scopes: [...transaction.scopes],
    scopeFingerprint: facadeScopeFingerprint(transaction.scopes),
    encryptedUpstreamRefreshToken: tokenSet.refreshToken ?? "",
    upstreamRefreshTokenHash: hashKey(tokenSet.refreshToken ?? ""),
    upstreamClientId: front.upstreamClientID,
    status: "issued",
    version: 0,
  };
  await seeder.put(broker);

  const facadeCode = newOpaqueToken();
  const codeRecord: AuthorizationCodeRecord = {
    codeHash: hashKey(facadeCode),
    clientIdHash: transaction.clientIdHash,
    clientId: transaction.clientId,
    redirectUri: transaction.redirectUri,
    codeChallenge: transaction.codeChallenge,
    codeChallengeMethod: transaction.codeChallengeMethod,
    scopes: [...transaction.scopes],
    canonicalResource: transaction.canonicalResource,
    endpointKind: transaction.endpointKind,
    clientNamespace: transaction.clientNamespace,
    partnerId: transaction.partnerId,
    agentId: transaction.agentId,
    routeRefreshHandleHash: broker.handleHash,
    encryptedRouteRefreshHandle: handle,
    encryptedTokenResponse: JSON.stringify(tokenSet),
    status: FRONT_CHANNEL_CODE_STATUS_ISSUED,
    version: 0,
  };
  await front.stores.authorizationCode.put(codeRecord);

  const issuerResolution = frontChannelRouteIssuer(
    config,
    ctx,
    endpointPathFromRecord(transaction),
  );
  if (issuerResolution.failure !== null) {
    return issuerResolution.failure;
  }
  const values = new Map<string, string>();
  values.set("code", facadeCode);
  values.set("iss", issuerResolution.value);
  if (transaction.clientState !== "") {
    values.set("state", transaction.clientState);
  }
  return facadeClientRedirect(transaction.redirectUri, values);
}

/**
 * Serves the token endpoint (DESIGN §8.4). M3b owns the authorization_code
 * grant; the brokered refresh grant is M3c and answers unsupported_grant_type
 * until it lands, so no adopter assumes it works.
 */
async function handleToken(
  config: NormalizedConfig,
  kind: EndpointKind,
  ctx: Context,
): Promise<Response> {
  const front = config.frontChannel;
  if (front === null) {
    throw new Error(`${ERROR_PREFIX} front channel is not configured`);
  }
  const body = Buffer.from(ctx.request.body);
  if (body.byteLength > FRONT_CHANNEL_MAX_REQUEST_BODY_BYTES) {
    return facadeErrorPage(400, "invalid_request");
  }
  const form = parseFormQuery(body.toString("utf8"));
  if (form === null) {
    return facadeErrorPage(400, "invalid_request");
  }
  const grantType = formGet(form, "grant_type");
  if (grantType === "") {
    return facadeErrorPage(400, "invalid_request");
  }
  if (grantType === "authorization_code") {
    return await handleAuthorizationCodeGrant(config, kind, form);
  }
  // Ruled: the token response issues the refresh handle, but the refresh_token
  // grant is M3c and is refused until then.
  return facadeErrorPage(400, "unsupported_grant_type");
}

async function handleAuthorizationCodeGrant(
  config: NormalizedConfig,
  kind: EndpointKind,
  form: Map<string, string[]>,
): Promise<Response> {
  const front = config.frontChannel;
  if (front === null) {
    throw new Error(`${ERROR_PREFIX} front channel is not configured`);
  }
  const code = formGet(form, "code").trim();
  const redirectURI = formGet(form, "redirect_uri");
  const verifier = formGet(form, "code_verifier");
  if (code === "" || redirectURI.trim() === "" || verifier.trim() === "") {
    return facadeErrorPage(400, "invalid_request");
  }
  const clientID = formGet(form, "client_id").trim();
  if (clientID === "") {
    return facadeErrorPage(400, "invalid_client");
  }
  const client = await front.stores.client.get(hashKey(clientID));
  if (client === null) {
    return facadeErrorPage(400, "invalid_client");
  }
  // Only public clients are registered through the facade; a client record
  // that claims another authentication method fails closed.
  const method = (client.tokenEndpointAuthMethod ?? "").trim();
  if (method !== "" && method !== "none") {
    return facadeErrorPage(400, "invalid_client");
  }

  const consumeResult = await front.stores.authorizationCode.consume(
    hashKey(code),
  );
  if (consumeResult === null) {
    return facadeErrorPage(400, "invalid_grant");
  }
  if (consumeResult.replayed) {
    // T2: a replayed code revokes the broker record it minted, so the refresh
    // handle from that authorization dies with the replay.
    const replayRecord = consumeResult.record;
    if (replayRecord !== null && replayRecord.routeRefreshHandleHash !== "") {
      try {
        await front.stores.routeRefreshBroker.revoke(
          replayRecord.routeRefreshHandleHash,
        );
      } catch (err) {
        if (!(err instanceof BrokerNotFoundError)) {
          throw err;
        }
      }
    }
    return facadeErrorPage(400, "invalid_grant");
  }
  const record = consumeResult.record;
  if (consumeResult.expired || record === null) {
    return facadeErrorPage(400, "invalid_grant");
  }

  if (
    record.clientId !== clientID ||
    record.redirectUri !== redirectURI ||
    record.endpointKind !== String(kind) ||
    record.codeChallengeMethod !== "S256"
  ) {
    return facadeErrorPage(400, "invalid_grant");
  }
  let verified: boolean;
  try {
    verified = pkceVerifyS256(verifier, record.codeChallenge);
  } catch {
    verified = false;
  }
  if (!verified) {
    return facadeErrorPage(400, "invalid_grant");
  }
  const resource = formGet(form, "resource").trim();
  if (
    resource !== "" &&
    canonicalResourceURL(resource) !== record.canonicalResource
  ) {
    return facadeErrorPage(400, "invalid_target");
  }

  let tokenSet: TokenSet;
  try {
    tokenSet = JSON.parse(record.encryptedTokenResponse) as TokenSet;
  } catch (err) {
    throw new Error(
      `${ERROR_PREFIX} facade code record does not carry a token response: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  const payload: Record<string, unknown> = {
    access_token: tokenSet.accessToken,
    token_type: tokenSet.tokenType ?? "",
  };
  if (
    typeof tokenSet.expiresIn === "number" &&
    Number.isFinite(tokenSet.expiresIn) &&
    tokenSet.expiresIn !== 0
  ) {
    payload["expires_in"] = tokenSet.expiresIn;
  }
  if (tokenSet.scope !== undefined && tokenSet.scope !== "") {
    payload["scope"] = tokenSet.scope;
  }
  if (record.encryptedRouteRefreshHandle !== "") {
    payload["refresh_token"] = record.encryptedRouteRefreshHandle;
  }
  return {
    status: 200,
    headers: {
      "content-type": ["application/json; charset=utf-8"],
      "cache-control": ["no-store"],
      pragma: ["no-cache"],
    },
    cookies: [],
    body: Buffer.from(JSON.stringify(payload), "utf8"),
    isBase64: false,
  };
}

function frontChannelRouteResource(
  config: NormalizedConfig,
  ctx: Context,
  endpoint: EndpointPath,
): RouteResolution {
  try {
    return {
      value: buildAbsoluteURL(config, ctx, mcpPath(endpoint)),
      failure: null,
    };
  } catch (err) {
    const failure = metadataRequestFailure(err);
    if (failure !== null) {
      return { value: "", failure };
    }
    throw err;
  }
}

/**
 * The client-facing issuer: the route URL in route issuer mode and the
 * configured family issuer otherwise (DESIGN §3.3).
 */
function frontChannelRouteIssuer(
  config: NormalizedConfig,
  ctx: Context,
  endpoint: EndpointPath,
): RouteResolution {
  if (config.issuerMode !== ISSUER_MODE_ROUTE) {
    return { value: config.issuerURL, failure: null };
  }
  return frontChannelRouteResource(config, ctx, endpoint);
}

function frontChannelCallbackURL(
  config: NormalizedConfig,
  ctx: Context,
): RouteResolution {
  try {
    return {
      value: buildAbsoluteURL(config, ctx, config.upstreamCallbackPath),
      failure: null,
    };
  } catch (err) {
    const failure = metadataRequestFailure(err);
    if (failure !== null) {
      return { value: "", failure };
    }
    throw err;
  }
}

function endpointPathFromRecord(record: TransactionRecord): EndpointPath {
  return {
    kind: record.endpointKind as EndpointKind,
    clientNamespace: record.clientNamespace,
    partnerId: record.partnerId,
    agentId: record.agentId,
  };
}

/**
 * Reports whether the request redirect URI matches one of the client's
 * registered URIs exactly, allowing RFC 8252 §7.3 loopback port flexibility
 * only.
 */
function registeredRedirectURI(
  registered: string[],
  requested: string,
): boolean {
  if (requested.trim() === "") {
    return false;
  }
  for (const candidate of registered) {
    if (candidate === requested) {
      return true;
    }
    if (loopbackRedirectMatch(candidate, requested)) {
      return true;
    }
  }
  return false;
}

/**
 * Allows the ephemeral-port form of RFC 8252 §7.3: a loopback redirect URI
 * matches on scheme, host, path, query and fragment while the port alone is free
 * to differ — or to be absent on either side — because a native client obtains
 * its loopback port from the OS at request time. The port is therefore the only
 * component excluded from the comparison, so the match never widens beyond the
 * client's own registered loopback redirect: the host must be the same loopback
 * host and the scheme/path/query/fragment must match exactly (DESIGN §8.1,
 * "loopback port flexibility only").
 */
function loopbackRedirectMatch(registered: string, requested: string): boolean {
  const registeredURL = parseAbsoluteURL(registered);
  if (registeredURL === null) {
    return false;
  }
  const requestedURL = parseAbsoluteURL(requested);
  if (requestedURL === null) {
    return false;
  }
  if (
    !isLoopbackRedirectHost(registeredURL.decodedHostname) ||
    !isLoopbackRedirectHost(requestedURL.decodedHostname)
  ) {
    return false;
  }
  if (
    registeredURL.decodedHostname.toLowerCase() !==
    requestedURL.decodedHostname.toLowerCase()
  ) {
    return false;
  }
  if (
    registeredURL.scheme !== requestedURL.scheme ||
    registeredURL.path !== requestedURL.path
  ) {
    return false;
  }
  if (
    registeredURL.search !== requestedURL.search ||
    registeredURL.hash !== requestedURL.hash
  ) {
    return false;
  }
  return true;
}

function isLoopbackRedirectHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

/**
 * Reports whether a PKCE challenge is the RFC 7636 S256 shape: 43 base64url
 * characters.
 */
function validS256Challenge(challenge: string): boolean {
  if (challenge.length !== 43) {
    return false;
  }
  for (let index = 0; index < challenge.length; index += 1) {
    const code = challenge.charCodeAt(index);
    const base64url =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x5f;
    if (!base64url) {
      return false;
    }
  }
  return true;
}

/**
 * Clamps a client request to the route scope set: an absent request takes the
 * route set, a present one is intersected with it in route order, and a request
 * that survives to nothing fails closed instead of silently broadening to the
 * route set.
 */
function clampRequestedScopes(
  requested: string[],
  allowed: string[],
): { value: string[]; ok: boolean } {
  if (requested.length === 0) {
    return { value: [...allowed], ok: true };
  }
  const wanted = new Set<string>();
  for (const raw of requested) {
    for (const value of String(raw).split(/\s+/u)) {
      if (value !== "") {
        wanted.add(value);
      }
    }
  }
  const clamped = allowed.filter((value) => wanted.has(value));
  if (clamped.length === 0) {
    return { value: [], ok: false };
  }
  return { value: clamped, ok: true };
}

function facadeScopeFingerprint(scopes: string[]): string {
  return hashKey([...scopes].sort().join(" "));
}

/**
 * Renders a facade rejection that never redirects (DESIGN §8.1/§8.2): the fixed
 * error vocabulary, no upstream material, and no cacheable representation.
 */
function facadeErrorPage(status: number, code: string): Response {
  const body = Buffer.from(
    JSON.stringify({
      error: code,
      error_description: FRONT_CHANNEL_ERROR_DESCRIPTIONS[code] ?? "",
    }),
    "utf8",
  );
  return {
    status,
    headers: {
      "content-type": ["application/json; charset=utf-8"],
      "cache-control": ["no-store"],
      pragma: ["no-cache"],
    },
    cookies: [],
    body,
    isBase64: false,
  };
}

/**
 * The gateway-class provider failure (DESIGN §8.2): a distinct 502 carrying
 * upstream_error, never the facade's 400 vocabulary.
 */
function facadeUpstreamErrorPage(): Response {
  return facadeErrorPage(502, "upstream_error");
}

/**
 * Sends an authorization error back to the client's validated redirect URI,
 * carrying the fixed error code, the client's own state, and the client-facing
 * RFC 9207 iss (FRAMEWORK_VS_POLICY row 1).
 */
function facadeClientErrorRedirect(
  redirectURI: string,
  issuer: string,
  clientState: string,
  code: string,
): Response {
  const values = new Map<string, string>();
  values.set("error", code);
  values.set("iss", issuer);
  const description = FRONT_CHANNEL_ERROR_DESCRIPTIONS[code];
  if (description !== undefined && description !== "") {
    values.set("error_description", description);
  }
  if (clientState !== "") {
    values.set("state", clientState);
  }
  return facadeClientRedirect(redirectURI, values);
}

/**
 * Appends values to the client's redirect URI without rewriting the URI itself,
 * so the redirect target stays byte-identical to the registered value.
 */
function facadeClientRedirect(
  target: string,
  values: Map<string, string>,
): Response {
  let location = target;
  const encoded = encodeValues(values);
  if (encoded !== "") {
    const separator = location.includes("?") ? "&" : "?";
    location += `${separator}${encoded}`;
  }
  return {
    status: 302,
    headers: {
      location: [location],
      "cache-control": ["no-store"],
      pragma: ["no-cache"],
    },
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

/** Sends the browser to the upstream authorize URL. */
function facadeUpstreamRedirect(target: string): Response {
  return {
    status: 302,
    headers: {
      location: [target],
      "cache-control": ["no-store"],
      pragma: ["no-cache"],
    },
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

/** Encodes values the way Go's url.Values.Encode does: sorted by key. */
function encodeValues(values: Map<string, string>): string {
  const params = new URLSearchParams();
  for (const key of [...values.keys()].sort()) {
    params.set(key, values.get(key) ?? "");
  }
  return params.toString();
}

function firstQueryValue(
  query: Record<string, string[]>,
  name: string,
): string {
  const values = query[name];
  if (values === undefined || values.length === 0) {
    return "";
  }
  return values[0] ?? "";
}

/**
 * Parses a form-encoded body the way Go's url.ParseQuery does: an unescaped
 * ";" or a malformed percent escape fails the whole parse, so the facade can
 * answer invalid_request instead of reading a half-decoded form.
 */
function parseFormQuery(raw: string): Map<string, string[]> | null {
  const form = new Map<string, string[]>();
  if (raw === "") {
    return form;
  }
  for (const segment of raw.split("&")) {
    if (segment === "") {
      continue;
    }
    if (segment.includes(";")) {
      return null;
    }
    const separator = segment.indexOf("=");
    const rawKey = separator >= 0 ? segment.slice(0, separator) : segment;
    const rawValue = separator >= 0 ? segment.slice(separator + 1) : "";
    const key = queryUnescapeGo(rawKey);
    if (key === null) {
      return null;
    }
    const value = queryUnescapeGo(rawValue);
    if (value === null) {
      return null;
    }
    const values = form.get(key);
    if (values === undefined) {
      form.set(key, [value]);
    } else {
      values.push(value);
    }
  }
  return form;
}

function formGet(form: Map<string, string[]>, name: string): string {
  const values = form.get(name);
  if (values === undefined || values.length === 0) {
    return "";
  }
  return values[0] ?? "";
}

/**
 * Percent-decodes one form component the way Go's QueryUnescape does: "+" is a
 * space and a malformed "%" escape is an error. The result is a byte string
 * (one code unit per decoded byte), so it round-trips Go's raw-byte semantics.
 */
function queryUnescapeGo(value: string): string | null {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const ch = value.charAt(index);
    if (ch === "%") {
      if (index + 2 >= value.length) {
        return null;
      }
      const hex = value.slice(index + 1, index + 3);
      if (!HEX_PAIR.test(hex)) {
        return null;
      }
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    if (ch === "+") {
      out += " ";
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}
