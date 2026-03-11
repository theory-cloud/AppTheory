import { Buffer } from "node:buffer";

import type { AppSyncResolverEvent } from "../aws-types.js";
import { AppError } from "../errors.js";
import type { Request, Response } from "../types.js";

import { firstHeaderValue } from "./http.js";
import { hasJSONContentType, normalizeResponse } from "./response.js";

function appSyncMethod(parentTypeName: unknown): string {
  const parent = String(parentTypeName ?? "").trim();
  if (parent === "Query" || parent === "Subscription") {
    return "GET";
  }
  return "POST";
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

export function appSyncPayloadFromResponse(response: Response): unknown {
  const normalized = normalizeResponse(response);
  if (normalized.bodyStream || normalized.isBase64) {
    throw new AppError("app.internal", "internal error");
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
