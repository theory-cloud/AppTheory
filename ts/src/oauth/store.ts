import { createHash } from "node:crypto";

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

export type RouteRefreshBrokerStatus =
  | "issued"
  | "active"
  | "refreshing"
  | "revoked"
  | "expired"
  | "reauth_required";

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
  acquireLock(
    handleHash: string,
    lockOwner: string,
    expectedVersion: number,
  ): Promise<RouteRefreshBrokerRecord>;
  compareAndSwap(
    record: RouteRefreshBrokerRecord,
    expectedVersion: number,
  ): Promise<RouteRefreshBrokerRecord>;
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
 * The enumeration/revocation half of the family capability of a broker store. A
 * refresh family is the chain of handles one authorization grant produced;
 * `familyHash` names it on every record. `listFamily` answers which live handles
 * belong to a family and what state each is in, and `revokeFamily` revokes every
 * live record of a family in one operation.
 *
 * This pair alone is not enough for the framework-owned front channel: a
 * conforming store must implement
 * {@link RouteRefreshBrokerTransactionalFamilyStore}, which adds atomic root
 * creation and atomic rotation. The pair remains exported as the incident
 * surface and for stores that keep it while they migrate.
 */
export interface RouteRefreshBrokerFamilyStore {
  listFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
  revokeFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]>;
}

/** Family-state status values of the transactional family capability. */
export const BROKER_FAMILY_STATUS_ACTIVE = "active";
export const BROKER_FAMILY_STATUS_REVOKED = "revoked";

/** The store-internal family-state record behind one refresh family. */
export interface RouteRefreshFamilyState {
  familyHash: string;
  status: string;
  version: number;
  createdAt: Date;
  revokedAt?: Date;
}

/**
 * One atomic rotation request: the presented handle is still locked by
 * `lockOwner` at `expectedVersion`, its family is active, and `successor` does
 * not exist. The store creates the successor, checks the family/generation and
 * identity bindings, writes the grace response onto the presented record,
 * clears the lock, and returns the stored successor.
 */
export interface RouteRefreshFamilyRotation {
  presentedHandleHash: string;
  lockOwner: string;
  expectedVersion: number;
  successor: RouteRefreshBrokerRecord;
  graceRefreshResponse: string;
  graceExpiresAt: Date;
}

/**
 * The mandatory transactional family capability of a broker store used by the
 * framework-owned front channel. It extends the enumeration/revocation pair with
 * atomic root creation and atomic rotation; every Get, AcquireLock, and
 * RotateFamily of a family-marked handle honors the family tombstone.
 */
export interface RouteRefreshBrokerTransactionalFamilyStore extends RouteRefreshBrokerFamilyStore {
  createFamily(
    root: RouteRefreshBrokerRecord,
  ): Promise<RouteRefreshBrokerRecord>;
  rotateFamily(
    rotation: RouteRefreshFamilyRotation,
  ): Promise<RouteRefreshBrokerRecord>;
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
export class ClientVersionConflictError extends Error {
  constructor(message = "client record version conflict") {
    super(message);
    this.name = "ClientVersionConflictError";
  }
}

/** A broker compare-and-swap presented a stale version. */
export class BrokerVersionConflictError extends Error {
  constructor(message = "route refresh broker version conflict") {
    super(message);
    this.name = "BrokerVersionConflictError";
  }
}

/** The broker record is revoked, so it can be neither locked nor refreshed. */
export class BrokerRevokedError extends Error {
  constructor(message = "route refresh broker record is revoked") {
    super(message);
    this.name = "BrokerRevokedError";
  }
}

/** The broker record already holds an unexpired refresh lock. */
export class BrokerLockedError extends Error {
  constructor(message = "route refresh broker record is locked") {
    super(message);
    this.name = "BrokerLockedError";
  }
}

/** No broker record exists for the presented handle. */
export class BrokerNotFoundError extends Error {
  constructor(message = "route refresh broker record not found") {
    super(message);
    this.name = "BrokerNotFoundError";
  }
}

/**
 * The broker record exists but its local lifetime policy elapsed. It is
 * deliberately distinguishable from {@link BrokerNotFoundError} at the SPI so
 * the facade can attribute the failure (expiry versus absence) in telemetry,
 * while the client-facing body stays the uniform `invalid_grant`.
 */
export class BrokerExpiredError extends Error {
  constructor(message = "route refresh broker record expired") {
    super(message);
    this.name = "BrokerExpiredError";
  }
}

/** The broker store lacks the transactional family capability. */
export class BrokerFamilyCapabilityMissingError extends Error {
  constructor(
    message = "route refresh broker store lacks the transactional family capability",
  ) {
    super(message);
    this.name = "BrokerFamilyCapabilityMissingError";
  }
}

/** CreateFamily was called for a family ID that already exists. */
export class BrokerFamilyExistsError extends Error {
  constructor(message = "route refresh family already exists") {
    super(message);
    this.name = "BrokerFamilyExistsError";
  }
}

/** A family-marked record's required family state is missing or corrupt. */
export class BrokerFamilyStateUnavailableError extends Error {
  constructor(message = "route refresh family state is missing or corrupt") {
    super(message);
    this.name = "BrokerFamilyStateUnavailableError";
  }
}

/** A root, successor, or presented record fails its family/generation binding. */
export class BrokerFamilyMismatchError extends Error {
  constructor(message = "route refresh family or generation binding mismatch") {
    super(message);
    this.name = "BrokerFamilyMismatchError";
  }
}

/** A rotation successor handle is already stored. */
export class BrokerSuccessorExistsError extends Error {
  constructor(message = "route refresh successor already exists") {
    super(message);
    this.name = "BrokerSuccessorExistsError";
  }
}

/** A family-less record was presented for ordinary rotation. */
export class BrokerLegacyLineageUnsupportedError extends Error {
  constructor(
    message = "route refresh legacy lineage is unsupported for ordinary rotation",
  ) {
    super(message);
    this.name = "BrokerLegacyLineageUnsupportedError";
  }
}

export interface MemoryTransactionStoreOptions {
  now?: () => Date;
  ttlSeconds?: number;
}

/** In-memory reference TransactionStore. */
export class MemoryTransactionStore implements TransactionStore {
  private readonly records = new Map<string, TransactionRecord>();
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(options: MemoryTransactionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = positiveSeconds(options.ttlSeconds, 600);
  }

  put(record: TransactionRecord): Promise<void> {
    const stored = structuredClone(record);
    if (expiryMs(stored.expiresAt) === null) {
      stored.expiresAt = this.defaultExpiry();
    }
    stored.version = positiveInteger(stored.version, 1);
    this.records.set(stored.stateHash, stored);
    return Promise.resolve();
  }

  /**
   * Consume-once. The record leaves the store whichever way the consume ends,
   * so an expired consume is terminal too: the caller sees `expired` once and
   * every later consume of the same hash is `not_found`, even if the clock
   * runs backwards past the record's expiry.
   */
  consume(stateHash: string): Promise<TransactionRecord | null> {
    const record = this.records.get(stateHash);
    if (!record) return Promise.resolve(null);
    this.records.delete(stateHash);
    record.status = this.expired(record.expiresAt) ? "expired" : "consumed";
    return Promise.resolve(structuredClone(record));
  }

