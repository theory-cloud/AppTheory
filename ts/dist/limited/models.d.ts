export interface RateLimitEntry {
    PK: string;
    SK: string;
    Identifier: string;
    Resource: string;
    Operation: string;
    WindowStart: number;
    WindowType: string;
    WindowID: string;
    Count: number;
    TTL: number;
    CreatedAt: string;
    UpdatedAt: string;
    Metadata?: Record<string, string>;
}
export declare function setKeys(entry: Pick<RateLimitEntry, "Identifier" | "WindowStart" | "Resource" | "Operation"> & {
    PK?: string;
    SK?: string;
}): void;
export declare function rateLimitTableName(): string;
export type RateLimitWindow = {
    windowType: string;
    start: Date;
    end: Date;
};
export declare function unixSeconds(d: Date): number;
export declare function formatWindowId(d: Date): string;
export declare function formatRfc3339Nano(d: Date): string;
export declare function getMinuteWindow(now: Date): RateLimitWindow;
export declare function getHourWindow(now: Date): RateLimitWindow;
export declare function getDayWindow(now: Date): RateLimitWindow;
export declare function getFixedWindow(now: Date, durationMs: number): RateLimitWindow;
