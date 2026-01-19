import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
}

export class RealClock {
  now() {
    return new Date();
  }
}

export class ManualClock {
  constructor(now = new Date(0)) {
    this._now = new Date(now.valueOf());
  }

  now() {
    return new Date(this._now.valueOf());
  }

  set(now) {
    this._now = new Date(now.valueOf());
  }

  advance(ms) {
    this._now = new Date(this._now.valueOf() + ms);
    return this.now();
  }
}

export class RandomIdGenerator {
  newId() {
    return randomUUID();
  }
}

export class ManualIdGenerator {
  constructor({ prefix = "test-id", start = 1 } = {}) {
    this._prefix = String(prefix);
    this._next = Number(start) || 1;
    this._queue = [];
  }

  queue(...ids) {
    this._queue.push(...ids.map((v) => String(v)));
  }

  reset() {
    this._next = 1;
    this._queue = [];
  }

  newId() {
    if (this._queue.length > 0) {
      return this._queue.shift();
    }
    const out = `${this._prefix}-${this._next}`;
    this._next += 1;
    return out;
  }
}

export class Context {
  constructor({
    request,
    params,
    clock,
    ids,
    ctx,
    requestId,
    tenantId,
    authIdentity,
    remainingMs,
    middlewareTrace,
  }) {
    this.ctx = ctx ?? null;
    this.request = request;
    this.params = params ?? {};
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
    this.requestId = requestId ?? "";
    this.tenantId = tenantId ?? "";
    this.authIdentity = authIdentity ?? "";
    this.remainingMs = Number(remainingMs ?? 0);
    this.middlewareTrace = Array.isArray(middlewareTrace) ? middlewareTrace : [];
  }

  now() {
    return this._clock.now();
  }

  newId() {
    return this._ids.newId();
  }

  param(name) {
    return this.params?.[name] ?? "";
  }

  jsonValue() {
    if (!hasJSONContentType(this.request.headers)) {
      throw new AppError("app.bad_request", "invalid json");
    }
    if (this.request.body.length === 0) {
      return null;
    }
    try {
      return JSON.parse(this.request.body.toString("utf8"));
    } catch {
      throw new AppError("app.bad_request", "invalid json");
    }
  }
}

export function text(status, body) {
  return normalizeResponse({
    status,
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(String(body), "utf8"),
    isBase64: false,
  });
}