  private expired(expiresAt: Date | undefined): boolean {
    const at = expiryMs(expiresAt);
    return at !== null && this.now().getTime() >= at;
  }

  /** The record's expiry when the store applied its own TTL. */
  private defaultExpiry(): Date {
    return new Date(this.now().getTime() + this.ttlSeconds * 1000);
  }
}

export interface MemoryAuthorizationCodeStoreOptions {
  now?: () => Date;
  ttlSeconds?: number;
}

/** In-memory reference AuthorizationCodeStore. */
export class MemoryAuthorizationCodeStore implements AuthorizationCodeStore {
  private readonly records = new Map<string, AuthorizationCodeRecord>();
  private readonly consumed = new Set<string>();
  private readonly now: () => Date;
  private readonly ttlSeconds: number;

  constructor(options: MemoryAuthorizationCodeStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = positiveSeconds(options.ttlSeconds, 60);
  }

  put(record: AuthorizationCodeRecord): Promise<void> {
    const stored = structuredClone(record);
    if (expiryMs(stored.expiresAt) === null) {
      stored.expiresAt = this.defaultExpiry();
    }
    stored.version = positiveInteger(stored.version, 1);
    this.records.set(stored.codeHash, stored);
    this.consumed.delete(stored.codeHash);
    return Promise.resolve();
  }

  /**
   * Consume-once, but the record is retained so a replay is distinguishable
   * from an unknown code. The stored record is returned unmutated — its status
   * and version are the caller's, exactly as Go's in-memory reference store
   * does — and the terminal signal travels on the result instead: a replayed
   * code sets `replayed`, and a first consume of an expired code sets `expired`.
   * Both are terminal no matter which way the clock moves, so a backwards clock
   * can never make a burned code fresh again.
   */
  consume(codeHash: string): Promise<AuthorizationCodeConsumeResult | null> {
    const record = this.records.get(codeHash);
    if (!record) return Promise.resolve(null);
    if (this.consumed.has(codeHash)) {
      return Promise.resolve({
        record: structuredClone(record),
        replayed: true,
        expired: false,
      });
    }
    this.consumed.add(codeHash);
    const expired = this.expired(record.expiresAt);
    return Promise.resolve({
      record: expired ? null : structuredClone(record),
      replayed: false,
      expired,
    });
  }

  private expired(expiresAt: Date | undefined): boolean {
    const at = expiryMs(expiresAt);
    return at !== null && this.now().getTime() >= at;
  }

  /** The record's expiry when the store applied its own TTL. */
  private defaultExpiry(): Date {
    return new Date(this.now().getTime() + this.ttlSeconds * 1000);
  }
}

export interface MemoryClientStoreOptions {
  now?: () => Date;
}

/** In-memory reference ClientStore. */
export class MemoryClientStore implements ClientStore {
  private readonly records = new Map<string, ClientRecord>();
  private readonly now: () => Date;

