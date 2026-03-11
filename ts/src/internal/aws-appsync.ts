import { Buffer } from "node:buffer";

import type { AppSyncResolverEvent } from "../aws-types.js";
import { AppSyncContext } from "../context.js";
import { AppError, AppTheoryError } from "../errors.js";
import type { Context } from "../context.js";
import type { Request, Response } from "../types.js";

import { firstHeaderValue } from "./http.js";
import { hasJSONContentType, normalizeResponse } from "./response.js";

export const APPSYNC_PROJECTION_MESSAGE = "unsupported appsync response";
export const APPSYNC_PROJECTION_BINARY_REASON = "binary_body_unsupported";
export const APPSYNC_PROJECTION_STREAM_REASON = "streaming_body_unsupported";

function appSyncMethod(parentTypeName: unknown): string {
  const parent = String(parentTypeName ?? "").trim();
  if (parent === "Query" || parent === "Subscription") {
    return "GET";
  }
  return "POST";
}

export function isAppSyncResolverEvent(
  event: unknown,
): event is AppSyncResolverEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  if (!("arguments" in record)) {
    return false;
  }

  const info = record["info"];
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return false;
  }

  const infoRecord = info as Record<string, unknown>;
  const fieldName = String(infoRecord["fieldName"] ?? "").trim();
  const parentTypeName = String(infoRecord["parentTypeName"] ?? "").trim();
  return Boolean(fieldName && parentTypeName);
}

export function requestFromAppSync(event: AppSyncResolverEvent): Request {
  const fieldName = String(event?.info?.fieldName ?? "").trim();
  const parentTypeName = String(event?.info?.parentTypeName ?? "").trim();
  if (!fieldName || !parentTypeName) {
    throw new AppError("app.bad_request", "invalid appsync event");
  }

  const headers: Request["headers"] = {};
  const rawHeaders =
    event?.request?.headers && typeof event.request.headers === "object"
      ? event.request.headers
      : {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const name = String(key).trim();
    if (!name) continue;
    headers[name] = [String(value)];
  }
  if (!headers["content-type"]) {
    headers["content-type"] = ["application/json; charset=utf-8"];
  }

  let body = Buffer.alloc(0);
  const args = event?.arguments;
  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length > 0
  ) {
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
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

export function applyAppSyncContextValues(
  requestCtx: Context,
  event: AppSyncResolverEvent,
): void {
  requestCtx.set("apptheory.trigger_type", "appsync");
  requestCtx.set("apptheory.appsync.field_name", event.info.fieldName);
  requestCtx.set(
    "apptheory.appsync.parent_type_name",
    event.info.parentTypeName,
  );
  requestCtx.set("apptheory.appsync.arguments", event.arguments ?? {});
  requestCtx.set("apptheory.appsync.identity", event.identity ?? {});
  requestCtx.set("apptheory.appsync.source", event.source ?? {});
  requestCtx.set("apptheory.appsync.variables", event.info.variables ?? {});
  requestCtx.set("apptheory.appsync.prev", event.prev ?? null);
  requestCtx.set("apptheory.appsync.stash", event.stash ?? {});
  requestCtx.set(
    "apptheory.appsync.request_headers",
    event.request?.headers ?? {},
  );
  requestCtx.set("apptheory.appsync.raw_event", event);
}

export function createAppSyncContext(
  event: AppSyncResolverEvent,
): AppSyncContext {
  return new AppSyncContext({
    fieldName: event.info.fieldName,
    parentTypeName: event.info.parentTypeName,
    arguments:
      event.arguments && typeof event.arguments === "object"
        ? { ...event.arguments }
        : {},
    identity:
      event.identity && typeof event.identity === "object"
        ? { ...event.identity }
        : {},
    source:
      event.source && typeof event.source === "object"
        ? { ...event.source }
        : {},
    variables:
      event.info.variables && typeof event.info.variables === "object"
        ? { ...event.info.variables }
        : {},
    stash:
      event.stash && typeof event.stash === "object" ? { ...event.stash } : {},
    prev: event.prev ?? null,
    requestHeaders:
      event.request?.headers && typeof event.request.headers === "object"
        ? { ...event.request.headers }
        : {},
    rawEvent: event,
  });
}

export function appSyncPayloadFromResponse(response: Response): unknown {
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
      return JSON.parse(normalized.body.toString("utf8")) as unknown;
    } catch {
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
