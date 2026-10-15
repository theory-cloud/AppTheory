import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import { Context } from "../context.js";
import { unknownSourceProvenance } from "../internal/source-provenance.js";

import {
  frameworkFetch,
  isNonPublicHostError,
  isPublicHostAddress,
  newJwksValidator,
  type JWKSValidatorOptions,
} from "./jwks.js";

import {
  canonicalizeIssuerURL,
  type BearerTokenClaimsValidator,
} from "./index.js";

const OP_DISCOVERY = "discovery";
const OP_AUTHORIZATION_URL = "authorization_url";
const OP_EXCHANGE_CODE = "exchange_code";
const OP_REFRESH = "refresh";
const OP_VALIDATE_ACCESS_TOKEN = "validate_access_token";

/** Framework default bound on one provider HTTP exchange, shared with Go and Python. */
const DEFAULT_FETCH_TIMEOUT_SECONDS = 10;
/** Bounds every provider response body the adapter reads. */
const MAX_RESPONSE_BYTES = 1 << 20;
/** Bounds the per-expectation-set validator cache. */
const MAX_VALIDATOR_ENTRIES = 32;

const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";
const TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * The closed client-facing vocabulary a provider adapter reports. The facade
 * maps these classes to HTTP statuses; raw upstream error bodies never travel
 * with them.
 */
export type ProviderErrorClass =
  | "upstream_error"
  | "temporarily_unavailable"
  | "invalid_grant"
  | "invalid_request"
  | "reauth_required";

const PROVIDER_ERROR_HTTP_STATUS: Record<ProviderErrorClass, number> = {
  upstream_error: 502,
  temporarily_unavailable: 503,
  invalid_grant: 400,
  invalid_request: 400,
  reauth_required: 400,
};

/**
 * One fixed message per error class. The message never carries upstream
 * material: an upstream error body can echo hidden material, so no code path
 * lets it into `message`.
 */
const PROVIDER_ERROR_MESSAGE: Record<ProviderErrorClass, string> = {
  upstream_error: "oauth provider upstream error",
  temporarily_unavailable: "oauth provider temporarily unavailable",
  invalid_grant: "oauth provider rejected the grant",
  invalid_request: "oauth provider request is invalid",
  reauth_required: "oauth provider requires reauthentication",
};

/**
 * The upstream OAuth error codes that are a definitive grant rejection. Any
 * other 4xx code stays an upstream_error, so an unknown signal is never
 * upgraded into a client-facing decision. The set is identical in the Go and
 * Python adapters.
 */
const TERMINAL_TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "invalid_request",
  "access_denied",
  "expired_token",
  "invalid_token",
]);

/**
 * The authorize parameters the adapter itself owns. A hint whose name collides
 * with one of these -- compared case-insensitively after trimming -- is refused
 * with `invalid_request` instead of being allowed to override or duplicate it:
 * the required parameter wins by refusal, never by silent replacement. The set
 * is identical in the Go and Python adapters.
 */
const RESERVED_AUTHORIZE_PARAMETERS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
]);

/**
 * A provider-call failure in the facade's closed vocabulary. `httpStatus` is
 * the facade status the class maps to, and `op` names the SPI operation that
 * failed; both are safe to surface.
 */
export class ProviderError extends Error {
  readonly errorClass: ProviderErrorClass;
  readonly op: string;
  readonly httpStatus: number;

  constructor(errorClass: ProviderErrorClass, op: string) {
    super(PROVIDER_ERROR_MESSAGE[errorClass]);
    this.name = "ProviderError";
    this.errorClass = errorClass;
    this.op = op;
    this.httpStatus = PROVIDER_ERROR_HTTP_STATUS[errorClass];
  }
}

/** The upstream provider's advertised metadata, verified before it is trusted. */
export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  codeChallengeMethodsSupported: string[];
  authorizationResponseIssParameterSupported: boolean;
  resourceParameterSupported: boolean;
}

