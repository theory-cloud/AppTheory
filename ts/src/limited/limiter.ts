import type { Clock } from "../clock.js";
import { RealClock } from "../clock.js";
import type {
  AttributeValue,
  DynamoDBItem,
  GetItemOutput,
} from "../internal/aws-dynamodb.js";
import { DynamoDBClient } from "../internal/aws-dynamodb.js";

import { newError, wrapError } from "./errors.js";
import {
  formatRfc3339Nano,
  formatWindowId,
  getHourWindow,
  getMinuteWindow,
  rateLimitTableName,
  setKeys,
  unixSeconds,
} from "./models.js";
import {
  FixedWindowStrategy,
  MultiWindowStrategy,
  SlidingWindowStrategy,
} from "./strategies.js";
import {
  type AtomicRateLimiter,
  type Config,
  type LimitDecision,
  type RateLimiter,
  type RateLimitKey,
  type RateLimitStrategy,
  type TimeWindow,
  type UsageStats,
} from "./types.js";

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err) return false;
  const name = String((err as { name?: unknown }).name ?? "").trim();
  return (
    name === "ConditionalCheckFailedException" ||
    name === "TransactionCanceledException"
  );
}

function getNumber(item: DynamoDBItem | undefined, key: string): number {
  if (!item) return 0;
  const av = item[key];
  if (!av || !("N" in av)) return 0;
  const n = Number(av.N);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function avS(value: string): AttributeValue {
  return { S: String(value) };
}

function avN(value: number): AttributeValue {
  return { N: String(Math.floor(Number(value) || 0)) };
}

function avStringMap(map: Record<string, string> | undefined): AttributeValue {
  const m: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    const key = String(k).trim();
    if (!key) continue;
    m[key] = avS(String(v));
  }
  return { M: m };
}

