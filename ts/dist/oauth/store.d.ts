import type { ManualClock } from "../clock.js";
/**
 * Durable, pluggable stores with reference in-memory implementations. Every
 * operation is atomic, and the two operations the facade's correctness rests
 * on — consume-once and compare-and-swap — are part of the SPI rather than a
 * convention the caller is trusted to keep.
 */
/** A pending or consumed front-channel transaction, keyed by hash(upstream state). */
export interface TransactionRecord {
    stateHash: string;
    clientIdHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    clientState: string;
    /** The PKCE verifier for the upstream leg, encrypted at rest. */
    encryptedUpstreamCodeVerifier: string;
    scopes: string[];
    canonicalResource: string;
    endpointKind: string;
    clientNamespace: string;
    partnerId: string;
    agentId: string;
    status: TransactionStatus;
    expiresAt: Date;
    version: number;
}
export type TransactionStatus = "pending" | "consumed" | "expired";
/**
 * A minted facade code, keyed by hash(facade code). The record is retained
 * after consume so a replay is distinguishable from an unknown code, and it
 * holds no unencrypted upstream material.
 */
export interface AuthorizationCodeRecord {
    codeHash: string;
    clientIdHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scopes: string[];
    canonicalResource: string;
    endpointKind: string;
    clientNamespace: string;
    partnerId: string;
    agentId: string;
    routeRefreshHandleHash: string;
    encryptedRouteRefreshHandle: string;
    /** The upstream TokenSet, encrypted; it embeds the upstream access token. */
    encryptedTokenResponse: string;
    status: AuthorizationCodeStatus;
    expiresAt: Date;
    version: number;
}
export type AuthorizationCodeStatus = "issued" | "consumed" | "expired";
/** A dynamically registered client, keyed by hash(client id). */
export interface ClientRecord {
    clientIdHash: string;
    clientId: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: string;
    grantTypes: string[];
    responseTypes: string[];
    boundRoute: string;
    createdAt: Date;
    version: number;
}
/**
 * One route refresh handle's brokered state, keyed by hash(route refresh
 * handle). A handle is never rebound to a new issuer or client registration.
 */
export interface RouteRefreshBrokerRecord {
    handleHash: string;
    issuer: string;
    stage: string;
    canonicalResource: string;
    clientNamespace: string;
    endpointKind: string;
    partnerId: string;
    agentId: string;
    clientIdHash: string;
    subjectIdHash: string;
    scopes: string[];
    scopeFingerprint: string;
    /** The durable upstream refresh token, encrypted at rest. */
    encryptedUpstreamRefreshToken: string;
    upstreamRefreshTokenHash: string;
    upstreamClientId: string;
    encryptedGraceRefreshResponse?: string;
    graceExpiresAt?: Date;
    status: RouteRefreshBrokerStatus;
    refreshLockOwner?: string;
    refreshLockExpiresAt?: Date;
    version: number;
}
export type RouteRefreshBrokerStatus = "issued" | "active" | "refreshing" | "revoked" | "expired" | "reauth_required";
/** Consume-once transaction state: hash(upstream state) → record. */
export interface TransactionStore {
    put(record: TransactionRecord): Promise<void>;
    consume(stateHash: string): Promise<TransactionRecord | null>;
}
/** Consume-once facade codes that retain their record so replay is visible. */
export interface AuthorizationCodeStore {
    put(record: AuthorizationCodeRecord): Promise<void>;
    consume(codeHash: string): Promise<AuthorizationCodeConsumeResult | null>;
}
export interface AuthorizationCodeConsumeResult {
    record: AuthorizationCodeRecord;
    replayed: boolean;
}
/** Registered clients. Update is compare-and-swap on version. */
export interface ClientStore {
    put(record: ClientRecord): Promise<void>;
    get(clientIdHash: string): Promise<ClientRecord | null>;
    update(record: ClientRecord, expectedVersion: number): Promise<ClientRecord>;
}
/**
 * Route refresh broker state. AcquireLock is exclusive and expiring,
 * CompareAndSwap is versioned, and Revoke is idempotent and terminal.
 */