/** The inputs to one upstream authorize redirect. */
export interface AuthorizationRequest {
  upstreamClientId: string;
  callbackUrl: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  resource: string;
  scopes: string[];
  /**
   * Opaque provider hints forwarded onto the authorize query. A hint whose
   * name collides, case-insensitively after trimming, with a required or
   * reserved authorize parameter is refused as `invalid_request` rather than
   * being allowed to override or duplicate that parameter.
   */
  hints?: Record<string, string>;
}

/** The inputs to one server-side upstream code exchange. */
export interface CodeExchangeRequest {
  code: string;
  upstreamClientId: string;
  callbackUrl: string;
  codeVerifier: string;
}

/**
 * The inputs to one upstream refresh. `upstreamClientId` is the OAuth client
 * that owns the recorded upstream material, so refresh presents the owning
 * client rather than the facade's own.
 */
export interface RefreshRequest {
  refreshMaterial: string;
  upstreamClientId: string;
}

/** The fail-closed expectations one access token is validated against. */
export interface TokenExpectations {
  expectedIssuer: string;
  expectedAudience: string;
  requiredScopes?: string[];
  allowedAuthorizedParties?: string[];
}

/** The upstream token response. `id_token` never reaches the client. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
  idToken?: string;
}

/** The verified claims a provider reports for one access token. */
export interface TokenClaims {
  subject: string;
  audience: string;
  scopes: string[];
  expiresAt?: Date;
  authorizedParty: string;
}

/** The provider-neutral upstream IdP adapter. */
export interface Provider {
  discovery(): Promise<ProviderMetadata>;
  authorizationUrl(req: AuthorizationRequest): Promise<string>;
  exchangeCode(req: CodeExchangeRequest): Promise<TokenSet>;
  refresh(req: RefreshRequest): Promise<TokenSet>;
  validateAccessToken(
    token: string,
    expected: TokenExpectations,
  ): Promise<TokenClaims>;
}

/** The Autheory adapter's configuration. */
export interface AutheoryProviderOptions {
  issuer: string;
  /**
   * The adapter's own upstream client registration id, retained for parity
   * with the Go and Python options. It is never read: the adapter never derives
   * a request's client id from it, and a request that omits its upstream client
   * id fails closed with `invalid_request`.
   */
  clientId?: string;
  discoveryUrl?: string;
  tokenEndpoint?: string;
  authorizationEndpoint?: string;
  jwksUri?: string;
  fetchImpl?: typeof fetch;
  allowPrivateHosts?: boolean;
  fetchTimeoutSeconds?: number;
  now?: () => Date;
  allowedAuthorizedParties?: string[];
}

interface BoundedTransport {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  allowPrivateHosts: boolean;
}

interface BoundedResponse {
  status: number;
  body: string;
}

interface BoundedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A refused request: non-HTTPS, or a non-public host address literal. */
class ProviderRequestRefused extends Error {}
/** A connect or socket failure. */
class ProviderTransportFailure extends Error {}
/** The fetch deadline elapsed. */
class ProviderTimeoutFailure extends Error {}
/** The response body crossed the adapter's size cap. */
class ProviderOversizedBody extends Error {}
/** The request was answered with a redirect. */
class ProviderRedirectRefused extends Error {}

/**
 * The inert context handed to the JWKS validator. The adapter's expectations
 * are always static values (a provider call carries no AppTheory request), so
 * the validator never consults the route-aware resolvers this context would
 * feed, but the validator's signature still requires one.
 */
const VALIDATOR_CONTEXT = new Context({
  request: {
    method: "POST",
    path: "/",
    query: {},
    headers: {},
    cookies: {},
    body: new Uint8Array(0),
    isBase64: false,
    sourceProvenance: unknownSourceProvenance(),
    traceId: "",
  },
});

/**
 * Builds the Autheory provider adapter: the first implementation of the
 * provider SPI. Discovery is RFC 8414, verified by canonical issuer equality
 * before any endpoint is trusted; the authorize redirect always carries the
 * RFC 8707 `resource`; code exchange and refresh are bounded form-encoded
 * POSTs; access tokens are validated fail-closed through the framework's
 * RS256/JWKS validator.
 */
