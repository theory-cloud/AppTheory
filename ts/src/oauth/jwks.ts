import { Buffer } from "node:buffer";
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import type { Context } from "../context.js";

import {
  ERR_BEARER_TOKEN_EXPIRED,
  ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
  ERR_BEARER_TOKEN_INVALID_AUDIENCE,
  ERR_INVALID_BEARER_TOKEN,
  OAuthBearerError,
  type BearerTokenClaims,
  type BearerTokenClaimsValidator,
} from "./index.js";

const ERROR_PREFIX = "jwks:";

/**
 * The only JWS algorithm this validator accepts. The algorithm is pinned rather
 * than negotiated so an RSA public key can never be reinterpreted as an HMAC
 * secret (algorithm confusion).
 */
const ACCESS_TOKEN_ALGORITHM = "RS256";
const VERIFY_ALGORITHM = "RSA-SHA256";
const SIGNING_KEY_USE = "sig";

/** Bounds every discovery and JWKS response body. */
const MAX_DOCUMENT_BYTES = 1 << 20;
/** Bounds the number of keys accepted from one JWKS document. */
const MAX_KEYS = 64;

const DEFAULT_CACHE_TTL_SECONDS = 900;
const DEFAULT_REFRESH_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_REFRESH_PER_KID = 1;
/** Framework default bound on one discovery or JWKS fetch, shared with Go and Python. */
export const DEFAULT_FETCH_TIMEOUT_SECONDS = 10;
/** Framework default bound on a token `kid`'s length, shared with Go and Python. */
export const DEFAULT_MAX_KID_LENGTH = 256;
/** Framework default bound on a validator's distinct `kid` resolution windows. */
export const DEFAULT_MAX_WINDOW_ENTRIES = 1024;
/** Framework default bound on a validator's cached signing keys. */
export const DEFAULT_MAX_KEY_ENTRIES = 128;
/** Framework default bound on key-set fetches inside one unknown-kid fetch window. */
export const DEFAULT_MAX_UNKNOWN_KID_FETCHES = 32;
/** Framework default length, in seconds, of the unknown-kid fetch budget window. */
export const DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS = 60;

export interface JWKSValidatorOptions {
  /**
   * Required. The expected token issuer; every accepted token's `iss` must
   * canonicalize to it.
   */
  issuer: string;
  /**
   * Absolute HTTPS JSON Web Key Set URL; when absent, `discoveryUrl`
   * bootstraps it.
   */
  jwksUri?: string;
  /**
   * Absolute HTTPS OIDC discovery document URL. It is consulted only when
   * `jwksUri` is absent, and its document issuer must equal `issuer` before its
   * `jwks_uri` is trusted.
   */
  discoveryUrl?: string;
  /** Injectable fetch, used by tests to serve keys without network egress. */
  fetchImpl?: typeof fetch;
  /**
   * Disables the non-public-host check. Off by default; the framework never
   * enables it. Local development and the loopback test suites opt in.
   */
  allowPrivateHosts?: boolean;
  /** Overrides the clock used for `exp`/`nbf`, cache expiry, and cooldown. */
  now?: () => Date;
  /** Tolerance applied to `exp` and `nbf`. */
  clockSkewSeconds?: number;
  /**
   * Bounds one discovery or JWKS fetch. Zero or absent means the framework
   * default of 10 seconds (`DEFAULT_FETCH_TIMEOUT_SECONDS`), shared with the Go
   * and Python validators.
   */
  fetchTimeoutSeconds?: number;
  /** How long a fetched key stays usable before a refresh. Zero means default. */
  cacheTtlSeconds?: number;
  /**
   * Bounds how often one unknown `kid` may trigger fetches. Zero means default.
   */
  refreshCooldownSeconds?: number;
  /**
   * Bounds the refresh fetches a single unknown `kid` may trigger beyond the
   * fetch that populates the cache. Zero means the default of 1.
   */
  maxRefreshPerKid?: number;
  /**
   * Bounds the length of a token `kid` this validator resolves. A longer `kid`
   * is refused as unknown without a fetch or any state change, and document
   * entries with a longer `kid` are not cached. Zero or absent means the
   * framework default of 256.
   */
  maxKidLength?: number;
  /**
   * Bounds the distinct `kid` resolution windows held by one validator; a full
   * map evicts its oldest window first. Zero or absent means the framework
   * default of 1024.
   */
  maxWindowEntries?: number;
  /**
   * Bounds the signing keys cached by one validator; the cache evicts the
   * earliest-expiring entry first. Zero or absent means the framework default
   * of 128.
   */
  maxKeyEntries?: number;
  /**
   * Bounds the key-set fetches triggered by unknown-`kid` resolution inside one
   * unknown-kid fetch window. Zero or absent means the framework default of 32.
   */
  maxUnknownKidFetches?: number;
  /**
   * Length in seconds of the global unknown-`kid` fetch budget window. Zero or
   * absent means the framework default of 60.
   */
  unknownKidFetchWindowSeconds?: number;
  /** Exact-match `azp`/`client_id` allow-list; empty disables the check. */
  allowedAzp?: string[];
  /**
   * Derives the route-bound audience for the matched route. A non-empty result
   * must equal one `aud` entry exactly; there is no substring or wildcard match.
   */
  requiredAudience?: string | ((ctx: Context) => string | Promise<string>);
  /**
   * Derives the route-bound scope set for the matched route. Every entry must be
   * present in the token.
   */
  requiredScopes?: string[] | ((ctx: Context) => string[] | Promise<string[]>);
}

