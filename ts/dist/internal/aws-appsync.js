import { Buffer } from "node:buffer";
import { AppSyncContext } from "../context.js";
import { AppError, AppTheoryError } from "../errors.js";
import { firstHeaderValue } from "./http.js";
import { hasJSONContentType, normalizeResponse } from "./response.js";
export const APPSYNC_PROJECTION_MESSAGE = "unsupported appsync response";
export const APPSYNC_PROJECTION_BINARY_REASON = "binary_body_unsupported";
export const APPSYNC_PROJECTION_STREAM_REASON = "streaming_body_unsupported";
export const APPSYNC_ERROR_TYPE_CLIENT = "CLIENT_ERROR";
export const APPSYNC_ERROR_TYPE_SYSTEM = "SYSTEM_ERROR";
function appSyncMethod(parentTypeName) {
    const parent = String(parentTypeName ?? "").trim();
    if (parent === "Query" || parent === "Subscription") {
        return "GET";
    }
    return "POST";
}
export function isAppSyncResolverEvent(event) {
    if (!event || typeof event !== "object") {
        return false;
    }
    const record = event;
    if (!("arguments" in record)) {
        return false;
    }
    const info = record["info"];
    if (!info || typeof info !== "object" || Array.isArray(info)) {
        return false;
    }
    const infoRecord = info;
    const fieldName = String(infoRecord["fieldName"] ?? "").trim();
    const parentTypeName = String(infoRecord["parentTypeName"] ?? "").trim();
    return Boolean(fieldName && parentTypeName);
}
export function requestFromAppSync(event) {
    const fieldName = String(event?.info?.fieldName ?? "").trim();
    const parentTypeName = String(event?.info?.parentTypeName ?? "").trim();
    if (!fieldName || !parentTypeName) {
        throw new AppError("app.bad_request", "invalid appsync event");
    }
    const headers = {};
    const rawHeaders = event?.request?.headers && typeof event.request.headers === "object"
        ? event.request.headers
        : {};
    for (const [key, value] of Object.entries(rawHeaders)) {
        const name = String(key).trim();
        if (!name)
            continue;
        headers[name] = [String(value)];
    }
    if (!headers["content-type"]) {
        headers["content-type"] = ["application/json; charset=utf-8"];
    }
    let body = Buffer.alloc(0);
    const args = event?.arguments;
    if (args &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length > 0) {
        let serialized;
        try {
            serialized = JSON.stringify(args);
        }
        catch {
            throw new AppError("app.bad_request", "invalid appsync event");
        }
        body = Buffer.from(serialized, "utf8");
    }
    return {
        method: appSyncMethod(parentTypeName),
        path: `/${fieldName}`,
        headers,
        body,
        isBase64: false,
    };
}
export function applyAppSyncContextValues(requestCtx, event) {
    requestCtx.set("apptheory.trigger_type", "appsync");
    requestCtx.set("apptheory.appsync.field_name", event.info.fieldName);
    requestCtx.set("apptheory.appsync.parent_type_name", event.info.parentTypeName);
    requestCtx.set("apptheory.appsync.arguments", event.arguments ?? {});
    requestCtx.set("apptheory.appsync.identity", event.identity ?? {});
    requestCtx.set("apptheory.appsync.source", event.source ?? {});
    requestCtx.set("apptheory.appsync.variables", event.info.variables ?? {});
    requestCtx.set("apptheory.appsync.prev", event.prev ?? null);
    requestCtx.set("apptheory.appsync.stash", event.stash ?? {});
    requestCtx.set("apptheory.appsync.request_headers", event.request?.headers ?? {});
    requestCtx.set("apptheory.appsync.raw_event", event);
}
export function createAppSyncContext(event) {
    return new AppSyncContext({
        fieldName: event.info.fieldName,
        parentTypeName: event.info.parentTypeName,
        arguments: event.arguments && typeof event.arguments === "object"
            ? { ...event.arguments }
            : {},
        identity: event.identity && typeof event.identity === "object"
            ? { ...event.identity }
            : {},
        source: event.source && typeof event.source === "object"
            ? { ...event.source }
            : {},
        variables: event.info.variables && typeof event.info.variables === "object"
            ? { ...event.info.variables }
            : {},
        stash: event.stash && typeof event.stash === "object" ? { ...event.stash } : {},
        prev: event.prev ?? null,
        requestHeaders: event.request?.headers && typeof event.request.headers === "object"
            ? { ...event.request.headers }
            : {},
        rawEvent: event,
    });
}
export function appSyncPayloadFromResponse(response) {
    const normalized = normalizeResponse(response);
    if (normalized.isBase64) {
        throw new AppTheoryError("app.internal", APPSYNC_PROJECTION_MESSAGE, {
            statusCode: 500,
            details: { reason: APPSYNC_PROJECTION_BINARY_REASON },
        });
    }
    if (normalized.bodyStream) {
        throw new AppTheoryError("app.internal", APPSYNC_PROJECTION_MESSAGE, {
            statusCode: 500,
            details: { reason: APPSYNC_PROJECTION_STREAM_REASON },
        });
    }
    if (normalized.body.length === 0) {
        return null;
    }
    if (hasJSONContentType(normalized.headers)) {
        try {
            return JSON.parse(normalized.body.toString("utf8"));
        }
        catch {
            throw new AppError("app.internal", "internal error");
        }
    }
    const contentType = firstHeaderValue(normalized.headers, "content-type")
        .trim()
        .toLowerCase();
    if (contentType.startsWith("text/")) {
        return normalized.body.toString("utf8");
    }
    return normalized.body.toString("utf8");
}
function statusForErrorCode(code) {
    switch (String(code ?? "").trim()) {
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
function appSyncErrorTypeForStatus(status) {
    return status >= 400 && status < 500
        ? APPSYNC_ERROR_TYPE_CLIENT
        : APPSYNC_ERROR_TYPE_SYSTEM;
}
function appSyncStatusForError(err) {
    if (err instanceof AppTheoryError) {
        return typeof err.statusCode === "number" && err.statusCode > 0
            ? err.statusCode
            : statusForErrorCode(String(err.code ?? "").trim() || "app.internal");
    }
    if (err instanceof AppError) {
        return statusForErrorCode(err.code);
    }
    return 500;
}
export function appSyncRequestFromEvent(event) {
    const fieldName = String(event?.info?.fieldName ?? "").trim();
    const parentTypeName = String(event?.info?.parentTypeName ?? "").trim();
    if (!fieldName || !parentTypeName) {
        return {
            method: "",
            path: "/",
            headers: {},
            body: Buffer.alloc(0),
            isBase64: false,
        };
    }
    return {
        method: appSyncMethod(parentTypeName),
        path: `/${fieldName}`,
        headers: {},
        body: Buffer.alloc(0),
        isBase64: false,
    };
}
export function appSyncRequestIdFromContext(ctx) {
    return ctx &&
        typeof ctx === "object" &&
        typeof ctx["awsRequestId"] === "string"
        ? String(ctx["awsRequestId"]).trim()
        : "";
}
export function appSyncRequestIdFromResponse(response, fallbackRequestId) {
    return (firstHeaderValue(normalizeResponse(response).headers, "x-request-id").trim() || String(fallbackRequestId ?? "").trim());
}
function appSyncPortableErrorPayload(code, message, status, details, requestId, traceId, timestamp, request) {
    const resolvedCode = String(code ?? "").trim() || "app.internal";
    const resolvedStatus = Number.isFinite(status) && status > 0
        ? Math.floor(status)
        : statusForErrorCode(resolvedCode);
    const errorData = {
        status_code: resolvedStatus,
    };
    const resolvedRequestId = String(requestId ?? "").trim();
    if (resolvedRequestId) {
        errorData["request_id"] = resolvedRequestId;
    }
    const resolvedTraceId = String(traceId ?? "").trim();
    if (resolvedTraceId) {
        errorData["trace_id"] = resolvedTraceId;
    }
    const resolvedTimestamp = String(timestamp ?? "").trim();
    if (resolvedTimestamp) {
        errorData["timestamp"] = resolvedTimestamp;
    }
    const errorInfo = {
        code: resolvedCode,
        trigger_type: "appsync",
    };
    const method = String(request?.method ?? "").trim();
    if (method) {
        errorInfo["method"] = method;
    }
    const path = String(request?.path ?? "").trim();
    if (path) {
        errorInfo["path"] = path;
    }
    if (details && Object.keys(details).length > 0) {
        errorInfo["details"] = { ...details };
    }
    return {
        pay_theory_error: true,
        error_message: String(message ?? ""),
        error_type: appSyncErrorTypeForStatus(resolvedStatus),
        error_data: errorData,
        error_info: errorInfo,
    };
}
export function appSyncErrorPayload(err, request, requestId) {
    if (err instanceof AppTheoryError) {
        return appSyncPortableErrorPayload(err.code, err.message, typeof err.statusCode === "number" && err.statusCode > 0
            ? err.statusCode
            : statusForErrorCode(err.code), err.details, String(err.requestId ?? "").trim() || String(requestId ?? "").trim(), String(err.traceId ?? "").trim(), String(err.timestamp ?? "").trim(), request);
    }
    if (err instanceof AppError) {
        return appSyncPortableErrorPayload(err.code, err.message, statusForErrorCode(err.code), undefined, String(requestId ?? "").trim(), "", "", request);
    }
    return {
        pay_theory_error: true,
        error_message: "internal error",
        error_type: APPSYNC_ERROR_TYPE_SYSTEM,
        error_data: {},
        error_info: {},
    };
}
export function appSyncErrorResponse(err, request, requestId) {
    let body;
    try {
        body = Buffer.from(JSON.stringify(appSyncErrorPayload(err, request, requestId)), "utf8");
    }
    catch {
        body = Buffer.from(JSON.stringify({
            pay_theory_error: true,
            error_message: "internal error",
            error_type: APPSYNC_ERROR_TYPE_SYSTEM,
            error_data: {},
            error_info: {},
        }), "utf8");
    }
    return normalizeResponse({
        status: appSyncStatusForError(err),
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body,
        isBase64: false,
    });
}
