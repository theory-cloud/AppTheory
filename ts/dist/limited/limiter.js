import { TheorydbClient, TheorydbError, defineModel, getLambdaDynamoDBClient, } from "@theory-cloud/tabletheory-ts";
import { RealClock } from "../clock.js";
import { newError, wrapError } from "./errors.js";
import { formatRfc3339Nano, formatWindowId, getHourWindow, getMinuteWindow, setKeys, unixSeconds, } from "./models.js";
import { FixedWindowStrategy, MultiWindowStrategy, SlidingWindowStrategy, } from "./strategies.js";
function isConditionalCheckFailed(err) {
    if (err instanceof TheorydbError) {
        return String(err.code ?? "").trim() === "ErrConditionFailed";
    }
    if (!err || typeof err !== "object")
        return false;
    const rec = err;
    return (String(rec["code"] ?? "").trim() === "ErrConditionFailed" ||
        String(rec["name"] ?? "").trim() === "ErrConditionFailed");
}
function getCount(item) {
    const n = Number(item?.["Count"] ?? 0);
    return Number.isFinite(n) ? Math.floor(n) : 0;
}
function normalizeKeyId(pk, sk) {
    const p = String(pk ?? "").trim();
    const s = String(sk ?? "").trim();
    return p && s ? `${p}\n${s}` : "";
}
function sanitizeMetadata(metadata) {
    const out = {};
    for (const [k, v] of Object.entries(metadata ?? {})) {
        const key = String(k).trim();
        if (!key)
            continue;
        out[key] = String(v);
    }
    return out;
}
const rateLimitModelName = "RateLimitEntry";
function rateLimitModel(tableName) {
    return defineModel({
        name: rateLimitModelName,
        table: { name: tableName },
        keys: {
            partition: { attribute: "PK", type: "S" },
            sort: { attribute: "SK", type: "S" },
        },
        attributes: [
            { attribute: "PK", type: "S" },
            { attribute: "SK", type: "S" },
            { attribute: "Identifier", type: "S" },
            { attribute: "Resource", type: "S" },
            { attribute: "Operation", type: "S" },
            { attribute: "WindowStart", type: "N" },
            { attribute: "WindowType", type: "S" },
            { attribute: "WindowID", type: "S" },
            { attribute: "Count", type: "N" },
            { attribute: "TTL", type: "N" },
            { attribute: "CreatedAt", type: "S" },
            { attribute: "UpdatedAt", type: "S" },
            { attribute: "Metadata", type: "M", optional: true },
        ],
    });
}
export function defaultConfig() {
    return {
        defaultRequestsPerHour: 1000,
        defaultRequestsPerMinute: 100,
        defaultBurstCapacity: 10,
        enableBurstCapacity: false,
        enableSoftLimits: false,
        failOpen: true,
        tableName: "rate-limits",
        consistentRead: false,
        ttlHours: 1,
        identifierLimits: {},
        resourceLimits: {},
    };
}
function normalizeConfig(config) {
    const base = defaultConfig();
    const merged = {
        ...base,
        ...config,
        identifierLimits: {
            ...(config?.identifierLimits ?? base.identifierLimits),
        },
        resourceLimits: { ...(config?.resourceLimits ?? base.resourceLimits) },
    };
    merged.defaultRequestsPerHour = Math.floor(Number(merged.defaultRequestsPerHour) || 0);
    merged.defaultRequestsPerMinute = Math.floor(Number(merged.defaultRequestsPerMinute) || 0);
    merged.defaultBurstCapacity = Math.floor(Number(merged.defaultBurstCapacity) || 0);
    merged.ttlHours = Math.floor(Number(merged.ttlHours) || 0);
    merged.consistentRead = Boolean(merged.consistentRead);
    merged.enableBurstCapacity = Boolean(merged.enableBurstCapacity);
    merged.enableSoftLimits = Boolean(merged.enableSoftLimits);
    merged.failOpen = Boolean(merged.failOpen);
    merged.tableName = String(merged.tableName ?? "").trim() || base.tableName;
    return merged;
}
function normalizeKey(key) {
    const out = {
        identifier: String(key?.identifier ?? "").trim(),
        resource: String(key?.resource ?? "").trim(),
        operation: String(key?.operation ?? "").trim(),
    };
    if (key?.metadata)
        out.metadata = { ...key.metadata };
    return out;
}
function validateKey(key) {
    if (!key.identifier)
        throw newError("invalid_input", "identifier is required");
    if (!key.resource)
        throw newError("invalid_input", "resource is required");
    if (!key.operation)
        throw newError("invalid_input", "operation is required");
}
function setKeysStrict(entry) {
    setKeys(entry);
    if (!entry.PK || !entry.SK) {
        throw newError("internal_error", "failed to set rate limit entry keys");
    }
}
function countForPrimaryWindow(strategy, windows, counts) {
    if (windows.length === 0)
        return 0;
    if (strategy instanceof SlidingWindowStrategy) {
        let total = 0;
        for (const v of Object.values(counts))
            total += Number(v) || 0;
        return Math.floor(total);
    }
    const primary = windows[0];
    if (!primary)
        return 0;
    return Math.floor(Number(counts[primary.key] ?? 0) || 0);
}
function maxRequestsForWindow(strategy, window) {
    const idx = window.key.lastIndexOf("_");
    if (idx !== -1 && idx < window.key.length - 1) {
        const suffix = window.key.slice(idx + 1).trim(); // e.g. "60000ms"
        if (suffix.endsWith("ms")) {
            const dur = Number(suffix.slice(0, -2));
            if (Number.isFinite(dur)) {
                for (const cfg of strategy.windows) {
                    if (Math.floor(Number(cfg.durationMs)) === Math.floor(dur)) {
                        return Math.floor(Number(cfg.maxRequests) || 0);
                    }
                }
            }
        }
    }
    return strategy.windows.length > 0
        ? Math.floor(Number(strategy.windows[0]?.maxRequests ?? 0))
        : 0;
}
function resetTimeForDecision(strategy, now, windows, counts, allowed) {
    if (windows.length === 0)
        return now;
    const primary = windows[0];
    if (!primary)
        return now;
    if (allowed || !(strategy instanceof MultiWindowStrategy)) {
        return primary.end;
    }
    let maxReset = primary.end;
    for (const window of windows) {
        const maxAllowed = maxRequestsForWindow(strategy, window);
        if (maxAllowed <= 0) {
            if (window.end.valueOf() > maxReset.valueOf())
                maxReset = window.end;
            continue;
        }
        const count = Math.floor(Number(counts[window.key] ?? 0) || 0);
        if (count >= maxAllowed && window.end.valueOf() > maxReset.valueOf()) {
            maxReset = window.end;
        }
    }
    return maxReset;
}
export class DynamoRateLimiter {
    _theorydb;
    _config;
    _strategy;
    _clock;
    constructor(options = {}) {
        this._config = normalizeConfig(options.config);
        this._strategy =
            options.strategy ??
                new FixedWindowStrategy(3_600_000, this._config.defaultRequestsPerHour);
        const model = rateLimitModel(this._config.tableName);
        this._theorydb =
            options.theorydb ?? new TheorydbClient(getLambdaDynamoDBClient());
        this._theorydb.register(model);
        this._clock = options.clock ?? new RealClock();
    }
    setClock(clock) {
        this._clock = clock ?? new RealClock();
    }
    async checkLimit(key) {
        const k = normalizeKey(key);
        validateKey(k);
        const now = this._clock.now();
        const windows = this._strategy.calculateWindows(now);
        if (windows.length === 0) {
            throw newError("internal_error", "no windows calculated");
        }
        const primary = windows[0];
        if (!primary) {
            throw newError("internal_error", "no windows calculated");
        }
        const cfg = this._config;
        const counts = {};
        const keys = [];
        const keyIdByWindow = new Map();
        for (const window of windows) {
            const entry = {
                Identifier: k.identifier,
                WindowStart: unixSeconds(window.start),
                Resource: k.resource,
                Operation: k.operation,
            };
            setKeysStrict(entry);
            const key = { PK: entry.PK, SK: entry.SK };
            keys.push(key);
            keyIdByWindow.set(window.key, normalizeKeyId(key.PK, key.SK));
        }
        let items;
        try {
            const resp = await this._theorydb.batchGet(rateLimitModelName, keys, {
                consistentRead: cfg.consistentRead,
            });
            if (resp.unprocessedKeys.length > 0) {
                throw new Error("apptheory: unprocessed rate limit keys");
            }
            items = resp.items;
        }
        catch (err) {
            if (cfg.failOpen) {
                return {
                    allowed: true,
                    currentCount: 0,
                    limit: this._strategy.getLimit(k),
                    resetsAt: primary.end,
                };
            }
            throw wrapError(err, "internal_error", "failed to check rate limit");
        }
        const byKeyId = new Map();
        for (const item of items) {
            const id = normalizeKeyId(item["PK"], item["SK"]);
            if (!id)
                continue;
            byKeyId.set(id, item);
        }
        for (const window of windows) {
            const id = keyIdByWindow.get(window.key) ?? "";
            counts[window.key] = getCount(id ? byKeyId.get(id) : undefined);
        }
        const limit = Math.floor(Number(this._strategy.getLimit(k)) || 0);
        const allowed = this._strategy.shouldAllow(counts, limit);
        const currentCount = countForPrimaryWindow(this._strategy, windows, counts);
        const resetsAt = resetTimeForDecision(this._strategy, now, windows, counts, allowed);
        const decision = {
            allowed,
            currentCount,
            limit,
            resetsAt,
        };
        if (!allowed) {
            decision.retryAfterMs = Math.max(0, resetsAt.valueOf() - now.valueOf());
        }
        return decision;
    }
    async recordRequest(key) {
        const k = normalizeKey(key);
        validateKey(k);
        const now = this._clock.now();
        const windows = this._strategy.calculateWindows(now);
        if (windows.length === 0) {
            throw newError("internal_error", "no windows calculated");
        }
        const cfg = this._config;
        const targetWindows = this._strategy instanceof MultiWindowStrategy
            ? windows
            : windows.slice(0, 1);
        for (const window of targetWindows) {
            const entry = {
                Identifier: k.identifier,
                WindowStart: unixSeconds(window.start),
                Resource: k.resource,
                Operation: k.operation,
            };
            setKeysStrict(entry);
            const ttl = unixSeconds(window.end) + cfg.ttlHours * 3600;
            const nowStr = formatRfc3339Nano(now);
            const windowId = formatWindowId(window.start);
            try {
                const builder = this._theorydb.updateBuilder(rateLimitModelName, {
                    PK: entry.PK,
                    SK: entry.SK,
                });
                builder.add("Count", 1);
                builder.set("UpdatedAt", nowStr);
                builder.setIfNotExists("WindowType", null, window.key);
                builder.setIfNotExists("WindowID", null, windowId);
                builder.setIfNotExists("Identifier", null, k.identifier);
                builder.setIfNotExists("Resource", null, k.resource);
                builder.setIfNotExists("Operation", null, k.operation);
                builder.setIfNotExists("WindowStart", null, unixSeconds(window.start));
                builder.setIfNotExists("TTL", null, ttl);
                builder.setIfNotExists("CreatedAt", null, nowStr);
                await builder.execute();
            }
            catch (err) {
                throw wrapError(err, "internal_error", "failed to record request");
            }
        }
    }
    async getUsage(key) {
        const k = normalizeKey(key);
        validateKey(k);
        const now = this._clock.now();
        const minuteWindow = getMinuteWindow(now);
        const hourWindow = getHourWindow(now);
        const cfg = this._config;
        let minuteLimit = cfg.defaultRequestsPerMinute;
        let hourLimit = cfg.defaultRequestsPerHour;
        const override = cfg.identifierLimits[k.identifier];
        if (override) {
            if (override.requestsPerMinute > 0)
                minuteLimit = override.requestsPerMinute;
            if (override.requestsPerHour > 0)
                hourLimit = override.requestsPerHour;
        }
        const minuteEntry = {
            Identifier: k.identifier,
            WindowStart: unixSeconds(minuteWindow.start),
            Resource: k.resource,
            Operation: k.operation,
        };
        setKeysStrict(minuteEntry);
        const hourEntry = {
            Identifier: k.identifier,
            WindowStart: unixSeconds(hourWindow.start),
            Resource: k.resource,
            Operation: k.operation,
        };
        setKeysStrict(hourEntry);
        const loadCount = async (pk, sk, errMsg) => {
            try {
                const resp = await this._theorydb.batchGet(rateLimitModelName, [{ PK: pk, SK: sk }], { consistentRead: cfg.consistentRead });
                if (resp.unprocessedKeys.length > 0) {
                    throw new Error("apptheory: unprocessed rate limit key");
                }
                return resp.items.length > 0 ? getCount(resp.items[0]) : 0;
            }
            catch (err) {
                throw wrapError(err, "internal_error", errMsg);
            }
        };
        const minuteCount = await loadCount(minuteEntry.PK, minuteEntry.SK, "failed to get minute usage");
        const hourCount = await loadCount(hourEntry.PK, hourEntry.SK, "failed to get hour usage");
        return {
            identifier: k.identifier,
            resource: k.resource,
            customWindows: {},
            currentMinute: {
                count: minuteCount,
                limit: minuteLimit,
                windowStart: minuteWindow.start,
                windowEnd: minuteWindow.end,
            },
            currentHour: {
                count: hourCount,
                limit: hourLimit,
                windowStart: hourWindow.start,
                windowEnd: hourWindow.end,
            },
            dailyTotal: hourCount,
        };
    }
    async checkAndIncrement(key) {
        const k = normalizeKey(key);
        validateKey(k);
        const now = this._clock.now();
        if (this._strategy instanceof MultiWindowStrategy) {
            return this._checkAndIncrementMultiWindow(k, now, this._strategy);
        }
        return this._checkAndIncrementSingleWindow(k, now);
    }
    async _checkAndIncrementSingleWindow(key, now) {
        const windows = this._strategy.calculateWindows(now);
        if (windows.length === 0) {
            throw newError("internal_error", "no windows calculated");
        }
        const window = windows[0];
        if (!window) {
            throw newError("internal_error", "no windows calculated");
        }
        const limit = Math.floor(Number(this._strategy.getLimit(key)) || 0);
        const cfg = this._config;
        const entry = {
            Identifier: key.identifier,
            WindowStart: unixSeconds(window.start),
            Resource: key.resource,
            Operation: key.operation,
        };
        setKeysStrict(entry);
        const nowStr = formatRfc3339Nano(now);
        try {
            const builder = this._theorydb.updateBuilder(rateLimitModelName, {
                PK: entry.PK,
                SK: entry.SK,
            });
            builder.add("Count", 1);
            builder.set("UpdatedAt", nowStr);
            builder.condition("Count", "<", limit);
            builder.returnValues("ALL_NEW");
            return {
                allowed: true,
                currentCount: getCount(await builder.execute()),
                limit,
                resetsAt: window.end,
            };
        }
        catch (err) {
            if (isConditionalCheckFailed(err)) {
                return await this._handleSingleWindowConditionFailed(key, now, window, limit, entry);
            }
            if (cfg.failOpen) {
                return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
            }
            throw wrapError(err, "internal_error", "failed to check and increment rate limit");
        }
    }
    async _handleSingleWindowConditionFailed(key, now, window, limit, entry) {
        const cfg = this._config;
        let items;
        try {
            const resp = await this._theorydb.batchGet(rateLimitModelName, [{ PK: entry.PK, SK: entry.SK }], { consistentRead: cfg.consistentRead });
            if (resp.unprocessedKeys.length > 0) {
                throw new Error("apptheory: unprocessed rate limit key");
            }
            items = resp.items;
        }
        catch (err) {
            if (cfg.failOpen) {
                return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
            }
            throw wrapError(err, "internal_error", "failed to load rate limit entry");
        }
        const item = items[0];
        if (item) {
            const currentCount = getCount(item);
            return {
                allowed: false,
                currentCount,
                limit,
                resetsAt: window.end,
                retryAfterMs: Math.max(0, window.end.valueOf() - now.valueOf()),
            };
        }
        return await this._createSingleWindowEntry(key, now, window, limit);
    }
    async _createSingleWindowEntry(key, now, window, limit) {
        const cfg = this._config;
        if (limit <= 0) {
            return {
                allowed: false,
                currentCount: 0,
                limit,
                resetsAt: window.end,
                retryAfterMs: Math.max(0, window.end.valueOf() - now.valueOf()),
            };
        }
        const entry = {
            Identifier: key.identifier,
            WindowStart: unixSeconds(window.start),
            Resource: key.resource,
            Operation: key.operation,
            WindowType: window.key,
            WindowID: formatWindowId(window.start),
            Count: 1,
            CreatedAt: formatRfc3339Nano(now),
            UpdatedAt: formatRfc3339Nano(now),
            TTL: unixSeconds(window.end) + cfg.ttlHours * 3600,
            Metadata: sanitizeMetadata(key.metadata),
        };
        setKeysStrict(entry);
        try {
            await this._theorydb.create(rateLimitModelName, {
                PK: entry.PK,
                SK: entry.SK,
                Identifier: entry.Identifier,
                Resource: entry.Resource,
                Operation: entry.Operation,
                WindowStart: entry.WindowStart,
                WindowType: entry.WindowType,
                WindowID: entry.WindowID,
                Count: entry.Count,
                TTL: entry.TTL,
                CreatedAt: entry.CreatedAt,
                UpdatedAt: entry.UpdatedAt,
                Metadata: entry.Metadata,
            }, { ifNotExists: true });
            return { allowed: true, currentCount: 1, limit, resetsAt: window.end };
        }
        catch (err) {
            if (isConditionalCheckFailed(err)) {
                return await this.checkAndIncrement(key);
            }
            if (cfg.failOpen) {
                return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
            }
            throw wrapError(err, "internal_error", "failed to create rate limit entry");
        }
    }
    async _checkAndIncrementMultiWindow(key, now, strategy) {
        const windows = strategy.calculateWindows(now);
        if (windows.length === 0) {
            throw newError("internal_error", "no windows calculated");
        }
        const primaryWindow = windows[0];
        if (!primaryWindow) {
            throw newError("internal_error", "no windows calculated");
        }
        const primaryLimit = Math.floor(Number(strategy.getLimit(key)) || 0);
        if (primaryLimit <= 0) {
            return {
                allowed: false,
                currentCount: 0,
                limit: primaryLimit,
                resetsAt: primaryWindow.end,
                retryAfterMs: Math.max(0, primaryWindow.end.valueOf() - now.valueOf()),
            };
        }
        const cfg = this._config;
        const nowStr = formatRfc3339Nano(now);
        const transactActions = [];
        for (const window of windows) {
            const maxAllowed = maxRequestsForWindow(strategy, window);
            if (maxAllowed <= 0) {
                const err = new TheorydbError("ErrConditionFailed", "apptheory: max_allowed is 0");
                return await this._handleMultiWindowIncrementError(key, now, windows, primaryLimit, err);
            }
            const entry = {
                Identifier: key.identifier,
                WindowStart: unixSeconds(window.start),
                Resource: key.resource,
                Operation: key.operation,
            };
            setKeysStrict(entry);
            const ttl = unixSeconds(window.end) + cfg.ttlHours * 3600;
            const windowId = formatWindowId(window.start);
            transactActions.push({
                kind: "update",
                model: rateLimitModelName,
                key: { PK: entry.PK, SK: entry.SK },
                updateFn: (builder) => {
                    builder.add("Count", 1);
                    builder.set("UpdatedAt", nowStr);
                    builder.setIfNotExists("WindowType", null, window.key);
                    builder.setIfNotExists("WindowID", null, windowId);
                    builder.setIfNotExists("Identifier", null, key.identifier);
                    builder.setIfNotExists("Resource", null, key.resource);
                    builder.setIfNotExists("Operation", null, key.operation);
                    builder.setIfNotExists("WindowStart", null, unixSeconds(window.start));
                    builder.setIfNotExists("TTL", null, ttl);
                    builder.setIfNotExists("CreatedAt", null, nowStr);
                    builder.conditionNotExists("Count");
                    builder.orCondition("Count", "<", maxAllowed);
                },
            });
        }
        try {
            await this._theorydb.transactWrite(transactActions);
        }
        catch (err) {
            return await this._handleMultiWindowIncrementError(key, now, windows, primaryLimit, err);
        }
        let currentCount = 0;
        try {
            const primary = windows[0];
            if (!primary) {
                throw newError("internal_error", "no windows calculated");
            }
            const entry = {
                Identifier: key.identifier,
                WindowStart: unixSeconds(primary.start),
                Resource: key.resource,
                Operation: key.operation,
            };
            setKeysStrict(entry);
            const resp = await this._theorydb.batchGet(rateLimitModelName, [{ PK: entry.PK, SK: entry.SK }], { consistentRead: cfg.consistentRead });
            if (resp.unprocessedKeys.length > 0) {
                throw new Error("apptheory: unprocessed rate limit key");
            }
            currentCount = resp.items.length > 0 ? getCount(resp.items[0]) : 0;
        }
        catch (err) {
            if (cfg.failOpen) {
                return {
                    allowed: true,
                    currentCount: 0,
                    limit: primaryLimit,
                    resetsAt: primaryWindow.end,
                };
            }
            throw wrapError(err, "internal_error", "failed to load updated rate limit entry");
        }
        return {
            allowed: true,
            currentCount,
            limit: primaryLimit,
            resetsAt: primaryWindow.end,
        };
    }
    async _handleMultiWindowIncrementError(key, now, windows, primaryLimit, err) {
        const primary = windows[0];
        const resetsAt = primary ? primary.end : now;
        if (isConditionalCheckFailed(err)) {
            const decision = await this.checkLimit(key);
            const out = { ...decision, allowed: false };
            if (out.retryAfterMs === undefined) {
                out.retryAfterMs = Math.max(0, out.resetsAt.valueOf() - now.valueOf());
            }
            return out;
        }
        if (this._config.failOpen) {
            return {
                allowed: true,
                currentCount: 0,
                limit: primaryLimit,
                resetsAt,
            };
        }
        throw wrapError(err, "internal_error", "failed to check and increment rate limit");
    }
}