interface ParsedJWS {
  alg: string;
  kid: string;
  signingInput: Buffer;
  signature: Buffer;
  payload: Record<string, unknown>;
}

interface CachedKey {
  key: KeyObject;
  expiresAt: number;
}

interface JWKSClaims {
  issuer: string;
  subject: string;
  audience: string[];
  scopes: string[];
  azp: string;
  clientId: string;
  hasExpiry: boolean;
  expiresAt: number;
  hasNotBefore: boolean;
  notBefore: number;
}

/**
 * Fetches the OIDC discovery document at `discoveryUrl`, verifies that its
 * `issuer` equals `issuer`, and returns the document's `jwks_uri`. The
 * discovery URL and the returned key-set URL must both be absolute HTTPS URLs;
 * a document that omits `jwks_uri`, an issuer mismatch, and any redirect all
 * fail closed. The fetch is bounded by `timeoutSeconds`, which defaults to the
 * shared framework default.
 */
export async function bootstrapOidcDiscovery(
  discoveryUrl: string,
  issuer: string,
  fetchImpl?: typeof fetch,
  timeoutSeconds: number = DEFAULT_FETCH_TIMEOUT_SECONDS,
): Promise<string> {
  const configuredIssuer = canonicalIssuer(issuer);
  if (!configuredIssuer) {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: configured issuer must be an absolute URL`,
    );
  }
  const requestUrl = secureURL(discoveryUrl, "discovery url");
  const document = await fetchDocument(
    requestUrl,
    fetchImpl ?? frameworkFetch(),
    "discovery",
    positiveSeconds(timeoutSeconds, DEFAULT_FETCH_TIMEOUT_SECONDS) * 1000,
  );
  const documentIssuer = canonicalIssuer(stringClaim(document, "issuer"));
  if (!documentIssuer || documentIssuer !== configuredIssuer) {
    throw new Error(
      `${ERROR_PREFIX} issuer_mismatch: discovery issuer does not match the configured issuer`,
    );
  }
  const jwksUri = stringClaim(document, "jwks_uri").trim();
  if (!jwksUri) {
    throw new Error(
      `${ERROR_PREFIX} missing_jwks_uri: discovery document omits jwks_uri`,
    );
  }
  return secureURL(jwksUri, "jwks uri").toString();
}

/**
 * Builds a fail-closed RS256/JWKS claims validator.
 *
 * The returned validator resolves signing keys from a bounded `kid` cache that
 * `refreshCooldownSeconds` rate-limits and a global unknown-`kid` fetch budget
 * caps, verifies RSASSA-PKCS1-v1_5/SHA-256
 * signatures, and refuses the request on every doubt: a malformed token, a
 * non-RS256 algorithm, a missing `kid`, an unknown or inconsistent key, a
 * signature mismatch, an issuer mismatch, a missing or expired `exp`, a `nbf`
 * in the future, an audience or scope mismatch, and a disallowed `azp`. It
 * never returns claims for a token it could not fully verify, and it never logs
 * the token or key material.
 */
export async function newJwksValidator(
  options: JWKSValidatorOptions,
): Promise<BearerTokenClaimsValidator> {
  if (!options || typeof options !== "object") {
    throw new Error(`${ERROR_PREFIX} invalid_url: options are required`);
  }
  const configuredIssuer = canonicalIssuer(options.issuer);
  if (!configuredIssuer) {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: jwks validator issuer must be an absolute URL`,
    );
  }
  // Only the framework's own transport carries the non-public-host guard; an
  // injected `fetchImpl` is caller-owned and is never re-plumbed. The
  // `allowPrivateHosts` override drops the guard by not installing it at all.
  const fetchImpl =
    options.fetchImpl ??
    (options.allowPrivateHosts === true ? fetch : frameworkFetch());
  const now = options.now ?? (() => new Date());
  const clockSkewMs = nonNegativeSeconds(options.clockSkewSeconds, 0) * 1000;
  const fetchTimeoutSeconds = positiveSeconds(
    options.fetchTimeoutSeconds,
    DEFAULT_FETCH_TIMEOUT_SECONDS,
  );
  const fetchTimeoutMs = fetchTimeoutSeconds * 1000;
  const cacheTtlSeconds = positiveSeconds(
    options.cacheTtlSeconds,
    DEFAULT_CACHE_TTL_SECONDS,
  );
  const refreshCooldownSeconds = positiveSeconds(
    options.refreshCooldownSeconds,
    DEFAULT_REFRESH_COOLDOWN_SECONDS,
  );
  const maxRefreshPerKid = positiveInteger(
    options.maxRefreshPerKid,
    DEFAULT_MAX_REFRESH_PER_KID,
  );
  const maxKidLength = positiveInteger(
    options.maxKidLength,
    DEFAULT_MAX_KID_LENGTH,
  );
  const maxWindowEntries = positiveInteger(
    options.maxWindowEntries,
    DEFAULT_MAX_WINDOW_ENTRIES,
  );
  const maxKeyEntries = positiveInteger(
    options.maxKeyEntries,
    DEFAULT_MAX_KEY_ENTRIES,
  );
  const maxUnknownKidFetches = positiveInteger(
    options.maxUnknownKidFetches,
    DEFAULT_MAX_UNKNOWN_KID_FETCHES,
  );
  const unknownKidFetchWindowMs =
    positiveSeconds(
      options.unknownKidFetchWindowSeconds,
      DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS,
    ) * 1000;
  const cacheTtlMs = cacheTtlSeconds * 1000;
  const refreshCooldownMs = refreshCooldownSeconds * 1000;
  const azpAllowList = new Set(normalizeClaimValues(options.allowedAzp ?? []));

  const discoveryUrl = String(options.discoveryUrl ?? "").trim();
  if (discoveryUrl) secureURL(discoveryUrl, "discovery url");

  const explicitJwksUri = String(options.jwksUri ?? "").trim();
  let jwksUri: URL;
  if (explicitJwksUri) {
    jwksUri = secureURL(explicitJwksUri, "jwks uri");
  } else if (discoveryUrl) {
    jwksUri = new URL(
      await bootstrapOidcDiscovery(
        discoveryUrl,
        configuredIssuer,
        fetchImpl,
        fetchTimeoutSeconds,
      ),
    );
  } else {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: jwks validator requires a jwks uri or a discovery url`,
    );
  }

  const keys = new Map<string, CachedKey>();
  const windows = new Map<string, number>();
  let fetchBudgetWindowStart = Number.NEGATIVE_INFINITY;
  let fetchBudgetUsed = 0;
  let inFlightRefresh: Promise<void> | null = null;

  /**
   * Consumes one unit of the global unknown-`kid` fetch budget. The window
   * resets once `unknownKidFetchWindowMs` has elapsed since it opened; when the
   * budget is exhausted the caller must fail closed without fetching, so a
   * stream of distinct attacker-chosen kids cannot amplify token traffic into
   * unbounded key-set traffic.
   */
  const takeFetchBudget = (at: number): boolean => {
    if (at - fetchBudgetWindowStart >= unknownKidFetchWindowMs) {
      fetchBudgetWindowStart = at;
      fetchBudgetUsed = 0;
    }
    if (fetchBudgetUsed >= maxUnknownKidFetches) return false;
    fetchBudgetUsed += 1;
    return true;
  };

  /**
   * Drops cache entries whose expiry has passed, then evicts the
   * earliest-expiring entry until the cache holds at most `maxKeyEntries`
   * entries, so the cache stays bounded however many keys are published.
   */
  const pruneKeys = (at: number): void => {
    for (const [kid, entry] of keys) {
      if (at >= entry.expiresAt) keys.delete(kid);
    }
    while (keys.size > maxKeyEntries) {
      let victim: string | undefined;
      let earliest = Number.POSITIVE_INFINITY;
      for (const [kid, entry] of keys) {
        if (entry.expiresAt < earliest) {
          earliest = entry.expiresAt;
          victim = kid;
        }
      }
      if (victim === undefined) break;
      keys.delete(victim);
    }
  };

  /**
   * Fetches and stores the key set once, returning false when the global
   * unknown-`kid` fetch budget refuses the fetch. A caller that joins an
   * already-started refresh consumes no additional budget unit. Document entries
   * with an oversized `kid` are never cached.
   */
  const refresh = async (at: number): Promise<boolean> => {
    if (inFlightRefresh) {
      await inFlightRefresh;
      return true;
    }
    if (!takeFetchBudget(at)) return false;
    const pending = (async (): Promise<void> => {
      const document = await fetchDocument(
        jwksUri,
        fetchImpl,
        "jwks",
        fetchTimeoutMs,
      );
      const published = document["keys"];
      if (!Array.isArray(published) || published.length === 0) {
        throw new Error(
          `${ERROR_PREFIX} document_invalid: jwks document must carry a non-empty keys array`,
        );
      }
      if (published.length > MAX_KEYS) {
        throw new Error(
          `${ERROR_PREFIX} too_many_keys: jwks document exceeds the maximum key count`,
        );
      }
      const imported = new Map<string, KeyObject>();
      for (const raw of published) {
        const entry = importSigningKey(raw);
        if (
          entry &&
          entry.kid.length <= maxKidLength &&
          !imported.has(entry.kid)
        ) {
          imported.set(entry.kid, entry.key);
        }
      }
      for (const [kid, key] of imported) {
        // Re-store at the tail so every refresh orders the cache by the
        // document's key order, which keeps eviction deterministic.
        keys.delete(kid);
        keys.set(kid, { key, expiresAt: at + cacheTtlMs });
      }
      pruneKeys(at);
    })();
    inFlightRefresh = pending;
    try {
      await pending;
    } finally {
      inFlightRefresh = null;
    }
    return true;
  };

  /**
   * Records the resolution window for `kid`. Entries older than the refresh
   * cooldown are dropped, and a full map evicts its oldest entry first, so the
   * map never holds more than `maxWindowEntries` entries however many distinct
   * attacker-chosen kids arrive.
   */
  const recordWindow = (kid: string, at: number): void => {
    for (const [existing, startedAt] of windows) {
      if (at - startedAt >= refreshCooldownMs) windows.delete(existing);
    }
    if (windows.size >= maxWindowEntries) {
      let victim: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [existing, startedAt] of windows) {
        if (startedAt < oldest) {
          oldest = startedAt;
          victim = existing;
        }
      }
      if (victim !== undefined) windows.delete(victim);
    }
    windows.set(kid, at);
  };

  const cachedKey = (kid: string, at: number): KeyObject | null => {
    const entry = keys.get(kid);
    if (!entry || at >= entry.expiresAt) return null;
    return entry.key;
  };

  /**
   * Resolves a signing key for `kid` from the bounded cache. A `kid` longer than
   * `maxKidLength` is refused as unknown without touching any map and without a
   * fetch. An unknown `kid` opens one resolution window per
   * `refreshCooldownSeconds`: the first fetch populates the cache and up to
   * `maxRefreshPerKid` further fetches absorb key publication lag. Every further
   * unknown-`kid` token inside the cooldown is rejected without another fetch,
   * and the global unknown-`kid` fetch budget caps the fetches distinct kids can
   * trigger, so an attacker cannot amplify token traffic into key-set traffic.
   */
  const keyForKid = async (kid: string): Promise<KeyObject | null> => {
    if (kid.length > maxKidLength) return null;
    const at = now().getTime();
    const cached = cachedKey(kid, at);
    if (cached) return cached;
    const startedAt = windows.get(kid);
    if (startedAt !== undefined && at - startedAt < refreshCooldownMs) {
      return null;
    }
    recordWindow(kid, at);
    for (let attempt = 0; attempt <= maxRefreshPerKid; attempt += 1) {
      if (!(await refresh(at))) return null;
      const found = cachedKey(kid, at);
      if (found) return found;
    }
    return null;
  };

  return async (ctx, token) => {
    const parsed = parseCompactJWS(token);
    if (parsed.alg !== ACCESS_TOKEN_ALGORITHM) {
      throw invalidToken("algorithm_not_allowed");
    }
    if (!parsed.kid) throw invalidToken("missing_kid");
    const claims = parseClaims(parsed.payload);
    // The issuer is checked before the key lookup so a token for another issuer
    // can never steer a fetch, and again after verification so nothing observed
    // before the signature is what authorizes the request.
    checkIssuer(claims.issuer, configuredIssuer);

    let key: KeyObject | null;
    try {
      key = await keyForKid(parsed.kid);
    } catch (err) {
      throw invalidToken(`jwks_unavailable: ${errorMessage(err)}`);
    }
    if (!key) throw invalidToken("unknown_kid");
    if (!verifyRS256(key, parsed.signingInput, parsed.signature)) {
      throw invalidToken("signature_mismatch");
    }

    checkIssuer(claims.issuer, configuredIssuer);
    const at = now().getTime();
    if (!claims.hasExpiry) throw invalidToken("claim_invalid");
    if (at >= claims.expiresAt * 1000 + clockSkewMs) {
      throw new OAuthBearerError(
        ERR_BEARER_TOKEN_EXPIRED,
        `${ERR_BEARER_TOKEN_EXPIRED}: expired`,
      );
    }
    if (claims.hasNotBefore && at + clockSkewMs < claims.notBefore * 1000) {
      throw invalidToken("not_yet_valid");
    }

    const requiredAudience = await resolveAudience(
      ctx,
      options.requiredAudience,
    );
    let audience = requiredAudience;
    if (requiredAudience) {
      if (!claims.audience.includes(requiredAudience)) {
        throw new OAuthBearerError(
          ERR_BEARER_TOKEN_INVALID_AUDIENCE,
          `${ERR_BEARER_TOKEN_INVALID_AUDIENCE}: audience_mismatch`,
        );
      }
    } else {
      audience = claims.audience[0] ?? "";
    }

    const requiredScopes = await resolveScopes(ctx, options.requiredScopes);
    if (missingScopes(claims.scopes, requiredScopes).length > 0) {
      throw new OAuthBearerError(ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE);
    }
    const azp = claims.azp || claims.clientId;
    if (azpAllowList.size > 0 && !azpAllowList.has(azp)) {
      throw invalidToken("azp_not_allowed");
    }

    const result: BearerTokenClaims = {
      subject: claims.subject.trim(),
      audience,
      scopes: [...claims.scopes],
    };
    result.expiresAt = new Date(claims.expiresAt * 1000);
    return result;
  };
}

async function resolveAudience(
  ctx: Context,
  option: JWKSValidatorOptions["requiredAudience"],
): Promise<string> {
  if (typeof option === "function") {
    return String((await option(ctx)) ?? "").trim();
  }
  return String(option ?? "").trim();
}

async function resolveScopes(
  ctx: Context,
  option: JWKSValidatorOptions["requiredScopes"],
): Promise<string[]> {
  if (typeof option === "function") {
    return normalizeClaimValues(await option(ctx));
  }
  return normalizeClaimValues(option ?? []);
}

function checkIssuer(issuer: string, configuredIssuer: string): void {
  if (canonicalIssuer(issuer) !== configuredIssuer) {
    throw invalidToken("issuer_mismatch");
  }
}

function verifyRS256(
  key: KeyObject,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  if (signature.length === 0) return false;
  try {
    return verify(VERIFY_ALGORITHM, signingInput, key, signature);
  } catch {
    return false;
  }
}

function parseCompactJWS(token: string): ParsedJWS {
  const segments = String(token ?? "")
    .trim()
    .split(".");
  if (segments.length !== 3) throw invalidToken("malformed");
  const encodedHeader = segments[0] ?? "";
  const encodedPayload = segments[1] ?? "";
  const encodedSignature = segments[2] ?? "";
  if (!encodedHeader || !encodedPayload) throw invalidToken("malformed");

  const header = decodeJSONSegment(encodedHeader, "malformed");
  if (!header) throw invalidToken("malformed");
  const rawCrit = header["crit"];
  // An unrecognized critical header must fail closed rather than be ignored.
  if (rawCrit !== undefined && rawCrit !== null)
    throw invalidToken("malformed");

  const payload = decodeJSONSegment(encodedPayload, "malformed");
  if (!payload) throw invalidToken("malformed");
  const signature = decodeSegment(encodedSignature, true);
  if (!signature) throw invalidToken("malformed");

  return {
    alg: stringClaim(header, "alg", "malformed").trim(),
    kid: stringClaim(header, "kid", "malformed").trim(),
    signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    signature,
    payload,
  };
}

function parseClaims(payload: Record<string, unknown>): JWKSClaims {
  const scp = parseStringOrStringList(payload["scp"]);
  const scopes = normalizeClaimValues([
    ...splitScope(stringClaim(payload, "scope")),
    ...scp,
  ]);

  const claims: JWKSClaims = {
    issuer: stringClaim(payload, "iss").trim(),
    subject: stringClaim(payload, "sub"),
    audience: parseAudience(payload["aud"]),
    scopes,
    azp: stringClaim(payload, "azp"),
    clientId: stringClaim(payload, "client_id"),
    hasExpiry: false,
    expiresAt: 0,
    hasNotBefore: false,
    notBefore: 0,
  };

  const exp = numericClaim(payload, "exp");
  if (exp.present) {
    if (exp.value === null) throw invalidToken("claim_invalid");
    claims.hasExpiry = true;
    claims.expiresAt = exp.value;
  }
  const nbf = numericClaim(payload, "nbf");
  if (nbf.present) {
    if (nbf.value === null) throw invalidToken("claim_invalid");
    claims.hasNotBefore = true;
    claims.notBefore = nbf.value;
  }
  return claims;
}

function parseAudience(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return normalizeClaimValues(parseStringList(raw));
  if (typeof raw === "string") return normalizeClaimValues([raw]);
  throw invalidToken("claim_invalid");
}

function parseStringOrStringList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return normalizeClaimValues(parseStringList(raw));
  if (typeof raw === "string") return normalizeClaimValues([raw]);
  throw invalidToken("claim_invalid");
}

function parseStringList(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw invalidToken("claim_invalid");
    out.push(value);
  }
  return out;
}

function numericClaim(
  payload: Record<string, unknown>,
  name: string,
): { present: boolean; value: number | null } {
  const raw = payload[name];
  if (raw === undefined || raw === null) return { present: false, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { present: true, value: null };
  }
  return { present: true, value: raw };
}

function splitScope(scope: string): string[] {
  return scope.split(/\s+/u);
}

function missingScopes(got: string[], required: string[]): string[] {
  const seen = new Set(got);
  return required.filter((scope) => !seen.has(scope));
}

function importSigningKey(
  raw: unknown,
): { kid: string; key: KeyObject } | null {
  if (!isRecord(raw)) return null;
  const kid = keyStringField(raw, "kid").trim();
  if (!kid) return null;
  if (keyStringField(raw, "kty").toUpperCase() !== "RSA") return null;
  const alg = keyStringField(raw, "alg").trim();
  if (alg && alg !== ACCESS_TOKEN_ALGORITHM) return null;
  const use = keyStringField(raw, "use").trim();
  if (use && use.toUpperCase() !== SIGNING_KEY_USE.toUpperCase()) return null;
  try {
    return { kid, key: createPublicKey({ key: raw, format: "jwk" }) };
  } catch {
    return null;
  }
}

/**
 * Reads a JWKS member. A present non-string member is a malformed document
 * rather than a skippable key, matching the document-level decode the Go
 * validation performs before any key is trusted.
 */
function keyStringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error(
      `${ERROR_PREFIX} document_invalid: jwks member ${name} must be a string`,
    );
  }
  return value;
}

async function fetchDocument(
  url: URL,
  fetchImpl: typeof fetch,
  label: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await withFetchTimeout(
      async (signal) =>
        await fetchImpl(url.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal,
        }),
      timeoutMs,
    );
  } catch (err) {
    // A framed refusal from the framework transport (the non-public-host
    // guard) is a first-class rejection, not a fetch failure, so its reason
    // survives to the caller instead of being flattened.
    if (err instanceof OAuthBearerError) throw err;
    throw new Error(
      `${ERROR_PREFIX} discovery_unavailable: ${label} document cannot be fetched`,
      { cause: err },
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw redirectFailure(url, response.headers.get("location") ?? "");
  }
  if (response.status !== 200) {
    throw new Error(
      `${ERROR_PREFIX} discovery_unavailable: ${label} document returned status ${response.status}`,
    );
  }
  const body = await readBoundedBody(response, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `${ERROR_PREFIX} document_invalid: ${label} document is not JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${ERROR_PREFIX} document_invalid: ${label} document must be a JSON object`,
    );
  }
  return parsed;
}

/**
 * Races `run` against a timeout so the caller is bounded even when an injected
 * `fetchImpl` ignores the abort signal. The signal is still handed to `run` so a
 * real `fetch` stops early. The timeout is unref'd so a pending timer never
 * keeps the process (or a test run) alive.
 */
async function withFetchTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `${ERROR_PREFIX} fetch_timeout: document fetch exceeded the timeout`,
        ),
      );
    }, timeoutMs);
    // Never keep the Node process (or a test run) alive for a pending timeout.
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reads a document body while enforcing `MAX_DOCUMENT_BYTES`: a streamed body is
 * cancelled as soon as the running total crosses the cap, so oversized content
 * is never buffered whole.
 */
async function readBoundedBody(
  response: Response,
  label: string,
): Promise<string> {
  const tooLarge = (): Error =>
    new Error(
      `${ERROR_PREFIX} response_too_large: ${label} document exceeds the maximum size`,
    );
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
      throw tooLarge();
    }
    return text;
  }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reports why a 3xx response was refused: a redirect that would leave the
 * origin is reported as a cross-origin redirect, every other redirect is a
 * plain failure. Redirects are never followed.
 */
function redirectFailure(requestUrl: URL, location: string): Error {
  const target = location.trim();
  if (!target) {
    return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
  }
  let resolved: URL;
  try {
    resolved = new URL(target, requestUrl);
  } catch {
    return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
  }
  if (resolved.origin !== requestUrl.origin) {
    return new Error(
      `${ERROR_PREFIX} cross_origin_redirect: cross-origin redirect refused`,
    );
  }
  return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
}

function decodeJSONSegment(
  segment: string,
  reason: string,
): Record<string, unknown> | null {
  const decoded = decodeSegment(segment, false);
  if (!decoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalidToken(reason);
  }
  return isRecord(parsed) ? parsed : null;
}

function decodeSegment(segment: string, allowEmpty: boolean): Buffer | null {
  const pattern = allowEmpty ? /^[A-Za-z0-9_-]*$/u : /^[A-Za-z0-9_-]+$/u;
  if (!pattern.test(segment)) return null;
  return Buffer.from(segment, "base64url");
}

function secureURL(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: ${label} must be an absolute URL`,
    );
  }
  if (!url.hostname) {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: ${label} must be an absolute URL`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(`${ERROR_PREFIX} non_https: ${label} must use https`);
  }
  if (url.username || url.password) {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: ${label} must not carry userinfo`,
    );
  }
  if (url.hash) {
    throw new Error(
      `${ERROR_PREFIX} invalid_url: ${label} must not carry a fragment`,
    );
  }
  return url;
}