export function defaultConfig(): Config {
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

function normalizeConfig(config: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  const merged: Config = {
    ...base,
    ...config,
    identifierLimits: {
      ...(config?.identifierLimits ?? base.identifierLimits),
    },
    resourceLimits: { ...(config?.resourceLimits ?? base.resourceLimits) },
  };

  merged.defaultRequestsPerHour = Math.floor(
    Number(merged.defaultRequestsPerHour) || 0,
  );
  merged.defaultRequestsPerMinute = Math.floor(
    Number(merged.defaultRequestsPerMinute) || 0,
  );
  merged.defaultBurstCapacity = Math.floor(
    Number(merged.defaultBurstCapacity) || 0,
  );
  merged.ttlHours = Math.floor(Number(merged.ttlHours) || 0);
  merged.consistentRead = Boolean(merged.consistentRead);
  merged.enableBurstCapacity = Boolean(merged.enableBurstCapacity);
  merged.enableSoftLimits = Boolean(merged.enableSoftLimits);
  merged.failOpen = Boolean(merged.failOpen);
  merged.tableName = String(merged.tableName ?? "").trim() || base.tableName;

  return merged;
}

function normalizeKey(key: RateLimitKey): RateLimitKey {
  const out: RateLimitKey = {
    identifier: String(key?.identifier ?? "").trim(),
    resource: String(key?.resource ?? "").trim(),
    operation: String(key?.operation ?? "").trim(),
  };
  if (key?.metadata) out.metadata = { ...key.metadata };
  return out;
}

function validateKey(key: RateLimitKey): void {
  if (!key.identifier)
    throw newError("invalid_input", "identifier is required");
  if (!key.resource) throw newError("invalid_input", "resource is required");
  if (!key.operation) throw newError("invalid_input", "operation is required");
}

type KeyedEntry = { PK: string; SK: string };
type KeyableEntry = {
  Identifier: string;
  WindowStart: number;
  Resource: string;
  Operation: string;
  PK?: string;
  SK?: string;
};

function setKeysStrict<T extends KeyableEntry>(
  entry: T,
): asserts entry is T & KeyedEntry {
  setKeys(entry);
  if (!entry.PK || !entry.SK) {
    throw newError("internal_error", "failed to set rate limit entry keys");
  }
}

function countForPrimaryWindow(
  strategy: RateLimitStrategy,
  windows: TimeWindow[],
  counts: Record<string, number>,
): number {
  if (windows.length === 0) return 0;
  if (strategy instanceof SlidingWindowStrategy) {
    let total = 0;
    for (const v of Object.values(counts)) total += Number(v) || 0;
    return Math.floor(total);
  }
  const primary = windows[0];
  if (!primary) return 0;
  return Math.floor(Number(counts[primary.key] ?? 0) || 0);
}

function maxRequestsForWindow(
  strategy: MultiWindowStrategy,
  window: TimeWindow,
): number {
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

function resetTimeForDecision(
  strategy: RateLimitStrategy,
  now: Date,
  windows: TimeWindow[],
  counts: Record<string, number>,
  allowed: boolean,
): Date {
  if (windows.length === 0) return now;
  const primary = windows[0];
  if (!primary) return now;
  if (allowed || !(strategy instanceof MultiWindowStrategy)) {
    return primary.end;
  }

  let maxReset = primary.end;
  for (const window of windows) {
    const maxAllowed = maxRequestsForWindow(strategy, window);
    if (maxAllowed <= 0) {
      if (window.end.valueOf() > maxReset.valueOf()) maxReset = window.end;
      continue;
    }

    const count = Math.floor(Number(counts[window.key] ?? 0) || 0);
    if (count >= maxAllowed && window.end.valueOf() > maxReset.valueOf()) {
      maxReset = window.end;
    }
  }

  return maxReset;
}

export class DynamoRateLimiter implements AtomicRateLimiter, RateLimiter {
  private readonly _dynamo: DynamoDBClient;
  private readonly _config: Config;
  private readonly _strategy: RateLimitStrategy;
  private _clock: Clock;

  constructor(
    options: {
      dynamo?: DynamoDBClient;
      config?: Partial<Config>;
      strategy?: RateLimitStrategy;
      clock?: Clock;
    } = {},
  ) {
    this._config = normalizeConfig(options.config);
    this._strategy =
      options.strategy ??
      new FixedWindowStrategy(3_600_000, this._config.defaultRequestsPerHour);
    this._dynamo = options.dynamo ?? new DynamoDBClient();
    this._clock = options.clock ?? new RealClock();
  }

  setClock(clock: Clock | null | undefined): void {
    this._clock = clock ?? new RealClock();
  }

  async checkLimit(key: RateLimitKey): Promise<LimitDecision> {
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
    const tableName = cfg.tableName || rateLimitTableName();

    const counts: Record<string, number> = {};
    for (const window of windows) {
      const entry = {
        Identifier: k.identifier,
        WindowStart: unixSeconds(window.start),
        Resource: k.resource,
        Operation: k.operation,
      };
      setKeysStrict(entry);

      let out: GetItemOutput;
      try {
        out = await this._dynamo.getItem({
          TableName: tableName,
          Key: { PK: avS(entry.PK), SK: avS(entry.SK) },
          ConsistentRead: cfg.consistentRead,
        });
      } catch (err) {
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

      counts[window.key] = getNumber(out.Item, "Count");
    }

    const limit = Math.floor(Number(this._strategy.getLimit(k)) || 0);
    const allowed = this._strategy.shouldAllow(counts, limit);
    const currentCount = countForPrimaryWindow(this._strategy, windows, counts);
    const resetsAt = resetTimeForDecision(
      this._strategy,
      now,
      windows,
      counts,
      allowed,
    );

    const decision: LimitDecision = {
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

  async recordRequest(key: RateLimitKey): Promise<void> {
    const k = normalizeKey(key);
    validateKey(k);

    const now = this._clock.now();
    const windows = this._strategy.calculateWindows(now);
    if (windows.length === 0) {
      throw newError("internal_error", "no windows calculated");
    }

    const cfg = this._config;
    const tableName = cfg.tableName || rateLimitTableName();

    const targetWindows =
      this._strategy instanceof MultiWindowStrategy
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
        await this._dynamo.updateItem({
          TableName: tableName,
          Key: { PK: avS(entry.PK), SK: avS(entry.SK) },
          UpdateExpression:
            "ADD #Count :inc SET #UpdatedAt=:now, #WindowType=if_not_exists(#WindowType,:wt), #WindowID=if_not_exists(#WindowID,:wid), #Identifier=if_not_exists(#Identifier,:id), #Resource=if_not_exists(#Resource,:res), #Operation=if_not_exists(#Operation,:op), #WindowStart=if_not_exists(#WindowStart,:ws), #TTL=if_not_exists(#TTL,:ttl), #CreatedAt=if_not_exists(#CreatedAt,:now)",
          ExpressionAttributeNames: {
            "#Count": "Count",
            "#UpdatedAt": "UpdatedAt",
            "#WindowType": "WindowType",
            "#WindowID": "WindowID",
            "#Identifier": "Identifier",
            "#Resource": "Resource",
            "#Operation": "Operation",
            "#WindowStart": "WindowStart",
            "#TTL": "TTL",
            "#CreatedAt": "CreatedAt",
          },
          ExpressionAttributeValues: {
            ":inc": avN(1),
            ":now": avS(nowStr),
            ":wt": avS(window.key),
            ":wid": avS(windowId),
            ":id": avS(k.identifier),
            ":res": avS(k.resource),
            ":op": avS(k.operation),
            ":ws": avN(unixSeconds(window.start)),
            ":ttl": avN(ttl),
          },
        });
      } catch (err) {
        throw wrapError(err, "internal_error", "failed to record request");
      }
    }
  }

  async getUsage(key: RateLimitKey): Promise<UsageStats> {
    const k = normalizeKey(key);
    validateKey(k);

    const now = this._clock.now();
    const minuteWindow = getMinuteWindow(now);
    const hourWindow = getHourWindow(now);

    const cfg = this._config;
    const tableName = cfg.tableName || rateLimitTableName();

    let minuteLimit = cfg.defaultRequestsPerMinute;
    let hourLimit = cfg.defaultRequestsPerHour;
    const override = cfg.identifierLimits[k.identifier];
    if (override) {
      if (override.requestsPerMinute > 0)
        minuteLimit = override.requestsPerMinute;
      if (override.requestsPerHour > 0) hourLimit = override.requestsPerHour;
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

    let minuteCount = 0;
    let hourCount = 0;
    try {
      const minuteOut = await this._dynamo.getItem({
        TableName: tableName,
        Key: { PK: avS(minuteEntry.PK), SK: avS(minuteEntry.SK) },
        ConsistentRead: cfg.consistentRead,
      });
      minuteCount = getNumber(minuteOut.Item, "Count");
    } catch (err) {
      throw wrapError(err, "internal_error", "failed to get minute usage");
    }

    try {
      const hourOut = await this._dynamo.getItem({
        TableName: tableName,
        Key: { PK: avS(hourEntry.PK), SK: avS(hourEntry.SK) },
        ConsistentRead: cfg.consistentRead,
      });
      hourCount = getNumber(hourOut.Item, "Count");
    } catch (err) {
      throw wrapError(err, "internal_error", "failed to get hour usage");
    }

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

  async checkAndIncrement(key: RateLimitKey): Promise<LimitDecision> {
    const k = normalizeKey(key);
    validateKey(k);

    const now = this._clock.now();
    if (this._strategy instanceof MultiWindowStrategy) {
      return this._checkAndIncrementMultiWindow(k, now, this._strategy);
    }
    return this._checkAndIncrementSingleWindow(k, now);
  }

  private async _checkAndIncrementSingleWindow(
    key: RateLimitKey,
    now: Date,
  ): Promise<LimitDecision> {
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
    const tableName = cfg.tableName || rateLimitTableName();

    const entry = {
      Identifier: key.identifier,
      WindowStart: unixSeconds(window.start),
      Resource: key.resource,
      Operation: key.operation,
    };
    setKeysStrict(entry);

    const nowStr = formatRfc3339Nano(now);

    try {
      const out = await this._dynamo.updateItem({
        TableName: tableName,
        Key: { PK: avS(entry.PK), SK: avS(entry.SK) },
        UpdateExpression: "ADD #Count :inc SET #UpdatedAt=:now",
        ConditionExpression: "#Count < :limit",
        ExpressionAttributeNames: {
          "#Count": "Count",
          "#UpdatedAt": "UpdatedAt",
        },
        ExpressionAttributeValues: {
          ":inc": avN(1),
          ":now": avS(nowStr),
          ":limit": avN(limit),
        },
        ReturnValues: "ALL_NEW",
      });

      return {
        allowed: true,
        currentCount: getNumber(out.Attributes, "Count"),
        limit,
        resetsAt: window.end,
      };
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return await this._handleSingleWindowConditionFailed(
          key,
          now,
          window,
          limit,
          entry,
        );
      }
      if (cfg.failOpen) {
        return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
      }
      throw wrapError(
        err,
        "internal_error",
        "failed to check and increment rate limit",
      );
    }
  }

  private async _handleSingleWindowConditionFailed(
    key: RateLimitKey,
    now: Date,
    window: TimeWindow,
    limit: number,
    entry: KeyedEntry & {
      Identifier: string;
      WindowStart: number;
      Resource: string;
      Operation: string;
    },
  ): Promise<LimitDecision> {
    const cfg = this._config;
    const tableName = cfg.tableName || rateLimitTableName();

    let out: GetItemOutput;
    try {
      out = await this._dynamo.getItem({
        TableName: tableName,
        Key: { PK: avS(entry.PK), SK: avS(entry.SK) },
        ConsistentRead: cfg.consistentRead,
      });
    } catch (err) {
      if (cfg.failOpen) {
        return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
      }
      throw wrapError(err, "internal_error", "failed to load rate limit entry");
    }

    if (out.Item) {
      const currentCount = getNumber(out.Item, "Count");
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

  private async _createSingleWindowEntry(
    key: RateLimitKey,
    now: Date,
    window: TimeWindow,
    limit: number,
  ): Promise<LimitDecision> {
    const cfg = this._config;
    const tableName = cfg.tableName || rateLimitTableName();

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
      Metadata: key.metadata ?? {},
    };
    setKeysStrict(entry);

    const item: DynamoDBItem = {
      PK: avS(entry.PK),
      SK: avS(entry.SK),
      Identifier: avS(entry.Identifier),
      Resource: avS(entry.Resource),
      Operation: avS(entry.Operation),
      WindowStart: avN(entry.WindowStart),
      WindowType: avS(entry.WindowType),
      WindowID: avS(entry.WindowID),
      Count: avN(entry.Count),
      TTL: avN(entry.TTL),
      CreatedAt: avS(entry.CreatedAt),
      UpdatedAt: avS(entry.UpdatedAt),
      Metadata: avStringMap(entry.Metadata),
    };

    try {
      await this._dynamo.putItem({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#PK)",
        ExpressionAttributeNames: { "#PK": "PK" },
      });
      return { allowed: true, currentCount: 1, limit, resetsAt: window.end };
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return await this.checkAndIncrement(key);
      }
      if (cfg.failOpen) {
        return { allowed: true, currentCount: 0, limit, resetsAt: window.end };
      }
      throw wrapError(
        err,
        "internal_error",
        "failed to create rate limit entry",
      );
    }
  }

  private async _checkAndIncrementMultiWindow(
    key: RateLimitKey,
    now: Date,
    strategy: MultiWindowStrategy,
  ): Promise<LimitDecision> {
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
    const tableName = cfg.tableName || rateLimitTableName();

    if (
      typeof (this._dynamo as { transactWriteItems?: unknown })
        .transactWriteItems !== "function"
    ) {
      return await this._checkAndIncrementMultiWindowFallback(key);
    }

    const nowStr = formatRfc3339Nano(now);

    const transactItems: Array<Record<string, unknown>> = [];
    for (const window of windows) {
      const maxAllowed = maxRequestsForWindow(strategy, window);
      if (maxAllowed <= 0) {
        const err = new Error("apptheory: max_allowed is 0");
        (err as { name: string }).name = "ConditionalCheckFailedException";
        return await this._handleMultiWindowIncrementError(
          key,
          now,
          windows,
          primaryLimit,
          err,
        );
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

      transactItems.push({
        Update: {
          TableName: tableName,
          Key: {
            PK: avS(entry.PK),
            SK: avS(entry.SK),
          },
          UpdateExpression:
            "ADD #Count :inc SET #UpdatedAt=:now, #WindowType=if_not_exists(#WindowType,:wt), #WindowID=if_not_exists(#WindowID,:wid), #Identifier=if_not_exists(#Identifier,:id), #Resource=if_not_exists(#Resource,:res), #Operation=if_not_exists(#Operation,:op), #WindowStart=if_not_exists(#WindowStart,:ws), #TTL=if_not_exists(#TTL,:ttl), #CreatedAt=if_not_exists(#CreatedAt,:now)",
          ConditionExpression:
            "attribute_not_exists(#Count) OR #Count < :maxAllowed",
          ExpressionAttributeNames: {
            "#Count": "Count",
            "#UpdatedAt": "UpdatedAt",
            "#WindowType": "WindowType",
            "#WindowID": "WindowID",
            "#Identifier": "Identifier",
            "#Resource": "Resource",
            "#Operation": "Operation",
            "#WindowStart": "WindowStart",
            "#TTL": "TTL",
            "#CreatedAt": "CreatedAt",
          },
          ExpressionAttributeValues: {
            ":inc": avN(1),
            ":now": avS(nowStr),
            ":wt": avS(window.key),
            ":wid": avS(windowId),
            ":id": avS(key.identifier),
            ":res": avS(key.resource),
            ":op": avS(key.operation),
            ":ws": avN(unixSeconds(window.start)),
            ":ttl": avN(ttl),
            ":maxAllowed": avN(maxAllowed),
          },
        },
      });
    }

    try {
      await this._dynamo.transactWriteItems({ TransactItems: transactItems });
    } catch (err) {
      return await this._handleMultiWindowIncrementError(
        key,
        now,
        windows,
        primaryLimit,
        err,
      );
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
      const out = await this._dynamo.getItem({
        TableName: tableName,
        Key: { PK: avS(entry.PK), SK: avS(entry.SK) },
        ConsistentRead: cfg.consistentRead,
      });
      currentCount = getNumber(out.Item, "Count");
    } catch (err) {
      if (cfg.failOpen) {
        return {
          allowed: true,
          currentCount: 0,
          limit: primaryLimit,
          resetsAt: primaryWindow.end,
        };
      }
      throw wrapError(
        err,
        "internal_error",
        "failed to load updated rate limit entry",
      );
    }

    return {
      allowed: true,
      currentCount,
      limit: primaryLimit,
      resetsAt: primaryWindow.end,
    };
  }

  private async _checkAndIncrementMultiWindowFallback(
    key: RateLimitKey,
  ): Promise<LimitDecision> {
    const decision = await this.checkLimit(key);
    if (!decision.allowed) return decision;
    try {
      await this.recordRequest(key);
    } catch (err) {
      if (!this._config.failOpen) {
        throw wrapError(err, "internal_error", "failed to record request");
      }
    }
    return { ...decision, currentCount: decision.currentCount + 1 };
  }

  private async _handleMultiWindowIncrementError(
    key: RateLimitKey,
    now: Date,
    windows: TimeWindow[],
    primaryLimit: number,
    err: unknown,
  ): Promise<LimitDecision> {
    const primary = windows[0];
    const resetsAt = primary ? primary.end : now;
    if (isConditionalCheckFailed(err)) {
      const decision = await this.checkLimit(key);
      const out: LimitDecision = { ...decision, allowed: false };
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

    throw wrapError(
      err,
      "internal_error",
      "failed to check and increment rate limit",
    );
  }
}
