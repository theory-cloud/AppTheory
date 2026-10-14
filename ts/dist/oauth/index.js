import { createHash, randomBytes } from "node:crypto";
import { metadataJSON } from "../response.js";
export const CONTEXT_KEY_BEARER_TOKEN = "oauth.bearer_token";
export const CONTEXT_KEY_BEARER_CLAIMS = "oauth.bearer_claims";
export const ERR_MISSING_BEARER_TOKEN = "missing bearer token";
export const ERR_INVALID_AUTHORIZATION_HEADER = "invalid authorization header";
export const ERR_INVALID_BEARER_TOKEN = "invalid bearer token";
export const ERR_BEARER_TOKEN_EXPIRED = "bearer token expired";
export const ERR_BEARER_TOKEN_INVALID_AUDIENCE = "bearer token invalid audience";
export const ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE = "bearer token insufficient scope";
export const ERR_INVALID_URL = "invalid url";
export class OAuthBearerError extends Error {
    oauthCode;
    constructor(oauthCode, message = oauthCode) {
        super(message);
        this.name = "OAuthBearerError";
        this.oauthCode = oauthCode;
    }
}
export function newProtectedResourceMetadata(resource, authorizationServers) {
    const canonicalResource = String(resource ?? "").trim();
    if (!isAbsoluteURL(canonicalResource)) {
        throw new Error(`${ERR_INVALID_URL}: resource must be an absolute URL`);
    }
    const servers = (authorizationServers ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
    if (servers.length === 0 || servers.some((value) => !isAbsoluteURL(value))) {
        throw new Error(`${ERR_INVALID_URL}: authorization server must be an absolute URL`);
    }
    return { resource: canonicalResource, authorization_servers: servers };
}
export function newAuthorizationServerMetadata(issuer, options) {
    const url = absoluteURL(issuer);
    if (!url)
        throw new Error(`${ERR_INVALID_URL}: issuer must be an absolute URL`);
    url.pathname = trimTrailingSlash(url.pathname);
    url.search = "";
    url.hash = "";
    const canonicalIssuer = url.toString();
    const endpoint = (suffix) => {
        const out = new URL(canonicalIssuer);
        out.pathname = joinURLPath(out.pathname, suffix);
        out.search = "";
        out.hash = "";
        return out.toString();
    };
    const metadata = {
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
                : absoluteURLValue(opts.deviceAuthorizationEndpoint, "device authorization endpoint");
    }
    return metadata;
}
export function protectedResourceMetadataHandler(metadata) {
    return () => metadataJSON(200, metadata);
}
export function authorizationServerMetadataHandler(metadata) {
    return () => metadataJSON(200, metadata);
}
export function protectedResourceWWWAuthenticate(resourceMetadataURL) {
    const value = String(resourceMetadataURL ?? "").trim();
    if (!value)
        return "Bearer";
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `Bearer resource_metadata="${escaped}"`;
}
/**
 * Builds the RFC 6750 (RFC 9728-extended) insufficient_scope challenge
 * carrying the route-derived remediation scope set. Order matches Go:
 * `error`, then `scope` when non-empty, then `resource_metadata` when
 * non-empty.
 */
export function insufficientScopeWWWAuthenticate(scopes, resourceMetadataURL) {
    const normalized = (scopes ?? [])
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean);
    const parts = ['Bearer error="insufficient_scope"'];
    if (normalized.length > 0) {
        parts.push(`scope=${quoteChallengeValue(normalized.join(" "))}`);
    }
    const url = String(resourceMetadataURL ?? "").trim();
    if (url)
        parts.push(`resource_metadata=${quoteChallengeValue(url)}`);
    return parts.join(", ");
}
/**
 * Reports whether two RFC 8707 resource indicators denote the same protected
 * resource after canonicalization. An empty expected indicator never matches.
 */
