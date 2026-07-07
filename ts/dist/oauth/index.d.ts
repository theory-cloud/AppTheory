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
    response_types_supported?: string[];
    grant_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    code_challenge_methods_supported?: string[];
    scopes_supported?: string[];
    subject_types_supported?: string[];
    id_token_signing_alg_values_supported?: string[];
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
    requiredAudience?: string;
    requiredScopes?: string[];
    now?: () => Date;
}
export interface RequireBearerTokenOptions {
    resourceMetadataURL?: string;
    validator?: BearerTokenValidator;
    claimsValidator?: BearerTokenClaimsValidator;
}
export declare class OAuthBearerError extends Error {
    readonly oauthCode: string;
    constructor(oauthCode: string, message?: string);
}
export declare function newProtectedResourceMetadata(resource: string, authorizationServers: string[]): ProtectedResourceMetadata;
export declare function newAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata;
export declare function protectedResourceMetadataHandler(metadata: ProtectedResourceMetadata): Handler;
export declare function authorizationServerMetadataHandler(metadata: AuthorizationServerMetadata): Handler;
export declare function protectedResourceWWWAuthenticate(resourceMetadataURL: string): string;
export declare function rfc9728ResourceMetadataURL(resourceURL: string): string | null;
export declare function resourceMetadataURLFromMcpEndpoint(mcpEndpoint: string): string | null;
export declare function canonicalResourceURL(raw: string): string;
export declare function canonicalizeIssuerURL(raw: string): string | null;
export declare function bearerTokenFromHeaders(headers: Headers | undefined): string;
export declare function requireBearerTokenMiddleware(options?: RequireBearerTokenOptions): Middleware;
export declare function newMemoryBearerTokenValidator(records: BearerTokenRecord[], options?: BearerTokenValidationOptions): BearerTokenClaimsValidator;
export declare function bearerTokenClaimsFromContext(ctx: Context): BearerTokenClaims | null;
export declare function claudeDynamicClientRegistrationPolicy(): DynamicClientRegistrationPolicy;
export declare function validateDynamicClientRegistrationRequest(request: DynamicClientRegistrationRequest, policy: DynamicClientRegistrationPolicy): void;
export declare function newPKCECodeVerifier(): string;
export declare function validatePKCECodeVerifier(verifier: string): void;
export declare function pkceChallengeS256(verifier: string): string;
export declare function pkceVerifyS256(verifier: string, expectedChallenge: string): boolean;
//# sourceMappingURL=index.d.ts.map