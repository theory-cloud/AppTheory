import { createHash, randomBytes } from "node:crypto";

import type { Context, Handler, Middleware, RouteGuard } from "../context.js";
import { metadataJSON } from "../response.js";
import type { Headers, Response } from "../types.js";

export const CONTEXT_KEY_BEARER_TOKEN = "oauth.bearer_token";
export const CONTEXT_KEY_BEARER_CLAIMS = "oauth.bearer_claims";

export const ERR_MISSING_BEARER_TOKEN = "missing bearer token";
export const ERR_INVALID_AUTHORIZATION_HEADER = "invalid authorization header";
export const ERR_INVALID_BEARER_TOKEN = "invalid bearer token";
export const ERR_BEARER_TOKEN_EXPIRED = "bearer token expired";
export const ERR_BEARER_TOKEN_INVALID_AUDIENCE =
  "bearer token invalid audience";
export const ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE =
  "bearer token insufficient scope";
export const ERR_INVALID_URL = "invalid url";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  jwks_uri?: string;
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  /**
   * RFC 9207 `iss` authorization-response advertisement (RFC 8414
   * `authorization_response_iss_parameter_supported`). Optional and absent by
   * default, so an unset member keeps the document byte-identical and means
   * false; only a surface that provably sends `iss` sets it. The handler emits
   * the member only while the value is the boolean `true`: an explicit `false`,
   * an absent member, and any non-boolean value all leave it out.
   */
  authorization_response_iss_parameter_supported?: boolean;
}

export interface AuthorizationServerMetadataOptions {
  /**
   * Opts into the RFC 8414 revocation_endpoint. `true` derives the
   * conventional `/revoke` path from the issuer base URL; a string must be an
   * absolute URL and is used verbatim. Absent means the document does not
   * advertise a revocation endpoint.
   */
  revocationEndpoint?: string | true;
  /**
   * Opts into the RFC 8628 device_authorization_endpoint. `true` derives the
   * conventional `/device` path from the issuer base URL; a string must be an
   * absolute URL and is used verbatim. Absent means the document does not
   * advertise a device authorization endpoint.
   */
  deviceAuthorizationEndpoint?: string | true;
}

export interface DynamicClientRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

export interface DynamicClientRegistrationPolicy {
  allowedRedirectUris?: string[];
  requirePublicClient?: boolean;
  requireRefreshToken?: boolean;
}

export interface BearerTokenClaims {
  subject?: string;
  audience?: string;
  scopes?: string[];
  expiresAt?: Date;
}

export interface BearerTokenRecord extends BearerTokenClaims {
  token: string;
  scope?: string;
}

export type BearerTokenValidator = (
  ctx: Context,
  token: string,
) => void | Promise<void>;

export type BearerTokenClaimsValidator = (
  ctx: Context,
  token: string,
) => BearerTokenClaims | Promise<BearerTokenClaims>;

export interface BearerTokenValidationOptions {
  /**
   * Static audience the token must be bound to, or a route-derived resolver
   * that returns the exact matched-route audience. A function takes
   * precedence, so audience can be the matched route URL rather than a
   * process-global value.
   */
  requiredAudience?: string | ((ctx: Context) => string | Promise<string>);
  /**
   * Static scope set the token must carry, or a route-derived resolver that
   * returns the scope set for the matched route. A function takes precedence.
   */
  requiredScopes?: string[] | ((ctx: Context) => string[] | Promise<string[]>);
  now?: () => Date;
}

export interface RequireBearerTokenOptions {
  /**
   * Static protected-resource metadata URL for the RFC 9728 challenge, or a
   * route-derived resolver for the matched route. A function takes precedence.
   */
  resourceMetadataURL?: string | ((ctx: Context) => string | Promise<string>);
  /**
   * Absolute HTTPS URL template whose `{param}` placeholders are interpolated
   * from the matched route's path parameters, so a per-actor route
   * (`/mcp/{actor}`) advertises that actor's own RFC 9728 metadata URL with no
   * hand-rolled resolver. It is explicit application configuration: the
   * middleware reads no environment variable.
   *
   * The template is compiled when the middleware is constructed. It must be an
   * absolute HTTPS URL with no userinfo, query, fragment, or percent escape and
   * no `.` or `..` path segment, and its placeholders must appear in the path
   * and name route parameters; a malformed template throws at registration
   * rather than advertising a broken discovery URL.
   *
   * At request time a placeholder the matched route does not supply, or whose
   * value is not a safe single path segment, makes the middleware emit the bare
   * `Bearer` challenge. It never advertises a literal placeholder, and an
   * unresolvable template does not fall back to `resourceMetadataURL`.
   *
   * When set it takes precedence over `resourceMetadataURL`; a
   * `resourceMetadataURL` function still takes precedence over it.
   */
  resourceMetadataURLTemplate?: string;
  /**
   * Route-derived scope set used to build the 403 insufficient_scope
   * remediation challenge. Consulted only when a validator reports a scope
   * failure.
   */
  requiredScopes?: string[] | ((ctx: Context) => string[] | Promise<string[]>);
  validator?: BearerTokenValidator;
  claimsValidator?: BearerTokenClaimsValidator;
}

export class OAuthBearerError extends Error {
  readonly oauthCode: string;

  constructor(oauthCode: string, message: string = oauthCode) {
    super(message);
    this.name = "OAuthBearerError";
    this.oauthCode = oauthCode;
  }
}

