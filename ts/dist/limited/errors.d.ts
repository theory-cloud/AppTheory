export type ErrorType = "internal_error" | "rate_limit_exceeded" | "invalid_input";
export declare class RateLimiterError extends Error {
    readonly type: ErrorType;
    readonly cause: unknown;
    constructor(type: ErrorType, message: string, cause?: unknown);
}
export declare function newError(type: ErrorType, message: string): RateLimiterError;
export declare function wrapError(cause: unknown, type: ErrorType, message: string): RateLimiterError;
