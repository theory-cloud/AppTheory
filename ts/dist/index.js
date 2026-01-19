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
  constructor({ request, params, clock, ids, ctx }) {
    this.ctx = ctx ?? null;
    this.request = request;
    this.params = params ?? {};
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
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
  constructor({ clock, ids } = {}) {
    this._router = new Router();
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
  }

  handle(method, pattern, handler) {
    this._router.add(method, pattern, handler);
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
}

export function createTestEnv(options = {}) {
  return new TestEnv(options);
}

class Router {
  constructor() {
    this._routes = [];
  }

  add(method, pattern, handler) {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPattern = normalizePath(pattern);
    this._routes.push({
      method: normalizedMethod,
      pattern: normalizedPattern,
      segments: splitPath(normalizedPattern),
      handler,
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

function responseForError(err) {
  if (err instanceof AppError) {
    return errorResponse(err.code, err.message);
  }
  return errorResponse("app.internal", "internal error");
}

function formatAllowHeader(methods) {
  const unique = new Set();
  for (const m of methods ?? []) {
    const normalized = normalizeMethod(m);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort().join(", ");
}
