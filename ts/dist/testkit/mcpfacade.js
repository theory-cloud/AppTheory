import { Buffer } from "node:buffer";
import { insufficientScopeWWWAuthenticate, protectedResourceWWWAuthenticate, } from "../oauth/index.js";
const ERROR_PREFIX = "mcpfacade:";
/**
 * Creates a counting MCP transport handler that answers 204 No Content, so a
 * test can prove whether a denied request reached the application handler.
 */
export function countingTransportHandler() {
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
export async function assertCredentialFreeTransportDenied(app, method, path, resourceMetadataURL, handler) {
    const response = await app.serve(transportRequest(method, path));
    assertFacade(response.status === 401, `credential-free ${method} ${path}: status = ${response.status}, want 401`);
    const expected = protectedResourceWWWAuthenticate(resourceMetadataURL);
    const actual = firstHeader(response.headers, "www-authenticate");
    assertFacade(actual === expected, `credential-free ${method} ${path}: www-authenticate = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    const invocations = handler.invocations();
    assertFacade(invocations === 0, `credential-free ${method} ${path}: MCP handler invoked ${invocations} times, want 0`);
}
/**
 * Drives a request carrying a token the route scope map rejects to method path
 * and asserts the RFC 6750 insufficient_scope denial: HTTP 403, the exact
 * WWW-Authenticate challenge for the remediation scopes and
 * resourceMetadataURL, the `app.insufficient_scope` body error code, and no
 * invocation of the application handler.
 */
export async function assertInsufficientScopeTransportDenied(app, method, path, token, resourceMetadataURL, scopes, handler) {
    const response = await app.serve(transportRequest(method, path, { authorization: [`Bearer ${token}`] }));
    assertFacade(response.status === 403, `insufficient-scope ${method} ${path}: status = ${response.status}, want 403`);
    const expected = insufficientScopeWWWAuthenticate(scopes, resourceMetadataURL);
    const actual = firstHeader(response.headers, "www-authenticate");
    assertFacade(actual === expected, `insufficient-scope ${method} ${path}: www-authenticate = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    const code = bodyErrorCode(response.body);
    assertFacade(code === "app.insufficient_scope", `insufficient-scope ${method} ${path}: body error code = ${JSON.stringify(code)}, want "app.insufficient_scope"`);
    const invocations = handler.invocations();
    assertFacade(invocations === 0, `insufficient-scope ${method} ${path}: MCP handler invoked ${invocations} times, want 0`);
}
/**
 * The positive control for {@link assertCredentialFreeTransportDenied}: a
 * request carrying token reaches the handler exactly once, proving the denial
 * is not "always deny".
 */
export async function assertBearerTokenReachesTransportHandler(app, method, path, token, handler) {
    const before = handler.invocations();
    const response = await app.serve(transportRequest(method, path, { authorization: [`Bearer ${token}`] }));
    assertFacade(response.status === 204, `bearer ${method} ${path}: status = ${response.status}, want 204`);
    const invocations = handler.invocations();
    assertFacade(invocations === before + 1, `bearer ${method} ${path}: MCP handler invocations = ${invocations}, want ${before + 1}`);
}
function transportRequest(method, path, headers = {}) {
    return {
        method,
        path,
        headers,
        query: {},
        body: Buffer.alloc(0),
        isBase64: false,
    };
}
function firstHeader(headers, name) {
    const key = name.toLowerCase();
    for (const [rawKey, values] of Object.entries(headers ?? {})) {
        if (rawKey.toLowerCase() !== key) {
            continue;
        }
        return String(values?.[0] ?? "");
    }
    return "";
}
function assertFacade(condition, message) {
    if (!condition) {
        throw new Error(`${ERROR_PREFIX} ${message}`);
    }
}
/** Reads the `error.code` field of an AppTheory error body, or "" when absent. */
function bodyErrorCode(body) {
    try {
        const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
        if (parsed === null || typeof parsed !== "object") {
            return "";
        }
        const error = parsed.error;
        if (error === null || typeof error !== "object") {
            return "";
        }
        const code = error.code;
        return typeof code === "string" ? code : "";
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=mcpfacade.js.map