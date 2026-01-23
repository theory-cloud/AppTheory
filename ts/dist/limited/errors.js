export class RateLimiterError extends Error {
    type;
    cause;
    constructor(type, message, cause = null) {
        super(String(message));
        this.name = "RateLimiterError";
        this.type = type;
        this.cause = cause;
    }
}
export function newError(type, message) {
    return new RateLimiterError(type, message);
}
export function wrapError(cause, type, message) {
    return new RateLimiterError(type, message, cause);
}