export function newProtectedResourceMetadata(
  resource: string,
  authorizationServers: string[],
): ProtectedResourceMetadata {
  const canonicalResource = String(resource ?? "").trim();
  if (!isAbsoluteURL(canonicalResource)) {
    throw new Error(`${ERR_INVALID_URL}: resource must be an absolute URL`);
  }
  const servers = (authorizationServers ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (servers.length === 0 || servers.some((value) => !isAbsoluteURL(value))) {
    throw new Error(
      `${ERR_INVALID_URL}: authorization server must be an absolute URL`,
    );
  }
  return { resource: canonicalResource, authorization_servers: servers };
}

export function newAuthorizationServerMetadata(
  issuer: string,
  options?: AuthorizationServerMetadataOptions,
): AuthorizationServerMetadata {
  const url = absoluteURL(issuer);
  if (!url)
    throw new Error(`${ERR_INVALID_URL}: issuer must be an absolute URL`);
  url.pathname = trimTrailingSlash(url.pathname);
  url.search = "";
  url.hash = "";
  const canonicalIssuer = url.toString();
  const endpoint = (suffix: string): string => {
    const out = new URL(canonicalIssuer);
    out.pathname = joinURLPath(out.pathname, suffix);
    out.search = "";
    out.hash = "";
    return out.toString();
  };
  const metadata: AuthorizationServerMetadata = {
    issuer: canonicalIssuer,
    authorization_endpoint: endpoint("/authorize"),
    token_endpoint: endpoint("/token"),
    registration_endpoint: endpoint("/register"),
    jwks_uri: endpoint("/.well-known/jwks.json"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
  const opts = options ?? {};
  if (opts.revocationEndpoint !== undefined) {
    metadata.revocation_endpoint =
      opts.revocationEndpoint === true
        ? endpoint("/revoke")
        : absoluteURLValue(opts.revocationEndpoint, "revocation endpoint");
  }
  if (opts.deviceAuthorizationEndpoint !== undefined) {
    metadata.device_authorization_endpoint =
      opts.deviceAuthorizationEndpoint === true
        ? endpoint("/device")
        : absoluteURLValue(
            opts.deviceAuthorizationEndpoint,
            "device authorization endpoint",
          );
  }
  return metadata;
}

export function protectedResourceMetadataHandler(
  metadata: ProtectedResourceMetadata,
): Handler {
  return () => metadataJSON(200, metadata);
}

export function authorizationServerMetadataHandler(
  metadata: AuthorizationServerMetadata,
): Handler {
  return () => metadataJSON(200, normalizeIssParameterSupport(metadata));
}

/**
 * Applies the RFC 8414 "absent means false" rule to the RFC 9207 member: the
 * member is emitted only while it is the boolean `true`, so Go (a typed bool
 * with `omitempty`), TypeScript, and Python emit the same document for the same
 * input. An explicit `false`, an absent member, and any non-boolean value (a
 * string such as `"true"`, a number) all drop the member, so a value that is
 * not the boolean `true` never reaches the document.
 */
function normalizeIssParameterSupport(
  metadata: AuthorizationServerMetadata,
): AuthorizationServerMetadata {
  const value = metadata.authorization_response_iss_parameter_supported;
  if (value === undefined || value === true) {
    return metadata;
  }
  const copy: AuthorizationServerMetadata = { ...metadata };
  delete copy.authorization_response_iss_parameter_supported;
  return copy;
}

export function protectedResourceWWWAuthenticate(
  resourceMetadataURL: string,
): string {
  const value = String(resourceMetadataURL ?? "").trim();
  if (!value) return "Bearer";
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `Bearer resource_metadata="${escaped}"`;
}

/**
 * Builds the RFC 6750 (RFC 9728-extended) insufficient_scope challenge
 * carrying the route-derived remediation scope set. Order matches Go:
 * `error`, then `scope` when non-empty, then `resource_metadata` when
 * non-empty.
 */
export function insufficientScopeWWWAuthenticate(
  scopes: string[],
  resourceMetadataURL?: string,
): string {
  const normalized = (scopes ?? [])
    .map((scope) => String(scope ?? "").trim())
    .filter(Boolean);
  const parts = ['Bearer error="insufficient_scope"'];
  if (normalized.length > 0) {
    parts.push(`scope=${quoteChallengeValue(normalized.join(" "))}`);
  }
  const url = String(resourceMetadataURL ?? "").trim();
  if (url) parts.push(`resource_metadata=${quoteChallengeValue(url)}`);
  return parts.join(", ");
}

/**
 * Reports whether two RFC 8707 resource indicators denote the same protected
 * resource after canonicalization. An empty expected indicator never matches.
 */
export function resourceIndicatorMatches(
  expected: string,
  requested: string,
): boolean {
  const canonicalExpected = canonicalResourceURL(expected);
  if (!canonicalExpected) return false;
  return canonicalExpected === canonicalResourceURL(requested);
}

export function rfc9728ResourceMetadataURL(resourceURL: string): string | null {
  const url = absoluteURL(resourceURL);
  if (!url) return null;
  url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
  url.hash = "";
  return url.toString();
}

export function resourceMetadataURLFromMcpEndpoint(
  mcpEndpoint: string,
): string | null {
  return rfc9728ResourceMetadataURL(mcpEndpoint);
}

export function canonicalResourceURL(raw: string): string {
  return trimTrailingSlash(String(raw ?? "").trim());
}

/**
 * Canonicalizes an RFC 9207 `iss` value exactly as the Go reference
 * `oauth.CanonicalizeIssuerURL` does, because the pinned issuer is compared
 * byte-for-byte across runtimes. The scheme is lowercased; the authority is
 * preserved, so host case and an explicit port survive; the decoded path is
 * re-encoded with the Go `net/url` path rules and its trailing slashes are
 * trimmed; the raw query and fragment are kept. Relative, empty, control-byte
 * and malformed-percent-escape inputs return null.
 */
export function canonicalizeIssuerURL(raw: string): string | null {
  const input = String(raw ?? "").trim();
  if (input === "" || hasControlByte(input)) return null;

  let rest = input;
  let rawFragment: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    rawFragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  const scheme = splitURLScheme(rest);
  if (!scheme) return null;
  rest = scheme.rest;

  let forceQuery = false;
  let rawQuery = "";
  if (rest.endsWith("?") && rest.split("?").length === 2) {
    forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    const query = rest.indexOf("?");
    if (query >= 0) {
      rawQuery = rest.slice(query + 1);
      rest = rest.slice(0, query);
    }
  }

  if (!rest.startsWith("//")) return null;
  const pathStart = rest.indexOf("/", 2);
  const authority = pathStart < 0 ? rest.slice(2) : rest.slice(2, pathStart);
  const rawPath = pathStart < 0 ? "" : rest.slice(pathStart);

  const parts = parseAuthority(authority);
  if (!parts) return null;

  const decodedPath = goUnescape(rawPath, "path");
  if (decodedPath === null) return null;
  const trimmedPath = trimTrailingSlashBytes(decodedPath);

  let escapedPath = goEscapeBytes(trimmedPath, goPathAllows);
  if (goEscapeBytes(decodedPath, goPathAllows) !== rawPath) {
    const hinted = goUnescape(rawPath, "path");
    if (
      goValidEncoded(rawPath, "path") &&
      hinted !== null &&
      hinted.equals(trimmedPath)
    ) {
      escapedPath = rawPath;
    }
  }

  const decodedHost = goUnescape(parts.host, "host");
  if (decodedHost === null) return null;

  let out = `${scheme.scheme}://`;
  if (parts.userinfo !== null) out += `${parts.userinfo}@`;
  out += goEscapeBytes(decodedHost, goHostAllows);
  out += escapedPath;
  if (forceQuery || rawQuery !== "") out += `?${rawQuery}`;

  if (rawFragment !== null) {
    const decodedFragment = goUnescape(rawFragment, "fragment");
    if (decodedFragment === null) return null;
    if (decodedFragment.length > 0) {
      const fragment = goValidEncoded(rawFragment, "fragment")
        ? rawFragment
        : goEscapeBytes(decodedFragment, goFragmentAllows);
      out += `#${fragment}`;
    }
  }

  return out;
}

export function bearerTokenFromHeaders(headers: Headers | undefined): string {
  const auth = firstHeader(headers, "authorization").trim();
  if (!auth) throw new OAuthBearerError(ERR_MISSING_BEARER_TOKEN);
  const [schemeRaw = "", ...rest] = auth.split(" ");
  const token = rest.join(" ").trim();
  if (schemeRaw.toLowerCase() !== "bearer" || !token) {
    throw new OAuthBearerError(ERR_INVALID_AUTHORIZATION_HEADER);
  }
  return token;
}

/**
 * Validates the request credential and binds any verified claims to the
 * context. A non-null response is the denial to return.
 */
async function authorizeBearerToken(
  ctx: Context,
  options: RequireBearerTokenOptions,
  resourceMetadataURLTemplate: ResourceMetadataURLTemplate | null,
): Promise<Response | null> {
  const token = bearerTokenFromHeaders(ctx.request.headers);
  if (options.claimsValidator) {
    const claims = await options.claimsValidator(ctx, token);
    ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
    ctx.set(CONTEXT_KEY_BEARER_CLAIMS, cloneClaims(claims));
    return null;
  }
  if (!options.validator) {
    return await unauthorizedResponse(
      ctx,
      options,
      resourceMetadataURLTemplate,
    );
  }
  await options.validator(ctx, token);
  ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
  return null;
}

/**
 * Enforces `Authorization: Bearer <token>` and, when missing or invalid,
 * returns 401 with the MCP 2025-06-18 compatible WWW-Authenticate challenge
 * that points to the protected resource metadata.
 *
 * A `resourceMetadataURLTemplate` is compiled here, at registration, and a
 * malformed template throws: the middleware never serves a request whose
 * challenge would advertise a broken or partially resolved discovery URL.
 */
export function requireBearerTokenMiddleware(
  options: RequireBearerTokenOptions = {},
): Middleware {
  const resourceMetadataURLTemplate = compileResourceMetadataURLTemplate(
    options.resourceMetadataURLTemplate,
  );
  return async (ctx, next) => {
    try {
      const denied = await authorizeBearerToken(
        ctx,
        options,
        resourceMetadataURLTemplate,
      );
      if (denied) return denied;
      return await next(ctx);
    } catch (err) {
      return await bearerErrorResponse(
        ctx,
        options,
        err,
        resourceMetadataURLTemplate,
      );
    }
  };
}

/**
 * Returns the same credential decision as {@link requireBearerTokenMiddleware}
 * in route-guard form. The runtime runs a route guard after a route's
 * authorization gate and before application middleware, so a short-circuiting
 * middleware cannot bypass bearer validation. Verified claims are bound to the
 * context before the guard admits the request.
 */
export function requireBearerTokenGuard(
  options: RequireBearerTokenOptions = {},
): RouteGuard {
  const resourceMetadataURLTemplate = compileResourceMetadataURLTemplate(
    options.resourceMetadataURLTemplate,
  );
  return async (ctx) => {
    try {
      return await authorizeBearerToken(
        ctx,
        options,
        resourceMetadataURLTemplate,
      );
    } catch (err) {
      return await bearerErrorResponse(
        ctx,
        options,
        err,
        resourceMetadataURLTemplate,
      );
    }
  };
}

export function newMemoryBearerTokenValidator(
  records: BearerTokenRecord[],
  options: BearerTokenValidationOptions = {},
): BearerTokenClaimsValidator {
  const byToken = new Map<string, BearerTokenClaims>();
  for (const record of records ?? []) {
    const token = String(record.token ?? "").trim();
    if (!token) continue;
    const claims: BearerTokenClaims = {
      subject: String(record.subject ?? "").trim(),
      audience: String(record.audience ?? "").trim(),
      scopes:
        Array.isArray(record.scopes) && record.scopes.length > 0
          ? record.scopes
              .map((scope) => String(scope ?? "").trim())
              .filter(Boolean)
          : scopeFields(record.scope ?? ""),
    };
    if (record.expiresAt) claims.expiresAt = new Date(record.expiresAt);
    byToken.set(token, claims);
  }
  const audienceOption = options.requiredAudience;
  const scopesOption = options.requiredScopes;
  const now = options.now ?? (() => new Date());
  return async (ctx, token) => {
    const claims = byToken.get(String(token ?? "").trim());
    if (!claims) throw new OAuthBearerError(ERR_INVALID_BEARER_TOKEN);
    if (claims.expiresAt && now().getTime() >= claims.expiresAt.getTime()) {
      throw new OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED);
    }
    const requiredAudience =
      typeof audienceOption === "function"
        ? String((await audienceOption(ctx)) ?? "").trim()
        : String(audienceOption ?? "").trim();
    if (requiredAudience && claims.audience !== requiredAudience) {
      throw new OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE);
    }
    const requiredScopes =
      typeof scopesOption === "function"
        ? normalizeScopeList(await scopesOption(ctx))
        : normalizeScopeList(scopesOption ?? []);
    if (missingScopes(claims.scopes ?? [], requiredScopes).length > 0) {
      throw new OAuthBearerError(ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE);
    }
    return cloneClaims(claims);
  };
}

export function bearerTokenClaimsFromContext(
  ctx: Context,
): BearerTokenClaims | null {
  const claims = ctx.get(CONTEXT_KEY_BEARER_CLAIMS);
  if (!claims || typeof claims !== "object") return null;
  return cloneClaims(claims as BearerTokenClaims);
}

export function claudeDynamicClientRegistrationPolicy(): DynamicClientRegistrationPolicy {
  return {
    allowedRedirectUris: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
    ],
    requirePublicClient: true,
    requireRefreshToken: true,
  };
}

