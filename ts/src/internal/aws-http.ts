import { STATUS_CODES } from "node:http";

import type {
  ALBTargetGroupRequest,
  ALBTargetGroupResponse,
  APIGatewayProxyRequest,
  APIGatewayProxyResponse,
  APIGatewayV2HTTPRequest,
  APIGatewayV2HTTPResponse,
  APIGatewayWebSocketProxyRequest,
  LambdaFunctionURLRequest,
  LambdaFunctionURLResponse,
} from "../aws-types.js";
import type { Headers, Query, Request, Response } from "../types.js";

import {
  headersFromSingle,
  normalizePath,
  parseRawQueryString,
  queryFromSingle,
  toBuffer,
} from "./http.js";
import { normalizeRequest, type NormalizedRequest } from "./request.js";
import { normalizeResponse } from "./response.js";

export function requestFromWebSocketEvent(
  event: APIGatewayWebSocketProxyRequest,
): NormalizedRequest {
  const headers: Headers = {};
  for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
    headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (headers[key]) continue;
    headers[key] = [String(value)];
  }

  const query: Query = {};
  for (const [key, values] of Object.entries(
    event.multiValueQueryStringParameters ?? {},
  )) {
    query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(
    event.queryStringParameters ?? {},
  )) {
    if (query[key]) continue;
    query[key] = [String(value)];
  }

  return normalizeRequest({
    method: String(event.httpMethod ?? ""),
    path: String(event.path ?? "/"),
    query,
    headers,
    body: toBuffer(String(event.body ?? "")),
    isBase64: Boolean(event.isBase64Encoded),
  });
}

function requestFromAPIGatewayProxyLike(
  event: APIGatewayProxyRequest,
  pathOverride?: string,
): Request {
  const headers: Headers = {};
  for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
    headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (headers[key]) continue;
    headers[key] = [String(value)];
  }

  const query: Query = {};
  for (const [key, values] of Object.entries(
    event.multiValueQueryStringParameters ?? {},
  )) {
    query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(
    event.queryStringParameters ?? {},
  )) {
    if (query[key]) continue;
    query[key] = [String(value)];
  }

  const rc =
    event.requestContext && typeof event.requestContext === "object"
      ? (event.requestContext as Record<string, unknown>)
      : null;
  const rcMethod =
    rc && typeof rc["httpMethod"] === "string" ? String(rc["httpMethod"]) : "";
  const rcPath =
    rc && typeof rc["path"] === "string" ? String(rc["path"]) : "/";

  return {
    method: String(event.httpMethod ?? rcMethod ?? ""),
    path: String(pathOverride ?? event.path ?? rcPath ?? "/"),
    query,
    headers,
    body: toBuffer(String(event.body ?? "")),
    isBase64: Boolean(event.isBase64Encoded),
  };
}

const REMOTE_MCP_APIGW_CANONICAL_RESOURCES = new Set<string>([
  "/mcp",
  "/mcp/{actor}",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource/mcp/{actor}",
]);

function trimEdgeSlashes(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(start, end);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
}

function normalizeAPIGatewayProxyRoutePath(path: unknown): string {
  const trimmed = trimEdgeSlashes(String(path ?? "").trim());
  if (!trimmed) return "/";

  const parts = trimmed
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part);
  if (parts.length === 0) return "/";
  return `/${parts.join("/")}`;
}

function apigatewayProxyMatchedResource(event: APIGatewayProxyRequest): string {
  const resource = normalizeAPIGatewayProxyRoutePath(event.resource);
  if (resource !== "/") return resource;

  const rc =
    event.requestContext && typeof event.requestContext === "object"
      ? (event.requestContext as Record<string, unknown>)
      : null;
  const rcResource =
    rc && typeof rc["resourcePath"] === "string"
      ? normalizeAPIGatewayProxyRoutePath(rc["resourcePath"])
      : "";
  return rcResource === "/" ? "" : rcResource;
}

function shouldCanonicalizeAPIGatewayProxyRequestPath(
  event: APIGatewayProxyRequest,
): boolean {
  return REMOTE_MCP_APIGW_CANONICAL_RESOURCES.has(
    apigatewayProxyMatchedResource(event),
  );
}

