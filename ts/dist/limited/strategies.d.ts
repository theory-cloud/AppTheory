import type { RateLimitKey, RateLimitStrategy, TimeWindow } from "./types.js";
export declare class FixedWindowStrategy implements RateLimitStrategy {
    readonly windowSizeMs: number;
    readonly maxRequests: number;
    readonly identifierLimits: Record<string, number>;
    readonly resourceLimits: Record<string, number>;
    constructor(windowSizeMs: number, maxRequests: number);
    calculateWindows(now: Date): TimeWindow[];
    getLimit(key: RateLimitKey): number;
    shouldAllow(counts: Record<string, number>, limit: number): boolean;
    setIdentifierLimit(identifier: string, limit: number): void;
    setResourceLimit(resource: string, limit: number): void;
}
export declare class SlidingWindowStrategy implements RateLimitStrategy {
    readonly windowSizeMs: number;
    readonly maxRequests: number;
    readonly granularityMs: number;
    readonly identifierLimits: Record<string, number>;
    readonly resourceLimits: Record<string, number>;
    constructor(windowSizeMs: number, maxRequests: number, granularityMs: number);
    calculateWindows(now: Date): TimeWindow[];
    getLimit(key: RateLimitKey): number;
    shouldAllow(counts: Record<string, number>, limit: number): boolean;
    setIdentifierLimit(identifier: string, limit: number): void;
    setResourceLimit(resource: string, limit: number): void;
}
export type WindowConfig = {
    durationMs: number;
    maxRequests: number;
};
export declare class MultiWindowStrategy implements RateLimitStrategy {
    readonly windows: WindowConfig[];
    readonly identifierLimits: Record<string, WindowConfig[]>;
    readonly resourceLimits: Record<string, WindowConfig[]>;
    constructor(windows: WindowConfig[]);
    calculateWindows(now: Date): TimeWindow[];
    getLimit(key: RateLimitKey): number;
    shouldAllow(counts: Record<string, number>, _limit: number): boolean;
    private _limitsForKey;
}