  constructor(options: MemoryClientStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Stores a copy at version 1, defaulting an unset or zero creation instant to
   * the store clock. A client record has no TTL: the age-out policy is the
   * application's, so put never applies one.
   */
  put(record: ClientRecord): Promise<void> {
    const stored = structuredClone(record);
    stored.version = 1;
    const createdAtMs = expiryMs(stored.createdAt);
    if (createdAtMs === null || createdAtMs === 0) {
      stored.createdAt = this.now();
    }
    this.records.set(stored.clientIdHash, stored);
    return Promise.resolve();
  }

  get(clientIdHash: string): Promise<ClientRecord | null> {
    const record = this.records.get(clientIdHash);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  update(record: ClientRecord, expectedVersion: number): Promise<ClientRecord> {
    const current = this.records.get(record.clientIdHash);
    if (!current || current.version !== expectedVersion) {
      return Promise.reject(new ClientVersionConflictError());
    }
    const updated: ClientRecord = {
      ...structuredClone(record),
      version: expectedVersion + 1,
    };
    this.records.set(updated.clientIdHash, updated);
    return Promise.resolve(structuredClone(updated));
  }
}

export interface MemoryRouteRefreshBrokerStoreOptions {
  now?: () => Date;
  lockTtlSeconds?: number;
  ttlSeconds?: number;
}

/**
 * The reference broker store's default refresh-lock TTL, matching Go's
 * `oauthstore.DefaultRouteRefreshLockTTL`. It is 15 seconds because the lock has
 * to outlast the single upstream refresh call it protects while staying as short
 * as possible when that call dies: the M2.1 hardened upstream HTTP deadline is 10
 * seconds (the provider adapter's `DEFAULT_FETCH_TIMEOUT_SECONDS`, shared by the
 * discovery, token, and JWKS fetches), so 15 seconds is that deadline plus a
 * five-second margin. It is also well above the facade's three-second coalesce
 * wait cap, so a waiter that is waiting for a rotation can never outlive the lock
 * it is waiting on and steal it. It is deliberately not exported: the value is
 * pinned by the store test through the lock expiry a lock actually writes.
 */
const DEFAULT_ROUTE_REFRESH_LOCK_TTL_SECONDS = 15;

/**
 * In-memory reference RouteRefreshBrokerStore. Each handle carries its own
 * lifetime: a handle older than the store's TTL reports `expired` from every
 * operation, so it can be neither read, locked, swapped nor revoked, and a swap
 * on an absent handle is `not_found` rather than a create. An aged-out handle
 * is distinguishable from one that never existed at the SPI, even though the
 * facade renders the same client-facing body for both.
 */
export class MemoryRouteRefreshBrokerStore
  implements
    RouteRefreshBrokerStore,
    RouteRefreshBrokerSeeder,
    RouteRefreshBrokerTransactionalFamilyStore,
    RouteRefreshBrokerHandleTTLReporter
{
  private readonly records = new Map<string, RouteRefreshBrokerRecord>();
  private readonly storedAt = new Map<string, number>();
  private readonly families = new Map<string, RouteRefreshFamilyState>();
  private readonly now: () => Date;
  private readonly lockTtlMs: number;
  private readonly ttlMs: number;

  constructor(options: MemoryRouteRefreshBrokerStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.lockTtlMs =
      positiveSeconds(
        options.lockTtlSeconds,
        DEFAULT_ROUTE_REFRESH_LOCK_TTL_SECONDS,
      ) * 1000;
    this.ttlMs = positiveSeconds(options.ttlSeconds, 900) * 1000;
  }

  /**
   * Seeds a handle: the store's own create path, and the only way a handle is
   * created. Creation is deliberately not a compare-and-swap, so a swap can
   * never resurrect a handle. A copy is stored with the caller's status
   * preserved verbatim, and a version below 1 is normalized to 1.
   */
  put(record: RouteRefreshBrokerRecord): Promise<void> {
    const stored: RouteRefreshBrokerRecord = {
      ...structuredClone(record),
      version: positiveInteger(record.version, 1),
    };
    this.records.set(stored.handleHash, stored);
    this.storedAt.set(stored.handleHash, this.now().getTime());
    return Promise.resolve();
  }

  /**
   * Reads one handle. An unknown key is `null`; a handle whose local lifetime
   * elapsed is {@link BrokerExpiredError}, so the facade can attribute the
   * rejection without making the client-facing body an oracle.
   */
  get(handleHash: string): Promise<RouteRefreshBrokerRecord | null> {
    const record = this.records.get(handleHash);
    if (!record) return Promise.resolve(null);
    if (this.expired(handleHash)) {
      this.discard(handleHash);
      return Promise.reject(new BrokerExpiredError());
    }
    const familyError = this.familyStateError(record);
    if (familyError !== null) return Promise.reject(familyError);
    return Promise.resolve(structuredClone(record));
  }

  /**
   * Takes the exclusive refresh lock. The revoked check runs first, then lock
   * exclusivity, then the version guard, so concurrent contenders for one
   * handle observe `locked` rather than a version conflict and a revoked
   * handle never becomes lockable again. The lock expires at its own bound.
   * Acquiring it rewrites the handle's mutable state, so it advances the
   * record's content version; a caller that already held a lock must re-read
   * the handle before taking another one.
   */
  acquireLock(
    handleHash: string,
    lockOwner: string,
    expectedVersion: number,
  ): Promise<RouteRefreshBrokerRecord> {
    const record = this.records.get(handleHash);
    if (!record) return Promise.reject(new BrokerNotFoundError());
    if (this.expired(handleHash)) {
      this.discard(handleHash);
      return Promise.reject(new BrokerExpiredError());
    }
    const familyError = this.familyStateError(record);
    if (familyError !== null) return Promise.reject(familyError);
    if (record.status === "revoked") {
      return Promise.reject(new BrokerRevokedError());
    }
    const at = this.now().getTime();
    const lockExpiresAt = expiryMs(record.refreshLockExpiresAt);
    if (lockExpiresAt !== null && at < lockExpiresAt) {
      return Promise.reject(new BrokerLockedError());
    }
    if (record.version !== expectedVersion) {
      return Promise.reject(new BrokerVersionConflictError());
    }
    record.refreshLockOwner = lockOwner;
    record.refreshLockExpiresAt = new Date(at + this.lockTtlMs);
    record.status = "refreshing";
    record.version += 1;
    return Promise.resolve(structuredClone(record));
  }

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
  compareAndSwap(
    record: RouteRefreshBrokerRecord,
    expectedVersion: number,
  ): Promise<RouteRefreshBrokerRecord> {
    const current = this.records.get(record.handleHash);
    if (!current) {
      return Promise.reject(new BrokerNotFoundError());
    }
    if (this.expired(record.handleHash)) {
      this.discard(record.handleHash);
      return Promise.reject(new BrokerExpiredError());
    }
    const familyError = this.familyStateError(current);
    if (familyError !== null) return Promise.reject(familyError);
    if (current.status === "revoked") {
      return Promise.reject(new BrokerRevokedError());
    }
    if (current.version !== expectedVersion) {
      return Promise.reject(new BrokerVersionConflictError());
    }
    const swapped: RouteRefreshBrokerRecord = {
      ...structuredClone(record),
      version: expectedVersion + 1,
    };
    if (!swapped.status) {
      swapped.status = current.status;
    }
    this.records.set(swapped.handleHash, swapped);
    return Promise.resolve(structuredClone(swapped));
  }

  /**
   * Revokes the handle. Revocation is idempotent and terminal: the transition
   * into `revoked` advances the record's content version, and a repeat revoke
   * leaves it alone. An aged-out handle is `expired`, not a resurrectable
   * record.
   */
  revoke(handleHash: string): Promise<RouteRefreshBrokerRecord> {
    const record = this.records.get(handleHash);
    if (!record) return Promise.reject(new BrokerNotFoundError());
    if (this.expired(handleHash)) {
      this.discard(handleHash);
      return Promise.reject(new BrokerExpiredError());
    }
    if (record.status !== "revoked") {
      record.status = "revoked";
      record.version += 1;
    }
    delete record.refreshLockOwner;
    delete record.refreshLockExpiresAt;
    return Promise.resolve(structuredClone(record));
  }

  /**
   * Reports the local handle lifetime policy the store applies, in seconds, so
   * the facade can refuse a configuration that declares a different ceiling.
   */
  routeRefreshBrokerHandleTTLSeconds(): number {
    return this.ttlMs / 1000;
  }

  /**
   * Atomically creates an active family-state record and its generation-1 root
   * record. A pre-existing family ID, active or revoked, is never overwritten or
   * reactivated, and an existing root handle is never replaced.
   */
  createFamily(
    root: RouteRefreshBrokerRecord,
  ): Promise<RouteRefreshBrokerRecord> {
    if (!root.handleHash || !root.familyHash) {
      return Promise.reject(
        new Error("store: family root needs a handle and family hash"),
      );
    }
    if (
      root.familyHash !== root.handleHash ||
      (root.chainGeneration ?? 0) !== 1
    ) {
      return Promise.reject(new BrokerFamilyMismatchError());
    }
    if (root.status !== "issued" && root.status !== "active") {
      return Promise.reject(new BrokerFamilyMismatchError());
    }
    if (this.families.has(root.familyHash)) {
      return Promise.reject(new BrokerFamilyExistsError());
    }
    if (this.records.has(root.handleHash)) {
      return Promise.reject(new BrokerSuccessorExistsError());
    }
    const at = this.now();
    const stored: RouteRefreshBrokerRecord = {
      ...structuredClone(root),
      status: root.status,
      version: 1,
    };
    this.families.set(root.familyHash, {
      familyHash: root.familyHash,
      status: BROKER_FAMILY_STATUS_ACTIVE,
      version: 1,
      createdAt: at,
    });
    this.records.set(stored.handleHash, stored);
    this.storedAt.set(stored.handleHash, at.getTime());
    return Promise.resolve(structuredClone(stored));
  }

  /**
   * Atomically rotates one family handle: lock owner, expected version, active
   * family, matching family/generation/identity, and successor uniqueness are
   * checked before the successor is created and the presented record updated.
   */
  rotateFamily(
    rotation: RouteRefreshFamilyRotation,
  ): Promise<RouteRefreshBrokerRecord> {
    if (
      !rotation.presentedHandleHash ||
      !rotation.successor ||
      !rotation.successor.handleHash
    ) {
      return Promise.reject(
        new Error("store: rotation needs a presented handle and successor"),
      );
    }
    if (!rotation.lockOwner) return Promise.reject(new BrokerLockedError());
    const presented = this.records.get(rotation.presentedHandleHash);
    if (!presented) return Promise.reject(new BrokerNotFoundError());
    if (this.expired(rotation.presentedHandleHash)) {
      this.discard(rotation.presentedHandleHash);
      return Promise.reject(new BrokerExpiredError());
    }
    if (!presented.familyHash) {
      return Promise.reject(new BrokerLegacyLineageUnsupportedError());
    }
    const familyError = this.familyStateError(presented);
    if (familyError !== null) return Promise.reject(familyError);
    if (presented.status === "revoked") {
      return Promise.reject(new BrokerRevokedError());
    }
    const at = this.now().getTime();
    const lockExpiresAt = expiryMs(presented.refreshLockExpiresAt);
    if (
      !presented.refreshLockOwner ||
      presented.refreshLockOwner !== rotation.lockOwner ||
      lockExpiresAt === null ||
      at >= lockExpiresAt
    ) {
      return Promise.reject(new BrokerLockedError());
    }
    if (presented.version !== rotation.expectedVersion) {
      return Promise.reject(new BrokerVersionConflictError());
    }
    const successor = rotation.successor;
    if (successor.handleHash === presented.handleHash) {
      return Promise.reject(new BrokerSuccessorExistsError());
    }
    if (
      successor.familyHash !== presented.familyHash ||
      (successor.chainGeneration ?? 0) !==
        (presented.chainGeneration ?? 0) + 1 ||
      !sameBrokerIdentity(presented, successor)
    ) {
      return Promise.reject(new BrokerFamilyMismatchError());
    }
    if (this.records.has(successor.handleHash)) {
      return Promise.reject(new BrokerSuccessorExistsError());
    }
    const storedSuccessor: RouteRefreshBrokerRecord = {
      ...structuredClone(successor),
      status: successor.status,
      version: 1,
    };
    delete storedSuccessor.refreshLockOwner;
    delete storedSuccessor.refreshLockExpiresAt;
    if (storedSuccessor.status !== "issued") {
      return Promise.reject(new BrokerFamilyMismatchError());
    }
    const completed: RouteRefreshBrokerRecord = {
      ...structuredClone(presented),
      encryptedGraceRefreshResponse: rotation.graceRefreshResponse,
      graceExpiresAt: rotation.graceExpiresAt,
      status: "active",
      version: presented.version + 1,
    };
    delete completed.refreshLockOwner;
    delete completed.refreshLockExpiresAt;
    const presentedStoredAt = this.storedAt.get(presented.handleHash);
    this.records.set(storedSuccessor.handleHash, storedSuccessor);
    this.storedAt.set(storedSuccessor.handleHash, at);
    if (presentedStoredAt !== undefined) {
      this.storedAt.set(presented.handleHash, presentedStoredAt);
    }
    this.records.set(presented.handleHash, completed);
    return Promise.resolve(structuredClone(storedSuccessor));
  }

  /**
   * Lists every live record of one refresh family. Aged-out records are purged
   * as they are observed and are not listed; a blank family hash is answered
   * with an empty list, because no record can belong to no family.
   */
  listFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]> {
    if (String(familyHash ?? "").trim() === "") return Promise.resolve([]);
    const family: RouteRefreshBrokerRecord[] = [];
    for (const [handleHash, record] of this.records) {
      if (this.expired(handleHash)) {
        this.discard(handleHash);
        continue;
      }
      if (record.familyHash === familyHash) {
        family.push(structuredClone(record));
      }
    }
    return Promise.resolve(family);
  }

  /**
   * Atomically writes the family revocation tombstone and revokes every live
   * member it handles. The tombstone is terminal and authoritative: every get,
   * acquireLock, and rotateFamily of a family-marked handle honors it. A family
   * that never existed is an idempotent no-op; a family with live members but no
   * family state is a partially backfilled or corrupt lineage and fails closed.
   */
  revokeFamily(familyHash: string): Promise<RouteRefreshBrokerRecord[]> {
    if (String(familyHash ?? "").trim() === "") return Promise.resolve([]);
    const state = this.families.get(familyHash);
    if (!state) {
      for (const [handleHash, record] of this.records) {
        if (this.expired(handleHash)) continue;
        if (record.familyHash === familyHash) {
          return Promise.reject(new BrokerFamilyStateUnavailableError());
        }
      }
      return Promise.resolve([]);
    }
    if (state.status !== BROKER_FAMILY_STATUS_REVOKED) {
      state.status = BROKER_FAMILY_STATUS_REVOKED;
      state.revokedAt = this.now();
      state.version += 1;
    }
    const family: RouteRefreshBrokerRecord[] = [];
    for (const [handleHash, record] of this.records) {
      if (this.expired(handleHash)) {
        this.discard(handleHash);
        continue;
      }
      if (record.familyHash !== familyHash) continue;
      if (record.status !== "revoked") {
        record.status = "revoked";
        record.version += 1;
      }
      delete record.refreshLockOwner;
      delete record.refreshLockExpiresAt;
      family.push(structuredClone(record));
    }
    return Promise.resolve(family);
  }

  /**
   * Reports the tombstone/binding error a family-marked record raises, or null
   * for a family-less record (which the facade refuses separately).
   */
  private familyStateError(record: RouteRefreshBrokerRecord): Error | null {
    if (!record.familyHash) return null;
    const state = this.families.get(record.familyHash);
    if (!state || !state.familyHash) {
      return new BrokerFamilyStateUnavailableError();
    }
    if (state.status === BROKER_FAMILY_STATUS_REVOKED) {
      return new BrokerRevokedError();
    }
    const generation = record.chainGeneration ?? 0;
    if (generation < 1) return new BrokerFamilyMismatchError();
    if (generation === 1 && record.handleHash !== record.familyHash) {
      return new BrokerFamilyMismatchError();
    }
    return null;
  }

  /** Whether the handle's own lifetime, apart from any refresh lock, elapsed. */
  private expired(handleHash: string): boolean {
    const storedAt = this.storedAt.get(handleHash);
    return (
      storedAt !== undefined && this.now().getTime() >= storedAt + this.ttlMs
    );
  }

  /**
   * Drops an expired handle. Every access — read or mutation — clears an
   * aged-out handle here, so it can be neither read, locked, swapped nor
   * revoked, and no operation ever recreates it.
   */
  private discard(handleHash: string): void {
    this.records.delete(handleHash);
    this.storedAt.delete(handleHash);
  }
}

/** Reports whether a successor preserves every identity field a handle binds. */
function sameBrokerIdentity(
  presented: RouteRefreshBrokerRecord,
  successor: RouteRefreshBrokerRecord,
): boolean {
  return (
    presented.issuer === successor.issuer &&
    presented.stage === successor.stage &&
    presented.canonicalResource === successor.canonicalResource &&
    presented.clientNamespace === successor.clientNamespace &&
    presented.endpointKind === successor.endpointKind &&
    presented.partnerId === successor.partnerId &&
    presented.agentId === successor.agentId &&
    presented.clientIdHash === successor.clientIdHash &&
    presented.subjectIdHash === successor.subjectIdHash &&
    presented.scopeFingerprint === successor.scopeFingerprint &&
    presented.upstreamClientId === successor.upstreamClientId
  );
}

export interface MemoryRateLimitStoreOptions {
  now?: () => Date;
  limit?: number;
  windowSeconds?: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/** In-memory reference RateLimitStore. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly now: () => Date;
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.defaultLimit = positiveInteger(options.limit, 60);
    this.defaultWindowSeconds = positiveSeconds(options.windowSeconds, 60);
  }

  /**
   * Increments one bucket and reports whether the increment stayed inside its
   * budget. The bucket is opened (or rolled over once its window elapsed) and
   * incremented before this method returns any promise, so concurrent checks
   * cannot interleave between the read and the write.
   */
  checkAndIncrement(key: RateLimitBucketKey): Promise<RateLimitResult> {
    const bucketKey = [key.identifier, key.resource, key.operation].join(
      "\u0000",
    );
    const limit = positiveInteger(key.limit, this.defaultLimit);
    const windowMs =
      positiveSeconds(key.windowSeconds, this.defaultWindowSeconds) * 1000;
    const at = this.now().getTime();
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || at >= bucket.resetAt) {
      bucket = { count: 0, resetAt: at + windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    const result: RateLimitResult = {
      allowed: bucket.count <= limit,
      limit,
      count: bucket.count,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: new Date(bucket.resetAt),
    };
    return Promise.resolve(result);
  }
}

/**
 * Returns the store key for a protected value: the unpadded base64url SHA-256
 * digest of the value. Every store SPI is keyed by the hash of the value it
 * protects and never by the value itself, so a caller that seeds a record
 * directly — a pre-registered client, for example — derives the key with this
 * helper and the facade derives the same key when it looks the record up.
 */
export function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
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
export async function runStoreConformance(
  stores: Stores,
  cases: StoreConformanceCase[],
  clock: ManualClock,
): Promise<{ ran: number }> {
  const epoch = clock.now();
  let ran = 0;
  for (const testCase of cases ?? []) {
    clock.set(epoch);
    const actual = await runStoreCase(stores, testCase, clock);
    const expect = testCase.expect ?? {};
    const observed: Record<string, unknown> = {};
    for (const key of Object.keys(expect)) observed[key] = actual[key];
    if (!deepEqual(observed, expect)) {
      throw new Error(
        `store conformance case ${testCase.id} failed: expected ${JSON.stringify(expect)}, got ${JSON.stringify(observed)}`,
      );
    }
    ran += 1;
  }
  return { ran };
}

async function runStoreCase(
  stores: Stores,
  testCase: StoreConformanceCase,
  clock: ManualClock,
): Promise<Record<string, unknown>> {
  const params = testCase.params ?? {};
  const key = testCase.id;
  switch (testCase.scenario) {
    case "consume_single_use": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 600);
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      const first = await stores.transaction.consume(key);
      const second = await stores.transaction.consume(key);
      return {
        first: transactionOutcome(first),
        second: transactionOutcome(second),
      };
    }
    case "consume_after_ttl": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 600);
      if (testCase.store === "authorization_code") {
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
        );
        clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
        const result = await stores.authorizationCode.consume(key);
        return { consume: authorizationCodeOutcome(result) };
      }
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      const consumed = await stores.transaction.consume(key);
      return { consume: transactionOutcome(consumed) };
    }
    case "consume_unknown": {
      const codeHash = key;
      if (testCase.store === "authorization_code") {
        const result = await stores.authorizationCode.consume(codeHash);
        return { consume: authorizationCodeOutcome(result) };
      }
      const result = await stores.transaction.consume(codeHash);
      return { consume: transactionOutcome(result) };
    }
    case "consume_single_use_then_replay": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 60);
      await stores.authorizationCode.put(
        authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      const first = await stores.authorizationCode.consume(key);
      const second = await stores.authorizationCode.consume(key);
      return {
        first: authorizationCodeOutcome(first),
        second: authorizationCodeOutcome(second),
      };
    }
    case "consume_record_payload": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 60);
      await stores.authorizationCode.put(
        authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      const first = await stores.authorizationCode.consume(key);
      const replay = await stores.authorizationCode.consume(key);
      const fields = (
        result: AuthorizationCodeConsumeResult | null,
      ): { status: string; version: number } =>
        result === null || result.record === null
          ? { status: "none", version: -1 }
          : { status: result.record.status, version: result.record.version };
      const firstFields = fields(first);
      const replayFields = fields(replay);
      return {
        first: authorizationCodeOutcome(first),
        first_status: firstFields.status,
        first_version: firstFields.version,
        replay: authorizationCodeOutcome(replay),
        replay_status: replayFields.status,
        replay_version: replayFields.version,
      };
    }
    case "put_payload": {
      const putStatus =
        typeof params["put_status"] === "string" ? params["put_status"] : "";
      const putVersion = numberParam(params, "put_version", 0);
      if (testCase.store === "transaction") {
        const ttlSeconds = numberParam(params, "ttl_seconds", 600);
        await stores.transaction.put(
          transactionRecord(
            key,
            addSeconds(clock.now(), ttlSeconds),
            putVersion,
          ),
        );
        const consumed = await stores.transaction.consume(key);
        // The status is deliberately not reported for the transaction store:
        // Go hands back the caller's status while this store stamps the consume
        // outcome on the record, so the two encodings differ by design.
        return {
          consume: transactionOutcome(consumed),
          version: consumed?.version ?? -1,
        };
      }
      if (testCase.store === "authorization_code") {
        const ttlSeconds = numberParam(params, "ttl_seconds", 60);
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds), {
            status: putStatus,
            version: putVersion,
          }),
        );
        const result = await stores.authorizationCode.consume(key);
        const record = result?.record ?? null;
        return {
          consume: authorizationCodeOutcome(result),
          status: record?.status ?? "none",
          version: record?.version ?? -1,
        };
      }
      await seedBrokerRecord(
        stores,
        brokerRecord(key, { status: putStatus, version: putVersion }),
      );
      const record = await stores.routeRefreshBroker.get(key);
      return {
        get: record === null ? "not_found" : "ok",
        status: record?.status ?? "none",
        version: record?.version ?? -1,
      };
    }
    case "concurrent_consume": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 60);
      const concurrency = numberParam(params, "concurrency", 16);
      if (testCase.store === "authorization_code") {
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
        );
        const results = await Promise.all(
          Array.from({ length: concurrency }, () =>
            stores.authorizationCode.consume(key),
          ),
        );
        return tally(
          results.map((result) => authorizationCodeOutcome(result)),
          testCase.expect,
        );
      }
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          stores.transaction.consume(key),
        ),
      );
      return tally(
        results.map((result) => transactionOutcome(result)),
        testCase.expect,
      );
    }
    case "put_get_update": {
      // The store's put owns the stored version, so a row that supplies a
      // put_version above 1 pins that put forces version 1.
      const record = clientRecord(key, numberParam(params, "put_version", 0));
      await stores.client.put(record);
      const stored = await stores.client.get(key);
      const updateOutcome = await clientUpdateOutcome(
        stores,
        stored ?? record,
        stored?.version ?? 1,
      );
      return {
        get_version: stored?.version ?? 0,
        update: updateOutcome.outcome,
        updated_version: updateOutcome.version,
      };
    }
    case "update_stale_version": {
      const record = clientRecord(key);
      await stores.client.put(record);
      await clientUpdateOutcome(stores, record, 1);
      const conflict = await clientUpdateOutcome(stores, record, 1);
      const stored = await stores.client.get(key);
      return {
        update: conflict.outcome,
        get_version: stored?.version ?? 0,
      };
    }
    case "get_unknown": {
      if (testCase.store === "route_refresh_broker") {
        const record = await stores.routeRefreshBroker.get(key);
        return { get: record === null ? "not_found" : "ok" };
      }
      const record = await stores.client.get(key);
      return { get: record === null ? "not_found" : "ok" };
    }
    case "acquire_lock_exclusive_with_expiry": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const first = await brokerLockOutcome(stores, key, "owner-a", 1);
      // Acquiring the lock advances the record's version, so a contender
      // presents the version it would have read after the first acquisition.
      const held = await stores.routeRefreshBroker.get(key);
      const contended = await brokerLockOutcome(
        stores,
        key,
        "owner-b",
        held?.version ?? 1,
      );
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      const current = await stores.routeRefreshBroker.get(key);
      const afterExpiry = await brokerLockOutcome(
        stores,
        key,
        "owner-b",
        current?.version ?? 1,
      );
      return { first, contended, after_expiry: afterExpiry };
    }
    case "compare_and_swap_versioned": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const acquired = await brokerLockOutcome(stores, key, "owner-a", 1);
      const held = await stores.routeRefreshBroker.get(key);
      const version = held?.version ?? 1;
      const swapped = await brokerSwapOutcome(
        stores,
        brokerRecord(key),
        version,
      );
      const stale = await brokerSwapOutcome(stores, brokerRecord(key), version);
      return { acquire_lock: acquired, swap: swapped, stale_swap: stale };
    }
    case "compare_and_swap_inherits_status": {
      // A rotation that states no status adopts the stored one, so a swap
      // against a locked handle stays refreshing rather than clearing it.
      await seedBrokerRecord(stores, brokerRecord(key, { status: "issued" }));
      const seeded = await stores.routeRefreshBroker.get(key);
      await stores.routeRefreshBroker.acquireLock(
        key,
        "owner-inherit",
        seeded?.version ?? 1,
      );
      const held = await stores.routeRefreshBroker.get(key);
      const swapped = await stores.routeRefreshBroker.compareAndSwap(
        brokerRecord(key, { status: "" }),
        held?.version ?? 1,
      );
      return { status: swapped.status };
    }
    case "compare_and_swap_unknown": {
      // A swap never creates: this handle was never seeded, so the swap is
      // not-found in every runtime and creation stays the seeder's own path.
      return { swap: await brokerSwapOutcome(stores, brokerRecord(key), 0) };
    }
    case "negative_expected_version": {
      // A negative expected version is never a skip-version-check wildcard:
      // the swap and the lock both report a version conflict, in every runtime.
      await seedBrokerRecord(stores, brokerRecord(key));
      const record = await stores.routeRefreshBroker.get(key);
      if (record === null) {
        throw new Error(
          `store conformance case ${testCase.id}: the seeded handle is missing`,
        );
      }
      const swap = await brokerSwapOutcome(stores, record, -1);
      let acquireLock: string;
      try {
        await stores.routeRefreshBroker.acquireLock(key, "owner-negative", -1);
        acquireLock = "ok";
      } catch (err) {
        acquireLock = brokerErrorOutcome(err);
      }
      return { swap, acquire_lock: acquireLock };
    }
    case "revoke_idempotent": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const first = await revokeOutcome(stores, key);
      const again = await revokeOutcome(stores, key);
      const record = await stores.routeRefreshBroker.get(key);
      return {
        revoke: first,
        revoke_again: again,
        status: record?.status ?? "not_found",
      };
    }
    case "revoke_then_lock": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const revoked = await revokeOutcome(stores, key);
      const locked = await brokerLockOutcome(stores, key, "owner-a", 1);
      return { revoke: revoked, acquire_lock: locked };
    }
    case "concurrent_acquire_lock": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const concurrency = numberParam(params, "concurrency", 16);
      const results = await Promise.all(
        Array.from({ length: concurrency }, (_unused, index) =>
          brokerLockOutcome(stores, key, `owner-${index}`, 1),
        ),
      );
      return tally(results, testCase.expect);
    }
    case "concurrent_revoke": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const concurrency = numberParam(params, "concurrency", 16);
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => revokeOutcome(stores, key)),
      );
      return tally(results, testCase.expect);
    }
    case "check_and_increment": {
      const limit = numberParam(params, "limit", 1);
      const windowSeconds = numberParam(params, "window_seconds", 60);
      const checks = numberParam(params, "checks", 1);
      const outcomes: string[] = [];
      for (let index = 0; index < checks; index += 1) {
        outcomes.push(
          await rateLimitOutcome(stores, {
            identifier: key,
            resource: "conformance",
            operation: "check_and_increment",
            limit,
            windowSeconds,
          }),
        );
      }
      return { outcomes };
    }
    case "window_reset": {
      const limit = numberParam(params, "limit", 1);
      const windowSeconds = numberParam(params, "window_seconds", 60);
      const rateLimitKey = {
        identifier: key,
        resource: "conformance",
        operation: "window_reset",
        limit,
        windowSeconds,
      };
      const first = await rateLimitOutcome(stores, rateLimitKey);
      const second = await rateLimitOutcome(stores, rateLimitKey);
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      const afterWindow = await rateLimitOutcome(stores, rateLimitKey);
      return { first, second, after_window: afterWindow };
    }
    case "consume_after_ttl_then_replay": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 600);
      const advanceMs = numberParam(params, "advance_seconds", 0) * 1000;
      if (testCase.store === "authorization_code") {
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
        );
        clock.advance(advanceMs);
        const first = await stores.authorizationCode.consume(key);
        const second = await stores.authorizationCode.consume(key);
        return {
          first: authorizationCodeOutcome(first),
          second: authorizationCodeOutcome(second),
        };
      }
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      clock.advance(advanceMs);
      const first = await stores.transaction.consume(key);
      const second = await stores.transaction.consume(key);
      return {
        first: transactionOutcome(first),
        second: transactionOutcome(second),
      };
    }
    case "clock_back_after_consume": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 600);
      const backMs = numberParam(params, "clock_back_seconds", 0) * 1000;
      if (testCase.store === "authorization_code") {
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
        );
        const first = await stores.authorizationCode.consume(key);
        clock.advance(-backMs);
        const afterClockBack = await stores.authorizationCode.consume(key);
        return {
          first: authorizationCodeOutcome(first),
          after_clock_back: authorizationCodeOutcome(afterClockBack),
        };
      }
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      const first = await stores.transaction.consume(key);
      clock.advance(-backMs);
      const afterClockBack = await stores.transaction.consume(key);
      return {
        first: transactionOutcome(first),
        after_clock_back: transactionOutcome(afterClockBack),
      };
    }
    case "clock_back_after_expired_consume": {
      const ttlSeconds = numberParam(params, "ttl_seconds", 600);
      const advanceMs = numberParam(params, "advance_seconds", 0) * 1000;
      const backMs = numberParam(params, "clock_back_seconds", 0) * 1000;
      if (testCase.store === "authorization_code") {
        await stores.authorizationCode.put(
          authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)),
        );
        clock.advance(advanceMs);
        const first = await stores.authorizationCode.consume(key);
        clock.advance(-backMs);
        const afterClockBack = await stores.authorizationCode.consume(key);
        return {
          first: authorizationCodeOutcome(first),
          after_clock_back: authorizationCodeOutcome(afterClockBack),
        };
      }
      await stores.transaction.put(
        transactionRecord(key, addSeconds(clock.now(), ttlSeconds)),
      );
      clock.advance(advanceMs);
      const first = await stores.transaction.consume(key);
      clock.advance(-backMs);
      const afterClockBack = await stores.transaction.consume(key);
      return {
        first: transactionOutcome(first),
        after_clock_back: transactionOutcome(afterClockBack),
      };
    }
    case "broker_ttl_boundary": {
      await seedBrokerRecord(stores, brokerRecord(key));
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      return { get: await brokerReadOutcome(stores, key) };
    }
    case "broker_expired_refuses_lock": {
      await seedBrokerRecord(stores, brokerRecord(key));
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      return {
        acquire_lock: await brokerLockOutcome(stores, key, "owner-ttl", 1),
      };
    }
    case "broker_expired_refuses_swap": {
      await seedBrokerRecord(stores, brokerRecord(key));
      // Capture the live handle first; once the clock passes the handle's TTL
      // it reads as absent, and the swap must be refused, not recreated.
      const record =
        (await stores.routeRefreshBroker.get(key)) ?? brokerRecord(key);
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      return { swap: await brokerSwapOutcome(stores, record, record.version) };
    }
    case "broker_expired_vs_unknown": {
      // An unknown key and an aged-out key report different outcomes at the
      // SPI, even though the client-facing body is the same.
      await seedBrokerRecord(stores, brokerRecord(key));
      clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
      return {
        unknown: await brokerReadOutcome(stores, `${key}-unknown`),
        expired: await brokerReadOutcome(stores, key),
      };
    }
    case "list_family": {
      const family = brokerFamilyStore(stores);
      const familyHash = `${key}-family`;
      const otherHash = `${key}-other-family`;
      const familySize = numberParam(params, "family_size", 0);
      const otherSize = numberParam(params, "other_family_size", 0);
      await seedFamilyWithRoot(stores, familyHash, familySize, key, "member");
      await seedFamilyWithRoot(stores, otherHash, otherSize, key, "other");
      const records = await family.listFamily(familyHash);
      const otherRecords = await family.listFamily(otherHash);
      return {
        family_size: records.length,
        other_family_size: otherRecords.length,
      };
    }
    case "revoke_family": {
      const family = brokerFamilyStore(stores);
      const familyHash = `${key}-family`;
      const otherHash = `${key}-other-family`;
      const familySize = numberParam(params, "family_size", 0);
      const otherSize = numberParam(params, "other_family_size", 0);
      await seedFamilyWithRoot(stores, familyHash, familySize, key, "member");
      await seedFamilyWithRoot(stores, otherHash, otherSize, key, "other");
      const familyKeys: string[] = [];
      const otherKeys: string[] = [];
      for (let index = 0; index < familySize; index += 1) {
        familyKeys.push(index === 0 ? familyHash : `${key}-member-${index}`);
      }
      for (let index = 0; index < otherSize; index += 1) {
        otherKeys.push(index === 0 ? otherHash : `${key}-other-${index}`);
      }
      const revoked = await family.revokeFamily(familyHash);
      const familyStatuses: string[] = [];
      for (const handleHash of familyKeys) {
        try {
          const record = await stores.routeRefreshBroker.get(handleHash);
          familyStatuses.push(record?.status ?? "not_found");
        } catch (err) {
          if (err instanceof BrokerRevokedError) {
            familyStatuses.push("revoked");
            continue;
          }
          throw err;
        }
      }
      const otherStatuses: string[] = [];
      for (const handleHash of otherKeys) {
        const record = await stores.routeRefreshBroker.get(handleHash);
        otherStatuses.push(record?.status ?? "not_found");
      }
      familyStatuses.sort();
      otherStatuses.sort();
      return {
        revoked_family_size: revoked.length,
        family_statuses: familyStatuses,
        other_statuses: otherStatuses,
      };
    }
    case "revoke_then_swap": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const revoked = await stores.routeRefreshBroker.revoke(key);
      return {
        revoke: "ok",
        swap: await brokerSwapOutcome(stores, revoked, revoked.version),
      };
    }
    case "acquire_lock_bumps_version": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const before = await stores.routeRefreshBroker.get(key);
      const version = before?.version ?? 0;
      await stores.routeRefreshBroker.acquireLock(key, "owner-bump", version);
      const after = await stores.routeRefreshBroker.get(key);
      return { version_delta: (after?.version ?? 0) - version };
    }
    case "acquire_lock_sets_refreshing": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const before = await stores.routeRefreshBroker.get(key);
      await stores.routeRefreshBroker.acquireLock(
        key,
        "owner-status",
        before?.version ?? 0,
      );
      const record = await stores.routeRefreshBroker.get(key);
      return { status: record?.status ?? "not_found" };
    }
    case "revoke_bumps_version": {
      await seedBrokerRecord(stores, brokerRecord(key));
      const stored = await stores.routeRefreshBroker.get(key);
      const v0 = stored?.version ?? 0;
      await stores.routeRefreshBroker.revoke(key);
      const revoked = await stores.routeRefreshBroker.get(key);
      const v1 = revoked?.version ?? 0;
      await stores.routeRefreshBroker.revoke(key);
      const again = await stores.routeRefreshBroker.get(key);
      const v2 = again?.version ?? 0;
      return {
        revoke_version_delta: v1 - v0,
        revoke_again_version_delta: v2 - v1,
      };
    }
    default: {
      if (testCase.scenario.startsWith("family_")) {
        const { runFamilyConformanceCase } =
          await import("./family-conformance.js");
        return runFamilyConformanceCase(stores, testCase, clock);
      }
      throw new Error(
        `store conformance case ${testCase.id} has an unknown scenario ${testCase.scenario}`,
      );
    }
  }
}

