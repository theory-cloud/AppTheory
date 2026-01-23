export type ErrorType =
  | "internal_error"
  | "rate_limit_exceeded"
  | "invalid_input";

export class RateLimiterError extends Error {
  readonly type: ErrorType;
  readonly cause: unknown;

  constructor(type: ErrorType, message: string, cause: unknown = null) {
    super(String(message));
    this.name = "RateLimiterError";
    this.type = type;
    this.cause = cause;
  }
}

export function newError(type: ErrorType, message: string): RateLimiterError {
  return new RateLimiterError(type, message);
}

export function wrapError(
  cause: unknown,
  type: ErrorType,
  message: string,
): RateLimiterError {
  return new RateLimiterError(type, message, cause);
}
