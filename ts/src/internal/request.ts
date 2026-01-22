import { Buffer } from "node:buffer";

import { AppError } from "../errors.js";
import type { Request } from "../types.js";

import {
  canonicalizeHeaders,
  cloneQuery,
  normalizeMethod,
  normalizePath,
  parseCookies,
  toBuffer,
} from "./http.js";

export interface NormalizedRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string[]>;
  cookies: Record<string, string>;
  body: Buffer;
  isBase64: boolean;
}

function isValidBase64String(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  if (/[^A-Za-z0-9+/=]/.test(value)) return false;

  const firstPad = value.indexOf("=");
  if (firstPad === -1) return true;

  const padLen = value.length - firstPad;
  if (padLen > 2) return false;
  for (let i = firstPad; i < value.length; i += 1) {
    if (value[i] !== "=") return false;
  }
  return true;
}

export function normalizeRequest(request: Request): NormalizedRequest {
  const method = normalizeMethod(request.method);
  const path = normalizePath(request.path);
  const query = cloneQuery(request.query);
  const headers = canonicalizeHeaders(request.headers);

  const rawBody = toBuffer(request.body);
  const isBase64 = Boolean(request.isBase64);
  let body: Buffer;
  if (isBase64) {
    const asString = rawBody.toString("utf8");
    if (!isValidBase64String(asString)) {
      throw new AppError("app.bad_request", "invalid base64");
    }
    body = Buffer.from(asString, "base64");
  } else {
    body = rawBody;
  }

  const cookies = parseCookies(headers["cookie"]);
  return { method, path, query, headers, cookies, body, isBase64 };
}