/** Places one broker handle through the store's own create path (the seeder). */
async function seedBrokerRecord(
  stores: Stores,
  record: RouteRefreshBrokerRecord,
): Promise<void> {
  const seeder = stores.routeRefreshBroker as Partial<RouteRefreshBrokerSeeder>;
  if (typeof seeder.put !== "function") {
    throw new Error(
      "store conformance: route refresh broker store is not seedable (no put)",
    );
  }
  await seeder.put(record);
}

/**
 * Reads one broker handle in the fixture's outcome vocabulary: `ok`, `expired`,
 * or `not_found`.
 */
async function brokerReadOutcome(
  stores: Stores,
  handleHash: string,
): Promise<string> {
  try {
    const record = await stores.routeRefreshBroker.get(handleHash);
    return record === null ? "not_found" : "ok";
  } catch (err) {
    if (err instanceof BrokerExpiredError) return "expired";
    if (err instanceof BrokerNotFoundError) return "not_found";
    throw err;
  }
}

/** The optional family capability a family row exercises. */
function brokerFamilyStore(stores: Stores): RouteRefreshBrokerFamilyStore {
  const family =
    stores.routeRefreshBroker as Partial<RouteRefreshBrokerFamilyStore>;
  if (
    typeof family.listFamily !== "function" ||
    typeof family.revokeFamily !== "function"
  ) {
    throw new Error(
      "store conformance: route refresh broker store does not implement the family capability",
    );
  }
  return family as RouteRefreshBrokerFamilyStore;
}