export async function newAutheoryProvider(
  options: AutheoryProviderOptions,
): Promise<AutheoryProvider> {
  return new AutheoryProvider(options);
}

/** The Autheory provider adapter. */
export class AutheoryProvider implements Provider {
  private readonly issuer: string;
  private readonly discoveryUrlOverride: string;
  private readonly tokenEndpointOverride: string;
  private readonly authorizationEndpointOverride: string;
  private readonly jwksUriOverride: string;
  private readonly transport: BoundedTransport;
  private readonly now: () => Date;
  private readonly fetchTimeoutSeconds: number | undefined;
  private readonly allowedAuthorizedParties: string[];
  private readonly validators = new Map<
    string,
    Promise<BearerTokenClaimsValidator>
  >();
  private cachedDiscovery: Promise<ProviderMetadata> | null = null;

  constructor(options: AutheoryProviderOptions) {
    const opts = options ?? ({} as AutheoryProviderOptions);
    this.issuer = trimmed(opts.issuer);
    this.discoveryUrlOverride = trimmed(opts.discoveryUrl);
    this.tokenEndpointOverride = trimmed(opts.tokenEndpoint);
    this.authorizationEndpointOverride = trimmed(opts.authorizationEndpoint);
    this.jwksUriOverride = trimmed(opts.jwksUri);
    this.now = opts.now ?? (() => new Date());
    this.fetchTimeoutSeconds =
      typeof opts.fetchTimeoutSeconds === "number" &&
      Number.isFinite(opts.fetchTimeoutSeconds) &&
      opts.fetchTimeoutSeconds > 0
        ? opts.fetchTimeoutSeconds
        : undefined;
    this.allowedAuthorizedParties = normalizeList(
      opts.allowedAuthorizedParties ?? [],
    );
    // An injected fetch is caller-owned and carries the caller's transport
    // policy. Otherwise the adapter reuses the framework's own guarded
    // transport -- the same connect-time non-public-host guard the JWKS
    // validator installs -- so a discovery or token host that resolves to a
    // non-public address is refused; `allowPrivateHosts` drops the guard by
    // not installing it at all.
    this.transport = {
      fetchImpl:
        opts.fetchImpl ??
        (opts.allowPrivateHosts === true ? fetch : frameworkFetch()),
      timeoutMs:
        (this.fetchTimeoutSeconds ?? DEFAULT_FETCH_TIMEOUT_SECONDS) * 1000,
      allowPrivateHosts: opts.allowPrivateHosts === true,
    };
  }

  /**
   * Fetches and pins the RFC 8414 document once, then caches it. The document
   * URL must be HTTPS, a redirect is refused, and the document's `issuer` must
   * canonicalize to the configured issuer before any advertised endpoint is
   * trusted.
   */
  discovery(): Promise<ProviderMetadata> {
    const cached = this.cachedDiscovery;
    if (cached) return cached;
    const pending = this.loadDiscovery();
    this.cachedDiscovery = pending;
    return this.settleDiscovery(pending);
  }

  /**
   * Joins the in-flight discovery so the launched load cannot outlive this
   * call, and clears the cache when it fails so a later call retries.
   */
  private async settleDiscovery(
    pending: Promise<ProviderMetadata>,
  ): Promise<ProviderMetadata> {
    try {
      return await pending;
    } catch (error) {
      if (this.cachedDiscovery === pending) this.cachedDiscovery = null;
      throw error;
    }
  }

