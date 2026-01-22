import { Buffer } from "node:buffer";
import { AppError } from "../errors.js";
export function normalizeMethod(method) {
    return String(method ?? "")
        .trim()
        .toUpperCase();
}
export function normalizePath(path) {
    let value = String(path ?? "").trim();
    if (!value)
        value = "/";
    const idx = value.indexOf("?");
    if (idx >= 0)
        value = value.slice(0, idx);
    if (!value.startsWith("/"))
        value = `/${value}`;
    if (!value)
        value = "/";
    return value;
}
export function splitPath(path) {
    const value = normalizePath(path).replace(/^\//, "");
    if (!value)
        return [];
    return value.split("/");
}
export function canonicalizeHeaders(headers) {
    const out = {};
    if (headers === null ||
        headers === undefined ||
        typeof headers !== "object") {
        return out;
    }
    const record = headers;
    const keys = Object.keys(record).sort();
    for (const key of keys) {
        const lower = String(key).trim().toLowerCase();
        if (!lower)
            continue;
        const raw = record[key];
        const values = Array.isArray(raw) ? raw : [raw];
        out[lower] = [...(out[lower] ?? []), ...values.map((v) => String(v))];
    }
    return out;
}
export function cloneQuery(query) {
    const out = {};
    if (query === null || query === undefined || typeof query !== "object") {
        return out;
    }
    const record = query;
    for (const [key, values] of Object.entries(record)) {
        out[key] = Array.isArray(values)
            ? values.map((v) => String(v))
            : [String(values)];
    }
    return out;
}
export function parseCookies(cookieHeaders) {
    const out = {};
    for (const header of cookieHeaders ?? []) {
        for (const part of String(header).split(";")) {
            const trimmed = part.trim();
            if (!trimmed)
                continue;
            const idx = trimmed.indexOf("=");
            if (idx <= 0)
                continue;
            const name = trimmed.slice(0, idx).trim();
            if (!name)
                continue;
            const value = trimmed.slice(idx + 1).trim();
            out[name] = value;
        }
    }
    return out;
}
export function toBuffer(body) {
    if (body === null || body === undefined)
        return Buffer.alloc(0);
    if (Buffer.isBuffer(body))
        return Buffer.from(body);
    if (body instanceof Uint8Array)
        return Buffer.from(body);
    if (typeof body === "string")
        return Buffer.from(body, "utf8");
    throw new TypeError("body must be Uint8Array, Buffer, or string");
}
export async function* normalizeBodyStream(bodyStream) {
    if (bodyStream === null || bodyStream === undefined) {
        return;
    }
    if (Symbol.asyncIterator in bodyStream) {
        for await (const chunk of bodyStream) {
            yield toBuffer(chunk);
        }
        return;
    }
    if (Symbol.iterator in bodyStream) {
        for (const chunk of bodyStream) {
            yield toBuffer(chunk);
        }
        return;
    }
    throw new TypeError("bodyStream must be an Iterable or AsyncIterable");
}
export function headersFromSingle(headers, ignoreCookieHeader) {
    const out = {};
    if (!headers)
        return out;
    for (const [key, value] of Object.entries(headers)) {
        if (ignoreCookieHeader && String(key).trim().toLowerCase() === "cookie") {
            continue;
        }
        out[key] = [String(value)];
    }
    return out;
}
export function queryFromSingle(params) {
    const out = {};
    if (!params)
        return out;
    for (const [key, value] of Object.entries(params)) {
        out[String(key)] = [String(value)];
    }
    return out;
}
function decodeFormComponent(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, " "));
    }
    catch {
        throw new AppError("app.bad_request", "invalid query string");
    }
}
export function parseRawQueryString(raw) {
    const out = {};
    if (!raw)
        return out;
    for (const part of String(raw).split("&")) {
        if (!part)
            continue;
        const idx = part.indexOf("=");
        const rawKey = idx >= 0 ? part.slice(0, idx) : part;
        const rawValue = idx >= 0 ? part.slice(idx + 1) : "";
        const key = decodeFormComponent(rawKey);
        const value = decodeFormComponent(rawValue);
        out[key] = [...(out[key] ?? []), value];
    }
    return out;
}
function encodeFormComponent(value) {
    return encodeURIComponent(String(value)).replace(/%20/g, "+");
}
function encodeRawQueryString(query) {
    const keys = Object.keys(query).sort();
    const parts = [];
    for (const key of keys) {
        const values = query[key] ?? [];
        for (const value of values) {
            parts.push(`${encodeFormComponent(key)}=${encodeFormComponent(value)}`);
        }
    }
    return parts.join("&");
}
export function firstQueryValues(query) {
    if (!query)
        return undefined;
    const out = {};
    let hasAny = false;
    for (const [key, values] of Object.entries(query)) {
        const list = values ?? [];
        if (list.length === 0)
            continue;
        out[key] = String(list[0] ?? "");
        hasAny = true;
    }
    return hasAny ? out : undefined;
}
export function splitPathAndQuery(path, query) {
    const value = String(path ?? "").trim();
    const idx = value.indexOf("?");
    const rawPath = normalizePath(idx >= 0 ? value.slice(0, idx) : value);
    let rawQueryString = "";
    if (query && Object.keys(query).length > 0) {
        rawQueryString = encodeRawQueryString(query);
    }
    else if (idx >= 0) {
        rawQueryString = value.slice(idx + 1);
    }
    return { rawPath, rawQueryString };
}
export function firstHeaderValue(headers, key) {
    const values = headers?.[String(key).trim().toLowerCase()] ?? [];
    return values.length > 0 ? String(values[0]) : "";
}
