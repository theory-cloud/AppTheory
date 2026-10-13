import type { App } from "./app.js";
import type { Handler } from "./context.js";
import { type RequireBearerTokenOptions } from "./oauth/index.js";
/**
 * Transport posture for the MCP transport routes.
 *
 * `iam` and `jwt` are enforced by the gateway; `runtime-bearer` validates an
 * RFC 9728 bearer token in the runtime; `none-public` is the explicit public
 * posture and is never a default.
 */
export type McpTransportPosture = "iam" | "jwt" | "runtime-bearer" | "none-public";
export interface RegisterMcpFacadeOptions {
    /** MCP transport paths; each is registered for POST, GET and DELETE. */
    readonly mcpPaths: string[];
    /** The application's MCP transport handler. */
    readonly mcpHandler: Handler;
    /** @default "iam" */
    readonly transportPosture?: McpTransportPosture;
    /** Required when transportPosture is "runtime-bearer"; refused under every other posture. */
    readonly requireBearerToken?: RequireBearerTokenOptions;
}
export interface McpFacadeRegistration {
    readonly transportPosture: McpTransportPosture;
    readonly transportPaths: string[];
}
/**
 * Registers the MCP transport routes with a resolved transport posture.
 *
 * Registration fails closed before any route is added: an unknown posture is
 * refused, `runtime-bearer` requires a bearer assertion, and a bearer assertion
 * is refused under `iam`, `jwt` and `none-public`.
 */
export declare function registerMcpFacade(app: App, options: RegisterMcpFacadeOptions): McpFacadeRegistration;
//# sourceMappingURL=mcpfacade.d.ts.map