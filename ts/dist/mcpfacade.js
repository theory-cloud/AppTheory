import { requireBearerTokenMiddleware, } from "./oauth/index.js";
const TRANSPORT_POSTURES = [
    "iam",
    "jwt",
    "runtime-bearer",
    "none-public",
];
const ERROR_PREFIX = "AppTheoryMcpFacade:";
/**
 * Registers the MCP transport routes with a resolved transport posture.
 *
 * Registration fails closed before any route is added: an unknown posture is
 * refused, `runtime-bearer` requires a bearer assertion, and a bearer assertion
 * is refused under `iam`, `jwt` and `none-public`.
 */
export function registerMcpFacade(app, options) {
    const transportPaths = validateMcpPaths(options.mcpPaths);
    const transportPosture = resolveTransportPosture(options.transportPosture, options.requireBearerToken);
    const mcpHandler = transportPosture === "runtime-bearer"
        ? wrapWithBearerAssertion(options.requireBearerToken, options.mcpHandler)
        : options.mcpHandler;
    for (const path of transportPaths) {
        app.post(path, mcpHandler);
        app.get(path, mcpHandler);
        app.delete(path, mcpHandler);
    }
    return { transportPosture, transportPaths: [...transportPaths] };
}
function wrapWithBearerAssertion(requireBearerToken, handler) {
    const middleware = requireBearerTokenMiddleware(requireBearerToken);
    return (ctx) => middleware(ctx, handler);
}
function validateMcpPaths(mcpPaths) {
    if (!Array.isArray(mcpPaths) || mcpPaths.length === 0) {
        throw new Error(`${ERROR_PREFIX} mcpPaths must be a non-empty array`);
    }
    return mcpPaths.map((path) => {
        const value = typeof path === "string" ? path.trim() : "";
        if (!value || !value.startsWith("/")) {
            throw new Error(`${ERROR_PREFIX} mcpPaths entries must be non-empty absolute paths`);
        }
        return value;
    });
}
function resolveTransportPosture(posture, requireBearerToken) {
    const resolved = posture ?? "iam";
    if (!TRANSPORT_POSTURES.includes(resolved)) {
        throw new Error(`${ERROR_PREFIX} transportPosture must be one of iam, jwt, runtime-bearer, none-public`);
    }
    if (resolved === "runtime-bearer") {
        if (!requireBearerToken) {
            throw new Error(`${ERROR_PREFIX} transportPosture runtime-bearer requires requireBearerToken`);
        }
        return resolved;
    }
    if (requireBearerToken) {
        if (resolved === "none-public") {
            throw new Error(`${ERROR_PREFIX} transportPosture none-public cannot be combined with requireBearerToken`);
        }
        throw new Error(`${ERROR_PREFIX} requireBearerToken is only valid with transportPosture runtime-bearer`);
    }
    return resolved;
}
//# sourceMappingURL=mcpfacade.js.map