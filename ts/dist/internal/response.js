import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "../errors.js";
import { HTTP_ERROR_FORMAT_FLAT_LEGACY, HTTP_ERROR_FORMAT_NESTED, normalizeHTTPErrorFormat, } from "../http-error-format.js";
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
function canonicalHTTPErrorFields(format, code, message) {
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
function canonicalRuntimeErrorCode(code) {
    switch (code) {
        case "EMPTY_BODY":
        case "INVALID_JSON":
            return "app.bad_request";
        default:
            return code;
    }
}
function errorBodyFromAppTheoryError(format, err, requestId, traceId = "") {
    const code = String(err.code ?? "").trim() || "app.internal";
    const canonical = canonicalHTTPErrorFields(format, code, String(err.message ?? ""));
    const error = {
        code: canonical.code,
        message: canonical.message,
    };
    if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY &&
        typeof err.statusCode === "number" &&
        err.statusCode > 0) {
        error["status_code"] = err.statusCode;
    }
    if (err.details !== undefined) {
        error["details"] = err.details;
    }
    if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
        const resolvedRequestId = String(err.requestId ?? "").trim() || String(requestId ?? "").trim();
        if (resolvedRequestId) {
            error["request_id"] = resolvedRequestId;
        }
        const resolvedTraceId = String(err.traceId ?? "").trim() || String(traceId ?? "").trim();
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
function serializeHTTPErrorBody(format, error) {
    if (normalizeHTTPErrorFormat(format) === HTTP_ERROR_FORMAT_FLAT_LEGACY) {
        return Buffer.from(JSON.stringify(error), "utf8");
    }
    return Buffer.from(JSON.stringify({ error }), "utf8");
}
function errorResponseFromAppTheoryErrorWithFormat(format, err, headers = {}, requestId = "", traceId = "") {
    const outHeaders = { ...canonicalizeHeaders(headers) };
    outHeaders["content-type"] = ["application/json; charset=utf-8"];
    const code = String(err.code ?? "").trim() || "app.internal";
    const canonical = canonicalHTTPErrorFields(format, code, err.message);
    const status = typeof err.statusCode === "number" && err.statusCode > 0
        ? err.statusCode
        : statusForErrorCode(canonical.code);
    return normalizeResponse({
        status,
        headers: outHeaders,
        cookies: [],
        body: serializeHTTPErrorBody(format, errorBodyFromAppTheoryError(format, err, requestId, traceId)),
        isBase64: false,
    });
}
export function errorResponse(code, message, headers = {}) {
    return errorResponseWithFormat(HTTP_ERROR_FORMAT_NESTED, code, message, headers);
}
export function errorResponseWithFormat(format, code, message, headers = {}) {
    const outHeaders = { ...canonicalizeHeaders(headers) };
    outHeaders["content-type"] = ["application/json; charset=utf-8"];
    return normalizeResponse({
        status: statusForErrorCode(canonicalRuntimeErrorCode(code)),
        headers: outHeaders,
        cookies: [],
        body: serializeHTTPErrorBody(format, canonicalHTTPErrorFields(format, code, message)),
        isBase64: false,
    });
}
export function errorResponseWithRequestId(code, message, headers = {}, requestId = "") {
    return errorResponseWithRequestIdAndFormat(HTTP_ERROR_FORMAT_NESTED, code, message, headers, requestId);
}
export function errorResponseWithRequestIdAndFormat(format, code, message, headers = {}, requestId = "") {
    return errorResponseWithRequestIdTraceIdAndFormat(format, code, message, headers, requestId, "");
}
export function errorResponseWithRequestIdTraceIdAndFormat(format, code, message, headers = {}, requestId = "", traceId = "") {
    const outHeaders = { ...canonicalizeHeaders(headers) };
    outHeaders["content-type"] = ["application/json; charset=utf-8"];
    const canonical = canonicalHTTPErrorFields(format, code, message);
    const error = {
        code: canonical.code,
        message: canonical.message,
    };
    if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY &&
        requestId) {
        error["request_id"] = String(requestId);
    }
    if (normalizeHTTPErrorFormat(format) !== HTTP_ERROR_FORMAT_FLAT_LEGACY) {
        const resolvedTraceId = String(traceId ?? "").trim();
        if (resolvedTraceId)
            error["trace_id"] = resolvedTraceId;
    }
    return normalizeResponse({
        status: statusForErrorCode(canonicalRuntimeErrorCode(code)),
        headers: outHeaders,
        cookies: [],
        body: serializeHTTPErrorBody(format, error),
        isBase64: false,
    });
}
export function responseForError(err) {
    return responseForErrorWithFormat(HTTP_ERROR_FORMAT_NESTED, err);
}
export function responseForErrorWithFormat(format, err) {
    if (err instanceof AppTheoryError) {
        return errorResponseFromAppTheoryErrorWithFormat(format, err);
    }
    if (err instanceof AppError) {
        return errorResponseWithFormat(format, err.code, err.message);
    }
    return errorResponseWithFormat(format, "app.internal", "internal error");
}
export function responseForErrorWithRequestId(err, requestId) {
    return responseForErrorWithRequestIdAndFormat(HTTP_ERROR_FORMAT_NESTED, err, requestId);
}
export function responseForErrorWithRequestIdAndFormat(format, err, requestId) {
    return responseForErrorWithRequestIdTraceIdAndFormat(format, err, requestId, "");
}
export function responseForErrorWithRequestIdTraceIdAndFormat(format, err, requestId, traceId) {
    if (err instanceof AppTheoryError) {
        return errorResponseFromAppTheoryErrorWithFormat(format, err, {}, requestId, traceId);
    }
    if (err instanceof AppError) {
        return errorResponseWithRequestIdTraceIdAndFormat(format, err.code, err.message, {}, requestId, traceId);
    }
    return errorResponseWithRequestIdTraceIdAndFormat(format, "app.internal", "internal error", {}, requestId, traceId);
}
//# sourceMappingURL=response.js.map