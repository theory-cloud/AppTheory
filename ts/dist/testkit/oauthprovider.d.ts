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
    /**
     * Status a `grant_type=refresh_token` call is answered with. Unset means
     * `tokenStatus`, so a caller that configures nothing keeps the
     * single-response behavior it had before.
     */
    refreshTokenStatus?: number;
    /**
     * JSON body a `grant_type=refresh_token` call is answered with. Unset means
     * `tokenBody`. It is how a test gives the refresh grant its own access token,
     * its own upstream refresh token, and its own id_token, so a caller that must
     * hide upstream material is observable.
     */
    refreshTokenBody?: unknown;
    /**
     * Stages the leading `grant_type=refresh_token` responses in call order: the
     * nth refresh call takes the nth stage, and every later call takes the
     * steady-state response above. A stage that omits `status` or `body` falls
     * back to the steady-state value. It exists so a transient upstream failure
     * that clears is observable.
     */
    refreshTokenStages?: FakeRefreshStage[];
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
/** One staged `grant_type=refresh_token` response. */
export interface FakeRefreshStage {
    /** The HTTP status. Unset means the steady-state refresh status. */
    status?: number;
    /** The JSON body. Unset means the steady-state refresh body. */
    body?: unknown;
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
    private readonly refreshStatus;
    private readonly refreshBody;
    private readonly refreshStages;
    private refreshCalls;
    private lastRefreshForm;
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
    /**
     * Reports how many `grant_type=refresh_token` requests the fake served,
     * counted separately from the total token request count, so a caller's
     * single-flight rotation is observable.
     */
    refreshCallCount(): number;
    /**
     * A copy of the form the last `grant_type=refresh_token` request presented, so
     * a test can observe the material and client that refresh leg carried. Unlike
     * `lastTokenRequest`, it deliberately retains the presented values: a refresh
     * leg's whole contract is which upstream refresh material it presented.
     */
    lastRefreshRequest(): URLSearchParams;
    private handleRequest;
    private handleDiscovery;
    private handleToken;
    /**
     * Counts one `grant_type=refresh_token` request and records its form,
     * returning the one-based index of that refresh call, or zero for any other
     * grant, so the caller can select a staged refresh response.
     */
    private recordRefreshRequest;
    /**
     * Returns the staged or steady-state response of the nth
     * `grant_type=refresh_token` call (one-based).
     */
    private refreshResponseFor;
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