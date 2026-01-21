import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";

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
    webSocket,
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
    this._webSocket = webSocket ?? null;
    this._values = new Map();
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

  set(key, value) {
    const k = String(key ?? "").trim();
    if (!k) return;
    this._values.set(k, value);
  }

  get(key) {
    const k = String(key ?? "").trim();
    if (!k) return undefined;
    return this._values.get(k);
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

  asWebSocket() {
    return this._webSocket;
  }
}

export class EventContext {
  constructor({ clock, ids, ctx, requestId, remainingMs }) {
    this.ctx = ctx ?? null;
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
    this.requestId = requestId ?? "";
    this.remainingMs = Number(remainingMs ?? 0);
    this._values = new Map();
  }

  now() {
    return this._clock.now();
  }

  newId() {
    return this._ids.newId();
  }

  set(key, value) {
    const k = String(key ?? "").trim();
    if (!k) return;
    this._values.set(k, value);
  }

  get(key) {
    const k = String(key ?? "").trim();
    if (!k) return undefined;
    return this._values.get(k);
  }
}

export class WebSocketContext {
  constructor({
    clock,
    ids,
    ctx,
    requestId,
    remainingMs,
    connectionId,
    routeKey,
    domainName,
    stage,
    eventType,
    managementEndpoint,
    body,
    clientFactory,
  }) {
    this.ctx = ctx ?? null;
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
    this.requestId = requestId ?? "";
    this.remainingMs = Number(remainingMs ?? 0);

    this.connectionId = String(connectionId ?? "").trim();
    this.routeKey = String(routeKey ?? "").trim();
    this.domainName = String(domainName ?? "").trim();
    this.stage = String(stage ?? "").trim();
    this.eventType = String(eventType ?? "").trim();
    this.managementEndpoint = String(managementEndpoint ?? "").trim();
    this.body = toBuffer(body);

    this._clientFactory = typeof clientFactory === "function" ? clientFactory : null;
    this._client = null;
    this._clientError = null;
  }

  now() {
    return this._clock.now();
  }

  newId() {
    return this._ids.newId();
  }

  async _managementClient() {
    if (this._client || this._clientError) {
      if (this._clientError) throw this._clientError;
      return this._client;
    }
    if (!this._clientFactory) {
      this._clientError = new Error("apptheory: missing websocket client factory");
      throw this._clientError;
    }
    const client = await this._clientFactory(this.managementEndpoint, this.ctx);
    if (!client) {
      this._clientError = new Error("apptheory: websocket client factory returned null");
      throw this._clientError;
    }
    this._client = client;
    return client;
  }

