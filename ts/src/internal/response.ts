import { Buffer } from "node:buffer";

import { AppError, AppTheoryError } from "../errors.js";
import {
  HTTP_ERROR_FORMAT_FLAT_LEGACY,
  HTTP_ERROR_FORMAT_NESTED,
  type HTTPErrorFormat,
  normalizeHTTPErrorFormat,
} from "../http-error-format.js";
import type { BodyStream, Headers, Response } from "../types.js";

import { canonicalizeHeaders, normalizeBodyStream, toBuffer } from "./http.js";

export interface NormalizedResponse {
  status: number;
  headers: Headers;
  cookies: string[];
  body: Buffer;
  bodyStream: AsyncIterable<Buffer> | null;
  isBase64: boolean;
}

export function normalizeResponse(
  response: Response | null | undefined,
): NormalizedResponse {
  if (!response) {
    return errorResponse("app.internal", "internal error");
  }

  const status = response.status ?? 200;
  const headers = canonicalizeHeaders(response.headers);
  const cookies = Array.isArray(response.cookies)
    ? response.cookies.map((c) => String(c))
    : [];

  const setCookie = headers["set-cookie"];
  if (Array.isArray(setCookie) && setCookie.length > 0) {
    cookies.push(...setCookie.map((c) => String(c)));
    delete headers["set-cookie"];
  }

  const body = toBuffer(response.body);
  const bodyStream =
    response.bodyStream !== null && response.bodyStream !== undefined
      ? normalizeBodyStream(response.bodyStream as BodyStream)
      : null;

  const isBase64 = Boolean(response.isBase64);
  if (isBase64 && bodyStream) {
    throw new TypeError("bodyStream cannot be used with isBase64=true");
  }

  // A response must carry exactly one body representation. A non-empty
  // buffered body combined with a streaming body is divergent: the buffered
  // adapters drain the stream and replace the buffered body, while the v1
  // proxy adapter ignores bodyStream entirely and the v1 streaming adapter
  // composes only body + BodyReader. The same handler response would produce
  // different wire bytes on different adapters, so the normalizer fails
  // closed on the ambiguous shape instead of letting adapters silently pick
  // one representation.
  if (body.length > 0 && bodyStream) {
    throw new TypeError("bodyStream cannot be used with a non-empty body");
  }

  return { status, headers, cookies, body, bodyStream, isBase64 };
}

export function hasJSONContentType(headers: Headers): boolean {
  for (const value of headers["content-type"] ?? []) {
    const normalized = String(value).trim().toLowerCase();
    if (normalized.startsWith("application/json")) {
      return true;
    }
  }
  return false;
}

function statusForErrorCode(code: string): number {
  switch (code) {
    case "app.bad_request":
      return 400;
    case "app.validation_failed":
      return 422;
    case "app.unauthorized":
      return 401;
    case "app.forbidden":
      return 403;
    case "app.not_found":
      return 404;
    case "app.method_not_allowed":
      return 405;
    case "app.conflict":
      return 409;
    case "app.too_large":
      return 413;
    case "app.timeout":
      return 408;
    case "app.rate_limited":
      return 429;
    case "app.overloaded":
      return 503;
    case "app.internal":
      return 500;
    default:
      return 500;
  }
}

function canonicalHTTPErrorFields(
  format: HTTPErrorFormat,
  code: string,
  message: string,
): { code: string; message: string } {
  if (normalizeHTTPErrorFormat(format) === HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    return { code, message };
  }
  switch (code) {
    case "EMPTY_BODY":
      return { code: "app.bad_request", message: "request body is empty" };
    case "INVALID_JSON":
      return { code: "app.bad_request", message: "invalid json" };
    default:
      return { code, message };
  }
}

function canonicalRuntimeErrorCode(code: string): string {
  switch (code) {
    case "EMPTY_BODY":
    case "INVALID_JSON":
      return "app.bad_request";
    default:
      return code;
  }
}

function errorBodyFromAppTheoryError(
  format: HTTPErrorFormat,
  err: AppTheoryError,
  status: number,
  requestId: string,
  traceId: string = "",
): Record<string, unknown> {
  const code = String(err.code ?? "").trim() || "app.internal";
  const canonical = canonicalHTTPErrorFields(
    format,
    code,
    String(err.message ?? ""),
  );
  const error: Record<string, unknown> = {
    code: canonical.code,
    message: canonical.message,
  };

  if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    error["status_code"] = status;
  }
  if (err.details !== undefined) {
    error["details"] = err.details;
  }

  if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    const resolvedRequestId =
      String(err.requestId ?? "").trim() || String(requestId ?? "").trim();
    if (resolvedRequestId) {
      error["request_id"] = resolvedRequestId;
    }
    const resolvedTraceId =
      String(err.traceId ?? "").trim() || String(traceId ?? "").trim();
    if (resolvedTraceId) {
      error["trace_id"] = resolvedTraceId;
    }
    if (String(err.timestamp ?? "").trim()) {
      error["timestamp"] = String(err.timestamp);
    }
    if (String(err.stackTrace ?? "").trim()) {
      error["stack_trace"] = String(err.stackTrace);
    }
  }

  return error;
}

