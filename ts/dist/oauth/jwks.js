import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { ERR_BEARER_TOKEN_EXPIRED, ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE, ERR_BEARER_TOKEN_INVALID_AUDIENCE, ERR_INVALID_BEARER_TOKEN, OAuthBearerError, } from "./index.js";
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
/**
 * Fetches the OIDC discovery document at `discoveryUrl`, verifies that its
 * `issuer` equals `issuer`, and returns the document's `jwks_uri`. The
 * discovery URL and the returned key-set URL must both be absolute HTTPS URLs;
 * a document that omits `jwks_uri`, an issuer mismatch, and any redirect all
 * fail closed. The fetch is bounded by `timeoutSeconds`, which defaults to the
 * shared framework default.
 */
export async function bootstrapOidcDiscovery(discoveryUrl, issuer, fetchImpl, timeoutSeconds = DEFAULT_FETCH_TIMEOUT_SECONDS) {
    const configuredIssuer = canonicalIssuer(issuer);
    if (!configuredIssuer) {
        throw new Error(`${ERROR_PREFIX} invalid_url: configured issuer must be an absolute URL`);
    }
    const requestUrl = secureURL(discoveryUrl, "discovery url");
    const document = await fetchDocument(requestUrl, fetchImpl ?? fetch, "discovery", positiveSeconds(timeoutSeconds, DEFAULT_FETCH_TIMEOUT_SECONDS) * 1000);
    const documentIssuer = canonicalIssuer(stringClaim(document, "issuer"));
    if (!documentIssuer || documentIssuer !== configuredIssuer) {
        throw new Error(`${ERROR_PREFIX} issuer_mismatch: discovery issuer does not match the configured issuer`);
    }
    const jwksUri = stringClaim(document, "jwks_uri").trim();
    if (!jwksUri) {
        throw new Error(`${ERROR_PREFIX} missing_jwks_uri: discovery document omits jwks_uri`);
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
export async function newJwksValidator(options) {
    if (!options || typeof options !== "object") {
        throw new Error(`${ERROR_PREFIX} invalid_url: options are required`);
    }
    const configuredIssuer = canonicalIssuer(options.issuer);
    if (!configuredIssuer) {
        throw new Error(`${ERROR_PREFIX} invalid_url: jwks validator issuer must be an absolute URL`);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? (() => new Date());
    const clockSkewMs = nonNegativeSeconds(options.clockSkewSeconds, 0) * 1000;
    const fetchTimeoutSeconds = positiveSeconds(options.fetchTimeoutSeconds, DEFAULT_FETCH_TIMEOUT_SECONDS);
    const fetchTimeoutMs = fetchTimeoutSeconds * 1000;
    const cacheTtlSeconds = positiveSeconds(options.cacheTtlSeconds, DEFAULT_CACHE_TTL_SECONDS);
    const refreshCooldownSeconds = positiveSeconds(options.refreshCooldownSeconds, DEFAULT_REFRESH_COOLDOWN_SECONDS);
    const maxRefreshPerKid = positiveInteger(options.maxRefreshPerKid, DEFAULT_MAX_REFRESH_PER_KID);
    const maxKidLength = positiveInteger(options.maxKidLength, DEFAULT_MAX_KID_LENGTH);
    const maxWindowEntries = positiveInteger(options.maxWindowEntries, DEFAULT_MAX_WINDOW_ENTRIES);
    const maxKeyEntries = positiveInteger(options.maxKeyEntries, DEFAULT_MAX_KEY_ENTRIES);
    const maxUnknownKidFetches = positiveInteger(options.maxUnknownKidFetches, DEFAULT_MAX_UNKNOWN_KID_FETCHES);
    const unknownKidFetchWindowMs = positiveSeconds(options.unknownKidFetchWindowSeconds, DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS) * 1000;
    const cacheTtlMs = cacheTtlSeconds * 1000;
    const refreshCooldownMs = refreshCooldownSeconds * 1000;
    const azpAllowList = new Set(normalizeClaimValues(options.allowedAzp ?? []));
    const discoveryUrl = String(options.discoveryUrl ?? "").trim();
    if (discoveryUrl)
        secureURL(discoveryUrl, "discovery url");
    const explicitJwksUri = String(options.jwksUri ?? "").trim();
    let jwksUri;
    if (explicitJwksUri) {
        jwksUri = secureURL(explicitJwksUri, "jwks uri");
    }
    else if (discoveryUrl) {
        jwksUri = new URL(await bootstrapOidcDiscovery(discoveryUrl, configuredIssuer, fetchImpl, fetchTimeoutSeconds));
    }
    else {
        throw new Error(`${ERROR_PREFIX} invalid_url: jwks validator requires a jwks uri or a discovery url`);
    }
    const keys = new Map();
    const windows = new Map();
    let fetchBudgetWindowStart = Number.NEGATIVE_INFINITY;
    let fetchBudgetUsed = 0;
    let inFlightRefresh = null;
    /**
     * Consumes one unit of the global unknown-`kid` fetch budget. The window
     * resets once `unknownKidFetchWindowMs` has elapsed since it opened; when the
     * budget is exhausted the caller must fail closed without fetching, so a
     * stream of distinct attacker-chosen kids cannot amplify token traffic into
     * unbounded key-set traffic.
     */
    const takeFetchBudget = (at) => {
        if (at - fetchBudgetWindowStart >= unknownKidFetchWindowMs) {
            fetchBudgetWindowStart = at;
            fetchBudgetUsed = 0;
        }
        if (fetchBudgetUsed >= maxUnknownKidFetches)
            return false;
        fetchBudgetUsed += 1;
        return true;
    };
    /**
     * Drops cache entries whose expiry has passed, then evicts the
     * earliest-expiring entry until the cache holds at most `maxKeyEntries`
     * entries, so the cache stays bounded however many keys are published.
     */
    const pruneKeys = (at) => {
        for (const [kid, entry] of keys) {
            if (at >= entry.expiresAt)
                keys.delete(kid);
        }
        while (keys.size > maxKeyEntries) {
            let victim;
            let earliest = Number.POSITIVE_INFINITY;
            for (const [kid, entry] of keys) {
                if (entry.expiresAt < earliest) {
                    earliest = entry.expiresAt;
                    victim = kid;
                }
            }
            if (victim === undefined)
                break;
            keys.delete(victim);
        }
    };
    /**
     * Fetches and stores the key set once, returning false when the global
     * unknown-`kid` fetch budget refuses the fetch. A caller that joins an
     * already-started refresh consumes no additional budget unit. Document entries
     * with an oversized `kid` are never cached.
     */
    const refresh = async (at) => {
        if (inFlightRefresh) {
            await inFlightRefresh;
            return true;
        }
        if (!takeFetchBudget(at))
            return false;
        const pending = (async () => {
            const document = await fetchDocument(jwksUri, fetchImpl, "jwks", fetchTimeoutMs);
            const published = document["keys"];
            if (!Array.isArray(published) || published.length === 0) {
                throw new Error(`${ERROR_PREFIX} document_invalid: jwks document must carry a non-empty keys array`);
            }
            if (published.length > MAX_KEYS) {
                throw new Error(`${ERROR_PREFIX} too_many_keys: jwks document exceeds the maximum key count`);
            }
            const imported = new Map();
            for (const raw of published) {
                const entry = importSigningKey(raw);
                if (entry &&
                    entry.kid.length <= maxKidLength &&
                    !imported.has(entry.kid)) {
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
        }
        finally {
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
    const recordWindow = (kid, at) => {
        for (const [existing, startedAt] of windows) {
            if (at - startedAt >= refreshCooldownMs)
                windows.delete(existing);
        }
        if (windows.size >= maxWindowEntries) {
            let victim;
            let oldest = Number.POSITIVE_INFINITY;
            for (const [existing, startedAt] of windows) {
                if (startedAt < oldest) {
                    oldest = startedAt;
                    victim = existing;
                }
            }
            if (victim !== undefined)
                windows.delete(victim);
        }
        windows.set(kid, at);
    };
    const cachedKey = (kid, at) => {
        const entry = keys.get(kid);
        if (!entry || at >= entry.expiresAt)
            return null;
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
    const keyForKid = async (kid) => {
        if (kid.length > maxKidLength)
            return null;
        const at = now().getTime();
        const cached = cachedKey(kid, at);
        if (cached)
            return cached;
        const startedAt = windows.get(kid);
        if (startedAt !== undefined && at - startedAt < refreshCooldownMs) {
            return null;
        }
        recordWindow(kid, at);
        for (let attempt = 0; attempt <= maxRefreshPerKid; attempt += 1) {
            if (!(await refresh(at)))
                return null;
            const found = cachedKey(kid, at);
            if (found)
                return found;
        }
        return null;
    };
    return async (ctx, token) => {
        const parsed = parseCompactJWS(token);
        if (parsed.alg !== ACCESS_TOKEN_ALGORITHM) {
            throw invalidToken("algorithm_not_allowed");
        }
        if (!parsed.kid)
            throw invalidToken("missing_kid");
        const claims = parseClaims(parsed.payload);
        // The issuer is checked before the key lookup so a token for another issuer
        // can never steer a fetch, and again after verification so nothing observed
        // before the signature is what authorizes the request.
        checkIssuer(claims.issuer, configuredIssuer);
        let key;
        try {
            key = await keyForKid(parsed.kid);
        }
        catch (err) {
            throw invalidToken(`jwks_unavailable: ${errorMessage(err)}`);
        }
        if (!key)
            throw invalidToken("unknown_kid");
        if (!verifyRS256(key, parsed.signingInput, parsed.signature)) {
            throw invalidToken("signature_mismatch");
        }
        checkIssuer(claims.issuer, configuredIssuer);
        const at = now().getTime();
        if (!claims.hasExpiry)
            throw invalidToken("claim_invalid");
        if (at >= claims.expiresAt * 1000 + clockSkewMs) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED, `${ERR_BEARER_TOKEN_EXPIRED}: expired`);
        }
        if (claims.hasNotBefore && at + clockSkewMs < claims.notBefore * 1000) {
            throw invalidToken("not_yet_valid");
        }
        const requiredAudience = await resolveAudience(ctx, options.requiredAudience);
        let audience = requiredAudience;
        if (requiredAudience) {
            if (!claims.audience.includes(requiredAudience)) {
                throw new OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE, `${ERR_BEARER_TOKEN_INVALID_AUDIENCE}: audience_mismatch`);
            }
        }
        else {
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
        const result = {
            subject: claims.subject.trim(),
            audience,
            scopes: [...claims.scopes],
        };
        result.expiresAt = new Date(claims.expiresAt * 1000);
        return result;
    };
}
async function resolveAudience(ctx, option) {
    if (typeof option === "function") {
        return String((await option(ctx)) ?? "").trim();
    }
    return String(option ?? "").trim();
}
async function resolveScopes(ctx, option) {
    if (typeof option === "function") {
        return normalizeClaimValues(await option(ctx));
    }
    return normalizeClaimValues(option ?? []);
}
function checkIssuer(issuer, configuredIssuer) {
    if (canonicalIssuer(issuer) !== configuredIssuer) {
        throw invalidToken("issuer_mismatch");
    }
}
function verifyRS256(key, signingInput, signature) {
    if (signature.length === 0)
        return false;
    try {
        return verify(VERIFY_ALGORITHM, signingInput, key, signature);
    }
    catch {
        return false;
    }
}
function parseCompactJWS(token) {
    const segments = String(token ?? "")
        .trim()
        .split(".");
    if (segments.length !== 3)
        throw invalidToken("malformed");
    const encodedHeader = segments[0] ?? "";
    const encodedPayload = segments[1] ?? "";
    const encodedSignature = segments[2] ?? "";
    if (!encodedHeader || !encodedPayload)
        throw invalidToken("malformed");
    const header = decodeJSONSegment(encodedHeader, "malformed");
    if (!header)
        throw invalidToken("malformed");
    const rawCrit = header["crit"];
    // An unrecognized critical header must fail closed rather than be ignored.
    if (rawCrit !== undefined && rawCrit !== null)
        throw invalidToken("malformed");
    const payload = decodeJSONSegment(encodedPayload, "malformed");
    if (!payload)
        throw invalidToken("malformed");
    const signature = decodeSegment(encodedSignature, true);
    if (!signature)
        throw invalidToken("malformed");
    return {
        alg: stringClaim(header, "alg", "malformed").trim(),
        kid: stringClaim(header, "kid", "malformed").trim(),
        signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
        signature,
        payload,
    };
}
function parseClaims(payload) {
    const scp = parseStringOrStringList(payload["scp"]);
    const scopes = normalizeClaimValues([
        ...splitScope(stringClaim(payload, "scope")),
        ...scp,
    ]);
    const claims = {
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
        if (exp.value === null)
            throw invalidToken("claim_invalid");
        claims.hasExpiry = true;
        claims.expiresAt = exp.value;
    }
    const nbf = numericClaim(payload, "nbf");
    if (nbf.present) {
        if (nbf.value === null)
            throw invalidToken("claim_invalid");
        claims.hasNotBefore = true;
        claims.notBefore = nbf.value;
    }
    return claims;
}
function parseAudience(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (Array.isArray(raw))
        return normalizeClaimValues(parseStringList(raw));
    if (typeof raw === "string")
        return normalizeClaimValues([raw]);
    throw invalidToken("claim_invalid");
}
function parseStringOrStringList(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (Array.isArray(raw))
        return normalizeClaimValues(parseStringList(raw));
    if (typeof raw === "string")
        return normalizeClaimValues([raw]);
    throw invalidToken("claim_invalid");
}
function parseStringList(values) {
    const out = [];
    for (const value of values) {
        if (typeof value !== "string")
            throw invalidToken("claim_invalid");
        out.push(value);
    }
    return out;
}
function numericClaim(payload, name) {
    const raw = payload[name];
    if (raw === undefined || raw === null)
        return { present: false, value: null };
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { present: true, value: null };
    }
    return { present: true, value: raw };
}
function splitScope(scope) {
    return scope.split(/\s+/u);
}
function missingScopes(got, required) {
    const seen = new Set(got);
    return required.filter((scope) => !seen.has(scope));
}
function importSigningKey(raw) {
    if (!isRecord(raw))
        return null;
    const kid = keyStringField(raw, "kid").trim();
    if (!kid)
        return null;
    if (keyStringField(raw, "kty").toUpperCase() !== "RSA")
        return null;
    const alg = keyStringField(raw, "alg").trim();
    if (alg && alg !== ACCESS_TOKEN_ALGORITHM)
        return null;
    const use = keyStringField(raw, "use").trim();
    if (use && use.toUpperCase() !== SIGNING_KEY_USE.toUpperCase())
        return null;
    try {
        return { kid, key: createPublicKey({ key: raw, format: "jwk" }) };
    }
    catch {
        return null;
    }
}
/**
 * Reads a JWKS member. A present non-string member is a malformed document
 * rather than a skippable key, matching the document-level decode the Go
 * validation performs before any key is trusted.
 */
function keyStringField(record, name) {
    const value = record[name];
    if (value === undefined || value === null)
        return "";
    if (typeof value !== "string") {
        throw new Error(`${ERROR_PREFIX} document_invalid: jwks member ${name} must be a string`);
    }
    return value;
}
async function fetchDocument(url, fetchImpl, label, timeoutMs) {
    let response;
    try {
        response = await withFetchTimeout(async (signal) => await fetchImpl(url.toString(), {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "manual",
            signal,
        }), timeoutMs);
    }
    catch {
        throw new Error(`${ERROR_PREFIX} discovery_unavailable: ${label} document cannot be fetched`);
    }
    if (response.status >= 300 && response.status < 400) {
        throw redirectFailure(url, response.headers.get("location") ?? "");
    }
    if (response.status !== 200) {
        throw new Error(`${ERROR_PREFIX} discovery_unavailable: ${label} document returned status ${response.status}`);
    }
    const body = await readBoundedBody(response, label);
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        throw new Error(`${ERROR_PREFIX} document_invalid: ${label} document is not JSON`);
    }
    if (!isRecord(parsed)) {
        throw new Error(`${ERROR_PREFIX} document_invalid: ${label} document must be a JSON object`);
    }
    return parsed;
}
/**
 * Races `run` against a timeout so the caller is bounded even when an injected
 * `fetchImpl` ignores the abort signal. The signal is still handed to `run` so a
 * real `fetch` stops early. The timeout is unref'd so a pending timer never
 * keeps the process (or a test run) alive.
 */
async function withFetchTimeout(run, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`${ERROR_PREFIX} fetch_timeout: document fetch exceeded the timeout`));
        }, timeoutMs);
        // Never keep the Node process (or a test run) alive for a pending timeout.
        if (typeof timer.unref === "function")
            timer.unref();
    });
    try {
        return await Promise.race([run(controller.signal), expired]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Reads a document body while enforcing `MAX_DOCUMENT_BYTES`: a streamed body is
 * cancelled as soon as the running total crosses the cap, so oversized content
 * is never buffered whole.
 */
async function readBoundedBody(response, label) {
    const tooLarge = () => new Error(`${ERROR_PREFIX} response_too_large: ${label} document exceeds the maximum size`);
    const body = response.body;
    if (!body) {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
            throw tooLarge();
        }
        return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
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
function redirectFailure(requestUrl, location) {
    const target = location.trim();
    if (!target) {
        return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
    }
    let resolved;
    try {
        resolved = new URL(target, requestUrl);
    }
    catch {
        return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
    }
    if (resolved.origin !== requestUrl.origin) {
        return new Error(`${ERROR_PREFIX} cross_origin_redirect: cross-origin redirect refused`);
    }
    return new Error(`${ERROR_PREFIX} redirect_rejected: redirect refused`);
}
function decodeJSONSegment(segment, reason) {
    const decoded = decodeSegment(segment, false);
    if (!decoded)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(decoded.toString("utf8"));
    }
    catch {
        throw invalidToken(reason);
    }
    return isRecord(parsed) ? parsed : null;
}
function decodeSegment(segment, allowEmpty) {
    const pattern = allowEmpty ? /^[A-Za-z0-9_-]*$/u : /^[A-Za-z0-9_-]+$/u;
    if (!pattern.test(segment))
        return null;
    return Buffer.from(segment, "base64url");
}
function secureURL(raw, label) {
    let url;
    try {
        url = new URL(String(raw ?? "").trim());
    }
    catch {
        throw new Error(`${ERROR_PREFIX} invalid_url: ${label} must be an absolute URL`);
    }
    if (!url.hostname) {
        throw new Error(`${ERROR_PREFIX} invalid_url: ${label} must be an absolute URL`);
    }
    if (url.protocol !== "https:") {
        throw new Error(`${ERROR_PREFIX} non_https: ${label} must use https`);
    }
    if (url.username || url.password) {
        throw new Error(`${ERROR_PREFIX} invalid_url: ${label} must not carry userinfo`);
    }
    if (url.hash) {
        throw new Error(`${ERROR_PREFIX} invalid_url: ${label} must not carry a fragment`);
    }
    return url;
}
function canonicalIssuer(raw) {
    let url;
    try {
        url = new URL(String(raw ?? "").trim());
    }
    catch {
        return null;
    }
    if (!url.protocol || !url.host)
        return null;
    url.pathname = trimTrailingSlashes(url.pathname);
    url.hash = "";
    return url.toString();
}
function trimTrailingSlashes(pathname) {
    let end = pathname.length;
    while (end > 0 && pathname.charCodeAt(end - 1) === 47) {
        end -= 1;
    }
    return pathname.slice(0, end);
}
function normalizeClaimValues(values) {
    const out = [];
    for (const value of values ?? []) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed)
            out.push(trimmed);
    }
    return out;
}
function stringClaim(record, name, reason = "claim_invalid") {
    const value = record[name];
    if (value === undefined || value === null)
        return "";
    if (typeof value !== "string")
        throw invalidToken(reason);
    return value;
}
function invalidToken(reason) {
    return new OAuthBearerError(ERR_INVALID_BEARER_TOKEN, `${ERR_INVALID_BEARER_TOKEN}: ${reason}`);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonNegativeSeconds(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : fallback;
}
function positiveSeconds(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}
function positiveInteger(value, fallback) {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}
//# sourceMappingURL=jwks.js.map