export function validateDynamicClientRegistrationRequest(
  request: DynamicClientRegistrationRequest,
  policy: DynamicClientRegistrationPolicy,
): void {
  if (!request || typeof request !== "object")
    throw new Error("dcr: request is nil");
  const allowed = new Set(
    (policy.allowedRedirectUris ?? [])
      .map((uri) => String(uri).trim())
      .filter(Boolean),
  );
  const redirectUris = request.redirect_uris ?? [];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error("dcr: redirect_uris is required");
  }
  for (const raw of redirectUris) {
    const uri = String(raw ?? "").trim();
    if (!uri) throw new Error("dcr: redirect_uris contains an empty value");
    if (allowed.size > 0 && !allowed.has(uri)) {
      throw new Error(`dcr: redirect_uri not allowed: ${uri}`);
    }
  }
  const method =
    String(request.token_endpoint_auth_method ?? "none").trim() || "none";
  if (policy.requirePublicClient && method !== "none") {
    throw new Error("dcr: token_endpoint_auth_method must be none");
  }
  const grantTypes = normalizeStringList(request.grant_types ?? []);
  if (grantTypes.length > 0) {
    if (!grantTypes.includes("authorization_code")) {
      throw new Error("dcr: grant_types must include authorization_code");
    }
    if (policy.requireRefreshToken && !grantTypes.includes("refresh_token")) {
      throw new Error("dcr: grant_types must include refresh_token");
    }
  }
  const responseTypes = normalizeStringList(request.response_types ?? []);
  if (responseTypes.length > 0 && !responseTypes.includes("code")) {
    throw new Error("dcr: response_types must include code");
  }
}

