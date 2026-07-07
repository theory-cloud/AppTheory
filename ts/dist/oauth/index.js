import { createHash, randomBytes } from "node:crypto";
import { json } from "../response.js";
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
export function newAuthorizationServerMetadata(issuer) {
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
    return {
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
}
export function protectedResourceMetadataHandler(metadata) {
    return () => json(200, metadata);
}
export function authorizationServerMetadataHandler(metadata) {
    return () => json(200, metadata);
}
export function protectedResourceWWWAuthenticate(resourceMetadataURL) {
    const value = String(resourceMetadataURL ?? "").trim();
    if (!value)
        return "Bearer";
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `Bearer resource_metadata="${escaped}"`;
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
export function canonicalizeIssuerURL(raw) {
    const url = absoluteURL(raw);
    if (!url)
        return null;
    url.pathname = trimTrailingSlash(url.pathname);
    url.hash = "";
    return url.toString();
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
        let token = "";
        try {
            token = bearerTokenFromHeaders(ctx.request.headers);
            if (options.claimsValidator) {
                const claims = await options.claimsValidator(ctx, token);
                ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
                ctx.set(CONTEXT_KEY_BEARER_CLAIMS, cloneClaims(claims));
                return await next(ctx);
            }
            if (!options.validator) {
                return unauthorizedResponse(ctx, options);
            }
            await options.validator(ctx, token);
            ctx.set(CONTEXT_KEY_BEARER_TOKEN, token);
            return await next(ctx);
        }
        catch (err) {
            return bearerErrorResponse(ctx, options, err);
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
    const requiredAudience = String(options.requiredAudience ?? "").trim();
    const requiredScopes = (options.requiredScopes ?? [])
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean);
    const now = options.now ?? (() => new Date());
    return (_ctx, token) => {
        const claims = byToken.get(String(token ?? "").trim());
        if (!claims)
            throw new OAuthBearerError(ERR_INVALID_BEARER_TOKEN);
        if (claims.expiresAt && now().getTime() >= claims.expiresAt.getTime()) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED);
        }
        if (requiredAudience && claims.audience !== requiredAudience) {
            throw new OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE);
        }
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
function unauthorizedResponse(_ctx, options) {
    const metadataURL = String(options.resourceMetadataURL ?? "").trim();
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
function bearerErrorResponse(ctx, options, err) {
    if (err instanceof OAuthBearerError &&
        (err.oauthCode === ERR_BEARER_TOKEN_INVALID_AUDIENCE ||
            err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE)) {
        return forbiddenResponse();
    }
    return unauthorizedResponse(ctx, options);
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
function trimTrailingSlash(pathname) {
    const value = String(pathname ?? "");
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) {
        end -= 1;
    }
    return value.slice(0, end);
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
//# sourceMappingURL=index.js.map