import { Buffer } from "node:buffer";
import { AppError } from "../errors.js";
import { firstHeaderValue } from "./http.js";
import { hasJSONContentType, normalizeResponse } from "./response.js";
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
export function appSyncPayloadFromResponse(response) {
    const normalized = normalizeResponse(response);
    if (normalized.bodyStream || normalized.isBase64) {
        throw new AppError("app.internal", "internal error");
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