function canonicalizeAPIGatewayProxyRequestPath(path: unknown): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return normalized;
  return trimTrailingSlashes(normalized) || "/";
}

export function requestFromAPIGatewayProxy(
  event: APIGatewayProxyRequest,
): Request {
  const path = shouldCanonicalizeAPIGatewayProxyRequestPath(event)
    ? canonicalizeAPIGatewayProxyRequestPath(
        event.path ??
          (event.requestContext as Record<string, unknown> | undefined)?.[
            "path"
          ] ??
          "/",
      )
    : undefined;
  return requestFromAPIGatewayProxyLike(event, path);
}

export function requestFromALBTargetGroup(
  event: ALBTargetGroupRequest,
): Request {
  return requestFromAPIGatewayProxyLike(event);
}

export function requestFromAPIGatewayV2(
  event: APIGatewayV2HTTPRequest,
): Request {
  const cookies = Array.isArray(event.cookies)
    ? event.cookies.map((v) => String(v))
    : [];
  const headers = headersFromSingle(event.headers, cookies.length > 0);
  if (cookies.length > 0) {
    headers["cookie"] = cookies;
  }

  const rawQueryString = String(event.rawQueryString ?? "").replace(/^\?/, "");
  const query = rawQueryString
    ? parseRawQueryString(rawQueryString)
    : queryFromSingle(event.queryStringParameters);

  return {
    method: String(event.requestContext?.http?.method ?? ""),
    path: String(event.rawPath ?? event.requestContext?.http?.path ?? "/"),
    query,
    headers,
    body: toBuffer(String(event.body ?? "")),
    isBase64: Boolean(event.isBase64Encoded),
  };
}

export function requestFromLambdaFunctionURL(
  event: LambdaFunctionURLRequest,
): Request {
  const cookies = Array.isArray(event.cookies)
    ? event.cookies.map((v) => String(v))
    : [];
  const headers = headersFromSingle(event.headers, cookies.length > 0);
  if (cookies.length > 0) {
    headers["cookie"] = cookies;
  }

  const rawQueryString = String(event.rawQueryString ?? "").replace(/^\?/, "");
  const query = rawQueryString
    ? parseRawQueryString(rawQueryString)
    : queryFromSingle(event.queryStringParameters);

  return {
    method: String(event.requestContext?.http?.method ?? ""),
    path: String(event.rawPath ?? event.requestContext?.http?.path ?? "/"),
    query,
    headers,
    body: toBuffer(String(event.body ?? "")),
    isBase64: Boolean(event.isBase64Encoded),
  };
}

export function apigatewayV2ResponseFromResponse(
  resp: Response,
): APIGatewayV2HTTPResponse {
  const normalized = normalizeResponse(resp);
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = String(values[0]);
    multiValueHeaders[key] = values.map((v) => String(v));
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    multiValueHeaders,
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
    cookies: [...normalized.cookies],
  };
}

export function lambdaFunctionURLResponseFromResponse(
  resp: Response,
): LambdaFunctionURLResponse {
  const normalized = normalizeResponse(resp);
  const headers: Record<string, string> = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = values.map((v) => String(v)).join(",");
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
    cookies: [...normalized.cookies],
  };
}

export function apigatewayProxyResponseFromResponse(
  resp: Response,
): APIGatewayProxyResponse {
  const normalized = normalizeResponse(resp);
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = String(values[0]);
    multiValueHeaders[key] = values.map((v) => String(v));
  }

  if (normalized.cookies.length > 0) {
    headers["set-cookie"] = String(normalized.cookies[0]);
    multiValueHeaders["set-cookie"] = normalized.cookies.map((v) => String(v));
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    multiValueHeaders,
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
}

function albStatusDescription(status: number): string {
  const code = Number(status ?? 0);
  const text = STATUS_CODES[String(code)] ?? "";
  return text ? `${code} ${text}` : String(code);
}

export function albTargetGroupResponseFromResponse(
  resp: Response,
): ALBTargetGroupResponse {
  const out = apigatewayProxyResponseFromResponse(resp);
  return { ...out, statusDescription: albStatusDescription(out.statusCode) };
}
