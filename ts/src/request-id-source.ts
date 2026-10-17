export const REQUEST_ID_SOURCE_DEFAULT = "default";
export const REQUEST_ID_SOURCE_SERVER = "server";

export type RequestIdSource =
  typeof REQUEST_ID_SOURCE_DEFAULT | typeof REQUEST_ID_SOURCE_SERVER;

export function normalizeRequestIdSource(source: unknown): RequestIdSource {
  return source === REQUEST_ID_SOURCE_SERVER
    ? REQUEST_ID_SOURCE_SERVER
    : REQUEST_ID_SOURCE_DEFAULT;
}

/** Longest client-supplied x-request-id the framework treats as well-formed. */
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

const CLIENT_REQUEST_ID_WHITESPACE = " \t\n\v\f\r";

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
export function isWellFormedClientRequestId(value: unknown): boolean {
  return wellFormedClientRequestId(value) !== "";
}

/**
 * Returns the trimmed client value when it is well-formed, and an empty string
 * otherwise.
 */
export function wellFormedClientRequestId(value: unknown): string {
  const trimmed = trimClientRequestIdWhitespace(String(value ?? ""));
  const length = trimmed.length;
  if (length === 0 || length > MAX_CLIENT_REQUEST_ID_LENGTH) return "";
  for (let index = 0; index < length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return "";
  }
  return trimmed;
}

function trimClientRequestIdWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (
    start < end &&
    CLIENT_REQUEST_ID_WHITESPACE.includes(value.charAt(start))
  ) {
    start += 1;
  }
  while (
    end > start &&
    CLIENT_REQUEST_ID_WHITESPACE.includes(value.charAt(end - 1))
  ) {
    end -= 1;
  }
  return value.slice(start, end);
}
