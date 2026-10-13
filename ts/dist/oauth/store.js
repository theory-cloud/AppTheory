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
/** In-memory reference TransactionStore. */
export class MemoryTransactionStore {
    records = new Map();
    now;
    ttlSeconds;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.ttlSeconds = positiveSeconds(options.ttlSeconds, 600);
    }
    put(record) {
        const stored = structuredClone(record);
        if (expiryMs(stored.expiresAt) === null) {
            stored.expiresAt = this.defaultExpiry();
        }
        this.records.set(stored.stateHash, stored);
        return Promise.resolve();
    }
    consume(stateHash) {
        const record = this.records.get(stateHash);
        if (!record)
            return Promise.resolve(null);
        if (this.expired(record.expiresAt)) {
            record.status = "expired";
            return Promise.resolve(structuredClone(record));
        }
        this.records.delete(stateHash);
        record.status = "consumed";
        return Promise.resolve(structuredClone(record));
    }
    expired(expiresAt) {
        const at = expiryMs(expiresAt);
        return at !== null && this.now().getTime() >= at;
    }
    /** The record's expiry when the store applied its own TTL. */
    defaultExpiry() {
        return new Date(this.now().getTime() + this.ttlSeconds * 1000);
    }
}
/** In-memory reference AuthorizationCodeStore. */
export class MemoryAuthorizationCodeStore {
    records = new Map();
    now;
    ttlSeconds;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.ttlSeconds = positiveSeconds(options.ttlSeconds, 60);
    }
    put(record) {
        const stored = structuredClone(record);
        if (expiryMs(stored.expiresAt) === null) {
            stored.expiresAt = this.defaultExpiry();
        }
        this.records.set(stored.codeHash, stored);
        return Promise.resolve();
    }
    consume(codeHash) {
        const record = this.records.get(codeHash);
        if (!record)
            return Promise.resolve(null);
        if (this.expired(record.expiresAt)) {
            record.status = "expired";
            return Promise.resolve({
                record: structuredClone(record),
                replayed: false,
            });
        }
        const replayed = record.status === "consumed";
        if (!replayed)
            record.status = "consumed";
        return Promise.resolve({ record: structuredClone(record), replayed });
    }
    expired(expiresAt) {
        const at = expiryMs(expiresAt);
        return at !== null && this.now().getTime() >= at;
    }
    /** The record's expiry when the store applied its own TTL. */
    defaultExpiry() {
        return new Date(this.now().getTime() + this.ttlSeconds * 1000);
    }
}
/** In-memory reference ClientStore. */
export class MemoryClientStore {
    records = new Map();
    put(record) {
        this.records.set(record.clientIdHash, {
            ...structuredClone(record),
            version: positiveInteger(record.version, 1),
        });
        return Promise.resolve();
    }
    get(clientIdHash) {
        const record = this.records.get(clientIdHash);
        return Promise.resolve(record ? structuredClone(record) : null);
    }
    update(record, expectedVersion) {
        const current = this.records.get(record.clientIdHash);
        if (!current || current.version !== expectedVersion) {
            return Promise.reject(new ClientVersionConflictError());
        }
        const updated = {
            ...structuredClone(record),
            version: expectedVersion + 1,
        };
        this.records.set(updated.clientIdHash, updated);
        return Promise.resolve(structuredClone(updated));
    }
}
/** In-memory reference RouteRefreshBrokerStore. */
export class MemoryRouteRefreshBrokerStore {
    records = new Map();
    now;
    lockTtlMs;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.lockTtlMs = positiveSeconds(options.lockTtlSeconds, 30) * 1000;
    }
    get(handleHash) {
        const record = this.records.get(handleHash);
        return Promise.resolve(record ? structuredClone(record) : null);
    }
    /**
     * Takes the exclusive refresh lock. The revoked check runs first, then lock
     * exclusivity, then the version guard, so concurrent contenders for one
     * handle observe `locked` rather than a version conflict and a revoked
     * handle never becomes lockable again. The lock expires at its own bound;
     * acquiring it does not advance the record's content version.
     */
    acquireLock(handleHash, lockOwner, expectedVersion) {
        const record = this.records.get(handleHash);
        if (!record)
            return Promise.reject(new BrokerNotFoundError());
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
        return Promise.resolve(structuredClone(record));
    }
    /**
     * Versioned compare-and-swap. A version of `0` is the optimistic-create
     * sentinel: it stores the record only when no record exists, which is how a
     * reference or application store seeds a handle. Any other version must
     * equal the stored record's version, and a revoked record refuses every
     * swap.
     */
    compareAndSwap(record, expectedVersion) {
        const current = this.records.get(record.handleHash);
        if (!current) {
            if (expectedVersion !== 0) {
                return Promise.reject(new BrokerVersionConflictError());
            }
            const created = {
                ...structuredClone(record),
                version: 1,
            };
            this.records.set(created.handleHash, created);
            return Promise.resolve(structuredClone(created));
        }
        if (current.status === "revoked") {
            return Promise.reject(new BrokerRevokedError());
        }
        if (current.version !== expectedVersion) {
            return Promise.reject(new BrokerVersionConflictError());
        }
        const swapped = {
            ...structuredClone(record),
            version: expectedVersion + 1,
        };
        this.records.set(swapped.handleHash, swapped);
        return Promise.resolve(structuredClone(swapped));
    }
    /** Revokes the handle. Revocation is idempotent and terminal. */
    revoke(handleHash) {
        const record = this.records.get(handleHash);
        if (!record)
            return Promise.reject(new BrokerNotFoundError());
        record.status = "revoked";
        delete record.refreshLockOwner;
        delete record.refreshLockExpiresAt;
        return Promise.resolve(structuredClone(record));
    }
}
/** In-memory reference RateLimitStore. */
export class MemoryRateLimitStore {
    buckets = new Map();
    now;
    defaultLimit;
    defaultWindowSeconds;
    constructor(options = {}) {
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
    checkAndIncrement(key) {
        const bucketKey = [key.identifier, key.resource, key.operation].join("\u0000");
        const limit = positiveInteger(key.limit, this.defaultLimit);
        const windowMs = positiveSeconds(key.windowSeconds, this.defaultWindowSeconds) * 1000;
        const at = this.now().getTime();
        let bucket = this.buckets.get(bucketKey);
        if (!bucket || at >= bucket.resetAt) {
            bucket = { count: 0, resetAt: at + windowMs };
            this.buckets.set(bucketKey, bucket);
        }
        bucket.count += 1;
        const result = {
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
 * Runs the shared store conformance table against `stores`, resetting the
 * clock to its starting instant before every row, and throws on the first row
 * whose observable outcome differs from its `expect`. The returned count is
 * the number of rows executed, so a caller can assert it against the fixture.
 */
export async function runStoreConformance(stores, cases, clock) {
    const epoch = clock.now();
    let ran = 0;
    for (const testCase of cases ?? []) {
        clock.set(epoch);
        const actual = await runStoreCase(stores, testCase, clock);
        const expect = testCase.expect ?? {};
        const observed = {};
        for (const key of Object.keys(expect))
            observed[key] = actual[key];
        if (!deepEqual(observed, expect)) {
            throw new Error(`store conformance case ${testCase.id} failed: expected ${JSON.stringify(expect)}, got ${JSON.stringify(observed)}`);
        }
        ran += 1;
    }
    return { ran };
}
async function runStoreCase(stores, testCase, clock) {
    const params = testCase.params ?? {};
    const key = testCase.id;
    switch (testCase.scenario) {
        case "consume_single_use": {
            const ttlSeconds = numberParam(params, "ttl_seconds", 600);
            await stores.transaction.put(transactionRecord(key, addSeconds(clock.now(), ttlSeconds)));
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
                await stores.authorizationCode.put(authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)));
                clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
                const result = await stores.authorizationCode.consume(key);
                return { consume: authorizationCodeOutcome(result) };
            }
            await stores.transaction.put(transactionRecord(key, addSeconds(clock.now(), ttlSeconds)));
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
            await stores.authorizationCode.put(authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)));
            const first = await stores.authorizationCode.consume(key);
            const second = await stores.authorizationCode.consume(key);
            return {
                first: authorizationCodeOutcome(first),
                second: authorizationCodeOutcome(second),
            };
        }
        case "concurrent_consume": {
            const ttlSeconds = numberParam(params, "ttl_seconds", 60);
            const concurrency = numberParam(params, "concurrency", 16);
            if (testCase.store === "authorization_code") {
                await stores.authorizationCode.put(authorizationCodeRecord(key, addSeconds(clock.now(), ttlSeconds)));
                const results = await Promise.all(Array.from({ length: concurrency }, () => stores.authorizationCode.consume(key)));
                return tally(results.map((result) => authorizationCodeOutcome(result)), testCase.expect);
            }
            await stores.transaction.put(transactionRecord(key, addSeconds(clock.now(), ttlSeconds)));
            const results = await Promise.all(Array.from({ length: concurrency }, () => stores.transaction.consume(key)));
            return tally(results.map((result) => transactionOutcome(result)), testCase.expect);
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
            const contended = await brokerLockOutcome(stores, key, "owner-b", 1);
            clock.advance(numberParam(params, "advance_seconds", 0) * 1000);
            const afterExpiry = await brokerLockOutcome(stores, key, "owner-b", 1);
            return { first, contended, after_expiry: afterExpiry };
        }
        case "compare_and_swap_versioned": {
            await seedBrokerRecord(stores, brokerRecord(key));
            const acquired = await brokerLockOutcome(stores, key, "owner-a", 1);
            const swapped = await brokerSwapOutcome(stores, brokerRecord(key), 1);
            const stale = await brokerSwapOutcome(stores, brokerRecord(key), 1);
            return { acquire_lock: acquired, swap: swapped, stale_swap: stale };
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
            const results = await Promise.all(Array.from({ length: concurrency }, (_unused, index) => brokerLockOutcome(stores, key, `owner-${index}`, 1)));
            return tally(results, testCase.expect);
        }
        case "concurrent_revoke": {
            await seedBrokerRecord(stores, brokerRecord(key));
            const concurrency = numberParam(params, "concurrency", 16);
            const results = await Promise.all(Array.from({ length: concurrency }, () => revokeOutcome(stores, key)));
            return tally(results, testCase.expect);
        }
        case "check_and_increment": {
            const limit = numberParam(params, "limit", 1);
            const windowSeconds = numberParam(params, "window_seconds", 60);
            const checks = numberParam(params, "checks", 1);
            const outcomes = [];
            for (let index = 0; index < checks; index += 1) {
                outcomes.push(await rateLimitOutcome(stores, {
                    identifier: key,
                    resource: "conformance",
                    operation: "check_and_increment",
                    limit,
                    windowSeconds,
                }));
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
        default:
            throw new Error(`store conformance case ${testCase.id} has an unknown scenario ${testCase.scenario}`);
    }
}
/** Seeds one broker handle through the versioned CAS create sentinel. */
async function seedBrokerRecord(stores, record) {
    await stores.routeRefreshBroker.compareAndSwap(record, 0);
}
async function clientUpdateOutcome(stores, record, expectedVersion) {
    try {
        const updated = await stores.client.update(record, expectedVersion);
        return { outcome: "ok", version: updated.version };
    }
    catch (err) {
        if (err instanceof ClientVersionConflictError) {
            return { outcome: "version_conflict", version: 0 };
        }
        throw err;
    }
}
async function brokerLockOutcome(stores, handleHash, owner, expectedVersion) {
    try {
        await stores.routeRefreshBroker.acquireLock(handleHash, owner, expectedVersion);
        return "ok";
    }
    catch (err) {
        return brokerErrorOutcome(err);
    }
}
async function brokerSwapOutcome(stores, record, expectedVersion) {
    try {
        await stores.routeRefreshBroker.compareAndSwap(record, expectedVersion);
        return "ok";
    }
    catch (err) {
        return brokerErrorOutcome(err);
    }
}
async function revokeOutcome(stores, handleHash) {
    try {
        await stores.routeRefreshBroker.revoke(handleHash);
        return "ok";
    }
    catch (err) {
        return brokerErrorOutcome(err);
    }
}
function brokerErrorOutcome(err) {
    if (err instanceof BrokerLockedError)
        return "locked";
    if (err instanceof BrokerRevokedError)
        return "revoked";
    if (err instanceof BrokerVersionConflictError)
        return "version_conflict";
    if (err instanceof BrokerNotFoundError)
        return "not_found";
    throw err;
}
async function rateLimitOutcome(stores, key) {
    const result = await stores.rateLimit.checkAndIncrement(key);
    return result.allowed ? "allowed" : "limited";
}
function transactionOutcome(record) {
    if (!record)
        return "not_found";
    if (record.status === "expired")
        return "expired";
    return "ok";
}
function authorizationCodeOutcome(result) {
    if (!result)
        return "not_found";
    if (result.record.status === "expired")
        return "expired";
    if (result.replayed)
        return "replayed";
    return "ok";
}
/** Counts outcomes, keyed by the `expect` shape so zero-count rows still compare. */
function tally(outcomes, expect) {
    const counts = {};
    for (const name of Object.keys(expect))
        counts[name] = 0;
    for (const outcome of outcomes) {
        counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
}
function transactionRecord(key, expiresAt) {
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
function authorizationCodeRecord(key, expiresAt) {
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
function clientRecord(key) {
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
function brokerRecord(key) {
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
function numberParam(params, name, fallback) {
    const value = params[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function addSeconds(at, seconds) {
    return new Date(at.valueOf() + seconds * 1000);
}
function expiryMs(value) {
    if (!(value instanceof Date))
        return null;
    const at = value.valueOf();
    return Number.isNaN(at) ? null : at;
}
function positiveSeconds(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}
function positiveInteger(value, fallback) {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fallback;
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return (a.length === b.length &&
            a.every((value, index) => deepEqual(value, b[index])));
    }
    if (isRecord(a) && isRecord(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length)
            return false;
        return keysA.every((name) => deepEqual(a[name], b[name]));
    }
    return false;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=store.js.map