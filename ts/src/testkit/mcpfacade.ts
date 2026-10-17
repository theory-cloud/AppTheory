import { Buffer } from "node:buffer";

import type { App, SecureApp } from "../app.js";
import type { Handler } from "../context.js";
import {
  insufficientScopeWWWAuthenticate,
  protectedResourceWWWAuthenticate,
} from "../oauth/index.js";
import type { Headers, Request, Response } from "../types.js";

const ERROR_PREFIX = "mcpfacade:";

/**
 * The one entry point the transport assertions drive. Both the legacy `App` and
 * the closed-by-default `SecureApp` expose the same `serve`, so one
 * implementation covers either topology and the two surfaces cannot drift.
 */
interface TransportSurface {
  serve(request: Request, ctx?: unknown): Promise<Response>;
}

/**
 * A counting MCP transport handler plus the number of requests that reached it.
 */
export interface CountingTransportHandler {
  /** The apptheory handler to mount on the transport routes. */
  readonly handler: Handler;
  /** How many requests reached the handler. */
  invocations(): number;
}

/**
 * Creates a counting MCP transport handler that answers 204 No Content, so a
 * test can prove whether a denied request reached the application handler.
 */
export function countingTransportHandler(): CountingTransportHandler {
  let count = 0;
  return {
    handler: () => {
      count += 1;
      return {
        status: 204,
        headers: {},
        cookies: [],
        body: Buffer.alloc(0),
        isBase64: false,
      };
    },
    invocations: () => count,
  };
}

/**
 * Drives a credential-free request to method path and asserts the RFC 9728
 * denial: HTTP 401, the exact WWW-Authenticate challenge for
 * resourceMetadataURL, and no invocation of the application handler.
 */
export async function assertCredentialFreeTransportDenied(
  app: App,
  method: string,
  path: string,
  resourceMetadataURL: string,
  handler: CountingTransportHandler,
): Promise<void> {
  return assertCredentialFreeTransportDeniedOn(
    app,
    method,
    path,
    resourceMetadataURL,
    handler,
  );
}

/**
 * {@link assertCredentialFreeTransportDenied} on a closed-by-default
 * {@link SecureApp}, so a consumer that runs its route families on a SecureApp
 * proves the same RFC 9728 denial without dropping to a plain app.
 */
export async function assertCredentialFreeTransportDeniedSecureApp(
  secureApp: SecureApp,
  method: string,
  path: string,
  resourceMetadataURL: string,
  handler: CountingTransportHandler,
): Promise<void> {
  return assertCredentialFreeTransportDeniedOn(
    secureApp,
    method,
    path,
    resourceMetadataURL,
    handler,
  );
}