function canonicalIssuer(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (!url.protocol || !url.host) return null;
  url.pathname = trimTrailingSlashes(url.pathname);
  url.hash = "";
  return url.toString();
}

function trimTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return pathname.slice(0, end);
}

function normalizeClaimValues(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function stringClaim(
  record: Record<string, unknown>,
  name: string,
  reason = "claim_invalid",
): string {
  const value = record[name];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidToken(reason);
  return value;
}

function invalidToken(reason: string): OAuthBearerError {
  return new OAuthBearerError(
    ERR_INVALID_BEARER_TOKEN,
    `${ERR_INVALID_BEARER_TOKEN}: ${reason}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeSeconds(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * The connectivity class of one host address literal. `invalid` is not an
 * address literal at all and is never connectable, so the classifier fails
 * closed. The classes are shared with the Go and Python validators through the
 * discovery-bootstrap contract fixture's `host_guard` table.
 */
export type HostAddressClass =
  | "loopback"
  | "link_local"
  | "private"
  | "unspecified"
  | "multicast"
  | "public"
  | "invalid";

/**
 * Classifies one IP address literal. An IPv4-mapped IPv6 address is classified
 * by the IPv4 address it maps to, so `::ffff:127.0.0.1` is loopback. Refused
 * classes are loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`,
 * `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 * `fc00::/7`), unspecified (`0.0.0.0`, `::`), and multicast (`224.0.0.0/4`,
 * `ff00::/8`); everything else is public.
 */
export function classifyHostAddress(address: string): HostAddressClass {
  const text = String(address ?? "").trim();
  const family = isIP(text);
  if (family === 4) {
    const octets = ipv4Octets(text);
    return octets ? classifyIpv4Octets(octets) : "invalid";
  }
  if (family === 6) {
    const bytes = ipv6Bytes(text);
    return bytes ? classifyIpv6Bytes(bytes) : "invalid";
  }
  return "invalid";
}

/** Reports whether one host address literal may be connected to. */
export function isPublicHostAddress(address: string): boolean {
  return classifyHostAddress(address) === "public";
}

/** The refusal phrase every runtime's non-public-host failure carries. */
const NON_PUBLIC_HOST_PHRASE = "not a public address";

function nonPublicHostError(subject: string): OAuthBearerError {
  return new OAuthBearerError(
    ERR_INVALID_BEARER_TOKEN,
    `${ERROR_PREFIX} non_public_host: ${subject} is ${NON_PUBLIC_HOST_PHRASE}`,
  );
}

/**
 * The framework's own document transport, and the only place the
 * non-public-host guard is installed.
 *
 * The guard runs inside `lookup`, on the addresses the name actually resolved
 * to, and Node connects to the address `lookup` hands back. Resolving,
 * checking, and connecting are therefore one step, so there is no window in
 * which a name could resolve to a public address for the check and to a
 * non-public one for the connection. TLS keeps its defaults: the request
 * carries the original URL, so the certificate is still verified against the
 * URL's host name even though the socket connects to an address of that name.
 */
function frameworkFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const literal = urlIpLiteral(url);
    if (literal && !isPublicHostAddress(literal)) {
      throw nonPublicHostError(literal);
    }
    const options: RequestOptions = {
      method: "GET",
      headers: { accept: "application/json" },
      lookup: guardedLookup,
    };
    const signal = init?.signal;
    if (signal) options.signal = signal;
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(url, options, (response) => {
        try {
          resolve(buildFetchResponse(response));
        } catch (err) {
          response.resume();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      request.on("error", (err: Error) => {
        reject(err);
      });
      request.end();
    });
  };
}

/**
 * Resolves a name and hands back only public addresses. When none survives,
 * the request is refused with the guard's message before any socket is
 * opened, so a name that resolves to a non-public address is never connected
 * to.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }
    const allowed = addresses.filter((entry) =>
      isPublicHostAddress(entry.address),
    );
    if (allowed.length === 0) {
      callback(nonPublicHostError(hostname), []);
      return;
    }
    if (options.all === true) {
      callback(null, allowed);
      return;
    }
    const first = allowed[0];
    if (!first) {
      callback(nonPublicHostError(hostname), []);
      return;
    }
    callback(null, first.address, first.family);
  });
};

/**
 * Returns the URL's host when it is already an IP address literal, and an
 * empty string when it is a name. Node skips `lookup` for a literal, so a
 * literal host has to be classified here as well.
 */
function urlIpLiteral(url: URL): string {
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return isIP(host) === 0 ? "" : host;
}

/**
 * Adapts a Node response to the web `Response` shape the document reader
 * expects: `status`, `headers.get`, and a `body` web `ReadableStream`.
 */
function buildFetchResponse(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk);
      });
      response.on("end", () => {
        controller.close();
      });
      response.on("error", (err: Error) => {
        controller.error(err);
      });
    },
    cancel(reason: unknown) {
      response.destroy(reason instanceof Error ? reason : undefined);
    },
  });
  return new Response(body, { status: response.statusCode ?? 502, headers });
}

function classifyIpv4Octets(octets: readonly number[]): HostAddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ) {
    return "private";
  }
  if (a === 0 && b === 0 && c === 0 && d === 0) return "unspecified";
  if (a >= 224 && a <= 239) return "multicast";
  return "public";
}

function classifyIpv6Bytes(raw: Uint8Array): HostAddressClass {
  const bytes = [...raw];
  const at = (index: number): number => bytes[index] ?? 0;
  if (
    at(10) === 0xff &&
    at(11) === 0xff &&
    bytes.slice(0, 10).every((value) => value === 0)
  ) {
    return classifyIpv4Octets([at(12), at(13), at(14), at(15)]);
  }
  if (bytes.every((value) => value === 0)) return "unspecified";
  if (at(15) === 1 && bytes.slice(0, 15).every((value) => value === 0)) {
    return "loopback";
  }
  const first = at(0);
  const second = at(1);
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link_local";
  if ((first & 0xfe) === 0xfc) return "private";
  if (first === 0xff) return "multicast";
  return "public";
}

function ipv4Octets(text: string): number[] | null {
  const pieces = text.split(".");
  if (pieces.length !== 4) return null;
  const octets: number[] = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/u.test(piece)) return null;
    const value = Number.parseInt(piece, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? 0;
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups, handling `::`
 * compression and an embedded IPv4 tail such as `::ffff:127.0.0.1`. A zone
 * index is stripped; the caller has already validated the literal with
 * `isIP`.
 */
function ipv6Groups(address: string): number[] | null {
  const zone = address.indexOf("%");
  const text = zone === -1 ? address : address.slice(0, zone);
  const marker = text.indexOf("::");
  if (marker !== -1 && text.slice(marker + 2).includes("::")) return null;
  const headText = marker === -1 ? text : text.slice(0, marker);
  const tailText = marker === -1 ? "" : text.slice(marker + 2);
  const head = ipv6GroupList(headText);
  const tail = ipv6GroupList(tailText);
  if (!head || !tail) return null;
  if (marker === -1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  const groups = [...head];
  for (let index = 0; index < fill; index += 1) groups.push(0);
  groups.push(...tail);
  return groups;
}

function ipv6GroupList(part: string): number[] | null {
  if (part === "") return [];
  const pieces = part.split(":");
  const groups: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";
    if (index === pieces.length - 1 && piece.includes(".")) {
      const octets = ipv4Octets(piece);
      if (!octets) return null;
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      groups.push((a << 8) | b, (c << 8) | d);
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/u.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}
