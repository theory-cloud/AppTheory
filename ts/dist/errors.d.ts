/**
 * Legacy portable, client-safe error with a stable error code.
 *
 * @deprecated Return AppTheoryError from new code so status, request, trace,
 * timestamp, details, and cause metadata use the canonical AppTheory error
 * path.
 */
export declare class AppError extends Error {
    code: string;
    constructor(code: string, message: string);
}
export type AppTheoryErrorDetails = Record<string, unknown>;
export type AppTheoryErrorOptions = {
    statusCode?: number;
    details?: AppTheoryErrorDetails;
    requestId?: string;
    traceId?: string;
    timestamp?: string | Date;
    stackTrace?: string;
    cause?: unknown;
};
/**
 * Canonical AppTheory portable, client-safe error.
 *
 * Return AppTheoryError from framework and application code when the runtime
 * should preserve status, details, request, trace, timestamp, stack, or cause
 * metadata in the AppTheory error envelope.
 */
export declare class AppTheoryError extends Error {
    code: string;
    statusCode?: number;
    details?: AppTheoryErrorDetails;
    requestId?: string;
    traceId?: string;
    timestamp?: string;
    stackTrace?: string;
    cause?: unknown;
    constructor(code: string, message: string, options?: AppTheoryErrorOptions);
    withDetails(details: AppTheoryErrorDetails): this;
    withRequestID(requestId: string): this;
    withTraceID(traceId: string): this;
    withTimestamp(timestamp: string | Date): this;
    withStackTrace(stackTrace: string): this;
    withStatusCode(statusCode: number): this;
    withCause(cause: unknown): this;
}
export declare const appTheoryErrorFromAppError: (err: AppError) => AppTheoryError;
export declare const isAppTheoryError: (err: unknown) => err is AppTheoryError;
//# sourceMappingURL=errors.d.ts.map