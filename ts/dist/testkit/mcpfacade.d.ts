import type { App, SecureApp } from "../app.js";
import type { Handler } from "../context.js";
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
export declare function countingTransportHandler(): CountingTransportHandler;
/**
 * Drives a credential-free request to method path and asserts the RFC 9728
 * denial: HTTP 401, the exact WWW-Authenticate challenge for
 * resourceMetadataURL, and no invocation of the application handler.
 */
export declare function assertCredentialFreeTransportDenied(app: App, method: string, path: string, resourceMetadataURL: string, handler: CountingTransportHandler): Promise<void>;
/**
 * {@link assertCredentialFreeTransportDenied} on a closed-by-default
 * {@link SecureApp}, so a consumer that runs its route families on a SecureApp
 * proves the same RFC 9728 denial without dropping to a plain app.
 */
export declare function assertCredentialFreeTransportDeniedSecureApp(secureApp: SecureApp, method: string, path: string, resourceMetadataURL: string, handler: CountingTransportHandler): Promise<void>;
/**
 * Drives a request carrying a token the route scope map rejects to method path
 * and asserts the RFC 6750 insufficient_scope denial: HTTP 403, the exact
 * WWW-Authenticate challenge for the remediation scopes and
 * resourceMetadataURL, the `app.insufficient_scope` body error code, and no
 * invocation of the application handler.
 */
export declare function assertInsufficientScopeTransportDenied(app: App, method: string, path: string, token: string, resourceMetadataURL: string, scopes: string[], handler: CountingTransportHandler): Promise<void>;
/**
 * {@link assertInsufficientScopeTransportDenied} on a closed-by-default
 * {@link SecureApp}.
 */
export declare function assertInsufficientScopeTransportDeniedSecureApp(secureApp: SecureApp, method: string, path: string, token: string, resourceMetadataURL: string, scopes: string[], handler: CountingTransportHandler): Promise<void>;
/**
 * The positive control for {@link assertCredentialFreeTransportDenied}: a
 * request carrying token reaches the handler exactly once, proving the denial
 * is not "always deny".
 */
export declare function assertBearerTokenReachesTransportHandler(app: App, method: string, path: string, token: string, handler: CountingTransportHandler): Promise<void>;
/**
 * {@link assertBearerTokenReachesTransportHandler} on a closed-by-default
 * {@link SecureApp}, the positive control for
 * {@link assertCredentialFreeTransportDeniedSecureApp}.
 */
export declare function assertBearerTokenReachesTransportHandlerSecureApp(secureApp: SecureApp, method: string, path: string, token: string, handler: CountingTransportHandler): Promise<void>;
//# sourceMappingURL=mcpfacade.d.ts.map