  async sendMessage(data) {
    const id = String(this.connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    const client = await this._managementClient();
    if (typeof client.postToConnection !== "function") {
      throw new Error("apptheory: websocket client missing postToConnection");
    }
    await client.postToConnection(id, toBuffer(data));
  }

  async sendJSONMessage(value) {
    await this.sendMessage(Buffer.from(JSON.stringify(value), "utf8"));
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

export function html(status, body) {
  return normalizeResponse({
    status,
    headers: { "content-type": ["text/html; charset=utf-8"] },
    cookies: [],
    body: toBuffer(body),
    isBase64: false,
  });
}

export function htmlStream(status, chunks) {
  return normalizeResponse({
    status,
    headers: { "content-type": ["text/html; charset=utf-8"] },
    cookies: [],
    body: Buffer.alloc(0),
    bodyStream: chunks,
    isBase64: false,
  });
}

function sortKeysDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return value;
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) {
    const next = sortKeysDeep(value[key]);
    if (next === undefined) continue;
    out[key] = next;
  }
  return out;
}

export function safeJSONForHTML(value) {
  let serialized;
  try {
    serialized = JSON.stringify(sortKeysDeep(value));
  } catch (err) {
    throw new Error(`json serialization failed: ${String(err)}`);
  }

  return String(serialized)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function cacheControlSSR() {
  return "private, no-store";
}

export function cacheControlSSG() {
  return "public, max-age=0, s-maxage=31536000";
}

export function cacheControlISR(revalidateSeconds, staleWhileRevalidateSeconds = 0) {
  let revalidate = Number(revalidateSeconds ?? 0);
  if (!Number.isFinite(revalidate) || revalidate < 0) revalidate = 0;
  revalidate = Math.floor(revalidate);

  let swr = Number(staleWhileRevalidateSeconds ?? 0);
  if (!Number.isFinite(swr) || swr < 0) swr = 0;
  swr = Math.floor(swr);

  const parts = ["public", "max-age=0", `s-maxage=${revalidate}`];
  if (swr > 0) parts.push(`stale-while-revalidate=${swr}`);
  return parts.join(", ");
}

export function etag(body) {
  const bytes = toBuffer(body);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `"${hash}"`;
}

function splitCommaValues(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function matchesIfNoneMatch(headers, tag) {
  const etagValue = String(tag ?? "").trim();
  if (!etagValue) return false;

  const h = canonicalizeHeaders(headers);
  for (const header of h["if-none-match"] ?? []) {
    for (let token of splitCommaValues(header)) {
      if (token === "*") return true;
      token = token.replace(/^W\//i, "").trim();
      if (token === etagValue) return true;
    }
  }
  return false;
}

export function vary(existing, ...add) {
  const seen = new Set();
  const out = [];

  const addToken = (token) => {
    const key = String(token ?? "").trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  const addValue = (value) => {
    for (const token of splitCommaValues(value)) {
      addToken(token);
    }
  };

  if (Array.isArray(existing)) {
    for (const value of existing) addValue(value);
  } else if (existing !== null && existing !== undefined) {
    addValue(existing);
  }

  for (const value of add) addValue(value);

  out.sort();
  return out;
}

function parseForwardedHeader(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { proto: "", host: "" };

  const first = raw.split(",")[0];
  let proto = "";
  let host = "";

  for (const part of String(first).split(";")) {
    const [k, v] = String(part).trim().split("=", 2);
    if (!k || v === undefined) continue;
    const key = String(k).trim().toLowerCase();
    const val = String(v).trim().replace(/^"/, "").replace(/"$/, "");
    if (key === "proto" && !proto) proto = val;
    if (key === "host" && !host) host = val;
  }

  return { proto, host };
}

function firstCommaToken(value) {
  return String(value ?? "").split(",", 1)[0];
}

export function originURL(headers) {
  const h = canonicalizeHeaders(headers);
  const forwarded = parseForwardedHeader(firstHeaderValue(h, "forwarded"));

  let host = firstHeaderValue(h, "x-forwarded-host") || forwarded.host || firstHeaderValue(h, "host");
  host = firstCommaToken(host).trim();
  if (!host) return "";

  let proto =
    firstHeaderValue(h, "cloudfront-forwarded-proto") || firstHeaderValue(h, "x-forwarded-proto") || forwarded.proto;
  proto = firstCommaToken(proto).trim().toLowerCase();
  if (!proto) proto = "https";

  return `${proto}://${host}`;
}

function parseCloudFrontViewerAddress(value) {
  const raw = String(value ?? "").trim().replace(/^"/, "").replace(/"$/, "");
  if (!raw) return "";

  if (raw.startsWith("[")) {
    const idx = raw.indexOf("]");
    if (idx > 1) return raw.slice(1, idx).trim();
  }

  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return raw;
  const ipPart = raw.slice(0, idx).trim();
  const portPart = raw.slice(idx + 1).trim();
  if (!ipPart || !portPart) return raw;
  if (!/^[0-9]+$/.test(portPart)) return raw;
  return ipPart;
}

export function clientIP(headers) {
  const h = canonicalizeHeaders(headers);
  const cf = firstHeaderValue(h, "cloudfront-viewer-address");
  if (cf) {
    const parsed = parseCloudFrontViewerAddress(cf);
    if (parsed) return parsed;
  }

  const xff = firstHeaderValue(h, "x-forwarded-for");
  if (xff) {
    const ip = firstCommaToken(xff).trim();
    if (ip) return ip;
  }

  return "";
}

function formatSSEEvent(event) {
  const id = String(event?.id ?? "").trim();
  const name = String(event?.event ?? "").trim();

  let data;
  const value = event?.data;
  if (value === null || value === undefined) {
    data = "";
  } else if (typeof value === "string") {
    data = value;
  } else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    data = Buffer.from(value).toString("utf8");
  } else {
    data = JSON.stringify(value);
  }

  data = String(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = String(data).split("\n");
  if (lines.length === 0) lines.push("");

  let out = "";
  if (id) out += `id: ${id}\n`;
  if (name) out += `event: ${name}\n`;
  for (const line of lines) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return out;
}

export function sse(status, events) {
  const list = Array.isArray(events) ? events : [];
  const framed = list.map(formatSSEEvent).join("");
  return normalizeResponse({
    status,
    headers: {
      "content-type": ["text/event-stream"],
      "cache-control": ["no-cache"],
      connection: ["keep-alive"],
    },
    cookies: [],
    body: Buffer.from(framed, "utf8"),
    isBase64: false,
  });
}

export async function* sseEventStream(events) {
  for await (const ev of events ?? []) {
    yield Buffer.from(formatSSEEvent(ev), "utf8");
  }
}

function sanitizeNamePart(value) {
  let out = String(value ?? "").trim().toLowerCase();
  if (!out) return "";
  out = out.replace(/[_ ]+/g, "-");
  out = out.replace(/[^a-z0-9-]+/g, "-");
  out = out.replace(/-+/g, "-");
  out = out.replace(/^-+/, "").replace(/-+$/, "");
  return out;
}

export function normalizeStage(stage) {
  const value = String(stage ?? "").trim().toLowerCase();
  switch (value) {
    case "prod":
    case "production":
    case "live":
      return "live";
    case "dev":
    case "development":
      return "dev";
    case "stg":
    case "stage":
    case "staging":
      return "stage";
    case "test":
    case "testing":
      return "test";
    case "local":
      return "local";
    default:
      return sanitizeNamePart(value);
  }
}

export function baseName(appName, stage, tenant = "") {
  const app = sanitizeNamePart(appName);
  const ten = sanitizeNamePart(tenant);
  const stg = normalizeStage(stage);
  return ten ? `${app}-${ten}-${stg}` : `${app}-${stg}`;
}

export function resourceName(appName, resource, stage, tenant = "") {
  const app = sanitizeNamePart(appName);
  const ten = sanitizeNamePart(tenant);
  const res = sanitizeNamePart(resource);
  const stg = normalizeStage(stage);
  return ten ? `${app}-${ten}-${res}-${stg}` : `${app}-${res}-${stg}`;
}

const REDACTED_VALUE = "[REDACTED]";

const allowedSanitizeFields = new Set(["card_bin", "card_brand", "card_type"]);

const sensitiveSanitizeFields = new Map([
  ["cvv", "fully"],
  ["security_code", "fully"],
  ["cvv2", "fully"],
  ["cvc", "fully"],
  ["cvc2", "fully"],

  ["cardholder", "fully"],
  ["cardholder_name", "fully"],

  ["card_number", "partial"],
  ["number", "partial"],

  ["account_number", "partial"],
  ["ssn", "partial"],
  ["tin", "partial"],
  ["tax_id", "partial"],
  ["ein", "partial"],

  ["password", "fully"],
  ["secret", "fully"],
  ["private_key", "fully"],
  ["secret_key", "fully"],

  ["api_token", "fully"],
  ["api_key_id", "partial"],
  ["authorization", "fully"],
  ["authorization_id", "fully"],
  ["authorization_header", "fully"],
]);

export function sanitizeLogString(value) {
  const v = String(value ?? "");
  if (!v) return v;
  return v.replace(/\r/g, "").replace(/\n/g, "");
}

function stripNonDigits(value) {
  return String(value ?? "").replace(/[^\d]+/g, "");
}

function maskRestrictedString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return REDACTED_VALUE;

  const digits = stripNonDigits(raw);
  if (digits.length >= 4) {
    if (digits.length === 4) return "****";
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  }

  if (raw.length >= 4) return `...${raw.slice(-4)}`;
  return REDACTED_VALUE;
}

function maskCardNumberString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return REDACTED_VALUE;

  const digits = stripNonDigits(raw);
  if (digits.length < 4) return REDACTED_VALUE;
  if (digits.length > 10) {
    return `${digits.slice(0, 6)}${"*".repeat(digits.length - 10)}${digits.slice(-4)}`;
  }
  if (digits.length > 4) {
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  }
  return "****";
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeLogString(value);
  if (value instanceof Uint8Array) return sanitizeLogString(Buffer.from(value).toString("utf8"));
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeFieldValue(k, v);
    }
    return out;
  }
  return sanitizeLogString(String(value));
}

export function sanitizeFieldValue(key, value) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return sanitizeValue(value);
  if (allowedSanitizeFields.has(k)) return sanitizeValue(value);

  const explicit = sensitiveSanitizeFields.get(k);
  if (explicit === "fully") return REDACTED_VALUE;
  if (explicit === "partial") {
    if (k === "card_number" || k === "number") return maskCardNumberString(value);
    return maskRestrictedString(value);
  }

  const blockedSubstrings = ["secret", "token", "password", "private_key", "client_secret", "api_key", "authorization"];
  for (const s of blockedSubstrings) {
    if (k.includes(s)) return REDACTED_VALUE;
  }

  return sanitizeValue(value);
}

export function sanitizeJSON(jsonBytes) {
  const buf = typeof jsonBytes === "string" ? Buffer.from(jsonBytes, "utf8") : toBuffer(jsonBytes);
  if (!buf || buf.length === 0) return "(empty)";

  let data;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    return `(malformed JSON: ${msg})`;
  }

  const sanitized = sanitizeJSONValue(data);
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return "(error marshaling sanitized JSON)";
  }
}

function sanitizeJSONValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeJSONValue(v));
  if (typeof value !== "object") return sanitizeValue(value);

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "body" && typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        out[key] = JSON.stringify(sanitizeJSONValue(parsed));
        continue;
      } catch {
        // fall through
      }
    }
    out[key] = sanitizeFieldValue(key, raw);
  }
  return out;
}

export function sanitizeXML(xmlString, patterns) {
  let out = String(xmlString ?? "");
  const list = Array.isArray(patterns) ? patterns : [];
  for (const p of list) {
    if (!p || !(p.pattern instanceof RegExp) || typeof p.maskingFunc !== "function") continue;
    out = out.replace(p.pattern, (match) => p.maskingFunc(match));
  }
  return out;
}

function maskCardNumberXML(match) {
  const m = String(match ?? "");
  const isEscaped = m.includes("&gt;");

  let start;
  let end;
  if (isEscaped) {
    start = m.indexOf("&gt;") + 4;
    end = m.lastIndexOf("&lt;");
  } else {
    start = m.indexOf(">") + 1;
    end = m.lastIndexOf("<");
  }

  if (end > start) {
    const number = m.slice(start, end);
    const masked = maskCardNumberString(number);
    return m.slice(0, start) + masked + m.slice(end);
  }
  return m;
}