export function newPKCECodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function validatePKCECodeVerifier(verifier: string): void {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(String(verifier ?? ""))) {
    throw new Error("pkce: invalid code verifier");
  }
}

export function pkceChallengeS256(verifier: string): string {
  validatePKCECodeVerifier(verifier);
  return createHash("sha256")
    .update(String(verifier), "utf8")
    .digest("base64url");
}

export function pkceVerifyS256(
  verifier: string,
  expectedChallenge: string,
): boolean {
  return pkceChallengeS256(verifier) === String(expectedChallenge ?? "");
}

// A `{param}` protected-resource metadata URL template, compiled once at
// registration so request time only validates and interpolates the matched
// route parameters.
interface ResourceMetadataURLTemplate {
  template: string;
  rawPath: string;
  params: string[];
}

const RESOURCE_METADATA_URL_TEMPLATE_MAX_PARAM_BYTES = 128;

// Placeholder names are deliberately narrow: they name route parameters, not
// free-form expressions.
const RESOURCE_METADATA_URL_TEMPLATE_PARAM_PATTERN = /^[a-z][a-z0-9_]*$/u;

// The only bytes that may be interpolated into the advertised challenge URL.
// The alphabet is the RFC 3986 unreserved set plus the three path-safe
// punctuation bytes RFC 3986 allows unescaped; it is deliberately narrower than
// the router's own segment rule, so the advertised URL cannot differ from the
// matched route through case folding, percent-decoding, or separator handling
// in a proxy, CDN, or client.
const RESOURCE_METADATA_URL_TEMPLATE_VALUE_PATTERN = new RegExp(
  `^[a-z0-9._~-]{1,${RESOURCE_METADATA_URL_TEMPLATE_MAX_PARAM_BYTES}}$`,
  "u",
);

