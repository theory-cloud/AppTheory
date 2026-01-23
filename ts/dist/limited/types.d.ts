export interface RateLimitKey {
    identifier: string;
    resource: string;
    operation: string;
    metadata?: Record<string, string>;
}
export interface LimitDecision {
    allowed: boolean;
    currentCount: number;
    limit: number;
    resetsAt: Date;
    retryAfterMs?: number;
}
export interface UsageWindow {
    count: number;
    limit: number;
    windowStart: Date;
    windowEnd: Date;
}
export interface UsageStats {
    identifier: string;
    resource: string;
    currentHour: UsageWindow;
    currentMinute: UsageWindow;
    dailyTotal: number;
    customWindows: Record<string, UsageWindow>;
}
export interface RateLimiter {
    checkLimit(key: RateLimitKey): Promise<LimitDecision>;
    recordRequest(key: RateLimitKey): Promise<void>;
    getUsage(key: RateLimitKey): Promise<UsageStats>;
}
export interface AtomicRateLimiter extends RateLimiter {
    checkAndIncrement(key: RateLimitKey): Promise<LimitDecision>;
}
export interface TimeWindow {
    start: Date;
    end: Date;
    key: string;
}
export interface RateLimitStrategy {
    calculateWindows(now: Date): TimeWindow[];
    getLimit(key: RateLimitKey): number;
    shouldAllow(counts: Record<string, number>, limit: number): boolean;
}
export interface WindowLimit {
    durationMs: number;
    requests: number;
}
export interface Limit {
    requestsPerHour: number;
    requestsPerMinute: number;
    burstCapacity: number;
    customWindows: Record<string, WindowLimit>;
}
export interface Config {
    defaultRequestsPerHour: number;
    defaultRequestsPerMinute: number;
    defaultBurstCapacity: number;
    enableBurstCapacity: boolean;
    enableSoftLimits: boolean;
    failOpen: boolean;
    tableName: string;
    consistentRead: boolean;
    ttlHours: number;
    identifierLimits: Record<string, Limit>;
    resourceLimits: Record<string, Limit>;
}
