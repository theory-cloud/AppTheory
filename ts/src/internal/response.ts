import { Buffer } from "node:buffer";

import { AppError } from "../errors.js";
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

export function errorResponse(
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
    body: Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"),
    isBase64: false,
  });
}

export function errorResponseWithRequestId(
  code: string,
  message: string,
  headers: Headers = {},
  requestId: string = "",
): NormalizedResponse {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const error: Record<string, string> = { code, message };
  if (requestId) {
    error["request_id"] = String(requestId);
  }

  return normalizeResponse({
    status: statusForErrorCode(code),
    headers: outHeaders,
    cookies: [],
    body: Buffer.from(JSON.stringify({ error }), "utf8"),
    isBase64: false,
  });
}

export function responseForError(err: unknown): NormalizedResponse {
  if (err instanceof AppError) {
    return errorResponse(err.code, err.message);
  }
  return errorResponse("app.internal", "internal error");
}

export function responseForErrorWithRequestId(
  err: unknown,
  requestId: string,
): NormalizedResponse {
  if (err instanceof AppError) {
    return errorResponseWithRequestId(err.code, err.message, {}, requestId);
  }
  return errorResponseWithRequestId(
    "app.internal",
    "internal error",
    {},
    requestId,
  );
}