// An error envelope value that has no faithful JSON representation — a
// function, a symbol, a bigint, `undefined`, or a cycle — fails the envelope
// instead of being silently dropped, so a caller never receives a body that
// quietly lost a field.
class HTTPErrorBodySerializationError extends Error {}

const FALLBACK_HTTP_ERROR_STATUS = 500;
const FALLBACK_HTTP_ERROR_BODY_NESTED =
  '{"error":{"code":"app.internal","message":"internal error","status_code":500}}';
const FALLBACK_HTTP_ERROR_BODY_FLAT_LEGACY =
  '{"code":"app.internal","message":"internal error"}';

// The internal-error envelope sent when the intended envelope cannot be
// serialized. It carries no request id, trace id, timestamp, or stack trace: a
// response that failed to serialize reports the internal error and nothing
// about the original error.
function fallbackHTTPErrorBody(format: HTTPErrorFormat): Buffer {
  return Buffer.from(
    normalizeHTTPErrorFormat(format) === HTTP_ERROR_FORMAT_FLAT_LEGACY
      ? FALLBACK_HTTP_ERROR_BODY_FLAT_LEGACY
      : FALLBACK_HTTP_ERROR_BODY_NESTED,
    "utf8",
  );
}

// The Go and Python renderers marshal the error object through a key-sorted map
// (encoding/json map ordering; json.dumps(sort_keys=True)), so the nested envelope
// is byte-identical across runtimes only if TypeScript emits the same key order.
// Flat-legacy is deliberately left in insertion order to stay byte-identical.
function sortKeysDeep(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new HTTPErrorBodySerializationError(
        "error envelope contains a cycle",
      );
    }
    ancestors.add(value);
    const sorted = value.map((item) => sortKeysDeep(item, ancestors));
    ancestors.delete(value);
    return sorted;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) {
      throw new HTTPErrorBodySerializationError(
        "error envelope contains a cycle",
      );
    }
    ancestors.add(value);
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key], ancestors);
    }
    ancestors.delete(value);
    return sorted;
  }
  return value;
}

// JSON.stringify drops a function, symbol, or `undefined` property and throws on
// a bigint, so a replacer that refuses all four keeps the envelope faithful: an
// error that cannot be rendered in full is reported as the internal-error
// fallback rather than truncated without notice.
function strictJSONStringify(payload: unknown): string {
  return JSON.stringify(payload, (_key: string, value: unknown) => {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      throw new HTTPErrorBodySerializationError(
        "error envelope contains a value with no JSON representation",
      );
    }
    return value;
  });
}

function serializeHTTPErrorBody(
  format: HTTPErrorFormat,
  error: unknown,
): Buffer {
  const payload =
    normalizeHTTPErrorFormat(format) === HTTP_ERROR_FORMAT_FLAT_LEGACY
      ? error
      : { error: sortKeysDeep(error) };
  return Buffer.from(strictJSONStringify(payload), "utf8");
}

// Renders the error envelope, falling back to the internal-error body sent with
// status 500 when it cannot be serialized, so the status_code in the body never
// disagrees with the status on the wire.
function serializeErrorResponseBody(
  format: HTTPErrorFormat,
  status: number,
  error: unknown,
): { status: number; body: Buffer } {
  try {
    return { status, body: serializeHTTPErrorBody(format, error) };
  } catch {
    return {
      status: FALLBACK_HTTP_ERROR_STATUS,
      body: fallbackHTTPErrorBody(format),
    };
  }
}

function errorResponseFromAppTheoryErrorWithFormat(
  format: HTTPErrorFormat,
  err: AppTheoryError,
  headers: Headers = {},
  requestId: string = "",
  traceId: string = "",
): NormalizedResponse {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const code = String(err.code ?? "").trim() || "app.internal";
  const canonical = canonicalHTTPErrorFields(format, code, err.message);
  const status =
    typeof err.statusCode === "number" && err.statusCode > 0
      ? err.statusCode
      : statusForErrorCode(canonical.code);

  const serialized = serializeErrorResponseBody(
    format,
    status,
    errorBodyFromAppTheoryError(format, err, status, requestId, traceId),
  );

  return normalizeResponse({
    status: serialized.status,
    headers: outHeaders,
    cookies: [],
    body: serialized.body,
    isBase64: false,
  });
}

