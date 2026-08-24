import type { Headers } from "./types.js";
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
    headers?: Headers;
    cause?: unknown;
};
/**
 * Canonical AppTheory portable, client-safe error.
 *
 * Return AppTheoryError from framework and application code when the runtime
 * should preserve status, details, request, trace, timestamp, stack, or cause
 * metadata in the AppTheory error envelope.
 *
 * `headers` carries a bounded caller-supplied response header set. The HTTP
 * error renderer merges them (canonicalized) into the error response, so a
 * SecureApp principal resolver can attach a WWW-Authenticate challenge to a
 * 401/403 denial. The existing response vocabulary is unchanged: an omitted
 * or empty `headers` renders byte-identical to before.
 */
export declare class AppTheoryError extends Error {
    code: string;
    statusCode?: number;
    details?: AppTheoryErrorDetails;
    requestId?: string;
    traceId?: string;
    timestamp?: string;
    stackTrace?: string;
    headers?: Headers;
    cause?: unknown;
    constructor(code: string, message: string, options?: AppTheoryErrorOptions);
    withDetails(details: AppTheoryErrorDetails): this;
    withRequestID(requestId: string): this;
    withTraceID(traceId: string): this;
    withTimestamp(timestamp: string | Date): this;
    withStackTrace(stackTrace: string): this;
    withStatusCode(statusCode: number): this;
    /** Sets caller-supplied response headers rendered on the HTTP error response. */
    withHeaders(headers: Headers): this;
    withCause(cause: unknown): this;
}
export declare const appTheoryErrorFromAppError: (err: AppError) => AppTheoryError;
export declare const isAppTheoryError: (err: unknown) => err is AppTheoryError;
//# sourceMappingURL=errors.d.ts.map