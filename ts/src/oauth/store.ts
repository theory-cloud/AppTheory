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

  private expired(expiresAt: Date): boolean {
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

  private expired(expiresAt: Date): boolean {
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

  put(record: ClientRecord): Promise<void> {
    this.records.set(record.clientIdHash, {
      ...structuredClone(record),
      version: positiveInteger(record.version, 1),
    });
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
 * In-memory reference RouteRefreshBrokerStore. Each handle carries its own
 * lifetime: a handle older than the store's TTL is treated as absent by every
 * operation, so an expired handle can be neither read, locked, swapped nor
 * revoked, and a swap on an absent handle is `not_found` rather than a create.
 */
export class MemoryRouteRefreshBrokerStore
  implements RouteRefreshBrokerStore, RouteRefreshBrokerSeeder
{
  private readonly records = new Map<string, RouteRefreshBrokerRecord>();
  private readonly storedAt = new Map<string, number>();
  private readonly now: () => Date;
  private readonly lockTtlMs: number;
  private readonly ttlMs: number;

  constructor(options: MemoryRouteRefreshBrokerStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.lockTtlMs = positiveSeconds(options.lockTtlSeconds, 30) * 1000;
    this.ttlMs = positiveSeconds(options.ttlSeconds, 900) * 1000;
  }

  /**
   * Seeds a handle: the store's own create path, and the only way a handle is
   * created. Creation is deliberately not a compare-and-swap, so a swap can
   * never resurrect a handle. A copy is stored at version 1, and a record that
   * carries no status defaults to `active`.
   */
  put(record: RouteRefreshBrokerRecord): Promise<void> {
    const stored: RouteRefreshBrokerRecord = {
      ...structuredClone(record),
      status: record.status || "active",
      version: 1,
    };
    this.records.set(stored.handleHash, stored);
    this.storedAt.set(stored.handleHash, this.now().getTime());
    return Promise.resolve();
  }

  get(handleHash: string): Promise<RouteRefreshBrokerRecord | null> {
    const record = this.records.get(handleHash);
    if (!record) return Promise.resolve(null);
    if (this.expired(handleHash)) {
      this.discard(handleHash);
      return Promise.resolve(null);
    }
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
      return Promise.reject(new BrokerNotFoundError());
    }
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
   * Versioned compare-and-swap. A swap never creates: a handle that does not
   * exist — never seeded, or aged out past its TTL — is `not_found`, and
   * creation is the seeder's separate `put`. The presented version must equal
   * the stored record's version, and a revoked record refuses every swap. A
   * rotation keeps the handle's original stored-at instant, so refreshing a
   * handle upstream does not extend its local lifetime.
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
      return Promise.reject(new BrokerNotFoundError());
    }
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
    this.records.set(swapped.handleHash, swapped);
    return Promise.resolve(structuredClone(swapped));
  }

  /**
   * Revokes the handle. Revocation is idempotent and terminal: the transition
   * into `revoked` advances the record's content version, and a repeat revoke
   * leaves it alone.
   */
  revoke(handleHash: string): Promise<RouteRefreshBrokerRecord> {
    const record = this.records.get(handleHash);
    if (!record) return Promise.reject(new BrokerNotFoundError());
    if (this.expired(handleHash)) {
      this.discard(handleHash);
      return Promise.reject(new BrokerNotFoundError());
    }
    if (record.status !== "revoked") {
      record.status = "revoked";
      record.version += 1;
    }
    delete record.refreshLockOwner;
    delete record.refreshLockExpiresAt;
    return Promise.resolve(structuredClone(record));
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
      const record = clientRecord(key);
      await stores.client.put(record);
      const stored = await stores.client.get(key);
      const updateOutcome = await clientUpdateOutcome(stores, record, 1);
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
      const record = await stores.routeRefreshBroker.get(key);
      return { get: record === null ? "not_found" : "ok" };
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
    default:
      throw new Error(
        `store conformance case ${testCase.id} has an unknown scenario ${testCase.scenario}`,
      );
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

function transactionRecord(key: string, expiresAt: Date): TransactionRecord {
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
    version: 1,
  };
}

function authorizationCodeRecord(
  key: string,
  expiresAt: Date,
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
    status: "issued",
    expiresAt,
    version: 1,
  };
}

function clientRecord(key: string): ClientRecord {
  return {
    clientIdHash: key,
    clientId: "conformance-client",
    redirectUris: ["https://mcp.example.test/_oauth/mcp/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    boundRoute: "https://mcp.example.test/mcp",
    createdAt: new Date(0),
    version: 1,
  };
}

function brokerRecord(key: string): RouteRefreshBrokerRecord {
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
    status: "issued",
    version: 1,
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