/**
 * Places one family member through the store's own create path. A family
 * member is a policy-era record: generation 1 with the family hash the row
 * supplied.
 */
async function seedBrokerFamilyRecord(
  stores: Stores,
  handleHash: string,
  familyHash: string,
): Promise<void> {
  await seedBrokerRecord(
    stores,
    brokerRecord(handleHash, {
      status: "active",
      chainGeneration: 2,
      familyHash,
    }),
  );
}

/**
 * Creates a family root through the transactional capability and backfills the
 * remaining members through the store's create path, so the family rows start
 * from a lineage the new contract can rotate and revoke.
 */
async function seedFamilyWithRoot(
  stores: Stores,
  familyHash: string,
  size: number,
  key: string,
  prefix: string,
): Promise<void> {
  if (size <= 0) return;
  const family =
    stores.routeRefreshBroker as Partial<RouteRefreshBrokerTransactionalFamilyStore>;
  if (typeof family.createFamily !== "function") {
    throw new Error(
      "store conformance: broker lacks the transactional family capability",
    );
  }
  await family.createFamily(
    brokerRecord(familyHash, {
      status: "active",
      chainGeneration: 1,
      familyHash,
    }),
  );
  for (let index = 1; index < size; index += 1) {
    await seedBrokerFamilyRecord(
      stores,
      `${key}-${prefix}-${index}`,
      familyHash,
    );
  }
}