export function json(status, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new Error(`json serialization failed: ${String(err)}`);
  }

  return normalizeResponse({
    status,
    headers: { "content-type": ["application/json; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(serialized, "utf8"),
    isBase64: false,
  });
}

export function binary(status, body, contentType) {
  const headers = {};
  if (contentType) {
    headers["content-type"] = [String(contentType)];
  }
  return normalizeResponse({
    status,
    headers,
    cookies: [],
    body,
    isBase64: true,
  });
}

export class App {
  constructor({ clock, ids, tier, limits, authHook, policyHook, observability } = {}) {
    this._router = new Router();
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
    this._tier = tier === "p1" || tier === "p2" ? tier : "p0";
    this._limits = {
      maxRequestBytes: Number(limits?.maxRequestBytes ?? 0),
      maxResponseBytes: Number(limits?.maxResponseBytes ?? 0),
    };
    this._authHook = authHook ?? null;
    this._policyHook = policyHook ?? null;
    this._observability = observability ?? null;
  }

  handle(method, pattern, handler, options = {}) {
    this._router.add(method, pattern, handler, options);
    return this;
  }

  get(pattern, handler) {
    return this.handle("GET", pattern, handler);
  }

  post(pattern, handler) {
    return this.handle("POST", pattern, handler);
  }

  put(pattern, handler) {
    return this.handle("PUT", pattern, handler);
  }

  delete(pattern, handler) {
    return this.handle("DELETE", pattern, handler);
  }

  async serve(request, ctx) {
    if (this._tier === "p0") {
    let normalized;
    try {
      normalized = normalizeRequest(request);
    } catch (err) {
      return responseForError(err);
    }

    const { match, allowed } = this._router.match(normalized.method, normalized.path);
    if (!match) {
      if (allowed.length > 0) {
        return errorResponse("app.method_not_allowed", "method not allowed", {
          allow: [formatAllowHeader(allowed)],
        });
      }
      return errorResponse("app.not_found", "not found");
    }

    const requestCtx = new Context({
      request: normalized,
      params: match.params,
      clock: this._clock,
      ids: this._ids,
      ctx,
    });

    try {
      const out = await match.route.handler(requestCtx);
      return normalizeResponse(out);
    } catch (err) {
      return responseForError(err);
    }
    }

    const preHeaders = canonicalizeHeaders(request?.headers);
    const preQuery = cloneQuery(request?.query);
    let method = normalizeMethod(request?.method);
    let path = normalizePath(request?.path);

    let requestId = firstHeaderValue(preHeaders, "x-request-id");
    if (!requestId) {
      requestId = this._ids.newId();
    }
    const origin = firstHeaderValue(preHeaders, "origin");

    const middlewareTrace = ["request_id", "recovery", "logging"];
    if (origin) middlewareTrace.push("cors");

    const tenantId = extractTenantId(preHeaders, preQuery);
    const remainingMs = extractRemainingMs(ctx);
    const enableP2 = this._tier === "p2";

    const finish = (resp, errCode) => {
      const out = finalizeP1Response(resp, requestId, origin);
      if (enableP2) {
        recordObservability(this._observability, {
          method,
          path,
          requestId,
          tenantId,
          status: out.status,
          errorCode: errCode ?? "",
        });
      }
      return out;
    };

    if (isCorsPreflight(method, preHeaders)) {
      const allow = firstHeaderValue(preHeaders, "access-control-request-method");
      const resp = normalizeResponse({
        status: 204,
        headers: { "access-control-allow-methods": [allow] },
        cookies: [],
        body: Buffer.alloc(0),
        isBase64: false,
      });
      return finish(resp, "");
    }

    let normalized;
    try {
      normalized = normalizeRequest(request);
    } catch (err) {
      return finish(responseForErrorWithRequestId(err, requestId), err instanceof AppError ? err.code : "app.internal");
    }

    method = normalized.method;
    path = normalized.path;

    if (this._limits.maxRequestBytes > 0 && normalized.body.length > this._limits.maxRequestBytes) {
      return finish(errorResponseWithRequestId("app.too_large", "request too large", {}, requestId), "app.too_large");
    }

    const { match, allowed } = this._router.match(normalized.method, normalized.path);
    if (!match) {
      if (allowed.length > 0) {
        return finish(
          errorResponseWithRequestId(
          "app.method_not_allowed",
          "method not allowed",
          { allow: [formatAllowHeader(allowed)] },
          requestId,
          ),
          "app.method_not_allowed",
        );
      }
      return finish(errorResponseWithRequestId("app.not_found", "not found", {}, requestId), "app.not_found");
    }

    const requestCtx = new Context({
      request: normalized,
      params: match.params,
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      tenantId,
      authIdentity: "",
      remainingMs,
      middlewareTrace,
    });

    if (enableP2 && typeof this._policyHook === "function") {
      let decision;
      try {
        decision = await this._policyHook(requestCtx);
      } catch (err) {
        return finish(responseForErrorWithRequestId(err, requestId), err instanceof AppError ? err.code : "app.internal");
      }

      const code = String(decision?.code ?? "").trim();
      if (code) {
        const message = String(decision?.message ?? "").trim() || defaultPolicyMessage(code);
        return finish(errorResponseWithRequestId(code, message, decision?.headers ?? {}, requestId), code);
      }
    }

    if (match.route.authRequired) {
      middlewareTrace.push("auth");
      try {
        if (!this._authHook) {
          throw new AppError("app.unauthorized", "unauthorized");
        }
        const identity = await this._authHook(requestCtx);
        if (!String(identity ?? "").trim()) {
          throw new AppError("app.unauthorized", "unauthorized");
        }
        requestCtx.authIdentity = String(identity);
      } catch (err) {
        return finish(responseForErrorWithRequestId(err, requestId), err instanceof AppError ? err.code : "app.internal");
      }
    }

    middlewareTrace.push("handler");

    let out;
    try {
      out = await match.route.handler(requestCtx);
    } catch (err) {
      return finish(responseForErrorWithRequestId(err, requestId), err instanceof AppError ? err.code : "app.internal");
    }

    let resp;
    if (out === null || out === undefined) {
      return finish(errorResponseWithRequestId("app.internal", "internal error", {}, requestId), "app.internal");
    } else {
      resp = normalizeResponse(out);
    }

    if (this._limits.maxResponseBytes > 0 && resp.body.length > this._limits.maxResponseBytes) {
      return finish(errorResponseWithRequestId("app.too_large", "response too large", {}, requestId), "app.too_large");
    }

    return finish(resp, "");
  }

  async serveAPIGatewayV2(event, ctx) {
    let request;
    try {
      request = requestFromAPIGatewayV2(event);
    } catch (err) {
      return apigatewayV2ResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return apigatewayV2ResponseFromResponse(resp);
  }

  async serveLambdaFunctionURL(event, ctx) {
    let request;
    try {
      request = requestFromLambdaFunctionURL(event);
    } catch (err) {
      return lambdaFunctionURLResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return lambdaFunctionURLResponseFromResponse(resp);
  }
}

export function createApp(options = {}) {
  return new App(options);
}

export class TestEnv {
  constructor({ now } = {}) {
    this.clock = new ManualClock(now ?? new Date(0));
    this.ids = new ManualIdGenerator();
  }

  app(options = {}) {
    return createApp({ clock: this.clock, ids: this.ids, ...options });
  }

  invoke(app, request, ctx) {
    return app.serve(request, ctx);
  }

  invokeAPIGatewayV2(app, event, ctx) {
    return app.serveAPIGatewayV2(event, ctx);
  }

  invokeLambdaFunctionURL(app, event, ctx) {
    return app.serveLambdaFunctionURL(event, ctx);
  }
}

export function createTestEnv(options = {}) {
  return new TestEnv(options);
}

export function buildAPIGatewayV2Request(method, path, options = {}) {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    cookies: Array.isArray(options.cookies) ? [...options.cookies] : [],
    headers: { ...(options.headers ?? {}) },
    queryStringParameters: firstQueryValues(options.query),
    requestContext: {
      http: {
        method: normalizedMethod,
        path: rawPath,
      },
    },
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
}

export function buildLambdaFunctionURLRequest(method, path, options = {}) {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);

  return {
    version: "2.0",
    rawPath,
    rawQueryString,
    cookies: Array.isArray(options.cookies) ? [...options.cookies] : [],
    headers: { ...(options.headers ?? {}) },
    queryStringParameters: firstQueryValues(options.query),
    requestContext: {
      http: {
        method: normalizedMethod,
        path: rawPath,
      },
    },
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
}

class Router {
  constructor() {
    this._routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPattern = normalizePath(pattern);
    this._routes.push({
      method: normalizedMethod,
      pattern: normalizedPattern,
      segments: splitPath(normalizedPattern),
      handler,
      authRequired: Boolean(options?.authRequired),
    });
  }

  match(method, path) {
    const normalizedMethod = normalizeMethod(method);
    const pathSegments = splitPath(normalizePath(path));

    const allowed = [];
    for (const route of this._routes) {
      const params = matchPath(route.segments, pathSegments);
      if (!params) {
        continue;
      }
      allowed.push(route.method);
      if (route.method === normalizedMethod) {
        return { match: { route, params }, allowed };
      }
    }
    return { match: null, allowed };
  }
}

function normalizeMethod(method) {
  return String(method ?? "").trim().toUpperCase();
}

function normalizePath(path) {
  let value = String(path ?? "").trim();
  if (!value) value = "/";
  const idx = value.indexOf("?");
  if (idx >= 0) value = value.slice(0, idx);
  if (!value.startsWith("/")) value = `/${value}`;
  if (!value) value = "/";
  return value;
}

function splitPath(path) {
  const value = normalizePath(path).replace(/^\//, "");
  if (!value) return [];
  return value.split("/");
}

function matchPath(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return null;

  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const pattern = patternSegments[i];
    const segment = pathSegments[i];
    if (!segment) return null;

    if (pattern.startsWith("{") && pattern.endsWith("}") && pattern.length > 2) {
      const name = pattern.slice(1, -1);
      params[name] = segment;
      continue;
    }
    if (pattern !== segment) return null;
  }
  return params;
}

function canonicalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const keys = Object.keys(headers).sort();
  for (const key of keys) {
    const lower = String(key).trim().toLowerCase();
    if (!lower) continue;
    const values = Array.isArray(headers[key]) ? headers[key] : [headers[key]];
    if (!out[lower]) out[lower] = [];
    out[lower].push(...values.map((v) => String(v)));
  }
  return out;
}

function cloneQuery(query) {
  const out = {};
  if (!query) return out;
  for (const [key, values] of Object.entries(query)) {
    out[key] = Array.isArray(values) ? [...values] : [String(values)];
  }
  return out;
}

function parseCookies(cookieHeaders) {
  const out = {};
  for (const header of cookieHeaders ?? []) {
    for (const part of String(header).split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const name = trimmed.slice(0, idx).trim();
      if (!name) continue;
      const value = trimmed.slice(idx + 1).trim();
      out[name] = value;
    }
  }
  return out;
}

function toBuffer(body) {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new TypeError("body must be Uint8Array, Buffer, or string");
}

function normalizeRequest(request) {
  const out = {};
  out.method = normalizeMethod(request?.method);
  out.path = normalizePath(request?.path);
  out.query = cloneQuery(request?.query);
  out.headers = canonicalizeHeaders(request?.headers);

  const rawBody = toBuffer(request?.body);
  out.isBase64 = Boolean(request?.isBase64);
  if (out.isBase64) {
    try {
      out.body = Buffer.from(rawBody.toString("utf8"), "base64");
    } catch {
      throw new AppError("app.bad_request", "invalid base64");
    }
  } else {
    out.body = rawBody;
  }

  out.cookies = parseCookies(out.headers.cookie);
  return out;
}

function normalizeResponse(response) {
  if (!response) {
    return errorResponse("app.internal", "internal error");
  }

  const out = {};
  out.status = response.status ?? 200;
  out.headers = canonicalizeHeaders(response.headers);
  out.cookies = Array.isArray(response.cookies) ? [...response.cookies] : [];
  out.body = toBuffer(response.body);
  out.isBase64 = Boolean(response.isBase64);
  return out;
}

function hasJSONContentType(headers) {
  for (const value of headers?.["content-type"] ?? []) {
    const normalized = String(value).trim().toLowerCase();
    if (normalized.startsWith("application/json")) {
      return true;
    }
  }
  return false;
}

function statusForErrorCode(code) {
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

function errorResponse(code, message, headers = {}) {
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

function errorResponseWithRequestId(code, message, headers = {}, requestId = "") {
  const outHeaders = { ...canonicalizeHeaders(headers) };
  outHeaders["content-type"] = ["application/json; charset=utf-8"];

  const error = { code, message };
  if (requestId) {
    error.request_id = String(requestId);
  }

  return normalizeResponse({
    status: statusForErrorCode(code),
    headers: outHeaders,
    cookies: [],
    body: Buffer.from(JSON.stringify({ error }), "utf8"),
    isBase64: false,
  });
}

function responseForError(err) {
  if (err instanceof AppError) {
    return errorResponse(err.code, err.message);
  }
  return errorResponse("app.internal", "internal error");
}

function responseForErrorWithRequestId(err, requestId) {
  if (err instanceof AppError) {
    return errorResponseWithRequestId(err.code, err.message, {}, requestId);
  }
  return errorResponseWithRequestId("app.internal", "internal error", {}, requestId);
}

function firstHeaderValue(headers, key) {
  const values = headers?.[String(key).trim().toLowerCase()] ?? [];
  return values.length > 0 ? String(values[0]) : "";
}

function extractTenantId(headers, query) {
  const headerTenant = firstHeaderValue(headers, "x-tenant-id");
  if (headerTenant) return headerTenant;
  const values = query?.tenant ?? [];
  return values.length > 0 ? String(values[0]) : "";
}

function isCorsPreflight(method, headers) {
  return normalizeMethod(method) === "OPTIONS" && firstHeaderValue(headers, "access-control-request-method");
}

function finalizeP1Response(resp, requestId, origin) {
  const headers = canonicalizeHeaders(resp.headers ?? {});
  if (requestId) {
    headers["x-request-id"] = [String(requestId)];
  }
  if (origin) {
    headers["access-control-allow-origin"] = [String(origin)];
    headers.vary = ["origin"];
  }
  return { ...resp, headers };
}

function defaultPolicyMessage(code) {
  switch (String(code ?? "").trim()) {
    case "app.rate_limited":
      return "rate limited";
    case "app.overloaded":
      return "overloaded";
    default:
      return "internal error";
  }
}

function extractRemainingMs(ctx) {
  if (ctx && typeof ctx === "object") {
    if (typeof ctx.getRemainingTimeInMillis === "function") {
      const value = Number(ctx.getRemainingTimeInMillis());
      if (Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
      return 0;
    }
    if ("remaining_ms" in ctx) {
      const value = Number(ctx.remaining_ms);
      if (Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
      return 0;
    }
  }
  return 0;
}

function recordObservability(hooks, { method, path, requestId, tenantId, status, errorCode }) {
  if (!hooks) return;

  let level = "info";
  if (status >= 500) {
    level = "error";
  } else if (status >= 400) {
    level = "warn";
  }

  if (typeof hooks.log === "function") {
    hooks.log({
      level,
      event: "request.completed",
      requestId,
      tenantId,
      method,
      path,
      status,
      errorCode,
    });
  }

  if (typeof hooks.metric === "function") {
    hooks.metric({
      name: "apptheory.request",
      value: 1,
      tags: {
        method,
        path,
        status: String(status),
        error_code: errorCode,
        tenant_id: tenantId,
      },
    });
  }

  if (typeof hooks.span === "function") {
    hooks.span({
      name: `http ${method} ${path}`,
      attributes: {
        "http.method": method,
        "http.route": path,
        "http.status_code": String(status),
        "request.id": requestId,
        "tenant.id": tenantId,
        "error.code": errorCode,
      },
    });
  }
}
function formatAllowHeader(methods) {
  const unique = new Set();
  for (const m of methods ?? []) {
    const normalized = normalizeMethod(m);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort().join(", ");
}

function requestFromAPIGatewayV2(event) {
  const cookies = Array.isArray(event?.cookies) ? event.cookies.map((v) => String(v)) : [];
  const headers = headersFromSingle(event?.headers, cookies.length > 0);
  if (cookies.length > 0) {
    headers.cookie = cookies;
  }

  const rawQueryString = String(event?.rawQueryString ?? "").replace(/^\?/, "");
  const query = rawQueryString
    ? parseRawQueryString(rawQueryString)
    : queryFromSingle(event?.queryStringParameters);

  return {
    method: String(event?.requestContext?.http?.method ?? ""),
    path: String(event?.rawPath ?? event?.requestContext?.http?.path ?? "/"),
    query,
    headers,
    body: String(event?.body ?? ""),
    isBase64: Boolean(event?.isBase64Encoded),
  };
}

function requestFromLambdaFunctionURL(event) {
  const cookies = Array.isArray(event?.cookies) ? event.cookies.map((v) => String(v)) : [];
  const headers = headersFromSingle(event?.headers, cookies.length > 0);
  if (cookies.length > 0) {
    headers.cookie = cookies;
  }

  const rawQueryString = String(event?.rawQueryString ?? "").replace(/^\?/, "");
  const query = rawQueryString
    ? parseRawQueryString(rawQueryString)
    : queryFromSingle(event?.queryStringParameters);

  return {
    method: String(event?.requestContext?.http?.method ?? ""),
    path: String(event?.rawPath ?? event?.requestContext?.http?.path ?? "/"),
    query,
    headers,
    body: String(event?.body ?? ""),
    isBase64: Boolean(event?.isBase64Encoded),
  };
}

function apigatewayV2ResponseFromResponse(resp) {
  const normalized = normalizeResponse(resp);
  const headers = {};
  const multiValueHeaders = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = String(values[0]);
    multiValueHeaders[key] = [...values].map((v) => String(v));
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    multiValueHeaders,
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
    cookies: [...normalized.cookies],
  };
}

function lambdaFunctionURLResponseFromResponse(resp) {
  const normalized = normalizeResponse(resp);
  const headers = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = [...values].map((v) => String(v)).join(",");
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
    cookies: [...normalized.cookies],
  };
}

function headersFromSingle(headers, ignoreCookieHeader) {
  const out = {};
  if (!headers) return out;

  for (const [key, value] of Object.entries(headers)) {
    if (ignoreCookieHeader && String(key).trim().toLowerCase() === "cookie") {
      continue;
    }
    out[key] = [String(value)];
  }
  return out;
}

function queryFromSingle(params) {
  const out = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    out[String(key)] = [String(value)];
  }
  return out;
}

function decodeFormComponent(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    throw new AppError("app.bad_request", "invalid query string");
  }
}

function parseRawQueryString(raw) {
  const out = {};
  if (!raw) return out;

  for (const part of String(raw).split("&")) {
    if (!part) continue;
    const idx = part.indexOf("=");
    const rawKey = idx >= 0 ? part.slice(0, idx) : part;
    const rawValue = idx >= 0 ? part.slice(idx + 1) : "";
    const key = decodeFormComponent(rawKey);
    const value = decodeFormComponent(rawValue);
    if (!out[key]) out[key] = [];
    out[key].push(value);
  }
  return out;
}

function encodeFormComponent(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

function encodeRawQueryString(query) {
  if (!query) return "";
  const keys = Object.keys(query).sort();
  const parts = [];
  for (const key of keys) {
    const values = Array.isArray(query[key]) ? query[key] : [String(query[key])];
    for (const value of values) {
      parts.push(`${encodeFormComponent(key)}=${encodeFormComponent(value)}`);
    }
  }
  return parts.join("&");
}

function firstQueryValues(query) {
  if (!query) return undefined;
  const out = {};
  let hasAny = false;
  for (const [key, values] of Object.entries(query)) {
    const list = Array.isArray(values) ? values : [String(values)];
    if (list.length === 0) continue;
    out[key] = String(list[0]);
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function splitPathAndQuery(path, query) {
  const value = String(path ?? "").trim();
  const idx = value.indexOf("?");
  const rawPath = normalizePath(idx >= 0 ? value.slice(0, idx) : value);
  const rawQueryString = query && Object.keys(query).length > 0 ? encodeRawQueryString(query) : idx >= 0 ? value.slice(idx + 1) : "";
  return { rawPath, rawQueryString };
}
