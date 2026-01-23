import type { Clock } from "../clock.js";
import { DynamoDBClient } from "../internal/aws-dynamodb.js";
import { type AtomicRateLimiter, type Config, type LimitDecision, type RateLimiter, type RateLimitKey, type RateLimitStrategy, type UsageStats } from "./types.js";
export declare function defaultConfig(): Config;
export declare class DynamoRateLimiter implements AtomicRateLimiter, RateLimiter {
    private readonly _dynamo;
    private readonly _config;
    private readonly _strategy;
    private _clock;
    constructor(options?: {
        dynamo?: DynamoDBClient;
        config?: Partial<Config>;
        strategy?: RateLimitStrategy;
        clock?: Clock;
    });
    setClock(clock: Clock | null | undefined): void;
    checkLimit(key: RateLimitKey): Promise<LimitDecision>;
    recordRequest(key: RateLimitKey): Promise<void>;
    getUsage(key: RateLimitKey): Promise<UsageStats>;
    checkAndIncrement(key: RateLimitKey): Promise<LimitDecision>;
    private _checkAndIncrementSingleWindow;
    private _handleSingleWindowConditionFailed;
    private _createSingleWindowEntry;
    private _checkAndIncrementMultiWindow;
    private _checkAndIncrementMultiWindowFallback;
    private _handleMultiWindowIncrementError;
}