export function resourceIndicatorMatches(expected, requested) {
    const canonicalExpected = canonicalResourceURL(expected);
    if (!canonicalExpected)
        return false;
    return canonicalExpected === canonicalResourceURL(requested);
}
export function rfc9728ResourceMetadataURL(resourceURL) {
    const url = absoluteURL(resourceURL);
    if (!url)
        return null;
    url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
    url.hash = "";
    return url.toString();
}
export function resourceMetadataURLFromMcpEndpoint(mcpEndpoint) {
    return rfc9728ResourceMetadataURL(mcpEndpoint);
}
export function canonicalResourceURL(raw) {
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
export function canonicalizeIssuerURL(raw) {
    const input = String(raw ?? "").trim();
    if (input === "" || hasControlByte(input))
        return null;
    let rest = input;
    let rawFragment = null;
    const hash = rest.indexOf("#");
    if (hash >= 0) {
        rawFragment = rest.slice(hash + 1);
        rest = rest.slice(0, hash);
    }
    const scheme = splitURLScheme(rest);
    if (!scheme)
        return null;
    rest = scheme.rest;
    let forceQuery = false;
    let rawQuery = "";
    if (rest.endsWith("?") && rest.split("?").length === 2) {
        forceQuery = true;
        rest = rest.slice(0, -1);
    }
    else {
        const query = rest.indexOf("?");
        if (query >= 0) {
            rawQuery = rest.slice(query + 1);
            rest = rest.slice(0, query);
        }
    }
    if (!rest.startsWith("//"))
        return null;
    const pathStart = rest.indexOf("/", 2);
    const authority = pathStart < 0 ? rest.slice(2) : rest.slice(2, pathStart);
    const rawPath = pathStart < 0 ? "" : rest.slice(pathStart);
    const parts = parseAuthority(authority);
    if (!parts)
        return null;
    const decodedPath = goUnescape(rawPath, "path");
    if (decodedPath === null)
        return null;
    const trimmedPath = trimTrailingSlashBytes(decodedPath);
    let escapedPath = goEscapeBytes(trimmedPath, goPathAllows);
    if (goEscapeBytes(decodedPath, goPathAllows) !== rawPath) {
        const hinted = goUnescape(rawPath, "path");
        if (goValidEncoded(rawPath, "path") &&
            hinted !== null &&
            hinted.equals(trimmedPath)) {
            escapedPath = rawPath;
        }
    }
    const decodedHost = goUnescape(parts.host, "host");
    if (decodedHost === null)
        return null;
    let out = `${scheme.scheme}://`;
    if (parts.userinfo !== null)
        out += `${parts.userinfo}@`;
    out += goEscapeBytes(decodedHost, goHostAllows);
    out += escapedPath;
    if (forceQuery || rawQuery !== "")
        out += `?${rawQuery}`;
    if (rawFragment !== null) {
        const decodedFragment = goUnescape(rawFragment, "fragment");
        if (decodedFragment === null)
            return null;
        if (decodedFragment.length > 0) {
            const fragment = goValidEncoded(rawFragment, "fragment")
                ? rawFragment
                : goEscapeBytes(decodedFragment, goFragmentAllows);
            out += `#${fragment}`;
        }
    }
    return out;
}
export function bearerTokenFromHeaders(headers) {
    const auth = firstHeader(headers, "authorization").trim();
    if (!auth)
        throw new OAuthBearerError(ERR_MISSING_BEARER_TOKEN);
    const [schemeRaw = "", ...rest] = auth.split(" ");
    const token = rest.join(" ").trim();
    if (schemeRaw.toLowerCase() !== "bearer" || !token) {
        throw new OAuthBearerError(ERR_INVALID_AUTHORIZATION_HEADER);
    }
    return token;
}
export function requireBearerTokenMiddleware(options = {}) {
    return async (ctx, next) => {
        let token;
        try {
            token = bearerTokenFromHeaders(ctx.request.headers);
            if (options.claimsValidator) {
                const claims = await options.claimsValidator(ctx, token);
                ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
                ctx.set(CONTEXT_KEY_BEARER_CLAIMS, cloneClaims(claims));
                return await next(ctx);
            }
            if (!options.validator) {
                return await unauthorizedResponse(ctx, options);
            }
            await options.validator(ctx, token);
            ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
            return await next(ctx);
        }
        catch (err) {
            return await bearerErrorResponse(ctx, options, err);
        }
    };
}
export function newMemoryBearerTokenValidator(records, options = {}) {
    const byToken = new Map();
    for (const record of records ?? []) {
        const token = String(record.token ?? "").trim();
        if (!token)
            continue;
        const claims = {
            subject: String(record.subject ?? "").trim(),
            audience: String(record.audience ?? "").trim(),
            scopes: Array.isArray(record.scopes) && record.scopes.length > 0
                ? record.scopes
                    .map((scope) => String(scope ?? "").trim())
                    .filter(Boolean)
                : scopeFields(record.scope ?? ""),
        };
        if (record.expiresAt)
            claims.expiresAt = new Date(record.expiresAt);
        byToken.set(token, claims);
    }
    const audienceOption = options.requiredAudience;
    const scopesOption = options.requiredScopes;
    const now = options.now ?? (() => new Date());
    return async (ctx, token) => {
        const claims = byToken.get(String(token ?? "").trim());
        if (!claims)
            throw new OAuthBearerError(ERR_INVALID_BEARER_TOKEN);
        if (claims.expiresAt && now().getTime() >= claims.expiresAt.getTime()) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED);
        }
        const requiredAudience = typeof audienceOption === "function"
            ? String((await audienceOption(ctx)) ?? "").trim()
            : String(audienceOption ?? "").trim();
        if (requiredAudience && claims.audience !== requiredAudience) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE);
        }
        const requiredScopes = typeof scopesOption === "function"
            ? normalizeScopeList(await scopesOption(ctx))
            : normalizeScopeList(scopesOption ?? []);
        if (missingScopes(claims.scopes ?? [], requiredScopes).length > 0) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE);
        }
        return cloneClaims(claims);
    };
}
export function bearerTokenClaimsFromContext(ctx) {
    const claims = ctx.get(CONTEXT_KEY_BEARER_CLAIMS);
    if (!claims || typeof claims !== "object")
        return null;
    return cloneClaims(claims);
}
export function claudeDynamicClientRegistrationPolicy() {
    return {
        allowedRedirectUris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.com/api/mcp/auth_callback",
        ],
        requirePublicClient: true,
        requireRefreshToken: true,
    };
}
export function validateDynamicClientRegistrationRequest(request, policy) {
    if (!request || typeof request !== "object")
        throw new Error("dcr: request is nil");
    const allowed = new Set((policy.allowedRedirectUris ?? [])
        .map((uri) => String(uri).trim())
        .filter(Boolean));
    const redirectUris = request.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        throw new Error("dcr: redirect_uris is required");
    }
    for (const raw of redirectUris) {
        const uri = String(raw ?? "").trim();
        if (!uri)
            throw new Error("dcr: redirect_uris contains an empty value");
        if (allowed.size > 0 && !allowed.has(uri)) {
            throw new Error(`dcr: redirect_uri not allowed: ${uri}`);
        }
    }
    const method = String(request.token_endpoint_auth_method ?? "none").trim() || "none";
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
export function newPKCECodeVerifier() {
    return randomBytes(32).toString("base64url");
}
export function validatePKCECodeVerifier(verifier) {
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(String(verifier ?? ""))) {
        throw new Error("pkce: invalid code verifier");
    }
}
export function pkceChallengeS256(verifier) {
    validatePKCECodeVerifier(verifier);
    return createHash("sha256")
        .update(String(verifier), "utf8")
        .digest("base64url");
}
export function pkceVerifyS256(verifier, expectedChallenge) {
    return pkceChallengeS256(verifier) === String(expectedChallenge ?? "");
}
async function unauthorizedResponse(ctx, options) {
    const metadataURL = await resolveResourceMetadataURL(ctx, options);
    const headers = {
        "content-type": ["application/json; charset=utf-8"],
    };
    headers["www-authenticate"] = [
        metadataURL ? protectedResourceWWWAuthenticate(metadataURL) : "Bearer",
    ];
    return {
        status: 401,
        headers,
        cookies: [],
        body: Buffer.from(JSON.stringify({
            error: { code: "app.unauthorized", message: "unauthorized" },
        }), "utf8"),
        isBase64: false,
    };
}
async function insufficientScopeResponse(ctx, options) {
    const scopes = await resolveRequiredScopes(ctx, options.requiredScopes);
    const metadataURL = await resolveResourceMetadataURL(ctx, options);
    const headers = {
        "content-type": ["application/json; charset=utf-8"],
        "www-authenticate": [insufficientScopeWWWAuthenticate(scopes, metadataURL)],
    };
    return {
        status: 403,
        headers,
        cookies: [],
        body: Buffer.from(JSON.stringify({
            error: {
                code: "app.insufficient_scope",
                message: "insufficient scope",
            },
        }), "utf8"),
        isBase64: false,
    };
}
function forbiddenResponse() {
    return {
        status: 403,
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body: Buffer.from(JSON.stringify({
            error: { code: "app.forbidden", message: "forbidden" },
        }), "utf8"),
        isBase64: false,
    };
}
async function bearerErrorResponse(ctx, options, err) {
    if (err instanceof OAuthBearerError) {
        if (err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE) {
            return await insufficientScopeResponse(ctx, options);
        }
        if (err.oauthCode === ERR_BEARER_TOKEN_INVALID_AUDIENCE) {
            return forbiddenResponse();
        }
    }
    return await unauthorizedResponse(ctx, options);
}
/**
 * Resolves the RFC 9728 protected-resource metadata URL for a challenge. A
 * route-derived resolver takes precedence; a resolver failure degrades to no
 * challenge URL, matching the Go middleware.
 */
