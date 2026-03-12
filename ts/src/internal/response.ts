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
    case "app.validation_failed":
      return 400;
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

function errorBodyFromAppTheoryError(
  format: HTTPErrorFormat,
  err: AppTheoryError,
  requestId: string,
): Record<string, unknown> {
  const code = String(err.code ?? "").trim() || "app.internal";
  const error: Record<string, unknown> = {
    code,
    message: String(err.message ?? ""),
  };

  if (
    normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY &&
    typeof err.statusCode === "number" &&
    err.statusCode > 0
  ) {
    error["status_code"] = err.statusCode;
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
    if (String(err.traceId ?? "").trim()) {
      error["trace_id"] = String(err.traceId);
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

function serializeHTTPErrorBody(
  format: HTTPErrorFormat,
  error: Record<string, unknown>,
): Buffer {
  if (normalizeHTTPErrorFormat(format) === HTTP_ERROR_FORMAT_FLAT_LEGACY) {
    return Buffer.from(JSON.stringify(error), "utf8");
  }
  return Buffer.from(JSON.stringify({ error }), "utf8");
}

function errorResponseFromAppTheoryErrorWithFormat(
  format: HTTPErrorFormat,
  err: AppTheoryError,
  headers: Headers = {},
  requestId: string = "",
): NormalizedResponse {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const code = String(err.code ?? "").trim() || "app.internal";
  const status =
    typeof err.statusCode === "number" && err.statusCode > 0
      ? err.statusCode
      : statusForErrorCode(code);

  return normalizeResponse({
    status,
    headers: outHeaders,
    cookies: [],
    body: serializeHTTPErrorBody(
      format,
      errorBodyFromAppTheoryError(format, err, requestId),
    ),
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

  return normalizeResponse({
    status: statusForErrorCode(code),
    headers: outHeaders,
    cookies: [],
    body: serializeHTTPErrorBody(format, { code, message }),
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
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const error: Record<string, string> = { code, message };
  if (
    normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY &&
    requestId
  ) {
    error["request_id"] = String(requestId);
  }

  return normalizeResponse({
    status: statusForErrorCode(code),
    headers: outHeaders,
    cookies: [],
    body: serializeHTTPErrorBody(format, error),
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
    return errorResponseFromAppTheoryErrorWithFormat(format, err);
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
  if (err instanceof AppTheoryError) {
    return errorResponseFromAppTheoryErrorWithFormat(
      format,
      err,
      {},
      requestId,
    );
  }
  if (err instanceof AppError) {
    return errorResponseWithRequestIdAndFormat(
      format,
      err.code,
      err.message,
      {},
      requestId,
    );
  }
  return errorResponseWithRequestIdAndFormat(
    format,
    "app.internal",
    "internal error",
    {},
    requestId,
  );
}