async function assertCredentialFreeTransportDeniedOn(
  surface: TransportSurface,
  method: string,
  path: string,
  resourceMetadataURL: string,
  handler: CountingTransportHandler,
): Promise<void> {
  const response = await surface.serve(transportRequest(method, path));
  assertFacade(
    response.status === 401,
    `credential-free ${method} ${path}: status = ${response.status}, want 401`,
  );
  const expected = protectedResourceWWWAuthenticate(resourceMetadataURL);
  const actual = firstHeader(response.headers, "www-authenticate");
  assertFacade(
    actual === expected,
    `credential-free ${method} ${path}: www-authenticate = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
  const invocations = handler.invocations();
  assertFacade(
    invocations === 0,
    `credential-free ${method} ${path}: MCP handler invoked ${invocations} times, want 0`,
  );
}

/**
 * Drives a request carrying a token the route scope map rejects to method path
 * and asserts the RFC 6750 insufficient_scope denial: HTTP 403, the exact
 * WWW-Authenticate challenge for the remediation scopes and
 * resourceMetadataURL, the `app.insufficient_scope` body error code, and no
 * invocation of the application handler.
 */
export async function assertInsufficientScopeTransportDenied(
  app: App,
  method: string,
  path: string,
  token: string,
  resourceMetadataURL: string,
  scopes: string[],
  handler: CountingTransportHandler,
): Promise<void> {
  return assertInsufficientScopeTransportDeniedOn(
    app,
    method,
    path,
    token,
    resourceMetadataURL,
    scopes,
    handler,
  );
}

/**
 * {@link assertInsufficientScopeTransportDenied} on a closed-by-default
 * {@link SecureApp}.
 */
export async function assertInsufficientScopeTransportDeniedSecureApp(
  secureApp: SecureApp,
  method: string,
  path: string,
  token: string,
  resourceMetadataURL: string,
  scopes: string[],
  handler: CountingTransportHandler,
): Promise<void> {
  return assertInsufficientScopeTransportDeniedOn(
    secureApp,
    method,
    path,
    token,
    resourceMetadataURL,
    scopes,
    handler,
  );
}

async function assertInsufficientScopeTransportDeniedOn(
  surface: TransportSurface,
  method: string,
  path: string,
  token: string,
  resourceMetadataURL: string,
  scopes: string[],
  handler: CountingTransportHandler,
): Promise<void> {
  const before = handler.invocations();
  const response = await surface.serve(
    transportRequest(method, path, { authorization: [`Bearer ${token}`] }),
  );
  assertFacade(
    response.status === 403,
    `insufficient-scope ${method} ${path}: status = ${response.status}, want 403`,
  );
  const expected = insufficientScopeWWWAuthenticate(
    scopes,
    resourceMetadataURL,
  );
  const actual = firstHeader(response.headers, "www-authenticate");
  assertFacade(
    actual === expected,
    `insufficient-scope ${method} ${path}: www-authenticate = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
  const code = bodyErrorCode(response.body);
  assertFacade(
    code === "app.insufficient_scope",
    `insufficient-scope ${method} ${path}: body error code = ${JSON.stringify(code)}, want "app.insufficient_scope"`,
  );
  const invocations = handler.invocations();
  assertFacade(
    invocations === before,
    `insufficient-scope ${method} ${path}: MCP handler invoked ${invocations - before} additional times, want 0`,
  );
}

/**
 * The positive control for {@link assertCredentialFreeTransportDenied}: a
 * request carrying token reaches the handler exactly once, proving the denial
 * is not "always deny".
 */
export async function assertBearerTokenReachesTransportHandler(
  app: App,
  method: string,
  path: string,
  token: string,
  handler: CountingTransportHandler,
): Promise<void> {
  return assertBearerTokenReachesTransportHandlerOn(
    app,
    method,
    path,
    token,
    handler,
  );
}

/**
 * {@link assertBearerTokenReachesTransportHandler} on a closed-by-default
 * {@link SecureApp}, the positive control for
 * {@link assertCredentialFreeTransportDeniedSecureApp}.
 */
export async function assertBearerTokenReachesTransportHandlerSecureApp(
  secureApp: SecureApp,
  method: string,
  path: string,
  token: string,
  handler: CountingTransportHandler,
): Promise<void> {
  return assertBearerTokenReachesTransportHandlerOn(
    secureApp,
    method,
    path,
    token,
    handler,
  );
}

async function assertBearerTokenReachesTransportHandlerOn(
  surface: TransportSurface,
  method: string,
  path: string,
  token: string,
  handler: CountingTransportHandler,
): Promise<void> {
  const before = handler.invocations();
  const response = await surface.serve(
    transportRequest(method, path, { authorization: [`Bearer ${token}`] }),
  );
  assertFacade(
    response.status === 204,
    `bearer ${method} ${path}: status = ${response.status}, want 204`,
  );
  const invocations = handler.invocations();
  assertFacade(
    invocations === before + 1,
    `bearer ${method} ${path}: MCP handler invocations = ${invocations}, want ${before + 1}`,
  );
}

function transportRequest(
  method: string,
  path: string,
  headers: Headers = {},
): Request {
  return {
    method,
    path,
    headers,
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function firstHeader(headers: Headers, name: string): string {
  const key = name.toLowerCase();
  for (const [rawKey, values] of Object.entries(headers ?? {})) {
    if (rawKey.toLowerCase() !== key) {
      continue;
    }
    return String(values?.[0] ?? "");
  }
  return "";
}

function assertFacade(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`${ERROR_PREFIX} ${message}`);
  }
}

/** Reads the `error.code` field of an AppTheory error body, or "" when absent. */
function bodyErrorCode(body: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return "";
    }
    const error = (parsed as { error?: unknown }).error;
    if (error === null || typeof error !== "object") {
      return "";
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}