/**
 * Validates a template and records the route parameters it interpolates.
 *
 * A template is valid when it is an absolute HTTPS URL with no userinfo, query,
 * fragment, or percent-escape, with no `.` or `..` path segment, and every
 * `{param}` placeholder sits in the URL path and names a lower-case route
 * parameter. Placeholders outside the path are refused, because interpolating
 * one would let a request steer the advertised authority rather than only its
 * path suffix.
 *
 * A malformed template throws here, at registration, so a bad configuration
 * fails closed at startup instead of at request time.
 */
function compileResourceMetadataURLTemplate(
  raw: string | undefined,
): ResourceMetadataURLTemplate | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template is not an absolute URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must be an absolute HTTPS URL",
    );
  }
  // `new URL` reads `https:host/path` as a host, but Go reads it as an opaque
  // URL with no host; require the explicit authority separator Go expects.
  const afterScheme = trimmed.slice(url.protocol.length);
  if (!afterScheme.startsWith("//")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template is not an absolute URL",
    );
  }
  if (!url.host || !url.hostname) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must include a host",
    );
  }
  // Split the raw authority and path out of the template text: the checks below
  // read them rather than the parsed URL, because WHATWG normalization drops the
  // differences Go and Python refuse (empty userinfo, dot segments).
  const remainder = afterScheme.slice(2);
  const slash = remainder.indexOf("/");
  const authority = slash < 0 ? remainder : remainder.slice(0, slash);
  const rawPath = slash < 0 ? "" : remainder.slice(slash);
  // Userinfo is refused on the raw authority text: WHATWG parses
  // `https://@api.example.com/x` to an empty userinfo, so `url.username ||
  // url.password` is falsy and would let it through, while Go's
  // `url.User != nil` and Python's `username is not None` both refuse it.
  if (authority.includes("@")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must not include userinfo",
    );
  }
  if (trimmed.includes("?")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must not include a query",
    );
  }
  if (trimmed.includes("#")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must not include a fragment",
    );
  }
  if (authority.includes("{") || authority.includes("}")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template placeholders must appear in the path, not the authority",
    );
  }
  if (rawPath.includes("%")) {
    throw new Error(
      "invalid ResourceMetadataURLTemplate: template must not percent-encode its path",
    );
  }
  if (hasDotPathSegment(rawPath)) {
    throw new Error(
      'invalid ResourceMetadataURLTemplate: template must not contain a "." or ".." path segment',
    );
  }
  return {
    template: trimmed,
    rawPath,
    params: resourceMetadataURLTemplateParams(rawPath),
  };
}

/**
 * Reports whether a URL path carries a `.` or `..` segment.
 *
 * A static dot segment in a template is never intended, and the runtimes do not
 * agree on what to do with one: Go and Python advertise the literal segment
 * while a WHATWG URL parser normalizes it away, so the advertised URL would
 * depend on the runtime. The template is refused instead.
 */
function hasDotPathSegment(rawPath: string): boolean {
  return rawPath
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Returns the distinct placeholder names in path order, refusing anything that
 * is not a well-formed `{param}`.
 */
function resourceMetadataURLTemplateParams(rawPath: string): string[] {
  const params: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawPath.length;) {
    const char = rawPath[index];
    if (char === "{") {
      const end = rawPath.indexOf("}", index);
      if (end < 0) {
        throw new Error(
          "invalid ResourceMetadataURLTemplate: template placeholder is unterminated",
        );
      }
      const name = rawPath.slice(index + 1, end);
      if (!RESOURCE_METADATA_URL_TEMPLATE_PARAM_PATTERN.test(name)) {
        throw new Error(
          `invalid ResourceMetadataURLTemplate: template placeholder "${name}" is not a route parameter name`,
        );
      }
      if (!seen.has(name)) {
        seen.add(name);
        params.push(name);
      }
      index = end + 1;
      continue;
    }
    if (char === "}") {
      throw new Error(
        'invalid ResourceMetadataURLTemplate: template has an unmatched "}"',
      );
    }
    index += 1;
  }
  return params;
}

/**
 * Interpolates the matched route parameters into the template.
 *
 * Every placeholder must be present in the matched route and its value must
 * satisfy the pinned value rule; the resolved path is then checked to be free
 * of leftover placeholders. A failure returns null so the caller emits the bare
 * `Bearer` challenge instead of a literal placeholder or a partially resolved
 * URL.
 */
