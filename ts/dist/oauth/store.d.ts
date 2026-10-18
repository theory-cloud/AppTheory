import type { ManualClock } from "../clock.js";
/**
 * Durable, pluggable stores with reference in-memory implementations. Every
 * operation is atomic, and the two operations the facade's correctness rests
 * on — consume-once and compare-and-swap — are part of the SPI rather than a
 * convention the caller is trusted to keep.
 *
 * An `Encrypted*` record field carries upstream material exactly as the
 * provider handed it to the facade: the framework performs no sealing and adds
 * no encryption surface or key management, so a durable store implementation
 * MUST encrypt those fields at rest (for example with a persistence-layer
 * encryption tag). The in-memory reference stores here are NON-DURABLE and do
 * not encrypt: they are for deterministic tests and local development only.
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
    /**
     * The record's expiry. Leave it unset to let the store apply its own
     * transaction TTL; a set value is kept verbatim.
     */
    expiresAt?: Date;
    version: number;
}
export type TransactionStatus = "pending" | "consumed" | "expired";
/**
 * A minted facade code, keyed by hash(facade code). The record is retained
 * after consume so a replay is distinguishable from an unknown code. Its
 * `Encrypted*` fields carry upstream material as the provider handed it to the
 * facade (the store encrypts them at rest, per the module note).
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
    /**
     * The record's expiry. Leave it unset to let the store apply its own code
     * TTL; a set value is kept verbatim.
     */
    expiresAt?: Date;
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
    /**
     * The refresh family generation of the handle. A handle the framework mints
     * under the current policy is generation 1 and the root of its own family;
     * every successor records the presented generation plus one and inherits the
     * family hash, so the depth of a rotated-away handle relative to the head is
     * arithmetic. A record that predates the policy carries 0 (or omits the
     * field) and is classified structurally.
     */
    chainGeneration?: number;
    /**
     * The family the handle belongs to: the hash of the root handle's own
     * handle. Absent or empty marks a pre-policy record, which becomes the root
     * of a new family on its first mutation under the policy.
     */
    familyHash?: string;
    /**
     * Marks a rotated-away handle that has already been answered once beyond its
     * grace window with the access token only. A second such presentation is
     * theft class, so the marker is written before the serve.
     */
    depthOneServedAt?: Date;
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
    /**
     * The stored record, returned unmutated. Null on the first consume of an
     * expired code, which Go's reference store reports as no record.
     */
    record: AuthorizationCodeRecord | null;
    replayed: boolean;
    /** True when the first consume found the code past its TTL. */
    expired: boolean;
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
 * The optional create path a broker store needs to place the record a
 * conformance row starts from. The broker SPI itself is
 * get/acquireLock/compareAndSwap/revoke and a compare-and-swap never creates, so
 * creating a handle is a separate operation the facade's own write path owns; a
 * durable store implements this with whatever create path it already has.
 */
export interface RouteRefreshBrokerSeeder {
    put(record: RouteRefreshBrokerRecord): Promise<void>;
}
/**
 * The optional family capability of a broker store. A refresh family is the
 * chain of handles one authorization grant produced; `familyHash` names it on
 * every record. `listFamily` answers which handles belong to a family and what
 * state each is in, and `revokeFamily` revokes every record of a family in one
 * operation, so a confirmed theft is not limited by the eight-link successor
 * walk a long-lived chain would exhaust.
 *
 * A store that does not implement this capability remains fully usable: the
 * facade falls back to the bounded successor walk and reports a state event, so
 * the degradation is visible rather than silent.
 */
export interface RouteRefreshBrokerFamilyStore {
    listFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
    revokeFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
}
/**
 * The optional capability a broker store reports its local handle lifetime
 * policy through. The facade compares it with the configured policy at
 * registration, so a deployment cannot declare a long-lived ceiling while its
 * store silently keeps a shorter one.
 */
