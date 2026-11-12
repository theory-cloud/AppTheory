/**
 * The closed client-facing vocabulary a provider adapter reports. The facade
 * maps these classes to HTTP statuses; raw upstream error bodies never travel
 * with them.
 */
export type ProviderErrorClass = "upstream_error" | "temporarily_unavailable" | "invalid_grant" | "invalid_request" | "reauth_required";
/**
 * The upstream OAuth error codes that are a definitive, contract-terminal grant
 * rejection. Exactly one code is terminal: `invalid_grant`, which the identity
 * plane emits only for genuinely terminal cases (out-of-window replay,
 * logout/revoke-all containment, explicit revocation). Any other non-2xx stays
 * an upstream_error, so an unknown signal is never upgraded into a client-facing
 * decision. The set is identical in the Go and Python adapters
 * (theorycloud_refresh_rotation_recovery.v0.1 R6).
 */
export declare const TERMINAL_TOKEN_ERROR_CODES: ReadonlySet<string>;
/**
 * The contract's per-request client-error set: the codes a token endpoint
 * answers when this one request cannot be honored. They are transient to the
 * family, so no family, session, or tombstone may be killed for one of them. The
 * set is identical in the Go and Python adapters, and it is enumerated in both
 * directions by the shared provider conformance table.
 */
export declare const PER_REQUEST_TOKEN_ERROR_CODES: ReadonlySet<string>;
/**
 * Reports whether an upstream token-endpoint error code may carry a
 * contract-terminal family verdict. It is the exported seam the facade's
 * terminal classifier and the vendored refresh-rotation-recovery corpus are
 * pinned against, so a consumer classifies an upstream answer exactly as the
 * facade does.
 */
export declare function isTerminalTokenVerdict(code: string): boolean;
/** The contract's terminal token-verdict codes. */
export declare function terminalTokenVerdictCodes(): string[];
/**
 * Reports whether an upstream token-endpoint error code is one of the contract's
 * per-request client errors. The two sets are disjoint by construction.
 */
export declare function isPerRequestTokenVerdict(code: string): boolean;
/**
 * A provider-call failure in the facade's closed vocabulary. `httpStatus` is
 * the facade status the class maps to, and `op` names the SPI operation that
 * failed; both are safe to surface.
 */
export declare class ProviderError extends Error {
    readonly errorClass: ProviderErrorClass;
    readonly op: string;
    readonly httpStatus: number;
    constructor(errorClass: ProviderErrorClass, op: string);
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
    validateAccessToken(token: string, expected: TokenExpectations): Promise<TokenClaims>;
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
/**
 * Builds the Autheory provider adapter: the first implementation of the
 * provider SPI. Discovery is RFC 8414, verified by canonical issuer equality
 * before any endpoint is trusted; the authorize redirect always carries the
 * RFC 8707 `resource`; code exchange and refresh are bounded form-encoded
 * POSTs; access tokens are validated fail-closed through the framework's
 * RS256/JWKS validator.
 */
export declare function newAutheoryProvider(options: AutheoryProviderOptions): Promise<AutheoryProvider>;
/** The Autheory provider adapter. */
export declare class AutheoryProvider implements Provider {
    private readonly issuer;
    private readonly discoveryUrlOverride;
    private readonly tokenEndpointOverride;
    private readonly authorizationEndpointOverride;
    private readonly jwksUriOverride;
    private readonly transport;
    private readonly now;
    private readonly fetchTimeoutSeconds;
    private readonly allowedAuthorizedParties;
    private readonly validators;
    private cachedDiscovery;
    constructor(options: AutheoryProviderOptions);
    /**
     * Fetches and pins the RFC 8414 document once, then caches it. The document
     * URL must be HTTPS, a redirect is refused, and the document's `issuer` must
     * canonicalize to the configured issuer before any advertised endpoint is
     * trusted.
     */
    discovery(): Promise<ProviderMetadata>;
    /**
     * Joins the in-flight discovery so the launched load cannot outlive this
     * call, and clears the cache when it fails so a later call retries.
     */
    private settleDiscovery;
    /**
     * Builds the absolute upstream authorize URL. Everything that can fail
     * closed is checked before the endpoint is resolved, so no refused request
     * reaches the upstream: a hint whose name collides, case-insensitively after
     * trimming, with a required or reserved authorize parameter fails closed
     * with `invalid_request`, and so does a request that omits its own upstream
     * client id. The required parameters are then built first, so an accepted
     * hint can never replace one.
     */
    authorizationUrl(req: AuthorizationRequest): Promise<string>;
    exchangeCode(req: CodeExchangeRequest): Promise<TokenSet>;
    refresh(req: RefreshRequest): Promise<TokenSet>;
    /**
     * Validates one access token fail-closed against `expected`, returning the
     * verified claims without mutating the token. Every validator error —
     * malformed, unverified, expired, wrong issuer/audience/scope, or a key-set
     * failure — is reported as `upstream_error`.
     */
    validateAccessToken(token: string, expected: TokenExpectations): Promise<TokenClaims>;
    private loadDiscovery;
    private tokenRequest;
    private validatorFor;
}
//# sourceMappingURL=provider.d.ts.map