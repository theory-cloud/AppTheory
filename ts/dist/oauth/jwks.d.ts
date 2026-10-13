import type { Context } from "../context.js";
import { type BearerTokenClaimsValidator } from "./index.js";
/** Framework default bound on one discovery or JWKS fetch, shared with Go and Python. */
export declare const DEFAULT_FETCH_TIMEOUT_SECONDS = 10;
/** Framework default bound on a token `kid`'s length, shared with Go and Python. */
export declare const DEFAULT_MAX_KID_LENGTH = 256;
/** Framework default bound on a validator's distinct `kid` resolution windows. */
export declare const DEFAULT_MAX_WINDOW_ENTRIES = 1024;
/** Framework default bound on a validator's cached signing keys. */
export declare const DEFAULT_MAX_KEY_ENTRIES = 128;
/** Framework default bound on key-set fetches inside one unknown-kid fetch window. */
export declare const DEFAULT_MAX_UNKNOWN_KID_FETCHES = 32;
/** Framework default length, in seconds, of the unknown-kid fetch budget window. */
export declare const DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS = 60;
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
/**
 * Fetches the OIDC discovery document at `discoveryUrl`, verifies that its
 * `issuer` equals `issuer`, and returns the document's `jwks_uri`. The
 * discovery URL and the returned key-set URL must both be absolute HTTPS URLs;
 * a document that omits `jwks_uri`, an issuer mismatch, and any redirect all
 * fail closed. The fetch is bounded by `timeoutSeconds`, which defaults to the
 * shared framework default.
 */
export declare function bootstrapOidcDiscovery(discoveryUrl: string, issuer: string, fetchImpl?: typeof fetch, timeoutSeconds?: number): Promise<string>;
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
export declare function newJwksValidator(options: JWKSValidatorOptions): Promise<BearerTokenClaimsValidator>;
/**
 * The connectivity class of one host address literal. `invalid` is not an
 * address literal at all and is never connectable, so the classifier fails
 * closed. The classes are shared with the Go and Python validators through the
 * discovery-bootstrap contract fixture's `host_guard` table.
 */
export type HostAddressClass = "loopback" | "link_local" | "private" | "unspecified" | "multicast" | "public" | "invalid";
/**
 * Classifies one IP address literal. An IPv4-mapped IPv6 address is classified
 * by the IPv4 address it maps to, so `::ffff:127.0.0.1` is loopback. Refused
 * classes are loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`,
 * `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 * `fc00::/7`), unspecified (`0.0.0.0`, `::`), and multicast (`224.0.0.0/4`,
 * `ff00::/8`); everything else is public.
 */
export declare function classifyHostAddress(address: string): HostAddressClass;
/** Reports whether one host address literal may be connected to. */
export declare function isPublicHostAddress(address: string): boolean;
//# sourceMappingURL=jwks.d.ts.map