  /**
   * Builds the absolute upstream authorize URL. Everything that can fail
   * closed is checked before the endpoint is resolved, so no refused request
   * reaches the upstream: a hint whose name collides, case-insensitively after
   * trimming, with a required or reserved authorize parameter fails closed
   * with `invalid_request`, and so does a request that omits its own upstream
   * client id. The required parameters are then built first, so an accepted
   * hint can never replace one.
   */
  async authorizationUrl(req: AuthorizationRequest): Promise<string> {
    const clientId = trimmed(req?.upstreamClientId);
    const callbackUrl = trimmed(req?.callbackUrl);
    const codeChallenge = trimmed(req?.codeChallenge);
    const codeChallengeMethod = trimmed(req?.codeChallengeMethod);
    const state = trimmed(req?.state);
    const resource = trimmed(req?.resource);
    if (
      !clientId ||
      !callbackUrl ||
      !codeChallenge ||
      !codeChallengeMethod ||
      !state ||
      !resource ||
      codeChallengeMethod !== "S256"
    ) {
      throw new ProviderError("invalid_request", OP_AUTHORIZATION_URL);
    }
    // Hints are validated before the discovery/endpoint fetch, so a refused
    // hint causes no upstream interaction at all.
    const hints = forwardableHints(req?.hints);
    const metadata = await this.discovery();
    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", codeChallengeMethod);
    url.searchParams.set("state", state);
    // Autheory requires the RFC 8707 resource indicator, so it is always sent.
    url.searchParams.set("resource", resource);
    const scope = joinScopes(req?.scopes ?? []);
    if (scope) url.searchParams.set("scope", scope);
    // The required parameters are already in place, so an accepted hint only
    // ever adds a parameter the adapter does not own.
    for (const [name, value] of hints) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }

  async exchangeCode(req: CodeExchangeRequest): Promise<TokenSet> {
    const code = trimmed(req?.code);
    const clientId = trimmed(req?.upstreamClientId);
    const callbackUrl = trimmed(req?.callbackUrl);
    const codeVerifier = trimmed(req?.codeVerifier);
    if (!code || !clientId || !callbackUrl || !codeVerifier) {
      throw new ProviderError("invalid_request", OP_EXCHANGE_CODE);
    }
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", callbackUrl);
    body.set("client_id", clientId);
    body.set("code_verifier", codeVerifier);
    return await this.tokenRequest(body, OP_EXCHANGE_CODE);
  }

