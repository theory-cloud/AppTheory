export class AppError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
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

export class AppTheoryError extends Error {
  code: string;
  statusCode?: number;
  details?: AppTheoryErrorDetails;
  requestId?: string;
  traceId?: string;
  timestamp?: string;
  stackTrace?: string;
  override cause?: unknown;

  constructor(
    code: string,
    message: string,
    options: AppTheoryErrorOptions = {},
  ) {
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

  withDetails(details: AppTheoryErrorDetails): this {
    this.details = details;
    return this;
  }

  withRequestID(requestId: string): this {
    this.requestId = requestId;
    return this;
  }

  withTraceID(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  withTimestamp(timestamp: string | Date): this {
    this.timestamp =
      timestamp instanceof Date ? timestamp.toISOString() : timestamp;
    return this;
  }

  withStackTrace(stackTrace: string): this {
    this.stackTrace = stackTrace;
    return this;
  }

  withStatusCode(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  withCause(cause: unknown): this {
    this.cause = cause;
    return this;
  }
}

export const appTheoryErrorFromAppError = (err: AppError): AppTheoryError =>
  new AppTheoryError(err.code, err.message);

export const isAppTheoryError = (err: unknown): err is AppTheoryError =>
  err instanceof AppTheoryError;