export function errorResponse(
  code: string,
  message: string,
  headers: Headers = {},
): NormalizedResponse {
  return errorResponseWithFormat(
    HTTP_ERROR_FORMAT_NESTED,
    code,
    message,
    headers,
  );
}

export function errorResponseWithFormat(
  format: HTTPErrorFormat,
  code: string,
  message: string,
  headers: Headers = {},
): NormalizedResponse {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const status = statusForErrorCode(canonicalRuntimeErrorCode(code));
  const canonical = canonicalHTTPErrorFields(format, code, message);
  const error: Record<string, unknown> = {
    code: canonical.code,
    message: canonical.message,
  };
  if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    error["status_code"] = status;
  }

  const serialized = serializeErrorResponseBody(format, status, error);

  return normalizeResponse({
    status: serialized.status,
    headers: outHeaders,
    cookies: [],
    body: serialized.body,
    isBase64: false,
  });
}

export function errorResponseWithRequestId(
  code: string,
  message: string,
  headers: Headers = {},
  requestId: string = "",
): NormalizedResponse {
  return errorResponseWithRequestIdAndFormat(
    HTTP_ERROR_FORMAT_NESTED,
    code,
    message,
    headers,
    requestId,
  );
}

export function errorResponseWithRequestIdAndFormat(
  format: HTTPErrorFormat,
  code: string,
  message: string,
  headers: Headers = {},
  requestId: string = "",
): NormalizedResponse {
  return errorResponseWithRequestIdTraceIdAndFormat(
    format,
    code,
    message,
    headers,
    requestId,
    "",
  );
}

export function errorResponseWithRequestIdTraceIdAndFormat(
  format: HTTPErrorFormat,
  code: string,
  message: string,
  headers: Headers = {},
  requestId: string = "",
  traceId: string = "",
): NormalizedResponse {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const canonical = canonicalHTTPErrorFields(format, code, message);
  const status = statusForErrorCode(canonicalRuntimeErrorCode(code));
  const error: Record<string, unknown> = {
    code: canonical.code,
    message: canonical.message,
  };
  if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    error["status_code"] = status;
    if (requestId) {
      error["request_id"] = String(requestId);
    }
    const resolvedTraceId = String(traceId ?? "").trim();
    if (resolvedTraceId) error["trace_id"] = resolvedTraceId;
  }

  const serialized = serializeErrorResponseBody(format, status, error);

  return normalizeResponse({
    status: serialized.status,
    headers: outHeaders,
    cookies: [],
    body: serialized.body,
    isBase64: false,
  });
}

export function responseForError(err: unknown): NormalizedResponse {
  return responseForErrorWithFormat(HTTP_ERROR_FORMAT_NESTED, err);
}

export function responseForErrorWithFormat(
  format: HTTPErrorFormat,
  err: unknown,
): NormalizedResponse {
  if (err instanceof AppTheoryError) {
    return errorResponseFromAppTheoryErrorWithFormat(
      format,
      err,
      err.headers ?? {},
    );
  }
  if (err instanceof AppError) {
    return errorResponseWithFormat(format, err.code, err.message);
  }
  return errorResponseWithFormat(format, "app.internal", "internal error");
}

export function responseForErrorWithRequestId(
  err: unknown,
  requestId: string,
): NormalizedResponse {
  return responseForErrorWithRequestIdAndFormat(
    HTTP_ERROR_FORMAT_NESTED,
    err,
    requestId,
  );
}

export function responseForErrorWithRequestIdAndFormat(
  format: HTTPErrorFormat,
  err: unknown,
  requestId: string,
): NormalizedResponse {
  return responseForErrorWithRequestIdTraceIdAndFormat(
    format,
    err,
    requestId,
    "",
  );
}

export function responseForErrorWithRequestIdTraceIdAndFormat(
  format: HTTPErrorFormat,
  err: unknown,
  requestId: string,
  traceId: string,
): NormalizedResponse {
  if (err instanceof AppTheoryError) {
    return errorResponseFromAppTheoryErrorWithFormat(
      format,
      err,
      err.headers ?? {},
      requestId,
      traceId,
    );
  }
  if (err instanceof AppError) {
    return errorResponseWithRequestIdTraceIdAndFormat(
      format,
      err.code,
      err.message,
      {},
      requestId,
      traceId,
    );
  }
  return errorResponseWithRequestIdTraceIdAndFormat(
    format,
    "app.internal",
    "internal error",
    {},
    requestId,
    traceId,
  );
}