async function clientUpdateOutcome(
  stores: Stores,
  record: ClientRecord,
  expectedVersion: number,
): Promise<{ outcome: string; version: number }> {
  try {
    const updated = await stores.client.update(record, expectedVersion);
    return { outcome: "ok", version: updated.version };
  } catch (err) {
    if (err instanceof ClientVersionConflictError) {
      return { outcome: "version_conflict", version: 0 };
    }
    throw err;
  }
}

async function brokerLockOutcome(
  stores: Stores,
  handleHash: string,
  owner: string,
  expectedVersion: number,
): Promise<string> {
  try {
    await stores.routeRefreshBroker.acquireLock(
      handleHash,
      owner,
      expectedVersion,
    );
    return "ok";
  } catch (err) {
    return brokerErrorOutcome(err);
  }
}

async function brokerSwapOutcome(
  stores: Stores,
  record: RouteRefreshBrokerRecord,
  expectedVersion: number,
): Promise<string> {
  try {
    await stores.routeRefreshBroker.compareAndSwap(record, expectedVersion);
    return "ok";
  } catch (err) {
    return brokerErrorOutcome(err);
  }
}

async function revokeOutcome(
  stores: Stores,
  handleHash: string,
): Promise<string> {
  try {
    await stores.routeRefreshBroker.revoke(handleHash);
    return "ok";
  } catch (err) {
    return brokerErrorOutcome(err);
  }
}