function maskCompletelyXML(replacement) {
  const rep = String(replacement ?? "");
  return (match) => {
    const m = String(match ?? "");
    const isEscaped = m.includes("&gt;");

    let start;
    let end;
    if (isEscaped) {
      start = m.indexOf("&gt;") + 4;
      end = m.lastIndexOf("&lt;");
    } else {
      start = m.indexOf(">") + 1;
      end = m.lastIndexOf("<");
    }

    if (end >= start) {
      return m.slice(0, start) + rep + m.slice(end);
    }
    return m;
  };
}

function maskTokenLastFourXML(match) {
  const m = String(match ?? "");
  const isEscaped = m.includes("&gt;");

  if (m.includes("><") || m.includes("&gt;&lt;")) return m;

  let start;
  let end;
  if (isEscaped) {
    start = m.indexOf("&gt;") + 4;
    end = m.lastIndexOf("&lt;");
  } else {
    start = m.indexOf(">") + 1;
    end = m.lastIndexOf("<");
  }

  if (end > start) {
    const token = m.slice(start, end);
    const trimmed = String(token ?? "");
    if (trimmed.length > 4) {
      const masked = `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
      return m.slice(0, start) + masked + m.slice(end);
    }
  }
  return m;
}

export const paymentXMLPatterns = [
  {
    name: "AcctNum",
    pattern: /(<AcctNum>[^<]*<\/AcctNum>|&lt;AcctNum&gt;[^&]*&lt;\/AcctNum&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "CardNum",
    pattern: /(<CardNum>[^<]*<\/CardNum>|&lt;CardNum&gt;[^&]*&lt;\/CardNum&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "CardNumber",
    pattern: /(<CardNumber>[^<]*<\/CardNumber>|&lt;CardNumber&gt;[^&]*&lt;\/CardNumber&gt;)/gi,
    maskingFunc: maskCardNumberXML,
  },
  {
    name: "TrackData",
    pattern: /(<TrackData>[^<]*<\/TrackData>|&lt;TrackData&gt;[^&]*&lt;\/TrackData&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVV",
    pattern: /(<CVV>[^<]*<\/CVV>|&lt;CVV&gt;[^&]*&lt;\/CVV&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVV2",
    pattern: /(<CVV2>[^<]*<\/CVV2>|&lt;CVV2&gt;[^&]*&lt;\/CVV2&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "CVC",
    pattern: /(<CVC>[^<]*<\/CVC>|&lt;CVC&gt;[^&]*&lt;\/CVC&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "ExpDate",
    pattern: /(<ExpDate>[^<]*<\/ExpDate>|&lt;ExpDate&gt;[^&]*&lt;\/ExpDate&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "ExpiryDate",
    pattern: /(<ExpiryDate>[^<]*<\/ExpiryDate>|&lt;ExpiryDate&gt;[^&]*&lt;\/ExpiryDate&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "Password",
    pattern: /(<Password>[^<]*<\/Password>|&lt;Password&gt;[^&]*&lt;\/Password&gt;)/gi,
    maskingFunc: maskCompletelyXML(REDACTED_VALUE),
  },
  {
    name: "TransArmorToken",
    pattern: /(<TransArmorToken>[^<]*<\/TransArmorToken>|&lt;TransArmorToken&gt;[^&]*&lt;\/TransArmorToken&gt;)/gi,
    maskingFunc: maskTokenLastFourXML,
  },
];

export const rapidConnectXMLPatterns = paymentXMLPatterns;

export class App {
  constructor({ clock, ids, tier, limits, cors, authHook, policyHook, observability, webSocketClientFactory } = {}) {
    this._router = new Router();
    this._clock = clock ?? new RealClock();
    this._ids = ids ?? new RandomIdGenerator();
    this._tier = tier === "p0" || tier === "p1" || tier === "p2" ? tier : "p2";
    this._limits = {
      maxRequestBytes: Number(limits?.maxRequestBytes ?? 0),
      maxResponseBytes: Number(limits?.maxResponseBytes ?? 0),
    };
    this._cors = normalizeCorsConfig(cors);
    this._authHook = authHook ?? null;
    this._policyHook = policyHook ?? null;
    this._observability = observability ?? null;
    this._webSocketRoutes = [];
    this._webSocketClientFactory =
      typeof webSocketClientFactory === "function"
        ? webSocketClientFactory
        : (endpoint) => new WebSocketManagementClient({ endpoint });
    this._sqsRoutes = [];
    this._eventBridgeRoutes = [];
    this._dynamoDBRoutes = [];
    this._middlewares = [];
    this._eventMiddlewares = [];
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

  use(middleware) {
    if (typeof middleware !== "function") return this;
    this._middlewares.push(middleware);
    return this;
  }

  useEvents(middleware) {
    if (typeof middleware !== "function") return this;
    this._eventMiddlewares.push(middleware);
    return this;
  }

  _applyMiddlewares(handler) {
    if (typeof handler !== "function" || this._middlewares.length === 0) {
      return handler;
    }
    let wrapped = handler;
    for (let i = this._middlewares.length - 1; i >= 0; i -= 1) {
      const mw = this._middlewares[i];
      if (typeof mw !== "function") continue;
      const next = wrapped;
      wrapped = async (ctx) => mw(ctx, next);
    }
    return wrapped;
  }

  _applyEventMiddlewares(handler) {
    if (typeof handler !== "function" || this._eventMiddlewares.length === 0) {
      return handler;
    }
    let wrapped = handler;
    for (let i = this._eventMiddlewares.length - 1; i >= 0; i -= 1) {
      const mw = this._eventMiddlewares[i];
      if (typeof mw !== "function") continue;
      const next = wrapped;
      wrapped = async (ctx, event) => mw(ctx, event, async () => next(ctx, event));
    }
    return wrapped;
  }

  webSocket(routeKey, handler) {
    const key = String(routeKey ?? "").trim();
    if (!key || typeof handler !== "function") return this;
    this._webSocketRoutes.push({ routeKey: key, handler });
    return this;
  }

  sqs(queueName, handler) {
    const name = String(queueName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._sqsRoutes.push({ queueName: name, handler });
    return this;
  }

  eventBridge(selector, handler) {
    if (typeof handler !== "function") return this;
    const sel = {
      ruleName: String(selector?.ruleName ?? "").trim(),
      source: String(selector?.source ?? "").trim(),
      detailType: String(selector?.detailType ?? "").trim(),
    };
    if (!sel.ruleName && !sel.source && !sel.detailType) return this;
    this._eventBridgeRoutes.push({ selector: sel, handler });
    return this;
  }

  dynamoDB(tableName, handler) {
    const name = String(tableName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._dynamoDBRoutes.push({ tableName: name, handler });
    return this;
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
      const handler = this._applyMiddlewares(match.route.handler);
      const out = await handler(requestCtx);
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
      const out = finalizeP1Response(resp, requestId, origin, this._cors);
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
      const handler = this._applyMiddlewares(match.route.handler);
      out = await handler(requestCtx);
    } catch (err) {
      return finish(responseForErrorWithRequestId(err, requestId), err instanceof AppError ? err.code : "app.internal");
    }

    let resp;
    if (out === null || out === undefined) {
      return finish(errorResponseWithRequestId("app.internal", "internal error", {}, requestId), "app.internal");
    } else {
      resp = normalizeResponse(out);
    }

    if (!resp.bodyStream && this._limits.maxResponseBytes > 0 && resp.body.length > this._limits.maxResponseBytes) {
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

  async serveAPIGatewayProxy(event, ctx) {
    let request;
    try {
      request = requestFromAPIGatewayProxy(event);
    } catch (err) {
      return apigatewayProxyResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return apigatewayProxyResponseFromResponse(resp);
  }

  async serveALB(event, ctx) {
    let request;
    try {
      request = requestFromALBTargetGroup(event);
    } catch (err) {
      return albTargetGroupResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return albTargetGroupResponseFromResponse(resp);
  }

  _webSocketHandlerForEvent(event) {
    const routeKey = String(event?.requestContext?.routeKey ?? "").trim();
    if (!routeKey) return null;
    for (const route of this._webSocketRoutes) {
      if (route.routeKey === routeKey) return route.handler;
    }
    return null;
  }

  async serveWebSocket(event, ctx) {
    const handler = this._applyMiddlewares(this._webSocketHandlerForEvent(event));

    const requestId = String(event?.requestContext?.requestId ?? "").trim()
      ? String(event.requestContext.requestId).trim()
      : ctx && typeof ctx === "object" && typeof ctx.awsRequestId === "string" && ctx.awsRequestId.trim()
        ? ctx.awsRequestId.trim()
        : this._ids.newId();

    let request;
    try {
      request = requestFromWebSocketEvent(event);
    } catch (err) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(responseForError(err));
      }
      return apigatewayProxyResponseFromResponse(responseForErrorWithRequestId(err, requestId));
    }

    const domainName = String(event?.requestContext?.domainName ?? "").trim();
    const stage = String(event?.requestContext?.stage ?? "").trim();
    const wsCtx = new WebSocketContext({
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      remainingMs: extractRemainingMs(ctx),
      connectionId: String(event?.requestContext?.connectionId ?? "").trim(),
      routeKey: String(event?.requestContext?.routeKey ?? "").trim(),
      domainName,
      stage,
      eventType: String(event?.requestContext?.eventType ?? "").trim(),
      managementEndpoint: webSocketManagementEndpoint(domainName, stage),
      body: request.body,
      clientFactory: this._webSocketClientFactory,
    });

    const requestCtx = new Context({
      request,
      params: {},
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      tenantId: extractTenantId(request.headers, request.query),
      authIdentity: "",
      remainingMs: extractRemainingMs(ctx),
      middlewareTrace: [],
      webSocket: wsCtx,
    });

    if (!handler) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(errorResponse("app.not_found", "not found"));
      }
      return apigatewayProxyResponseFromResponse(errorResponseWithRequestId("app.not_found", "not found", {}, requestId));
    }

    let resp;
    try {
      resp = await handler(requestCtx);
    } catch (err) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(responseForError(err));
      }
      return apigatewayProxyResponseFromResponse(responseForErrorWithRequestId(err, requestId));
    }

    if (!resp) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(errorResponse("app.internal", "internal error"));
      }
      return apigatewayProxyResponseFromResponse(errorResponseWithRequestId("app.internal", "internal error", {}, requestId));
    }

    return apigatewayProxyResponseFromResponse(normalizeResponse(resp));
  }

  _eventContext(ctx) {
    const requestId =
      ctx && typeof ctx === "object" && typeof ctx.awsRequestId === "string" && ctx.awsRequestId.trim()
        ? ctx.awsRequestId.trim()
        : this._ids.newId();
    return new EventContext({
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      remainingMs: extractRemainingMs(ctx),
    });
  }

  _sqsHandlerForEvent(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;
    const queueName = sqsQueueNameFromArn(records[0]?.eventSourceARN);
    if (!queueName) return null;
    for (const route of this._sqsRoutes) {
      if (route.queueName === queueName) return route.handler;
    }
    return null;
  }

  async serveSQSEvent(event, ctx) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._sqsHandlerForEvent(event);
    if (!handler) {
      return {
        batchItemFailures: records
          .map((r) => ({ itemIdentifier: String(r?.messageId ?? "").trim() }))
          .filter((f) => Boolean(f.itemIdentifier)),
      };
    }

    const evtCtx = this._eventContext(ctx);
    const wrapped = this._applyEventMiddlewares(handler);
    const failures = [];
    for (const record of records) {
      try {
        await wrapped(evtCtx, record);
      } catch {
        const id = String(record?.messageId ?? "").trim();
        if (id) failures.push({ itemIdentifier: id });
      }
    }
    return { batchItemFailures: failures };
  }

  _eventBridgeHandlerForEvent(event) {
    const source = String(event?.source ?? "").trim();
    const detailType = String(event?.["detail-type"] ?? event?.detailType ?? "").trim();
    const resources = Array.isArray(event?.resources) ? event.resources : [];

    for (const route of this._eventBridgeRoutes) {
      const sel = route.selector ?? {};
      if (sel.ruleName) {
        for (const resource of resources) {
          if (eventBridgeRuleNameFromArn(resource) === sel.ruleName) {
            return route.handler;
          }
        }
        continue;
      }
      if (sel.source && sel.source !== source) continue;
      if (sel.detailType && sel.detailType !== detailType) continue;
      return route.handler;
    }
    return null;
  }

  async serveEventBridge(event, ctx) {
    const handler = this._eventBridgeHandlerForEvent(event);
    if (!handler) return null;
    const evtCtx = this._eventContext(ctx);
    const wrapped = this._applyEventMiddlewares(handler);
    return wrapped(evtCtx, event);
  }

  _dynamoDBHandlerForEvent(event) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;
    const tableName = dynamoDBTableNameFromStreamArn(records[0]?.eventSourceARN);
    if (!tableName) return null;
    for (const route of this._dynamoDBRoutes) {
      if (route.tableName === tableName) return route.handler;
    }
    return null;
  }

  async serveDynamoDBStream(event, ctx) {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._dynamoDBHandlerForEvent(event);
    if (!handler) {
      return {
        batchItemFailures: records
          .map((r) => ({ itemIdentifier: String(r?.eventID ?? "").trim() }))
          .filter((f) => Boolean(f.itemIdentifier)),
      };
    }

    const evtCtx = this._eventContext(ctx);
    const wrapped = this._applyEventMiddlewares(handler);
    const failures = [];
    for (const record of records) {
      try {
        await wrapped(evtCtx, record);
      } catch {
        const id = String(record?.eventID ?? "").trim();
        if (id) failures.push({ itemIdentifier: id });
      }
    }
    return { batchItemFailures: failures };
  }

  async handleLambda(event, ctx) {
    if (!event || typeof event !== "object") {
      throw new Error("apptheory: unknown event type");
    }

    const records = Array.isArray(event.Records) ? event.Records : [];
    if (records.length > 0) {
      const source = String(records[0]?.eventSource ?? "").trim();
      if (source === "aws:sqs") {
        return this.serveSQSEvent(event, ctx);
      }
      if (source === "aws:dynamodb") {
        return this.serveDynamoDBStream(event, ctx);
      }
    }

    if ("detail-type" in event || "detailType" in event) {
      return this.serveEventBridge(event, ctx);
    }

    if (event.requestContext) {
      if (event.requestContext.http) {
        if ("routeKey" in event) {
          return this.serveAPIGatewayV2(event, ctx);
        }
        return this.serveLambdaFunctionURL(event, ctx);
      }
      if (typeof event.requestContext.connectionId === "string" && event.requestContext.connectionId.trim()) {
        return this.serveWebSocket(event, ctx);
      }
      if (
        event.requestContext.elb &&
        typeof event.requestContext.elb === "object" &&
        typeof event.requestContext.elb.targetGroupArn === "string" &&
        event.requestContext.elb.targetGroupArn.trim()
      ) {
        return this.serveALB(event, ctx);
      }
      if (typeof event.httpMethod === "string" && event.httpMethod.trim()) {
        return this.serveAPIGatewayProxy(event, ctx);
      }
    }

    throw new Error("apptheory: unknown event type");
  }
}

export function createApp(options = {}) {
  return new App(options);
}

function lambdaFunctionURLSingleHeaders(headers) {
  const out = {};
  for (const [key, values] of Object.entries(headers ?? {})) {
    if (!values || values.length === 0) continue;
    out[key] = [...values].map((v) => String(v)).join(",");
  }
  return out;
}

function httpResponseStreamFrom(responseStream, meta) {
  const aws = globalThis.awslambda;
  const HttpResponseStream = aws && aws.HttpResponseStream ? aws.HttpResponseStream : null;
  if (HttpResponseStream && typeof HttpResponseStream.from === "function") {
    return HttpResponseStream.from(responseStream, meta);
  }

  if (responseStream && typeof responseStream.init === "function") {
    responseStream.init(meta);
    return responseStream;
  }

  return responseStream;
}

function streamErrorCodeForError(err) {
  if (!err) return "";
  if (err instanceof AppError && String(err.code ?? "").trim()) {
    return String(err.code).trim();
  }
  return "app.internal";
}

async function writeStreamedLambdaFunctionURLResponse(responseStream, resp) {
  if (resp.isBase64) {
    throw new TypeError("apptheory: cannot stream isBase64 responses");
  }

  const headers = lambdaFunctionURLSingleHeaders(resp.headers);
  const cookies = Array.isArray(resp.cookies) ? [...resp.cookies] : [];

  const prefix = Buffer.from(resp.body ?? []);
  const stream = resp.bodyStream;

  const meta = {
    statusCode: Number(resp.status ?? 200),
    headers,
    cookies,
  };

  let firstChunk = null;
  let iterator = null;

  if (prefix.length > 0) {
    firstChunk = prefix;
  } else if (stream) {
    iterator = stream[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (!first.done) {
        firstChunk = Buffer.from(first.value ?? []);
      }
    } catch (err) {
      const requestId = firstHeaderValue(resp.headers ?? {}, "x-request-id");
      const early = responseForErrorWithRequestId(err, requestId);
      const earlyMeta = {
        statusCode: Number(early.status ?? 200),
        headers: lambdaFunctionURLSingleHeaders(early.headers),
        cookies: Array.isArray(early.cookies) ? [...early.cookies] : [],
      };

      const out = httpResponseStreamFrom(responseStream, earlyMeta);
      const bodyBytes = Buffer.from(early.body ?? []);
      if (bodyBytes.length > 0) out.write(bodyBytes);
      out.end();
      return "";
    }
  }

  const out = httpResponseStreamFrom(responseStream, meta);
  let streamErrorCode = "";

  if (firstChunk && firstChunk.length > 0) {
    out.write(firstChunk);
  }

  try {
    if (stream) {
      if (!iterator) {
        for await (const chunk of stream) {
          out.write(Buffer.from(chunk ?? []));
        }
      } else {
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          out.write(Buffer.from(chunk ?? []));
        }
      }
    }
  } catch (err) {
    streamErrorCode = streamErrorCodeForError(err);
  } finally {
    out.end();
  }

  return streamErrorCode;
}

async function serveLambdaFunctionURLStreaming(app, event, responseStream, ctx) {
  let request;
  try {
    request = requestFromLambdaFunctionURL(event);
  } catch (err) {
    const resp = responseForError(err);
    return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
  }

  const resp = await app.serve(request, ctx);
  return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
}

export function createLambdaFunctionURLStreamingHandler(app) {
  const aws = globalThis.awslambda;
  if (aws && typeof aws.streamifyResponse === "function") {
    return aws.streamifyResponse((event, responseStream, ctx) => serveLambdaFunctionURLStreaming(app, event, responseStream, ctx));
  }

  return async (event, ctx) => app.serveLambdaFunctionURL(event, ctx);
}

class CapturedHttpResponseStream {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.cookies = [];
    this.chunks = [];
    this.ended = false;
  }

  init(meta) {
    this.statusCode = Number(meta?.statusCode ?? 0);
    this.headers = { ...(meta?.headers ?? {}) };
    this.cookies = Array.isArray(meta?.cookies) ? [...meta.cookies].map((c) => String(c)) : [];
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk ?? []));
    return true;
  }

  end(chunk) {
    if (chunk !== null && chunk !== undefined) {
      this.write(chunk);
    }
    this.ended = true;
  }
}

export function timeoutMiddleware(config = {}) {
  const cfg = normalizeTimeoutConfig(config);

  return async (ctx, next) => {
    const timeoutMs = timeoutForContext(ctx, cfg);
    if (timeoutMs <= 0) {
      return next(ctx);
    }

    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new AppError("app.timeout", cfg.timeoutMessage)), timeoutMs);
    });

    try {
      const run = Promise.resolve().then(() => next(ctx));
      return await Promise.race([run, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}

function normalizeTimeoutConfig(config) {
  let defaultTimeoutMs = Number(config?.defaultTimeoutMs ?? 0);
  if (!Number.isFinite(defaultTimeoutMs)) defaultTimeoutMs = 0;
  defaultTimeoutMs = Math.floor(defaultTimeoutMs);
  if (defaultTimeoutMs === 0) defaultTimeoutMs = 30_000;

  const timeoutMessage = String(config?.timeoutMessage ?? "").trim() || "request timeout";

  const operationTimeoutsMs =
    config?.operationTimeoutsMs && typeof config.operationTimeoutsMs === "object" ? config.operationTimeoutsMs : null;
  const tenantTimeoutsMs =
    config?.tenantTimeoutsMs && typeof config.tenantTimeoutsMs === "object" ? config.tenantTimeoutsMs : null;

  return {
    defaultTimeoutMs,
    operationTimeoutsMs,
    tenantTimeoutsMs,
    timeoutMessage,
  };
}

function timeoutForContext(ctx, config) {
  let timeoutMs = Number(config?.defaultTimeoutMs ?? 0);
  if (!Number.isFinite(timeoutMs)) timeoutMs = 0;

  const tenant = String(ctx?.tenantId ?? "").trim();
  if (tenant && config?.tenantTimeoutsMs && tenant in config.tenantTimeoutsMs) {
    const override = Number(config.tenantTimeoutsMs[tenant]);
    if (Number.isFinite(override)) {
      timeoutMs = override;
    }
  }

  const method = String(ctx?.request?.method ?? "").trim().toUpperCase();
  const path = String(ctx?.request?.path ?? "").trim() || "/";
  const op = `${method}:${path}`;
  if (config?.operationTimeoutsMs && op in config.operationTimeoutsMs) {
    const override = Number(config.operationTimeoutsMs[op]);
    if (Number.isFinite(override)) {
      timeoutMs = override;
    }
  }

  const remainingMs = Number(ctx?.remainingMs ?? 0);
  if (Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs < timeoutMs) {
    timeoutMs = remainingMs;
  }

  timeoutMs = Math.floor(timeoutMs);
  return timeoutMs;
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

  async invokeStreaming(app, request, ctx) {
    const resp = await app.serve(request, ctx);

    const headers = {};
    for (const [key, values] of Object.entries(resp.headers ?? {})) {
      headers[key] = Array.isArray(values) ? [...values].map((v) => String(v)) : [String(values)];
    }

    const cookies = Array.isArray(resp.cookies) ? [...resp.cookies].map((c) => String(c)) : [];

    const chunks = [];
    const buffers = [];

    if (resp.body && Buffer.from(resp.body).length > 0) {
      const b = Buffer.from(resp.body);
      chunks.push(b);
      buffers.push(b);
    }

    let streamErrorCode = "";
    if (resp.bodyStream) {
      try {
        for await (const chunk of resp.bodyStream) {
          const b = Buffer.from(chunk ?? []);
          chunks.push(b);
          buffers.push(b);
        }
      } catch (err) {
        streamErrorCode = err instanceof AppError ? String(err.code ?? "") : "app.internal";
      }
    }

    return {
      status: Number(resp.status ?? 0),
      headers,
      cookies,
      chunks,
      body: Buffer.concat(buffers),
      is_base64: Boolean(resp.isBase64),
      stream_error_code: streamErrorCode,
    };
  }

  invokeAPIGatewayV2(app, event, ctx) {
    return app.serveAPIGatewayV2(event, ctx);
  }

  invokeLambdaFunctionURL(app, event, ctx) {
    return app.serveLambdaFunctionURL(event, ctx);
  }

  async invokeLambdaFunctionURLStreaming(app, event, ctx) {
    const stream = new CapturedHttpResponseStream();
    const streamErrorCode = await serveLambdaFunctionURLStreaming(app, event, stream, ctx);

    const headers = {};
    for (const [key, value] of Object.entries(stream.headers ?? {})) {
      headers[key] = [String(value)];
    }

    const chunks = [...stream.chunks];
    return {
      status: Number(stream.statusCode ?? 0),
      headers,
      cookies: [...stream.cookies],
      chunks,
      body: Buffer.concat(chunks),
      is_base64: false,
      stream_error_code: streamErrorCode,
    };
  }

  invokeAPIGatewayProxy(app, event, ctx) {
    return app.serveAPIGatewayProxy(event, ctx);
  }

  invokeALB(app, event, ctx) {
    return app.serveALB(event, ctx);
  }

  invokeSQS(app, event, ctx) {
    return app.serveSQSEvent(event, ctx);
  }

  invokeEventBridge(app, event, ctx) {
    return app.serveEventBridge(event, ctx);
  }

  invokeDynamoDBStream(app, event, ctx) {
    return app.serveDynamoDBStream(event, ctx);
  }

  invokeLambda(app, event, ctx) {
    return app.handleLambda(event, ctx);
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

export function buildALBTargetGroupRequest(method, path, options = {}) {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);

  const query = options.query && Object.keys(options.query).length > 0 ? cloneQuery(options.query) : rawQueryString ? parseRawQueryString(rawQueryString) : {};

  const headers = { ...(options.headers ?? {}) };
  const multiValueHeaders = {};
  for (const [key, values] of Object.entries(options.multiHeaders ?? {})) {
    multiValueHeaders[key] = Array.isArray(values) ? [...values].map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key in multiValueHeaders) continue;
    multiValueHeaders[key] = [String(value)];
  }
  for (const [key, values] of Object.entries(multiValueHeaders)) {
    if (key in headers) continue;
    if (Array.isArray(values) && values.length > 0) {
      headers[key] = String(values[0]);
    }
  }

  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);

  return {
    httpMethod: normalizedMethod,
    path: rawPath,
    queryStringParameters: firstQueryValues(query),
    multiValueQueryStringParameters: Object.keys(query).length > 0 ? cloneQuery(query) : undefined,
    headers,
    multiValueHeaders: Object.keys(multiValueHeaders).length > 0 ? multiValueHeaders : undefined,
    requestContext: {
      elb: {
        targetGroupArn: String(
          options.targetGroupArn ??
            "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000",
        ),
      },
    },
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
}

export function buildSQSEvent(queueArn, records = []) {
  const arn = String(queueArn ?? "").trim();
  return {
    Records: records.map((r, idx) => ({
      messageId: String(r?.messageId ?? `msg-${idx + 1}`),
      receiptHandle: String(r?.receiptHandle ?? ""),
      body: String(r?.body ?? ""),
      attributes: r?.attributes ?? {},
      messageAttributes: r?.messageAttributes ?? {},
      md5OfBody: String(r?.md5OfBody ?? ""),
      eventSource: "aws:sqs",
      eventSourceARN: String(r?.eventSourceARN ?? arn),
      awsRegion: String(r?.awsRegion ?? "us-east-1"),
    })),
  };
}

export function buildEventBridgeEvent(options = {}) {
  const ruleArn = String(options.ruleArn ?? "").trim();
  const resources = Array.isArray(options.resources) ? [...options.resources] : [];
  if (ruleArn) resources.push(ruleArn);

  return {
    version: String(options.version ?? "0"),
    id: String(options.id ?? "evt-1"),
    "detail-type": String(options.detailType ?? "Scheduled Event"),
    source: String(options.source ?? "aws.events"),
    account: String(options.account ?? "000000000000"),
    time: String(options.time ?? "1970-01-01T00:00:00Z"),
    region: String(options.region ?? "us-east-1"),
    resources,
    detail: options.detail ?? {},
  };
}

export function buildDynamoDBStreamEvent(streamArn, records = []) {
  const arn = String(streamArn ?? "").trim();
  return {
    Records: records.map((r, idx) => ({
      eventID: String(r?.eventID ?? `evt-${idx + 1}`),
      eventName: String(r?.eventName ?? "MODIFY"),
      eventVersion: String(r?.eventVersion ?? "1.1"),
      eventSource: "aws:dynamodb",
      awsRegion: String(r?.awsRegion ?? "us-east-1"),
      dynamodb: r?.dynamodb ?? { SequenceNumber: String(idx + 1), SizeBytes: 1, StreamViewType: "NEW_AND_OLD_IMAGES" },
      eventSourceARN: String(r?.eventSourceARN ?? arn),
    })),
  };
}

class Router {
  constructor() {
    this._routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const normalizedMethod = normalizeMethod(method);
    const normalizedPattern = normalizePath(pattern);
    const parsed = parseRouteSegments(splitPath(normalizedPattern));
    if (!parsed.ok) {
      return;
    }

    const normalizedPatternValue = parsed.canonicalSegments.length > 0 ? `/${parsed.canonicalSegments.join("/")}` : "/";
    this._routes.push({
      method: normalizedMethod,
      pattern: normalizedPatternValue,
      segments: parsed.segments,
      handler,
      authRequired: Boolean(options?.authRequired),
      staticCount: parsed.staticCount,
      paramCount: parsed.paramCount,
      hasProxy: parsed.hasProxy,
      order: this._routes.length,
    });
  }

  match(method, path) {
    const normalizedMethod = normalizeMethod(method);
    const pathSegments = splitPath(normalizePath(path));

    const allowed = [];
    let best = null;
    for (const route of this._routes) {
      const params = matchRoute(route.segments, pathSegments);
      if (!params) {
        continue;
      }
      allowed.push(route.method);
      if (route.method === normalizedMethod) {
        if (!best || routeMoreSpecific(route, best.route)) {
          best = { route, params };
        }
      }
    }
    return { match: best, allowed };
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

function parseRouteSegments(rawSegments) {
  const rawList = Array.isArray(rawSegments) ? rawSegments : [];
  const segments = [];
  const canonicalSegments = [];
  let staticCount = 0;
  let paramCount = 0;
  let hasProxy = false;

  for (let i = 0; i < rawList.length; i += 1) {
    let raw = String(rawList[i] ?? "").trim();
    if (!raw) return { ok: false };

    if (raw.startsWith(":") && raw.length > 1) {
      raw = `{${raw.slice(1)}}`;
    }

    if (raw.startsWith("{") && raw.endsWith("}") && raw.length > 2) {
      const inner = raw.slice(1, -1).trim();
      if (inner.endsWith("+")) {
        const name = inner.slice(0, -1).trim();
        if (!name) return { ok: false };
        if (i !== rawList.length - 1) return { ok: false };
        segments.push({ kind: "proxy", value: name });
        canonicalSegments.push(`{${name}+}`);
        hasProxy = true;
        continue;
      }

      if (!inner) return { ok: false };
      segments.push({ kind: "param", value: inner });
      canonicalSegments.push(`{${inner}}`);
      paramCount += 1;
      continue;
    }

    segments.push({ kind: "static", value: raw });
    canonicalSegments.push(raw);
    staticCount += 1;
  }

  return { ok: true, segments, canonicalSegments, staticCount, paramCount, hasProxy };
}

function matchRoute(patternSegments, pathSegments) {
  const patterns = Array.isArray(patternSegments) ? patternSegments : [];
  const paths = Array.isArray(pathSegments) ? pathSegments : [];
  if (patterns.length === 0) return paths.length === 0 ? {} : null;

  const last = patterns[patterns.length - 1];
  const hasProxy = last?.kind === "proxy";

  if (hasProxy) {
    const prefixLen = patterns.length - 1;
    if (paths.length <= prefixLen) return null;

    const params = {};
    for (let i = 0; i < prefixLen; i += 1) {
      const pattern = patterns[i];
      const segment = paths[i];
      if (!segment) return null;
      if (pattern.kind === "static") {
        if (pattern.value !== segment) return null;
      } else if (pattern.kind === "param") {
        params[pattern.value] = segment;
      } else {
        return null;
      }
    }

    params[last.value] = paths.slice(prefixLen).join("/");
    return params;
  }

  if (patterns.length !== paths.length) return null;

  const params = {};
  for (let i = 0; i < patterns.length; i += 1) {
    const pattern = patterns[i];
    const segment = paths[i];
    if (!segment) return null;
    if (pattern.kind === "static") {
      if (pattern.value !== segment) return null;
    } else if (pattern.kind === "param") {
      params[pattern.value] = segment;
    } else {
      return null;
    }
  }
  return params;
}

function routeMoreSpecific(a, b) {
  const aStatic = Number(a?.staticCount ?? 0);
  const bStatic = Number(b?.staticCount ?? 0);
  if (aStatic !== bStatic) return aStatic > bStatic;

  const aParam = Number(a?.paramCount ?? 0);
  const bParam = Number(b?.paramCount ?? 0);
  if (aParam !== bParam) return aParam > bParam;

  const aProxy = Boolean(a?.hasProxy ?? false);
  const bProxy = Boolean(b?.hasProxy ?? false);
  if (aProxy !== bProxy) return !aProxy && bProxy;

  const aLen = Array.isArray(a?.segments) ? a.segments.length : 0;
  const bLen = Array.isArray(b?.segments) ? b.segments.length : 0;
  if (aLen !== bLen) return aLen > bLen;

  const aOrder = Number(a?.order ?? 0);
  const bOrder = Number(b?.order ?? 0);
  return aOrder < bOrder;
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

async function* normalizeBodyStream(bodyStream) {
  if (bodyStream === null || bodyStream === undefined) {
    return;
  }
  if (typeof bodyStream[Symbol.asyncIterator] === "function") {
    for await (const chunk of bodyStream) {
      yield toBuffer(chunk);
    }
    return;
  }
  if (typeof bodyStream[Symbol.iterator] === "function") {
    for (const chunk of bodyStream) {
      yield toBuffer(chunk);
    }
    return;
  }
  throw new TypeError("bodyStream must be an Iterable or AsyncIterable");
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
  out.cookies = Array.isArray(response.cookies) ? response.cookies.map((c) => String(c)) : [];
  const setCookie = out.headers["set-cookie"];
  if (Array.isArray(setCookie) && setCookie.length > 0) {
    out.cookies.push(...setCookie.map((c) => String(c)));
    delete out.headers["set-cookie"];
  }
  out.body = toBuffer(response.body);
  out.bodyStream = response.bodyStream !== null && response.bodyStream !== undefined ? normalizeBodyStream(response.bodyStream) : null;
  out.isBase64 = Boolean(response.isBase64);
  if (out.isBase64 && out.bodyStream) {
    throw new TypeError("bodyStream cannot be used with isBase64=true");
  }
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

function normalizeCorsConfig(cors) {
  const allowCredentials = Boolean(cors?.allowCredentials);

  let allowedOrigins = null;
  if (cors && typeof cors === "object" && "allowedOrigins" in cors) {
    if (Array.isArray(cors.allowedOrigins)) {
      const normalized = [];
      for (const origin of cors.allowedOrigins) {
        const trimmed = String(origin ?? "").trim();
        if (!trimmed) continue;
        if (trimmed === "*") {
          allowedOrigins = ["*"];
          break;
        }
        normalized.push(trimmed);
      }
      if (!allowedOrigins) {
        allowedOrigins = normalized;
      }
    }
  }

  let allowHeaders = null;
  if (cors && typeof cors === "object" && "allowHeaders" in cors) {
    if (Array.isArray(cors.allowHeaders)) {
      const normalized = [];
      for (const header of cors.allowHeaders) {
        const trimmed = String(header ?? "").trim();
        if (!trimmed) continue;
        normalized.push(trimmed);
      }
      allowHeaders = normalized;
    }
  }

  return { allowedOrigins, allowCredentials, allowHeaders };
}

function corsOriginAllowed(origin, cors) {
  const originValue = String(origin ?? "").trim();
  if (!originValue) return false;

  const allowed = cors?.allowedOrigins ?? null;
  if (allowed === null) {
    return true;
  }
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return false;
  }
  return allowed.some((entry) => entry === "*" || entry === originValue);
}

function corsAllowHeadersValue(cors) {
  const headers = Array.isArray(cors?.allowHeaders) ? cors.allowHeaders : [];
  if (headers.length > 0) {
    return headers.join(", ");
  }
  if (cors?.allowCredentials) {
    return "Content-Type, Authorization";
  }
  return "";
}

function finalizeP1Response(resp, requestId, origin, cors) {
  const headers = canonicalizeHeaders(resp.headers ?? {});
  if (requestId) {
    headers["x-request-id"] = [String(requestId)];
  }
  if (origin && corsOriginAllowed(origin, cors)) {
    headers["access-control-allow-origin"] = [String(origin)];
    headers.vary = vary(headers.vary, "origin");
    if (cors?.allowCredentials) {
      headers["access-control-allow-credentials"] = ["true"];
    }
    const allowHeaders = corsAllowHeadersValue(cors);
    if (allowHeaders) {
      headers["access-control-allow-headers"] = [allowHeaders];
    }
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

function requestFromWebSocketEvent(event) {
  const headers = {};
  for (const [key, values] of Object.entries(event?.multiValueHeaders ?? {})) {
    headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event?.headers ?? {})) {
    if (headers[key]) continue;
    headers[key] = [String(value)];
  }

  const query = {};
  for (const [key, values] of Object.entries(event?.multiValueQueryStringParameters ?? {})) {
    query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event?.queryStringParameters ?? {})) {
    if (query[key]) continue;
    query[key] = [String(value)];
  }

  return normalizeRequest({
    method: String(event?.httpMethod ?? ""),
    path: String(event?.path ?? "/"),
    query,
    headers,
    body: String(event?.body ?? ""),
    isBase64: Boolean(event?.isBase64Encoded),
  });
}

function requestFromAPIGatewayProxy(event) {
  const headers = {};
  for (const [key, values] of Object.entries(event?.multiValueHeaders ?? {})) {
    headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event?.headers ?? {})) {
    if (headers[key]) continue;
    headers[key] = [String(value)];
  }

  const query = {};
  for (const [key, values] of Object.entries(event?.multiValueQueryStringParameters ?? {})) {
    query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
  }
  for (const [key, value] of Object.entries(event?.queryStringParameters ?? {})) {
    if (query[key]) continue;
    query[key] = [String(value)];
  }

  return {
    method: String(event?.httpMethod ?? event?.requestContext?.httpMethod ?? ""),
    path: String(event?.path ?? event?.requestContext?.path ?? "/"),
    query,
    headers,
    body: String(event?.body ?? ""),
    isBase64: Boolean(event?.isBase64Encoded),
  };
}

function requestFromALBTargetGroup(event) {
  return requestFromAPIGatewayProxy(event);
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

function apigatewayProxyResponseFromResponse(resp) {
  const normalized = normalizeResponse(resp);
  const headers = {};
  const multiValueHeaders = {};
  for (const [key, values] of Object.entries(normalized.headers ?? {})) {
    if (!values || values.length === 0) continue;
    headers[key] = String(values[0]);
    multiValueHeaders[key] = [...values].map((v) => String(v));
  }

  if (normalized.cookies.length > 0) {
    headers["set-cookie"] = String(normalized.cookies[0]);
    multiValueHeaders["set-cookie"] = [...normalized.cookies].map((v) => String(v));
  }

  const bodyBytes = toBuffer(normalized.body);
  const isBase64Encoded = Boolean(normalized.isBase64);

  return {
    statusCode: normalized.status,
    headers,
    multiValueHeaders,
    body: isBase64Encoded ? bodyBytes.toString("base64") : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
}

function albStatusDescription(status) {
  const code = Number(status ?? 0);
  const text = STATUS_CODES[String(code)] ?? "";
  return text ? `${code} ${text}` : String(code);
}

function albTargetGroupResponseFromResponse(resp) {
  const out = apigatewayProxyResponseFromResponse(resp);
  return { ...out, statusDescription: albStatusDescription(out.statusCode) };
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

function sqsQueueNameFromArn(arn) {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const parts = value.split(":");
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function eventBridgeRuleNameFromArn(arn) {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const idx = value.indexOf(":rule/");
  const start = idx >= 0 ? idx + ":rule/".length : value.indexOf("rule/") >= 0 ? value.indexOf("rule/") + "rule/".length : -1;
  if (start < 0) return "";
  const after = value.slice(start).replace(/^\/+/, "");
  if (!after) return "";
  const slash = after.indexOf("/");
  return slash >= 0 ? after.slice(0, slash) : after;
}

function dynamoDBTableNameFromStreamArn(arn) {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const idx = value.indexOf(":table/");
  if (idx < 0) return "";
  const after = value.slice(idx + ":table/".length);
  const streamIdx = after.indexOf("/stream/");
  if (streamIdx >= 0) return after.slice(0, streamIdx);
  const slashIdx = after.indexOf("/");
  return slashIdx >= 0 ? after.slice(0, slashIdx) : after;
}

function webSocketManagementEndpoint(domainName, stage) {
  const dn = String(domainName ?? "").trim();
  const st = String(stage ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!dn || !st) return "";
  return `https://${dn}/${st}`;
}

function inferRegionFromDomainName(domainName) {
  const host = String(domainName ?? "").trim().toLowerCase();
  const m = host.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/);
  return m ? m[1] : "";
}

function loadEnvCredentials() {
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  const sessionToken = String(process.env.AWS_SESSION_TOKEN ?? "").trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("apptheory: missing aws credentials for websocket management client");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function normalizeWebSocketManagementEndpoint(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (!value) return "";
  if (value.startsWith("wss://")) return `https://${value.slice("wss://".length)}`;
  if (value.startsWith("ws://")) return `http://${value.slice("ws://".length)}`;
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  return `https://${value}`;
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function amzDateNow(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function signedFetch({ method, url, region, credentials, headers, body }) {
  const u = new URL(url);
  const host = u.host;
  const canonicalUri = u.pathname || "/";
  const canonicalQueryString = u.searchParams.toString();
  const payloadHash = sha256Hex(body ?? "");

  const amzDate = amzDateNow();
  const dateStamp = amzDate.slice(0, 8);

  const merged = { host, "x-amz-date": amzDate };
  for (const [key, value] of Object.entries(headers ?? {})) {
    const k = String(key).trim().toLowerCase();
    if (k) merged[k] = String(value);
  }
  if (credentials.sessionToken) {
    merged["x-amz-security-token"] = credentials.sessionToken;
  }

  const sortedKeys = Object.keys(merged).sort();

  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(merged[k]).trim().replace(/\\s+/g, " ")}\\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\\n");

  const scope = `${dateStamp}/${region}/execute-api/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\\n");
  const kSigning = signingKey(credentials.secretAccessKey, dateStamp, region, "execute-api");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  merged.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(u.toString(), {
    method,
    headers: merged,
    body: body ?? undefined,
  });
}

export class WebSocketManagementClient {
  constructor({ endpoint, region, credentials } = {}) {
    this.endpoint = normalizeWebSocketManagementEndpoint(endpoint);
    if (!this.endpoint) {
      throw new Error("apptheory: websocket management endpoint is empty");
    }

    const host = new URL(this.endpoint).host;
    this.region =
      String(region ?? "").trim() ||
      String(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "").trim() ||
      inferRegionFromDomainName(host);
    if (!this.region) {
      throw new Error("apptheory: aws region is empty");
    }

    this.credentials = credentials ?? loadEnvCredentials();
  }

  async postToConnection(connectionId, data) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;
    const body = toBuffer(data);

    const resp = await signedFetch({
      method: "POST",
      url,
      region: this.region,
      credentials: this.credentials,
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`apptheory: post_to_connection failed (${resp.status}) ${text}`.trim());
    }
  }

  async getConnection(connectionId) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;

    const resp = await signedFetch({
      method: "GET",
      url,
      region: this.region,
      credentials: this.credentials,
      headers: {},
      body: undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`apptheory: get_connection failed (${resp.status}) ${text}`.trim());
    }
    return resp.json();
  }

  async deleteConnection(connectionId) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;

    const resp = await signedFetch({
      method: "DELETE",
      url,
      region: this.region,
      credentials: this.credentials,
      headers: {},
      body: undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`apptheory: delete_connection failed (${resp.status}) ${text}`.trim());
    }
  }
}

export class FakeWebSocketManagementClient {
  constructor({ endpoint } = {}) {
    this.endpoint = String(endpoint ?? "").trim();
    this.calls = [];
    this.connections = new Map();
    this.postError = null;
    this.getError = null;
    this.deleteError = null;
  }

  async postToConnection(connectionId, data) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    this.calls.push({ op: "post_to_connection", connectionId: id, data: toBuffer(data) });
    if (this.postError) throw this.postError;
  }

  async getConnection(connectionId) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    this.calls.push({ op: "get_connection", connectionId: id, data: null });
    if (this.getError) throw this.getError;
    if (!this.connections.has(id)) throw new Error("apptheory: connection not found");
    return this.connections.get(id);
  }

  async deleteConnection(connectionId) {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");
    this.calls.push({ op: "delete_connection", connectionId: id, data: null });
    if (this.deleteError) throw this.deleteError;
    this.connections.delete(id);
  }
}
