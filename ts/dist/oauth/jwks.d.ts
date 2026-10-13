import type { Context } from "../context.js";
import { type BearerTokenClaimsValidator } from "./index.js";
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
    /** Overrides the clock used for `exp`/`nbf`, cache expiry, and cooldown. */
    now?: () => Date;
    /** Tolerance applied to `exp` and `nbf`. */
    clockSkewSeconds?: number;
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
/**
 * Fetches the OIDC discovery document at `discoveryUrl`, verifies that its
 * `issuer` equals `issuer`, and returns the document's `jwks_uri`. The
 * discovery URL and the returned key-set URL must both be absolute HTTPS URLs;
 * a document that omits `jwks_uri`, an issuer mismatch, and any redirect all
 * fail closed.
 */
export declare function bootstrapOidcDiscovery(discoveryUrl: string, issuer: string, fetchImpl?: typeof fetch): Promise<string>;
/**
 * Builds a fail-closed RS256/JWKS claims validator.
 *
 * The returned validator resolves signing keys from a bounded `kid` cache that
 * `refreshCooldownSeconds` rate-limits, verifies RSASSA-PKCS1-v1_5/SHA-256
 * signatures, and refuses the request on every doubt: a malformed token, a
 * non-RS256 algorithm, a missing `kid`, an unknown or inconsistent key, a
 * signature mismatch, an issuer mismatch, a missing or expired `exp`, a `nbf`
 * in the future, an audience or scope mismatch, and a disallowed `azp`. It
 * never returns claims for a token it could not fully verify, and it never logs
 * the token or key material.
 */
export declare function newJwksValidator(options: JWKSValidatorOptions): Promise<BearerTokenClaimsValidator>;
//# sourceMappingURL=jwks.d.ts.map