function resolveResourceMetadataURLTemplate(
  template: ResourceMetadataURLTemplate,
  params: Record<string, string> | undefined,
): string | null {
  let resolvedPath = template.rawPath;
  for (const name of template.params) {
    const value = String((params ?? {})[name] ?? "");
    if (!isSafeResourceMetadataURLTemplateValue(value)) return null;
    resolvedPath = resolvedPath.replaceAll(`{${name}}`, value);
  }
  if (resolvedPath.includes("{") || resolvedPath.includes("}")) return null;
  if (template.rawPath === "") return template.template;
  const url = new URL(template.template);
  url.pathname = resolvedPath;
  return url.toString();
}

/**
 * Reports whether a route parameter value may be interpolated into the
 * advertised challenge URL.
 *
 * The pinned rule accepts 1..128 bytes drawn from `[a-z0-9._~-]`, excluding the
 * dot segments `.` and `..`. Everything else — empty, `/`-containing,
 * percent-encoded, upper-case, whitespace, control, or non-ASCII — is refused,
 * and the caller then emits the bare `Bearer` challenge.
 */
function isSafeResourceMetadataURLTemplateValue(value: string): boolean {
  if (value === "." || value === "..") return false;
  return RESOURCE_METADATA_URL_TEMPLATE_VALUE_PATTERN.test(value);
}

async function unauthorizedResponse(
  ctx: Context,
  options: RequireBearerTokenOptions,
  resourceMetadataURLTemplate: ResourceMetadataURLTemplate | null,
): Promise<Response> {
  const metadataURL = await resolveResourceMetadataURL(
    ctx,
    options,
    resourceMetadataURLTemplate,
  );
  const headers: Headers = {
    "content-type": ["application/json; charset=utf-8"],
  };
  headers["www-authenticate"] = [
    metadataURL ? protectedResourceWWWAuthenticate(metadataURL) : "Bearer",
  ];
  return {
    status: 401,
    headers,
    cookies: [],
    body: Buffer.from(
      JSON.stringify({
        error: {
          code: "app.unauthorized",
          message: "unauthorized",
          status_code: 401,
        },
      }),
      "utf8",
    ),
    isBase64: false,
  };
}

async function insufficientScopeResponse(
  ctx: Context,
  options: RequireBearerTokenOptions,
  resourceMetadataURLTemplate: ResourceMetadataURLTemplate | null,
): Promise<Response> {
  const scopes = await resolveRequiredScopes(ctx, options.requiredScopes);
  const metadataURL = await resolveResourceMetadataURL(
    ctx,
    options,
    resourceMetadataURLTemplate,
  );
  const headers: Headers = {
    "content-type": ["application/json; charset=utf-8"],
    "www-authenticate": [insufficientScopeWWWAuthenticate(scopes, metadataURL)],
  };
  return {
    status: 403,
    headers,
    cookies: [],
    body: Buffer.from(
      JSON.stringify({
        error: {
          code: "app.insufficient_scope",
          message: "insufficient scope",
          status_code: 403,
        },
      }),
      "utf8",
    ),
    isBase64: false,
  };
}

