/** Configuration for one fake upstream provider. */
export interface FakeOAuthProviderOptions {
    /** The issuer the discovery document advertises. */
    issuer?: string;
    /**
     * The base URL the discovery document advertises for its endpoints. It
     * defaults to `issuer`, so a test can pin an HTTPS name the caller's
     * transport bridges to loopback while the document still fails or matches
     * an issuer the adapter was configured with.
     */
    publicBaseUrl?: string;
    kid?: string;
    discoveryPath?: string;
    jwksPath?: string;
    tokenPath?: string;
    authorizationPath?: string;
    /** When set, the discovery request is answered with a redirect to it. */
    discoveryRedirectTo?: string;
    codeChallengeMethodsSupported?: string[];
    authorizationResponseIssParameterSupported?: boolean;
    resourceParameterSupported?: boolean;
    /** Status the token endpoint answers with. Defaults to 200. */
    tokenStatus?: number;
    /** JSON body the token endpoint answers with. */
    tokenBody?: unknown;
    /** When positive, the token endpoint streams a body of this many bytes. */
    tokenBodyBytes?: number;
    /**
     * When positive, the token endpoint answers with a well-formed token document
     * whose `access_token` value is this many bytes long. Unlike `tokenBodyBytes`
     * the body is valid JSON, so a case that expects a failure only while the
     * response cap holds stops failing when the cap is removed.
     */
    tokenBodyPaddingBytes?: number;
    /** When positive, the token endpoint stalls this long before answering. */
    tokenDelaySeconds?: number;
}
/** The claims one minted access token carries. */
export interface FakeAccessTokenClaims {
    issuer?: string;
    audience?: string;
    authorizedParty?: string;
    subject?: string;
    scope?: string;
    expiresInSeconds?: number;
    kid?: string;
    /** When true, the minted signature is corrupted after signing. */
    tamperSignature?: boolean;
}
/**
 * What the fake observed on the last token request. Only non-secret shape is
 * retained: codes, refresh material, and PKCE verifiers are reported as
 * presence flags and never kept.
 */
export interface FakeTokenRequest {
    grantType: string;
    clientId: string;
    redirectUri: string;
    hasCode: boolean;
    hasCodeVerifier: boolean;
    hasRefreshToken: boolean;
}
/** A running fake upstream OAuth provider. */
export declare class FakeOAuthProvider {
    private readonly options;
    private readonly privateKey;
    private readonly jwk;
    private server;
    private loopbackUrl;
    private lastToken;
    constructor(options?: FakeOAuthProviderOptions);
    get url(): string;
    get issuer(): string;
    get discoveryPath(): string;
    get jwksPath(): string;
    get tokenPath(): string;
    get authorizationPath(): string;
    /** Starts the loopback server and returns its base URL. */
    start(): Promise<string>;
    /** Stops the loopback server and drops every open connection. */
    close(): Promise<void>;
    /** Mints one real RS256 compact JWS access token. */
    mintAccessToken(claims?: FakeAccessTokenClaims): string;
    /** The JWKS document the fake publishes. */
    jwksDocument(): Record<string, unknown>;
    /** The shape of the last token request, or null before the first one. */
    lastTokenRequest(): FakeTokenRequest | null;
    private handleRequest;
    private handleDiscovery;
    private handleToken;
    private sendJSON;
    /**
     * Streams a body larger than the adapter's cap in chunks, so the adapter
     * observes an oversized response while it is still being written and cancels
     * mid-stream. A cancelled response is expected, so write errors are dropped.
     */
    private sendOversized;
}
/** Builds a fake upstream OAuth provider. */
export declare function newFakeOAuthProvider(options?: FakeOAuthProviderOptions): FakeOAuthProvider;
//# sourceMappingURL=oauthprovider.d.ts.map