async function resolveResourceMetadataURL(ctx, options) {
    const option = options.resourceMetadataURL;
    if (typeof option === "function") {
        try {
            return String((await option(ctx)) ?? "").trim();
        }
        catch {
            return "";
        }
    }
    return String(option ?? "").trim();
}
/**
 * Resolves the route-derived remediation scope set for a 403 challenge. A
 * resolver failure degrades to an empty (omitted) scope set.
 */
async function resolveRequiredScopes(ctx, option) {
    try {
        if (typeof option === "function") {
            return normalizeScopeList(await option(ctx));
        }
        return normalizeScopeList(option ?? []);
    }
    catch {
        return [];
    }
}
function quoteChallengeValue(value) {
    const escaped = String(value ?? "")
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
    return `"${escaped}"`;
}
function firstHeader(headers, name) {
    const key = String(name).trim().toLowerCase();
    if (!headers)
        return "";
    for (const [rawKey, values] of Object.entries(headers)) {
        if (String(rawKey).trim().toLowerCase() !== key)
            continue;
        return String((values ?? [])[0] ?? "");
    }
    return "";
}
function cloneClaims(claims) {
    const out = {
        subject: String(claims.subject ?? ""),
        audience: String(claims.audience ?? ""),
        scopes: [...(claims.scopes ?? [])],
    };
    if (claims.expiresAt)
        out.expiresAt = new Date(claims.expiresAt);
    return out;
}
function scopeFields(scope) {
    return String(scope ?? "")
        .split(/\s+/u)
        .map((part) => part.trim())
        .filter(Boolean);
}
function normalizeScopeList(scopes) {
    return (scopes ?? [])
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean);
}
function missingScopes(got, required) {
    const seen = new Set((got ?? []).map((scope) => String(scope).trim()).filter(Boolean));
    return (required ?? []).filter((scope) => !seen.has(String(scope).trim()));
}
function normalizeStringList(values) {
    return (values ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .sort();
}
function absoluteURL(raw) {
    try {
        const url = new URL(String(raw ?? "").trim());
        if (!url.protocol || !url.host)
            return null;
        return url;
    }
    catch {
        return null;
    }
}
function isAbsoluteURL(raw) {
    return absoluteURL(raw) !== null;
}
function absoluteURLValue(raw, label) {
    const url = absoluteURL(String(raw ?? ""));
    if (!url)
        throw new Error(`${ERR_INVALID_URL}: ${label} must be an absolute URL`);
    return url.toString();
}
function trimTrailingSlash(pathname) {
    const value = String(pathname ?? "");
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) {
        end -= 1;
    }
    return value.slice(0, end);
}
const GO_HEX = "0123456789ABCDEF";
// `net/url.validEncoded` always accepts these bytes, whatever the mode.
const GO_ENCODED_LITERALS = new Set([
    0x21, 0x24, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x3b, 0x3a, 0x3d, 0x40,
    0x5b, 0x5d,
]);
function hasControlByte(value) {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}
function goByte(bytes, index) {
    return bytes[index] ?? 0;
}
function goIsHexByte(code) {
    return ((code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x46) ||
        (code >= 0x61 && code <= 0x66));
}
function goUnhex(code) {
    if (code >= 0x30 && code <= 0x39)
        return code - 0x30;
    if (code >= 0x41 && code <= 0x46)
        return code - 0x41 + 10;
    return code - 0x61 + 10;
}
function goPathAllows(code) {
    if (code >= 0x30 && code <= 0x39)
        return true;
    if (code >= 0x41 && code <= 0x5a)
        return true;
    if (code >= 0x61 && code <= 0x7a)
        return true;
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
function goHostAllows(code) {
    if (code >= 0x30 && code <= 0x39)
        return true;
    if (code >= 0x41 && code <= 0x5a)
        return true;
    if (code >= 0x61 && code <= 0x7a)
        return true;
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
function goFragmentAllows(code) {
    if (code >= 0x30 && code <= 0x39)
        return true;
    if (code >= 0x41 && code <= 0x5a)
        return true;
    if (code >= 0x61 && code <= 0x7a)
        return true;
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
function goUserinfoAllows(code) {
    if (code >= 0x30 && code <= 0x39)
        return true;
    if (code >= 0x41 && code <= 0x5a)
        return true;
    if (code >= 0x61 && code <= 0x7a)
        return true;
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
function goAllowsFor(mode) {
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
function goEscapeBytes(bytes, allows) {
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
function goUnescape(value, mode) {
    const bytes = Buffer.from(value, "utf8");
    const out = [];
    let index = 0;
    while (index < bytes.length) {
        const byte = goByte(bytes, index);
        if (byte === 0x25) {
            if (index + 2 >= bytes.length)
                return null;
            const high = goByte(bytes, index + 1);
            const low = goByte(bytes, index + 2);
            if (!goIsHexByte(high) || !goIsHexByte(low))
                return null;
            const decoded = (goUnhex(high) << 4) | goUnhex(low);
            const escaped = high === 0x32 && low === 0x35;
            if (mode === "host" && decoded < 0x80 && !escaped)
                return null;
            out.push(decoded);
            index += 3;
            continue;
        }
        if (mode === "host" && byte < 0x80 && !goHostAllows(byte))
            return null;
        out.push(byte);
        index += 1;
    }
    return Buffer.from(out);
}
function goValidEncoded(value, mode) {
    const allows = goAllowsFor(mode);
    const bytes = Buffer.from(value, "utf8");
    for (let index = 0; index < bytes.length; index += 1) {
        const byte = goByte(bytes, index);
        if (byte === 0x25) {
            if (index + 2 >= bytes.length ||
                !goIsHexByte(goByte(bytes, index + 1)) ||
                !goIsHexByte(goByte(bytes, index + 2))) {
                return false;
            }
            index += 2;
            continue;
        }
        if (GO_ENCODED_LITERALS.has(byte))
            continue;
        if (!allows(byte))
            return false;
    }
    return true;
}
function trimTrailingSlashBytes(bytes) {
    let end = bytes.length;
    while (end > 0 && goByte(bytes, end - 1) === 0x2f) {
        end -= 1;
    }
    return end === bytes.length ? bytes : bytes.subarray(0, end);
}
function splitURLScheme(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (isASCIILetter(code))
            continue;
        if (index > 0 && isSchemeTail(code))
            continue;
        if (index > 0 && code === 0x3a) {
            const scheme = value.slice(0, index).toLowerCase();
            return { scheme, rest: value.slice(index + 1) };
        }
        return null;
    }
    return null;
}
function isASCIILetter(code) {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}
function isSchemeTail(code) {
    if (code >= 0x30 && code <= 0x39)
        return true;
    return code === 0x2b || code === 0x2d || code === 0x2e;
}
function validOptionalPort(value) {
    if (value === "")
        return true;
    if (!value.startsWith(":"))
        return false;
    for (let index = 1; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x30 || code > 0x39)
            return false;
    }
    return true;
}
function isIPLiteral(value) {
    if (!value.includes(":"))
        return false;
    if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/u.test(value))
        return false;
    return /^[0-9A-Fa-f:.]+$/u.test(value);
}
function hostIsValid(host) {
    const openBracket = host.lastIndexOf("[");
    if (openBracket > 0)
        return false;
    if (openBracket === 0) {
        const closeBracket = host.lastIndexOf("]");
        if (closeBracket < 0)
            return false;
        if (!validOptionalPort(host.slice(closeBracket + 1)))
            return false;
        if (!isIPLiteral(host.slice(1, closeBracket)))
            return false;
        return goUnescape(host, "host") !== null;
    }
    const separator = host.indexOf(":");
    if (separator >= 0 && !validOptionalPort(host.slice(separator))) {
        return false;
    }
    return goUnescape(host, "host") !== null;
}
function userinfoIsValid(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x30 && code <= 0x39)
            continue;
        if (code >= 0x41 && code <= 0x5a)
            continue;
        if (code >= 0x61 && code <= 0x7a)
            continue;
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
function encodeUserinfo(raw) {
    const separator = raw.indexOf(":");
    if (separator < 0) {
        const username = goUnescape(raw, "userinfo");
        return username === null ? null : goEscapeBytes(username, goUserinfoAllows);
    }
    const username = goUnescape(raw.slice(0, separator), "userinfo");
    const password = goUnescape(raw.slice(separator + 1), "userinfo");
    if (username === null || password === null)
        return null;
    const encodedUsername = goEscapeBytes(username, goUserinfoAllows);
    const encodedPassword = goEscapeBytes(password, goUserinfoAllows);
    return `${encodedUsername}:${encodedPassword}`;
}
function parseAuthority(value) {
    const at = value.lastIndexOf("@");
    const host = at < 0 ? value : value.slice(at + 1);
    if (host === "" || !hostIsValid(host))
        return null;
    if (at < 0)
        return { host, userinfo: null };
    const raw = value.slice(0, at);
    if (!userinfoIsValid(raw))
        return null;
    const userinfo = encodeUserinfo(raw);
    if (userinfo === null)
        return null;
    return { host, userinfo };
}
function joinURLPath(base, suffix) {
    const left = trimTrailingSlash(String(base ?? ""));
    const right = trimLeadingAndTrailingSlashes(String(suffix ?? ""));
    if (!left && !right)
        return "/";
    if (!left)
        return `/${right}`;
    if (!right)
        return left || "/";
    return `${left}/${right}`;
}
function trimLeadingAndTrailingSlashes(value) {
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
export { bootstrapOidcDiscovery, newJwksValidator, } from "./jwks.js";
export * from "./provider.js";
export * from "./store.js";
//# sourceMappingURL=index.js.map