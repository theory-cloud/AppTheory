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
