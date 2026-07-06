/**
 * Legacy portable, client-safe error with a stable error code.
 *
 * @deprecated Return AppTheoryError from new code so status, request, trace,
 * timestamp, details, and cause metadata use the canonical AppTheory error
 * path.
 */
export class AppError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AppError";
    }
}
/**
 * Canonical AppTheory portable, client-safe error.
 *
 * Return AppTheoryError from framework and application code when the runtime
 * should preserve status, details, request, trace, timestamp, stack, or cause
 * metadata in the AppTheory error envelope.
 */
export class AppTheoryError extends Error {
    code;
    statusCode;
    details;
    requestId;
    traceId;
    timestamp;
    stackTrace;
    cause;
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.code = code;
        this.name = "AppTheoryError";
        if (options.statusCode !== undefined) {
            this.statusCode = options.statusCode;
        }
        if (options.details !== undefined) {
            this.details = options.details;
        }
        if (options.requestId !== undefined) {
            this.requestId = options.requestId;
        }
        if (options.traceId !== undefined) {
            this.traceId = options.traceId;
        }
        if (options.timestamp !== undefined) {
            this.timestamp =
                options.timestamp instanceof Date
                    ? options.timestamp.toISOString()
                    : options.timestamp;
        }
        if (options.stackTrace !== undefined) {
            this.stackTrace = options.stackTrace;
        }
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
    withDetails(details) {
        this.details = details;
        return this;
    }
    withRequestID(requestId) {
        this.requestId = requestId;
        return this;
    }
    withTraceID(traceId) {
        this.traceId = traceId;
        return this;
    }
    withTimestamp(timestamp) {
        this.timestamp =
            timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        return this;
    }
    withStackTrace(stackTrace) {
        this.stackTrace = stackTrace;
        return this;
    }
    withStatusCode(statusCode) {
        this.statusCode = statusCode;
        return this;
    }
    withCause(cause) {
        this.cause = cause;
        return this;
    }
}
export const appTheoryErrorFromAppError = (err) => new AppTheoryError(err.code, err.message);
export const isAppTheoryError = (err) => err instanceof AppTheoryError;
//# sourceMappingURL=errors.js.map