function brokerErrorOutcome(err: unknown): string {
  if (err instanceof BrokerLockedError) return "locked";
  if (err instanceof BrokerRevokedError) return "revoked";
  if (err instanceof BrokerVersionConflictError) return "version_conflict";
  if (err instanceof BrokerNotFoundError) return "not_found";
  if (err instanceof BrokerExpiredError) return "expired";
  throw err;
}

async function rateLimitOutcome(
  stores: Stores,
  key: RateLimitBucketKey,
): Promise<string> {
  const result = await stores.rateLimit.checkAndIncrement(key);
  return result.allowed ? "allowed" : "limited";
}

function transactionOutcome(record: TransactionRecord | null): string {
  if (!record) return "not_found";
  if (record.status === "expired") return "expired";
  return "ok";
}

function authorizationCodeOutcome(
  result: AuthorizationCodeConsumeResult | null,
): string {
  if (!result) return "not_found";
  if (result.replayed) return "replayed";
  if (result.expired) return "expired";
  return "ok";
}

/** Counts outcomes, keyed by the `expect` shape so zero-count rows still compare. */
function tally(
  outcomes: string[],
  expect: Record<string, unknown>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of Object.keys(expect)) counts[name] = 0;
  for (const outcome of outcomes) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

function transactionRecord(
  key: string,
  expiresAt: Date,
  version = 1,
): TransactionRecord {
  return {
    stateHash: key,
    clientIdHash: `client-hash:${key}`,
    clientId: "conformance-client",
    redirectUri: "https://mcp.example.test/_oauth/mcp/callback",
    codeChallenge: "conformance-code-challenge",
    codeChallengeMethod: "S256",
    clientState: "conformance-client-state",
    encryptedUpstreamCodeVerifier: "encrypted-upstream-code-verifier",
    scopes: ["mcp:tools"],
    canonicalResource: "https://mcp.example.test/mcp",
    endpointKind: "mcp",
    clientNamespace: "conformance",
    partnerId: "",
    agentId: "",
    status: "pending",
    expiresAt,
    version,
  };
}

