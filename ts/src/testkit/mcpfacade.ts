import { Buffer } from "node:buffer";

import type { App } from "../app.js";
import type { Handler } from "../context.js";
import { protectedResourceWWWAuthenticate } from "../oauth/index.js";
import type { Headers, Request } from "../types.js";

const ERROR_PREFIX = "mcpfacade:";

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
  const response = await app.serve(transportRequest(method, path));
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
  const before = handler.invocations();
  const response = await app.serve(
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
