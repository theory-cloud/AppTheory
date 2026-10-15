import type { Context, Handler, Middleware } from "../context.js";
import type { Headers } from "../types.js";
export declare const CONTEXT_KEY_BEARER_TOKEN = "oauth.bearer_token";
export declare const CONTEXT_KEY_BEARER_CLAIMS = "oauth.bearer_claims";
export declare const ERR_MISSING_BEARER_TOKEN = "missing bearer token";
export declare const ERR_INVALID_AUTHORIZATION_HEADER = "invalid authorization header";
export declare const ERR_INVALID_BEARER_TOKEN = "invalid bearer token";
export declare const ERR_BEARER_TOKEN_EXPIRED = "bearer token expired";
export declare const ERR_BEARER_TOKEN_INVALID_AUDIENCE = "bearer token invalid audience";
export declare const ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE = "bearer token insufficient scope";
export declare const ERR_INVALID_URL = "invalid url";
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
export type BearerTokenValidator = (ctx: Context, token: string) => void | Promise<void>;
export type BearerTokenClaimsValidator = (ctx: Context, token: string) => BearerTokenClaims | Promise<BearerTokenClaims>;
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
export declare class OAuthBearerError extends Error {
    readonly oauthCode: string;
    constructor(oauthCode: string, message?: string);
}
export declare function newProtectedResourceMetadata(resource: string, authorizationServers: string[]): ProtectedResourceMetadata;
export declare function newAuthorizationServerMetadata(issuer: string, options?: AuthorizationServerMetadataOptions): AuthorizationServerMetadata;
export declare function protectedResourceMetadataHandler(metadata: ProtectedResourceMetadata): Handler;
export declare function authorizationServerMetadataHandler(metadata: AuthorizationServerMetadata): Handler;
export declare function protectedResourceWWWAuthenticate(resourceMetadataURL: string): string;
/**
 * Builds the RFC 6750 (RFC 9728-extended) insufficient_scope challenge
 * carrying the route-derived remediation scope set. Order matches Go:
 * `error`, then `scope` when non-empty, then `resource_metadata` when
 * non-empty.
 */
export declare function insufficientScopeWWWAuthenticate(scopes: string[], resourceMetadataURL?: string): string;
/**
 * Reports whether two RFC 8707 resource indicators denote the same protected
 * resource after canonicalization. An empty expected indicator never matches.
 */
export declare function resourceIndicatorMatches(expected: string, requested: string): boolean;
export declare function rfc9728ResourceMetadataURL(resourceURL: string): string | null;
export declare function resourceMetadataURLFromMcpEndpoint(mcpEndpoint: string): string | null;
export declare function canonicalResourceURL(raw: string): string;
/**
 * Canonicalizes an RFC 9207 `iss` value exactly as the Go reference
 * `oauth.CanonicalizeIssuerURL` does, because the pinned issuer is compared
 * byte-for-byte across runtimes. The scheme is lowercased; the authority is
 * preserved, so host case and an explicit port survive; the decoded path is
 * re-encoded with the Go `net/url` path rules and its trailing slashes are
 * trimmed; the raw query and fragment are kept. Relative, empty, control-byte
 * and malformed-percent-escape inputs return null.
 */
export declare function canonicalizeIssuerURL(raw: string): string | null;
export declare function bearerTokenFromHeaders(headers: Headers | undefined): string;
/**
 * Enforces `Authorization: Bearer <token>` and, when missing or invalid,
 * returns 401 with the MCP 2025-06-18 compatible WWW-Authenticate challenge
 * that points to the protected resource metadata.
 *
 * A `resourceMetadataURLTemplate` is compiled here, at registration, and a
 * malformed template throws: the middleware never serves a request whose
 * challenge would advertise a broken or partially resolved discovery URL.
 */
export declare function requireBearerTokenMiddleware(options?: RequireBearerTokenOptions): Middleware;
export declare function newMemoryBearerTokenValidator(records: BearerTokenRecord[], options?: BearerTokenValidationOptions): BearerTokenClaimsValidator;
export declare function bearerTokenClaimsFromContext(ctx: Context): BearerTokenClaims | null;
export declare function claudeDynamicClientRegistrationPolicy(): DynamicClientRegistrationPolicy;
export declare function validateDynamicClientRegistrationRequest(request: DynamicClientRegistrationRequest, policy: DynamicClientRegistrationPolicy): void;
export declare function newPKCECodeVerifier(): string;
export declare function validatePKCECodeVerifier(verifier: string): void;
export declare function pkceChallengeS256(verifier: string): string;
export declare function pkceVerifyS256(verifier: string, expectedChallenge: string): boolean;
export { bootstrapOidcDiscovery, newJwksValidator, type JWKSValidatorOptions, } from "./jwks.js";
export * from "./provider.js";
export * from "./store.js";
//# sourceMappingURL=index.d.ts.map