function authorizationCodeRecord(
  key: string,
  expiresAt: Date,
  overrides: { status?: string; version?: number } = {},
): AuthorizationCodeRecord {
  return {
    codeHash: key,
    clientIdHash: `client-hash:${key}`,
    clientId: "conformance-client",
    redirectUri: "https://mcp.example.test/_oauth/mcp/callback",
    codeChallenge: "conformance-code-challenge",
    codeChallengeMethod: "S256",
    scopes: ["mcp:tools"],
    canonicalResource: "https://mcp.example.test/mcp",
    endpointKind: "mcp",
    clientNamespace: "conformance",
    partnerId: "",
    agentId: "",
    routeRefreshHandleHash: `handle-hash:${key}`,
    encryptedRouteRefreshHandle: "encrypted-route-refresh-handle",
    encryptedTokenResponse: "encrypted-token-response",
    status: (overrides.status ?? "issued") as AuthorizationCodeStatus,
    expiresAt,
    version: overrides.version ?? 1,
  };
}

function clientRecord(key: string, version = 1): ClientRecord {
  return {
    clientIdHash: key,
    clientId: "conformance-client",
    redirectUris: ["https://mcp.example.test/_oauth/mcp/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    boundRoute: "https://mcp.example.test/mcp",
    createdAt: new Date(0),
    version,
  };
}

function brokerRecord(
  key: string,
  overrides: {
    status?: string;
    version?: number;
    chainGeneration?: number;
    familyHash?: string;
  } = {},
): RouteRefreshBrokerRecord {
  return {
    handleHash: key,
    issuer: "https://auth.example.test",
    stage: "lab",
    canonicalResource: "https://mcp.example.test/mcp",
    clientNamespace: "conformance",
    endpointKind: "mcp",
    partnerId: "",
    agentId: "",
    clientIdHash: `client-hash:${key}`,
    subjectIdHash: `subject-hash:${key}`,
    scopes: ["mcp:tools"],
    scopeFingerprint: "conformance-scope-fingerprint",
    encryptedUpstreamRefreshToken: "encrypted-upstream-refresh-token",
    upstreamRefreshTokenHash: `refresh-token-hash:${key}`,
    upstreamClientId: "conformance-client",
    status: (overrides.status ?? "issued") as RouteRefreshBrokerStatus,
    version: overrides.version ?? 1,
    ...(overrides.chainGeneration === undefined
      ? {}
      : { chainGeneration: overrides.chainGeneration }),
    ...(overrides.familyHash === undefined
      ? {}
      : { familyHash: overrides.familyHash }),
  };
}

function numberParam(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.valueOf() + seconds * 1000);
}

function expiryMs(value: Date | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const at = value.valueOf();
  return Number.isNaN(at) ? null : at;
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((name) => deepEqual(a[name], b[name]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