  async refresh(req: RefreshRequest): Promise<TokenSet> {
    const refreshMaterial = trimmed(req?.refreshMaterial);
    const clientId = trimmed(req?.upstreamClientId);
    if (!refreshMaterial || !clientId) {
      throw new ProviderError("invalid_request", OP_REFRESH);
    }
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshMaterial);
    body.set("client_id", clientId);
    return await this.tokenRequest(body, OP_REFRESH);
  }

  /**
   * Validates one access token fail-closed against `expected`, returning the
   * verified claims without mutating the token. Every validator error —
   * malformed, unverified, expired, wrong issuer/audience/scope, or a key-set
   * failure — is reported as `upstream_error`.
   */
  async validateAccessToken(
    token: string,
    expected: TokenExpectations,
  ): Promise<TokenClaims> {
    const metadata = await this.discovery();
    const requiredScopes = normalizeList(expected?.requiredScopes ?? []);
    const allowedAuthorizedParties =
      expected?.allowedAuthorizedParties === undefined
        ? this.allowedAuthorizedParties
        : normalizeList(expected.allowedAuthorizedParties);
    const validator = await this.validatorFor(
      expected,
      metadata.jwksUri,
      requiredScopes,
      allowedAuthorizedParties,
    );
    let claims: Awaited<ReturnType<BearerTokenClaimsValidator>>;
    try {
      claims = await validator(VALIDATOR_CONTEXT, token);
    } catch {
      throw new ProviderError("upstream_error", OP_VALIDATE_ACCESS_TOKEN);
    }
    const authorizedParty =
      decodePayloadClaim(token, "azp") ||
      decodePayloadClaim(token, "client_id");
    const result: TokenClaims = {
      subject: claims.subject ?? "",
      audience: claims.audience ?? "",
      scopes: [...(claims.scopes ?? [])],
      authorizedParty,
    };
    if (claims.expiresAt) result.expiresAt = claims.expiresAt;
    return result;
  }

  private async loadDiscovery(): Promise<ProviderMetadata> {
    const issuer = canonicalizeIssuerURL(this.issuer);
    if (!issuer) throw new ProviderError("upstream_error", OP_DISCOVERY);
    const discoveryUrl =
      this.discoveryUrlOverride || defaultDiscoveryURL(issuer);
    let response: BoundedResponse;
    try {
      response = await boundedRequest(this.transport, discoveryUrl, {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch (err) {
      throw providerErrorFor(err, OP_DISCOVERY);
    }
    const document =
      response.status === 200 ? parseJSONObject(response.body) : null;
    if (!document) throw new ProviderError("upstream_error", OP_DISCOVERY);
    const documentIssuer = canonicalizeIssuerURL(
      stringField(document, "issuer"),
    );
    if (!documentIssuer || documentIssuer !== issuer) {
      throw new ProviderError("upstream_error", OP_DISCOVERY);
    }
    const authorizationEndpoint = httpsEndpoint(
      this.authorizationEndpointOverride ||
        stringField(document, "authorization_endpoint"),
      OP_DISCOVERY,
    );
    const tokenEndpoint = httpsEndpoint(
      this.tokenEndpointOverride || stringField(document, "token_endpoint"),
      OP_DISCOVERY,
    );
    const jwksUri = httpsEndpoint(
      this.jwksUriOverride || stringField(document, "jwks_uri"),
      OP_DISCOVERY,
    );
    return {
      issuer: stringField(document, "issuer").trim(),
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      codeChallengeMethodsSupported: normalizeList(
        stringListField(document, "code_challenge_methods_supported"),
      ),
      authorizationResponseIssParameterSupported:
        document["authorization_response_iss_parameter_supported"] === true,
      resourceParameterSupported:
        document["resource_parameter_supported"] === true,
    };
  }

  private async tokenRequest(
    body: URLSearchParams,
    op: string,
  ): Promise<TokenSet> {
    const metadata = await this.discovery();
    let response: BoundedResponse;
    try {
      response = await boundedRequest(this.transport, metadata.tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": TOKEN_CONTENT_TYPE,
        },
        body: body.toString(),
      });
    } catch (err) {
      throw providerErrorFor(err, op);
    }
    if (response.status < 200 || response.status >= 300) {
      // Only an explicit upstream signal changes the class: `reauth_required`
      // and `temporarily_unavailable` are read directly, a 4xx carrying one of
      // the terminal OAuth codes is a definitive grant rejection, and every
      // other non-2xx (including an unrecognized 4xx code, and a 3xx the
      // transport already refuses) is an upstream failure. Only the error code
      // is read, so nothing else in the body can reach the client.
      const errorBody = parseJSONObject(response.body);
      const code = errorBody ? stringField(errorBody, "error").trim() : "";
      if (code === "reauth_required") {
        throw new ProviderError("reauth_required", op);
      }
      if (code === "temporarily_unavailable") {
        throw new ProviderError("temporarily_unavailable", op);
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        TERMINAL_TOKEN_ERROR_CODES.has(code)
      ) {
        throw new ProviderError("invalid_grant", op);
      }
      throw new ProviderError("upstream_error", op);
    }
    const document = parseJSONObject(response.body);
    const accessToken = document ? stringField(document, "access_token") : "";
    if (!accessToken) throw new ProviderError("upstream_error", op);
    const tokenSet: TokenSet = { accessToken };
    const refreshToken = document ? stringField(document, "refresh_token") : "";
    if (refreshToken) tokenSet.refreshToken = refreshToken;
    const tokenType = document ? stringField(document, "token_type") : "";
    if (tokenType) tokenSet.tokenType = tokenType;
    const scope = document ? stringField(document, "scope") : "";
    if (scope) tokenSet.scope = scope;
    const idToken = document ? stringField(document, "id_token") : "";
    if (idToken) tokenSet.idToken = idToken;
    const expiresIn = document ? document["expires_in"] : undefined;
    if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
      tokenSet.expiresIn = expiresIn;
    }
    return tokenSet;
  }

  private async validatorFor(
    expected: TokenExpectations,
    jwksUri: string,
    requiredScopes: string[],
    allowedAuthorizedParties: string[],
  ): Promise<BearerTokenClaimsValidator> {
    const cacheKey = validatorCacheKey(
      expected,
      requiredScopes,
      allowedAuthorizedParties,
    );
    const cached = this.validators.get(cacheKey);
    if (cached) {
      try {
        return await cached;
      } catch {
        throw new ProviderError("upstream_error", OP_VALIDATE_ACCESS_TOKEN);
      }
    }
    const options: JWKSValidatorOptions = {
      issuer: trimmed(expected?.expectedIssuer),
      jwksUri,
      now: this.now,
      fetchImpl: this.transport.fetchImpl,
    };
    const expectedAudience = trimmed(expected?.expectedAudience);
    if (expectedAudience) options.requiredAudience = expectedAudience;
    if (requiredScopes.length > 0) options.requiredScopes = requiredScopes;
    if (allowedAuthorizedParties.length > 0) {
      options.allowedAzp = allowedAuthorizedParties;
    }
    if (this.transport.allowPrivateHosts) options.allowPrivateHosts = true;
    if (this.fetchTimeoutSeconds !== undefined) {
      options.fetchTimeoutSeconds = this.fetchTimeoutSeconds;
    }
    if (this.validators.size >= MAX_VALIDATOR_ENTRIES) {
      const keys = [...this.validators.keys()];
      const oldest = keys[0];
      if (oldest !== undefined) this.validators.delete(oldest);
    }
    const pending = newJwksValidator(options);
    this.validators.set(cacheKey, pending);
    try {
      return await pending;
    } catch {
      if (this.validators.get(cacheKey) === pending) {
        this.validators.delete(cacheKey);
      }
      throw new ProviderError("upstream_error", OP_VALIDATE_ACCESS_TOKEN);
    }
  }
}