export interface RouteRefreshBrokerStore {
    get(handleHash: string): Promise<RouteRefreshBrokerRecord | null>;
    acquireLock(handleHash: string, lockOwner: string, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    compareAndSwap(record: RouteRefreshBrokerRecord, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    revoke(handleHash: string): Promise<RouteRefreshBrokerRecord>;
}
/**
 * The rate-limit bucket a caller checks. `limit` and `windowSeconds` are the
 * caller's window budget for the (identifier, resource, operation) tuple, so
 * one store serves buckets with different budgets.
 */
export interface RateLimitBucketKey {
    identifier: string;
    resource: string;
    operation: string;
    limit: number;
    windowSeconds: number;
}
export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    count: number;
    remaining: number;
    resetAt: Date;
}
/** Atomic per-key rate limiting. */
export interface RateLimitStore {
    checkAndIncrement(key: RateLimitBucketKey): Promise<RateLimitResult>;
}
/** A consumed client update presented a stale version. */
export declare class ClientVersionConflictError extends Error {
    constructor(message?: string);
}
/** A broker compare-and-swap presented a stale version. */
export declare class BrokerVersionConflictError extends Error {
    constructor(message?: string);
}
/** The broker record is revoked, so it can be neither locked nor refreshed. */
export declare class BrokerRevokedError extends Error {
    constructor(message?: string);
}
/** The broker record already holds an unexpired refresh lock. */
export declare class BrokerLockedError extends Error {
    constructor(message?: string);
}
/** No broker record exists for the presented handle. */
export declare class BrokerNotFoundError extends Error {
    constructor(message?: string);
}
export interface MemoryTransactionStoreOptions {
    now?: () => Date;
    ttlSeconds?: number;
}
/** In-memory reference TransactionStore. */
export declare class MemoryTransactionStore implements TransactionStore {
    private readonly records;
    private readonly now;
    private readonly ttlSeconds;
    constructor(options?: MemoryTransactionStoreOptions);
    put(record: TransactionRecord): Promise<void>;
    consume(stateHash: string): Promise<TransactionRecord | null>;
    private expired;
    /** The record's expiry when the store applied its own TTL. */
    private defaultExpiry;
}
export interface MemoryAuthorizationCodeStoreOptions {
    now?: () => Date;
    ttlSeconds?: number;
}
/** In-memory reference AuthorizationCodeStore. */
export declare class MemoryAuthorizationCodeStore implements AuthorizationCodeStore {
    private readonly records;
    private readonly now;
    private readonly ttlSeconds;
    constructor(options?: MemoryAuthorizationCodeStoreOptions);
    put(record: AuthorizationCodeRecord): Promise<void>;
    consume(codeHash: string): Promise<AuthorizationCodeConsumeResult | null>;
    private expired;
    /** The record's expiry when the store applied its own TTL. */
    private defaultExpiry;
}
export interface MemoryClientStoreOptions {
    now?: () => Date;
}
/** In-memory reference ClientStore. */
export declare class MemoryClientStore implements ClientStore {
    private readonly records;
    put(record: ClientRecord): Promise<void>;
    get(clientIdHash: string): Promise<ClientRecord | null>;
    update(record: ClientRecord, expectedVersion: number): Promise<ClientRecord>;
}
export interface MemoryRouteRefreshBrokerStoreOptions {
    now?: () => Date;
    lockTtlSeconds?: number;
}
/** In-memory reference RouteRefreshBrokerStore. */
export declare class MemoryRouteRefreshBrokerStore implements RouteRefreshBrokerStore {
    private readonly records;
    private readonly now;
    private readonly lockTtlMs;
    constructor(options?: MemoryRouteRefreshBrokerStoreOptions);
    get(handleHash: string): Promise<RouteRefreshBrokerRecord | null>;
    /**
     * Takes the exclusive refresh lock. The revoked check runs first, then lock
     * exclusivity, then the version guard, so concurrent contenders for one
     * handle observe `locked` rather than a version conflict and a revoked
     * handle never becomes lockable again. The lock expires at its own bound;
     * acquiring it does not advance the record's content version.
     */
    acquireLock(handleHash: string, lockOwner: string, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    /**
     * Versioned compare-and-swap. A version of `0` is the optimistic-create
     * sentinel: it stores the record only when no record exists, which is how a
     * reference or application store seeds a handle. Any other version must
     * equal the stored record's version, and a revoked record refuses every
     * swap.
     */
    compareAndSwap(record: RouteRefreshBrokerRecord, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    /** Revokes the handle. Revocation is idempotent and terminal. */
    revoke(handleHash: string): Promise<RouteRefreshBrokerRecord>;
}
export interface MemoryRateLimitStoreOptions {
    now?: () => Date;
    limit?: number;
    windowSeconds?: number;
}
/** In-memory reference RateLimitStore. */
export declare class MemoryRateLimitStore implements RateLimitStore {
    private readonly buckets;
    private readonly now;
    private readonly defaultLimit;
    private readonly defaultWindowSeconds;
    constructor(options?: MemoryRateLimitStoreOptions);
    /**
     * Increments one bucket and reports whether the increment stayed inside its
     * budget. The bucket is opened (or rolled over once its window elapsed) and
     * incremented before this method returns any promise, so concurrent checks
     * cannot interleave between the read and the write.
     */
    checkAndIncrement(key: RateLimitBucketKey): Promise<RateLimitResult>;
}
/** Every reference store, as one conformance subject. */
export interface Stores {
    transaction: TransactionStore;
    authorizationCode: AuthorizationCodeStore;
    client: ClientStore;
    routeRefreshBroker: RouteRefreshBrokerStore;
    rateLimit: RateLimitStore;
}
/** One row of the shared store conformance table. */
export interface StoreConformanceCase {
    id: string;
    store: string;
    scenario: string;
    params: Record<string, unknown>;
    expect: Record<string, unknown>;
}
/**
 * Runs the shared store conformance table against `stores`, resetting the
 * clock to its starting instant before every row, and throws on the first row
 * whose observable outcome differs from its `expect`. The returned count is
 * the number of rows executed, so a caller can assert it against the fixture.
 */
export declare function runStoreConformance(stores: Stores, cases: StoreConformanceCase[], clock: ManualClock): Promise<{
    ran: number;
}>;
//# sourceMappingURL=store.d.ts.map