function forbiddenResponse(): Response {
  return {
    status: 403,
    headers: { "content-type": ["application/json; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(
      JSON.stringify({
        error: {
          code: "app.forbidden",
          message: "forbidden",
          status_code: 403,
        },
      }),
      "utf8",
    ),
    isBase64: false,
  };
}

async function bearerErrorResponse(
  ctx: Context,
  options: RequireBearerTokenOptions,
  err: unknown,
  resourceMetadataURLTemplate: ResourceMetadataURLTemplate | null,
): Promise<Response> {
  if (err instanceof OAuthBearerError) {
    if (err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE) {
      return await insufficientScopeResponse(
        ctx,
        options,
        resourceMetadataURLTemplate,
      );
    }
    if (err.oauthCode === ERR_BEARER_TOKEN_INVALID_AUDIENCE) {
      return forbiddenResponse();
    }
  }
  return await unauthorizedResponse(ctx, options, resourceMetadataURLTemplate);
}

/**
 * Resolves the RFC 9728 protected-resource metadata URL for a challenge. A
 * route-derived resolver takes precedence, then a route-parameter template,
 * then the static option. A resolver or template failure degrades to no
 * challenge URL, matching the Go middleware.
 */
async function resolveResourceMetadataURL(
  ctx: Context,
  options: RequireBearerTokenOptions,
  resourceMetadataURLTemplate: ResourceMetadataURLTemplate | null,
): Promise<string> {
  const option = options.resourceMetadataURL;
  if (typeof option === "function") {
    try {
      return String((await option(ctx)) ?? "").trim();
    } catch {
      return "";
    }
  }
  if (resourceMetadataURLTemplate) {
    const resolved = resolveResourceMetadataURLTemplate(
      resourceMetadataURLTemplate,
      ctx.params,
    );
    return resolved ?? "";
  }
  return String(option ?? "").trim();
}

/**
 * Resolves the route-derived remediation scope set for a 403 challenge. A
 * resolver failure degrades to an empty (omitted) scope set.
 */
async function resolveRequiredScopes(
  ctx: Context,
  option: RequireBearerTokenOptions["requiredScopes"],
): Promise<string[]> {
  try {
    if (typeof option === "function") {
      return normalizeScopeList(await option(ctx));
    }
    return normalizeScopeList(option ?? []);
  } catch {
    return [];
  }
}

function quoteChallengeValue(value: string): string {
  const escaped = String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function firstHeader(headers: Headers | undefined, name: string): string {
  const key = String(name).trim().toLowerCase();
  if (!headers) return "";
  for (const [rawKey, values] of Object.entries(headers)) {
    if (String(rawKey).trim().toLowerCase() !== key) continue;
    return String((values ?? [])[0] ?? "");
  }
  return "";
}

function cloneClaims(claims: BearerTokenClaims): BearerTokenClaims {
  const out: BearerTokenClaims = {
    subject: String(claims.subject ?? ""),
    audience: String(claims.audience ?? ""),
    scopes: [...(claims.scopes ?? [])],
  };
  if (claims.expiresAt) out.expiresAt = new Date(claims.expiresAt);
  return out;
}

function scopeFields(scope: string): string[] {
  return String(scope ?? "")
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeScopeList(scopes: readonly string[]): string[] {
  return (scopes ?? [])
    .map((scope) => String(scope ?? "").trim())
    .filter(Boolean);
}

function missingScopes(got: string[], required: string[]): string[] {
  const seen = new Set(
    (got ?? []).map((scope) => String(scope).trim()).filter(Boolean),
  );
  return (required ?? []).filter((scope) => !seen.has(String(scope).trim()));
}

function normalizeStringList(values: string[]): string[] {
  return (values ?? [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .sort();
}

function absoluteURL(raw: string): URL | null {
  try {
    const url = new URL(String(raw ?? "").trim());
    if (!url.protocol || !url.host) return null;
    return url;
  } catch {
    return null;
  }
}

function isAbsoluteURL(raw: string): boolean {
  return absoluteURL(raw) !== null;
}

function absoluteURLValue(raw: string, label: string): string {
  const url = absoluteURL(String(raw ?? ""));
  if (!url)
    throw new Error(`${ERR_INVALID_URL}: ${label} must be an absolute URL`);
  return url.toString();
}

function trimTrailingSlash(pathname: string): string {
  const value = String(pathname ?? "");
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

// The helpers below re-implement the slice of Go's `net/url` that
// `oauth.CanonicalizeIssuerURL` depends on: scheme splitting, authority
// parsing, and the escape table of `net/url`'s encoding modes. They are
// deliberately local to this module so the issuer pin cannot drift from Go.

type GoEscapeMode = "path" | "fragment" | "host" | "userinfo";

const GO_HEX = "0123456789ABCDEF";

// `net/url.validEncoded` always accepts these bytes, whatever the mode.
const GO_ENCODED_LITERALS = new Set([
  0x21, 0x24, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x3b, 0x3a, 0x3d, 0x40,
  0x5b, 0x5d,
]);

interface GoAuthority {
  host: string;
  /** Re-encoded the way Go's `Userinfo.String()` prints it, or null. */
  userinfo: string | null;
}

function hasControlByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function goByte(bytes: Buffer, index: number): number {
  return bytes[index] ?? 0;
}

function goIsHexByte(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function goUnhex(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return code - 0x61 + 10;
}

function goPathAllows(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  switch (code) {
    case 0x24: // $
    case 0x26: // &
    case 0x2b: // +
    case 0x2c: // ,
    case 0x2d: // -
    case 0x2e: // .
    case 0x2f: // /
    case 0x3a: // :
    case 0x3b: // ;
    case 0x3d: // =
    case 0x40: // @
    case 0x5f: // _
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

function goHostAllows(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  switch (code) {
    case 0x21: // !
    case 0x22: // "
    case 0x24: // $
    case 0x26: // &
    case 0x27: // '
    case 0x28: // (
    case 0x29: // )
    case 0x2a: // *
    case 0x2b: // +
    case 0x2c: // ,
    case 0x2d: // -
    case 0x2e: // .
    case 0x3a: // :
    case 0x3b: // ;
    case 0x3c: // <
    case 0x3d: // =
    case 0x3e: // >
    case 0x5b: // [
    case 0x5d: // ]
    case 0x5f: // _
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

function goFragmentAllows(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  switch (code) {
    case 0x21: // !
    case 0x24: // $
    case 0x26: // &
    case 0x28: // (
    case 0x29: // )
    case 0x2a: // *
    case 0x2b: // +
    case 0x2c: // ,
    case 0x2d: // -
    case 0x2e: // .
    case 0x2f: // /
    case 0x3a: // :
    case 0x3b: // ;
    case 0x3d: // =
    case 0x3f: // ?
    case 0x40: // @
    case 0x5f: // _
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

function goUserinfoAllows(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x61 && code <= 0x7a) return true;
  switch (code) {
    case 0x24: // $
    case 0x26: // &
    case 0x2b: // +
    case 0x2c: // ,
    case 0x2d: // -
    case 0x2e: // .
    case 0x3b: // ;
    case 0x3d: // =
    case 0x5f: // _
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

function goAllowsFor(mode: GoEscapeMode): (code: number) => boolean {
  switch (mode) {
    case "path":
      return goPathAllows;
    case "fragment":
      return goFragmentAllows;
    case "host":
      return goHostAllows;
    default:
      return goUserinfoAllows;
  }
}

function goEscapeBytes(
  bytes: Buffer,
  allows: (code: number) => boolean,
): string {
  let out = "";
  for (const byte of bytes) {
    if (allows(byte)) {
      out += String.fromCharCode(byte);
      continue;
    }
    out += `%${GO_HEX.charAt(byte >> 4)}${GO_HEX.charAt(byte & 0x0f)}`;
  }
  return out;
}

function goUnescape(value: string, mode: GoEscapeMode): Buffer | null {
  const bytes = Buffer.from(value, "utf8");
  const out: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const byte = goByte(bytes, index);
    if (byte === 0x25) {
      if (index + 2 >= bytes.length) return null;
      const high = goByte(bytes, index + 1);
      const low = goByte(bytes, index + 2);
      if (!goIsHexByte(high) || !goIsHexByte(low)) return null;
      const decoded = (goUnhex(high) << 4) | goUnhex(low);
      const escaped = high === 0x32 && low === 0x35;
      if (mode === "host" && decoded < 0x80 && !escaped) return null;
      out.push(decoded);
      index += 3;
      continue;
    }
    if (mode === "host" && byte < 0x80 && !goHostAllows(byte)) return null;
    out.push(byte);
    index += 1;
  }
  return Buffer.from(out);
}

function goValidEncoded(value: string, mode: GoEscapeMode): boolean {
  const allows = goAllowsFor(mode);
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = goByte(bytes, index);
    if (byte === 0x25) {
      if (
        index + 2 >= bytes.length ||
        !goIsHexByte(goByte(bytes, index + 1)) ||
        !goIsHexByte(goByte(bytes, index + 2))
      ) {
        return false;
      }
      index += 2;
      continue;
    }
    if (GO_ENCODED_LITERALS.has(byte)) continue;
    if (!allows(byte)) return false;
  }
  return true;
}

function trimTrailingSlashBytes(bytes: Buffer): Buffer {
  let end = bytes.length;
  while (end > 0 && goByte(bytes, end - 1) === 0x2f) {
    end -= 1;
  }
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

function splitURLScheme(
  value: string,
): { scheme: string; rest: string } | null {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isASCIILetter(code)) continue;
    if (index > 0 && isSchemeTail(code)) continue;
    if (index > 0 && code === 0x3a) {
      const scheme = value.slice(0, index).toLowerCase();
      return { scheme, rest: value.slice(index + 1) };
    }
    return null;
  }
  return null;
}

function isASCIILetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSchemeTail(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  return code === 0x2b || code === 0x2d || code === 0x2e;
}

function validOptionalPort(value: string): boolean {
  if (value === "") return true;
  if (!value.startsWith(":")) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function isIPLiteral(value: string): boolean {
  if (!value.includes(":")) return false;
  if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)) return false;
  return /^[0-9A-Fa-f:.]+$/u.test(value);
}

function hostIsValid(host: string): boolean {
  const openBracket = host.lastIndexOf("[");
  if (openBracket > 0) return false;
  if (openBracket === 0) {
    const closeBracket = host.lastIndexOf("]");
    if (closeBracket < 0) return false;
    if (!validOptionalPort(host.slice(closeBracket + 1))) return false;
    if (!isIPLiteral(host.slice(1, closeBracket))) return false;
    return goUnescape(host, "host") !== null;
  }
  const separator = host.indexOf(":");
  if (separator >= 0 && !validOptionalPort(host.slice(separator))) {
    return false;
  }
  return goUnescape(host, "host") !== null;
}

function userinfoIsValid(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) continue;
    if (code >= 0x41 && code <= 0x5a) continue;
    if (code >= 0x61 && code <= 0x7a) continue;
    switch (code) {
      case 0x21: // !
      case 0x24: // $
      case 0x25: // %
      case 0x26: // &
      case 0x27: // '
      case 0x28: // (
      case 0x29: // )
      case 0x2a: // *
      case 0x2b: // +
      case 0x2c: // ,
      case 0x2d: // -
      case 0x2e: // .
      case 0x3a: // :
      case 0x3b: // ;
      case 0x3d: // =
      case 0x40: // @
      case 0x5f: // _
      case 0x7e: // ~
        continue;
      default:
        return false;
    }
  }
  return true;
}

function encodeUserinfo(raw: string): string | null {
  const separator = raw.indexOf(":");
  if (separator < 0) {
    const username = goUnescape(raw, "userinfo");
    return username === null ? null : goEscapeBytes(username, goUserinfoAllows);
  }
  const username = goUnescape(raw.slice(0, separator), "userinfo");
  const password = goUnescape(raw.slice(separator + 1), "userinfo");
  if (username === null || password === null) return null;
  const encodedUsername = goEscapeBytes(username, goUserinfoAllows);
  const encodedPassword = goEscapeBytes(password, goUserinfoAllows);
  return `${encodedUsername}:${encodedPassword}`;
}

function parseAuthority(value: string): GoAuthority | null {
  const at = value.lastIndexOf("@");
  const host = at < 0 ? value : value.slice(at + 1);
  if (host === "" || !hostIsValid(host)) return null;
  if (at < 0) return { host, userinfo: null };
  const raw = value.slice(0, at);
  if (!userinfoIsValid(raw)) return null;
  const userinfo = encodeUserinfo(raw);
  if (userinfo === null) return null;
  return { host, userinfo };
}

function joinURLPath(base: string, suffix: string): string {
  const left = trimTrailingSlash(String(base ?? ""));
  const right = trimLeadingAndTrailingSlashes(String(suffix ?? ""));
  if (!left && !right) return "/";
  if (!left) return `/${right}`;
  if (!right) return left || "/";
  return `${left}/${right}`;
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

export {
  bootstrapOidcDiscovery,
  newJwksValidator,
  type JWKSValidatorOptions,
} from "./jwks.js";

export * from "./provider.js";
export * from "./store.js";