/**
 * One bounded provider HTTP exchange. The single deadline covers the response
 * head and its body; the body is capped while streaming; redirects are never
 * followed; and, unless the caller opted into private hosts, the framework
 * transport refuses a non-public address at connect time -- both an address
 * literal and a name, resolved inside the transport's own `lookup`, so there
 * is no rebinding window between the check and the connection.
 */
async function boundedRequest(
  transport: BoundedTransport,
  url: string,
  init: BoundedRequestInit,
): Promise<BoundedResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new ProviderRequestRefused();
  if (!transport.allowPrivateHosts) assertPublicHostLiteral(target);
  const controller = new AbortController();
  let failOnTimeout: (error: Error) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    failOnTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    failOnTimeout(new ProviderTimeoutFailure());
  }, transport.timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const race = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, expired]);
  const requestInit: RequestInit = {
    method: init.method,
    headers: init.headers,
    redirect: "manual",
    signal: controller.signal,
  };
  if (init.body !== undefined) requestInit.body = init.body;
  try {
    let response: Response;
    try {
      response = await race(
        transport.fetchImpl(target.toString(), requestInit),
      );
    } catch (err) {
      if (err instanceof ProviderTimeoutFailure) throw err;
      if (isNonPublicHostError(err)) throw new ProviderRequestRefused();
      throw new ProviderTransportFailure();
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderRedirectRefused();
    }
    const body = await readBoundedBody(response, controller.signal, race);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a response body while enforcing the adapter's size cap: a streamed
 * body is cancelled as soon as the running total crosses the cap, so oversized
 * content is never buffered whole. Every read races the fetch deadline, and an
 * abort cancels the body stream so a stalled response stops occupying its
 * connection.
 */
async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  race: <T>(work: Promise<T>) => Promise<T>,
): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ProviderOversizedBody();
    }
    return text;
  }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const cancellations: Promise<void>[] = [];
  const cancelOnAbort = (): void => {
    cancellations.push(reader.cancel());
  };
  if (signal.aborted) {
    cancellations.push(reader.cancel());
    throw new ProviderTimeoutFailure();
  }
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ProviderOversizedBody();
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    await Promise.all(cancellations);
  }
}