export interface RouteRefreshBrokerHandleTTLReporter {
    routeRefreshBrokerHandleTTLSeconds(): number;
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
/**
 * The broker record exists but its local lifetime policy elapsed. It is
 * deliberately distinguishable from {@link BrokerNotFoundError} at the SPI so
 * the facade can attribute the failure (expiry versus absence) in telemetry,
 * while the client-facing body stays the uniform `invalid_grant`.
 */
export declare class BrokerExpiredError extends Error {
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
    /**
     * Consume-once. The record leaves the store whichever way the consume ends,
     * so an expired consume is terminal too: the caller sees `expired` once and
     * every later consume of the same hash is `not_found`, even if the clock
     * runs backwards past the record's expiry.
     */
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
    private readonly consumed;
    private readonly now;
    private readonly ttlSeconds;
    constructor(options?: MemoryAuthorizationCodeStoreOptions);
    put(record: AuthorizationCodeRecord): Promise<void>;
    /**
     * Consume-once, but the record is retained so a replay is distinguishable
     * from an unknown code. The stored record is returned unmutated — its status
     * and version are the caller's, exactly as Go's in-memory reference store
     * does — and the terminal signal travels on the result instead: a replayed
     * code sets `replayed`, and a first consume of an expired code sets `expired`.
     * Both are terminal no matter which way the clock moves, so a backwards clock
     * can never make a burned code fresh again.
     */
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
    private readonly now;
    constructor(options?: MemoryClientStoreOptions);
    /**
     * Stores a copy at version 1, defaulting an unset or zero creation instant to
     * the store clock. A client record has no TTL: the age-out policy is the
     * application's, so put never applies one.
     */
    put(record: ClientRecord): Promise<void>;
    get(clientIdHash: string): Promise<ClientRecord | null>;
    update(record: ClientRecord, expectedVersion: number): Promise<ClientRecord>;
}
export interface MemoryRouteRefreshBrokerStoreOptions {
    now?: () => Date;
    lockTtlSeconds?: number;
    ttlSeconds?: number;
}
/**
 * In-memory reference RouteRefreshBrokerStore. Each handle carries its own
 * lifetime: a handle older than the store's TTL reports `expired` from every
 * operation, so it can be neither read, locked, swapped nor revoked, and a swap
 * on an absent handle is `not_found` rather than a create. An aged-out handle
 * is distinguishable from one that never existed at the SPI, even though the
 * facade renders the same client-facing body for both.
 */
export declare class MemoryRouteRefreshBrokerStore implements RouteRefreshBrokerStore, RouteRefreshBrokerSeeder, RouteRefreshBrokerFamilyStore, RouteRefreshBrokerHandleTTLReporter {
    private readonly records;
    private readonly storedAt;
    private readonly now;
    private readonly lockTtlMs;
    private readonly ttlMs;
    constructor(options?: MemoryRouteRefreshBrokerStoreOptions);
    /**
     * Seeds a handle: the store's own create path, and the only way a handle is
     * created. Creation is deliberately not a compare-and-swap, so a swap can
     * never resurrect a handle. A copy is stored with the caller's status
     * preserved verbatim, and a version below 1 is normalized to 1.
     */
    put(record: RouteRefreshBrokerRecord): Promise<void>;
    /**
     * Reads one handle. An unknown key is `null`; a handle whose local lifetime
     * elapsed is {@link BrokerExpiredError}, so the facade can attribute the
     * rejection without making the client-facing body an oracle.
     */
    get(handleHash: string): Promise<RouteRefreshBrokerRecord | null>;
    /**
     * Takes the exclusive refresh lock. The revoked check runs first, then lock
     * exclusivity, then the version guard, so concurrent contenders for one
     * handle observe `locked` rather than a version conflict and a revoked
     * handle never becomes lockable again. The lock expires at its own bound.
     * Acquiring it rewrites the handle's mutable state, so it advances the
     * record's content version; a caller that already held a lock must re-read
     * the handle before taking another one.
     */
    acquireLock(handleHash: string, lockOwner: string, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    /**
     * Versioned compare-and-swap. A swap never creates: an unknown handle is
     * `not_found`, an aged-out handle is `expired`, and creation is the seeder's
     * separate `put`. The presented version must equal
     * the stored record's version, and a revoked record refuses every swap. A
     * replacement that states no status adopts the stored one, so a rotation
     * cannot silently clear the handle's status. A rotation keeps the handle's
     * original stored-at instant, so refreshing a handle upstream does not extend
     * its local lifetime.
     */
    compareAndSwap(record: RouteRefreshBrokerRecord, expectedVersion: number): Promise<RouteRefreshBrokerRecord>;
    /**
     * Revokes the handle. Revocation is idempotent and terminal: the transition
     * into `revoked` advances the record's content version, and a repeat revoke
     * leaves it alone. An aged-out handle is `expired`, not a resurrectable
     * record.
     */
    revoke(handleHash: string): Promise<RouteRefreshBrokerRecord>;
    /**
     * Reports the local handle lifetime policy the store applies, in seconds, so
     * the facade can refuse a configuration that declares a different ceiling.
     */
    routeRefreshBrokerHandleTTLSeconds(): number;
    /**
     * Lists every live record of one refresh family. Aged-out records are purged
     * as they are observed and are not listed; a blank family hash is answered
     * with an empty list, because no record can belong to no family.
     */
    listFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
    /**
     * Revokes every live record of one refresh family and returns the records it
     * handled. Revocation is idempotent, so already-revoked members are returned
     * unchanged rather than reported as errors, and a blank family hash revokes
     * nothing.
     */
    revokeFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
    /** Whether the handle's own lifetime, apart from any refresh lock, elapsed. */
    private expired;
    /**
     * Drops an expired handle. Every access — read or mutation — clears an
     * aged-out handle here, so it can be neither read, locked, swapped nor
     * revoked, and no operation ever recreates it.
     */
    private discard;
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
/**
 * Returns the store key for a protected value: the unpadded base64url SHA-256
 * digest of the value. Every store SPI is keyed by the hash of the value it
 * protects and never by the value itself, so a caller that seeds a record
 * directly — a pre-registered client, for example — derives the key with this
 * helper and the facade derives the same key when it looks the record up.
 */
export declare function hashKey(value: string): string;
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