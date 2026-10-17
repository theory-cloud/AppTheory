export declare const REQUEST_ID_SOURCE_DEFAULT = "default";
export declare const REQUEST_ID_SOURCE_SERVER = "server";
export type RequestIdSource = typeof REQUEST_ID_SOURCE_DEFAULT | typeof REQUEST_ID_SOURCE_SERVER;
export declare function normalizeRequestIdSource(source: unknown): RequestIdSource;
/** Longest client-supplied x-request-id the framework treats as well-formed. */
export declare const MAX_CLIENT_REQUEST_ID_LENGTH = 128;
/**
 * Reports whether a client-supplied x-request-id header value is well-formed.
 *
 * A value is well-formed when, after trimming leading and trailing whitespace,
 * it is 1 to `MAX_CLIENT_REQUEST_ID_LENGTH` characters long and every character
 * is visible ASCII (0x21 through 0x7E). Spaces, tabs, carriage returns, line
 * feeds, other control characters, and non-ASCII characters all make a value
 * malformed.
 *
 * The runtime never uses a malformed value as the request ID. Consumer
 * applications read well-formed client values through `Context.clientRequestId`.
 */
export declare function isWellFormedClientRequestId(value: unknown): boolean;
/**
 * Returns the trimmed client value when it is well-formed, and an empty string
 * otherwise.
 */
export declare function wellFormedClientRequestId(value: unknown): string;
//# sourceMappingURL=request-id-source.d.ts.map