/** Maps one transport failure onto the closed provider error vocabulary. */
function providerErrorFor(error: unknown, op: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (
    error instanceof ProviderTimeoutFailure ||
    error instanceof ProviderTransportFailure
  ) {
    return new ProviderError("temporarily_unavailable", op);
  }
  return new ProviderError("upstream_error", op);
}

/**
 * Refuses a host that is already an IP address literal and is not public. Node
 * skips name resolution for a literal, so this is the one host the adapter can
 * classify without its own resolver.
 */
function assertPublicHostLiteral(url: URL): void {
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIP(host) === 0) return;
  if (!isPublicHostAddress(host)) throw new ProviderRequestRefused();
}

function defaultDiscoveryURL(issuer: string): string {
  const url = new URL(issuer);
  url.pathname = joinURLPath(url.pathname, DISCOVERY_PATH);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Returns `raw` as an absolute HTTPS URL, or fails the operation closed. */
function httpsEndpoint(raw: string, op: string): string {
  let url: URL;
  try {
    url = new URL(trimmed(raw));
  } catch {
    throw new ProviderError("upstream_error", op);
  }
  if (url.protocol !== "https:" || !url.host) {
    throw new ProviderError("upstream_error", op);
  }
  return url.toString();
}

function validatorCacheKey(
  expected: TokenExpectations,
  requiredScopes: string[],
  allowedAuthorizedParties: string[],
): string {
  return JSON.stringify([
    trimmed(expected?.expectedIssuer),
    trimmed(expected?.expectedAudience),
    requiredScopes,
    allowedAuthorizedParties,
  ]);
}

/**
 * Reads one string claim from a verified token's payload segment. The token has
 * already been signature-verified, so the decode is only used to report the
 * authorized party the validator does not return.
 */
function decodePayloadClaim(token: string, name: string): string {
  const segments = String(token ?? "")
    .trim()
    .split(".");
  const payload = segments.length === 3 ? (segments[1] ?? "") : "";
  if (!payload) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "";
  }
  if (!isRecord(parsed)) return "";
  const value = parsed[name];
  return typeof value === "string" ? value.trim() : "";
}

function parseJSONObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  return typeof value === "string" ? value : "";
}

function stringListField(
  record: Record<string, unknown>,
  name: string,
): string[] {
  const value = record[name];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function joinScopes(scopes: readonly string[]): string {
  return normalizeList(scopes).join(" ");
}

/**
 * Validates the caller's hints before any upstream call and returns the ones
 * that may be forwarded, as already-trimmed name/value pairs. A blank name is
 * dropped, and a name that collides, case-insensitively after trimming, with a
 * required or reserved authorize parameter is refused as `invalid_request`;
 * this runs before the authorize endpoint is resolved, so a refused hint
 * causes no upstream interaction.
 */
function forwardableHints(
  hints: Record<string, string> | undefined,
): Array<[string, string]> {
  const forwarded: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(hints ?? {})) {
    const name = trimmed(key);
    if (!name) continue;
    if (RESERVED_AUTHORIZE_PARAMETERS.has(name.toLowerCase())) {
      throw new ProviderError("invalid_request", OP_AUTHORIZATION_URL);
    }
    forwarded.push([name, String(value ?? "")]);
  }
  return forwarded;
}

function normalizeList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmedValue = typeof value === "string" ? value.trim() : "";
    if (trimmedValue) out.push(trimmedValue);
  }
  return out;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function joinURLPath(base: string, suffix: string): string {
  const left = trimTrailingSlashes(String(base ?? ""));
  const right = trimLeadingAndTrailingSlashes(String(suffix ?? ""));
  if (!right) return left || "/";
  return `${left}/${right}`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function trimLeadingAndTrailingSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(start, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
