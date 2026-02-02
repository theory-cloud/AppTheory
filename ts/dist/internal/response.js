import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "../errors.js";
import { canonicalizeHeaders, normalizeBodyStream, toBuffer } from "./http.js";
export function normalizeResponse(response) {
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
    const bodyStream = response.bodyStream !== null && response.bodyStream !== undefined
        ? normalizeBodyStream(response.bodyStream)
        : null;
    const isBase64 = Boolean(response.isBase64);
    if (isBase64 && bodyStream) {
        throw new TypeError("bodyStream cannot be used with isBase64=true");
    }
    return { status, headers, cookies, body, bodyStream, isBase64 };
}
export function hasJSONContentType(headers) {
    for (const value of headers["content-type"] ?? []) {
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
function errorBodyFromAppTheoryError(err, requestId) {
    const code = String(err.code ?? "").trim() || "app.internal";
    const error = {
        code,
        message: String(err.message ?? ""),
    };
    if (typeof err.statusCode === "number" && err.statusCode > 0) {
        error["status_code"] = err.statusCode;
    }
    if (err.details !== undefined) {
        error["details"] = err.details;
    }
    const resolvedRequestId = String(err.requestId ?? "").trim() || String(requestId ?? "").trim();
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
    return error;
}
function errorResponseFromAppTheoryError(err, headers = {}, requestId = "") {
    const outHeaders = { ...canonicalizeHeaders(headers) };
    outHeaders["content-type"] = ["application/json; charset=utf-8"];
    const code = String(err.code ?? "").trim() || "app.internal";
    const status = typeof err.statusCode === "number" && err.statusCode > 0
        ? err.statusCode
        : statusForErrorCode(code);
    return normalizeResponse({
        status,
        headers: outHeaders,
        cookies: [],
        body: Buffer.from(JSON.stringify({ error: errorBodyFromAppTheoryError(err, requestId) }), "utf8"),
        isBase64: false,
    });
}
export function errorResponse(code, message, headers = {}) {
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
export function errorResponseWithRequestId(code, message, headers = {}, requestId = "") {
    const outHeaders = { ...canonicalizeHeaders(headers) };
    outHeaders["content-type"] = ["application/json; charset=utf-8"];
    const error = { code, message };
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
export function responseForError(err) {
    if (err instanceof AppTheoryError) {
        return errorResponseFromAppTheoryError(err);
    }
    if (err instanceof AppError) {
        return errorResponse(err.code, err.message);
    }
    return errorResponse("app.internal", "internal error");
}
export function responseForErrorWithRequestId(err, requestId) {
    if (err instanceof AppTheoryError) {
        return errorResponseFromAppTheoryError(err, {}, requestId);
    }
    if (err instanceof AppError) {
        return errorResponseWithRequestId(err.code, err.message, {}, requestId);
    }
    return errorResponseWithRequestId("app.internal", "internal error", {}, requestId);
}
