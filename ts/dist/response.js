import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { canonicalizeHeaders, firstHeaderValue, toBuffer, } from "./internal/http.js";
import { normalizeResponse } from "./internal/response.js";
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
    }
    catch (err) {
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
async function* normalizeHTMLChunks(chunks) {
    if (Symbol.asyncIterator in chunks) {
        for await (const chunk of chunks) {
            yield toBuffer(chunk);
        }
        return;
    }
    for (const chunk of chunks) {
        yield toBuffer(chunk);
    }
}
export function htmlStream(status, chunks) {
    return normalizeResponse({
        status,
        headers: { "content-type": ["text/html; charset=utf-8"] },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: normalizeHTMLChunks(chunks),
        isBase64: false,
    });
}
function isPlainObject(value) {
    return (value !== null &&
        value !== undefined &&
        typeof value === "object" &&
        !Array.isArray(value));
}
function sortKeysDeep(value) {
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map(sortKeysDeep);
    if (typeof value !== "object")
        return value;
    if (value instanceof Uint8Array || Buffer.isBuffer(value))
        return value;
    if (!isPlainObject(value))
        return value;
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) {
        const next = sortKeysDeep(value[key]);
        if (next === undefined)
            continue;
        out[key] = next;
    }
    return out;
}
export function safeJSONForHTML(value) {
    let serialized;
    try {
        serialized = JSON.stringify(sortKeysDeep(value));
    }
    catch (err) {
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
    if (!Number.isFinite(revalidate) || revalidate < 0)
        revalidate = 0;
    revalidate = Math.floor(revalidate);
    let swr = Number(staleWhileRevalidateSeconds ?? 0);
    if (!Number.isFinite(swr) || swr < 0)
        swr = 0;
    swr = Math.floor(swr);
    const parts = ["public", "max-age=0", `s-maxage=${revalidate}`];
    if (swr > 0)
        parts.push(`stale-while-revalidate=${swr}`);
    return parts.join(", ");
}
export function etag(body) {
    const bytes = toBuffer(body);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return `"${hash}"`;
}
function splitCommaValues(value) {
    const raw = String(value ?? "").trim();
    if (!raw)
        return [];
    return raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}
export function matchesIfNoneMatch(headers, tag) {
    const etagValue = String(tag ?? "").trim();
    if (!etagValue)
        return false;
    const h = canonicalizeHeaders(headers);
    for (const header of h["if-none-match"] ?? []) {
        for (let token of splitCommaValues(header)) {
            if (token === "*")
                return true;
            token = token.replace(/^W\//i, "").trim();
            if (token === etagValue)
                return true;
        }
    }
    return false;
}
export function vary(existing, ...add) {
    const seen = new Set();
    const out = [];
    const addToken = (token) => {
        const key = String(token ?? "")
            .trim()
            .toLowerCase();
        if (!key)
            return;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push(key);
    };
    const addValue = (value) => {
        for (const token of splitCommaValues(value)) {
            addToken(token);
        }
    };
    if (Array.isArray(existing)) {
        for (const value of existing)
            addValue(value);
    }
    else if (existing !== null && existing !== undefined) {
        addValue(existing);
    }
    for (const value of add)
        addValue(value);
    out.sort();
    return out;
}
function parseForwardedHeader(value) {
    const raw = String(value ?? "").trim();
    if (!raw)
        return { proto: "", host: "" };
    const first = raw.split(",")[0];
    let proto = "";
    let host = "";
    for (const part of String(first).split(";")) {
        const [k, v] = String(part).trim().split("=", 2);
        if (!k || v === undefined)
            continue;
        const key = String(k).trim().toLowerCase();
        const val = String(v).trim().replace(/^"/, "").replace(/"$/, "");
        if (key === "proto" && !proto)
            proto = val;
        if (key === "host" && !host)
            host = val;
    }
    return { proto, host };
}
function firstCommaToken(value) {
    return String(value ?? "").split(",", 1)[0] ?? "";
}
export function originURL(headers) {
    const h = canonicalizeHeaders(headers);
    const forwarded = parseForwardedHeader(firstHeaderValue(h, "forwarded"));
    let host = firstHeaderValue(h, "x-forwarded-host") ||
        forwarded.host ||
        firstHeaderValue(h, "host");
    host = firstCommaToken(host).trim();
    if (!host)
        return "";
    let proto = firstHeaderValue(h, "cloudfront-forwarded-proto") ||
        firstHeaderValue(h, "x-forwarded-proto") ||
        forwarded.proto;
    proto = firstCommaToken(proto).trim().toLowerCase();
    if (!proto)
        proto = "https";
    return `${proto}://${host}`;
}
function parseCloudFrontViewerAddress(value) {
    const raw = String(value ?? "")
        .trim()
        .replace(/^"/, "")
        .replace(/"$/, "");
    if (!raw)
        return "";
    if (raw.startsWith("[")) {
        const idx = raw.indexOf("]");
        if (idx > 1)
            return raw.slice(1, idx).trim();
    }
    const idx = raw.lastIndexOf(":");
    if (idx <= 0)
        return raw;
    const ipPart = raw.slice(0, idx).trim();
    const portPart = raw.slice(idx + 1).trim();
    if (!ipPart || !portPart)
        return raw;
    if (!/^[0-9]+$/.test(portPart))
        return raw;
    return ipPart;
}
export function clientIP(headers) {
    const h = canonicalizeHeaders(headers);
    const cf = firstHeaderValue(h, "cloudfront-viewer-address");
    if (cf) {
        const parsed = parseCloudFrontViewerAddress(cf);
        if (parsed)
            return parsed;
    }
    const xff = firstHeaderValue(h, "x-forwarded-for");
    if (xff) {
        const ip = firstCommaToken(xff).trim();
        if (ip)
            return ip;
    }
    return "";
}
