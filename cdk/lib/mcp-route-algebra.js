"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpRouteAlgebra = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
/**
 * AppTheory's canonical, versioned MCP route-algebra contract.
 *
 * Every OAuth route is derived from the four MCP patterns through the pure
 * functions on this class. Concrete endpoint builders validate the same
 * kind-to-identifier invariants as the Go runtime package.
 */
class AppTheoryMcpRouteAlgebra {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra", version: "6.0.0" };
    /** MCP route-algebra contract version. */
    static CONTRACT_VERSION = "m17.mcp-route-algebra/v2";
    /** Superseded v1 route-algebra contract version, retained for read compatibility. */
    static CONTRACT_VERSION_V1 = "m17.mcp-route-algebra/v1";
    /** Closed issuer-mode vocabulary member: one family-wide issuer for the whole facade. */
    static ISSUER_MODE_FAMILY = "family";
    /** Closed issuer-mode vocabulary member: each route is its own authorization-server issuer. */
    static ISSUER_MODE_ROUTE = "route";
    /** Namespace endpoint kind. */
    static ENDPOINT_KIND_NAMESPACE = "namespace";
    /** Partner-scoped namespace endpoint kind. */
    static ENDPOINT_KIND_PARTNER_NAMESPACE = "partner_namespace";
    /** Agent endpoint kind. */
    static ENDPOINT_KIND_AGENT = "agent";
    /** Partner-scoped agent endpoint kind. */
    static ENDPOINT_KIND_PARTNER_AGENT = "partner_agent";
    /** Canonical namespace MCP route pattern. */
    static NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";
    /** Canonical partner-scoped namespace MCP route pattern. */
    static PARTNER_NAMESPACE_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/mcp";
    /** Canonical agent MCP route pattern. */
    static AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp";
    /** Canonical partner-scoped agent MCP route pattern. */
    static PARTNER_AGENT_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";
    /** RFC 9728 protected-resource metadata prefix. */
    static PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";
    /** RFC 8414 authorization-server metadata prefix. */
    static AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server";
    /**
     * Stage-global upstream OAuth callback path.
     *
     * The callback is correlated by the single-use upstream state the facade
     * minted, so one stage-global route is sufficient and no per-kind callback
     * multiplies.
     */
    static DEFAULT_CALLBACK_PATH = "/_oauth/mcp/callback";
    /** Return the closed issuer-mode vocabulary in contract order. */
    static supportedIssuerModes() {
        return [
            AppTheoryMcpRouteAlgebra.ISSUER_MODE_FAMILY,
            AppTheoryMcpRouteAlgebra.ISSUER_MODE_ROUTE,
        ];
    }
    /** Derive an RFC 9728 protected-resource path from a resource path. */
    static protectedResourcePathForResourcePath(resourcePath) {
        const normalized = normalizePath(resourcePath);
        if (normalized === "/") {
            return AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX;
        }
        return AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX + normalized;
    }
    /** Derive the canonical RFC 8414 discovery path from a resource path. */
    static authorizationServerPathForResourcePath(resourcePath) {
        const normalized = normalizePath(resourcePath);
        if (normalized === "/") {
            return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
        }
        return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX + normalized;
    }
    /** Derive the authorization facade path from a resource path. */
    static authorizationAuthorizePathForResourcePath(resourcePath) {
        return `${AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath)}/authorize`;
    }
    /** Derive the token facade path from a resource path. */
    static authorizationTokenPathForResourcePath(resourcePath) {
        return `${AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath)}/token`;
    }
    /**
     * Derive the RFC 7591 dynamic-client registration facade path from a resource path.
     *
     * The routed discovery document advertises exactly this path as
     * `registration_endpoint`, so the advertised URL and the mounted route
     * cannot drift.
     */
    static authorizationRegisterPathForResourcePath(resourcePath) {
        return `${AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath)}/register`;
    }
    /** Derive the suffix-compatible RFC 8414 discovery path from a resource path. */
    static authorizationServerSuffixPathForResourcePath(resourcePath) {
        const normalized = normalizePath(resourcePath);
        if (normalized === "/") {
            return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
        }
        return normalized + AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
    }
    /** Recover a resource path from an RFC 9728 protected-resource path. */
    static resourcePathFromProtectedResourcePath(protectedResourcePath) {
        const normalized = normalizePath(protectedResourcePath);
        const prefix = AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX;
        if (normalized === prefix) {
            return "/";
        }
        if (!normalized.startsWith(`${prefix}/`)) {
            throw new Error(`mcproutes: unsupported protected resource path ${JSON.stringify(normalized)}`);
        }
        return normalizePath(normalized.slice(prefix.length));
    }
    /** Derive the protected-resource path for an MCP path. */
    static protectedResourcePathFromMcpPath(mcpPath) {
        return AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(mcpPath);
    }
    /** Return every canonical MCP endpoint template in contract order. */
    static supportedEndpointTemplates() {
        return endpointTemplateSeeds().map(({ kind, pattern }) => ({
            kind,
            mcpPattern: pattern,
            protectedResourcePath: AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(pattern),
        }));
    }
    /** Return every canonical OAuth authorization facade template in contract order. */
    static supportedOAuthFacadeTemplates() {
        return endpointTemplateSeeds().map(({ kind, pattern }) => ({
            kind,
            authorizePattern: AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(pattern),
            tokenPattern: AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(pattern),
            registerPattern: AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(pattern),
        }));
    }
    /**
     * Return every stage-global route in contract order.
     *
     * v2 adds exactly one stage-global route: the upstream OAuth callback. The
     * callback path is overridable at runtime (`FacadeConfig.UpstreamCallbackPath`);
     * this returns the contract default.
     */
    static supportedStageGlobalRoutes() {
        return [
            {
                name: "upstream_callback",
                pattern: AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH,
                methods: ["GET"],
            },
        ];
    }
    /**
     * Resolve the effective stage-global callback path for a configured value.
     *
     * An unset (or whitespace-only) value resolves to `DEFAULT_CALLBACK_PATH`;
     * every other value must normalize to a valid absolute callback path.
     */
    static callbackPathForConfiguredPath(configured) {
        const trimmed = trimASCIIWhitespace(configured);
        if (trimmed === "") {
            return AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH;
        }
        return AppTheoryMcpRouteAlgebra.normalizeCallbackPath(trimmed);
    }
    /**
     * Validate and normalize an absolute callback path.
     *
     * The path must be absolute, contain no query or fragment, and must not use a
     * dot segment. It is normalized with the same rules as every other route path.
     */
    static normalizeCallbackPath(rawPath) {
        const trimmed = trimASCIIWhitespace(rawPath);
        if (trimmed === "" || !trimmed.startsWith("/")) {
            throw new Error(`mcproutes: callback path must be absolute ${JSON.stringify(rawPath)}`);
        }
        if (containsRefusedRoutePathBytes(trimmed)) {
            throw new Error(`mcproutes: callback path must not contain a percent-encoded slash, an interior ASCII whitespace or control character, or a backslash ${JSON.stringify(rawPath)}`);
        }
        if (trimmed.includes("?") || trimmed.includes("#")) {
            throw new Error(`mcproutes: callback path must not include a query or fragment ${JSON.stringify(rawPath)}`);
        }
        for (const segment of trimmed.split("/")) {
            if (segment === "." || segment === "..") {
                throw new Error(`mcproutes: callback path must not use dot segments ${JSON.stringify(rawPath)}`);
            }
        }
        return normalizePath(trimmed);
    }
    /** Return every canonical OAuth discovery template in contract order. */
    static supportedOAuthDiscoveryTemplates() {
        return endpointTemplateSeeds().map(({ kind, pattern }) => ({
            kind,
            canonicalPattern: AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(pattern),
            suffixPattern: AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(pattern),
        }));
    }
    /** Parse a concrete MCP path after contract normalization. */
    static parseMcpPath(rawPath) {
        const unnormalizedEndpoint = endpointFromSegments(splitPathBeforeDotNormalization(rawPath));
        if (unnormalizedEndpoint !== undefined) {
            AppTheoryMcpRouteAlgebra.validateEndpointPath(unnormalizedEndpoint);
            return unnormalizedEndpoint;
        }
        const endpoint = endpointFromSegments(splitPath(normalizePath(rawPath)));
        if (endpoint === undefined) {
            throw new Error(`mcproutes: unsupported MCP path ${JSON.stringify(rawPath)}`);
        }
        AppTheoryMcpRouteAlgebra.validateEndpointPath(endpoint);
        return endpoint;
    }
    /** Validate endpoint kind-to-identifier consistency and path-segment safety. */
    static validateEndpointPath(endpoint) {
        if (!isPathSegment(endpoint.clientNamespace)) {
            throw new Error("mcproutes: clientNamespace must be a non-empty path segment");
        }
        const partnerId = endpoint.partnerId ?? "";
        const agentId = endpoint.agentId ?? "";
        switch (endpoint.kind) {
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE:
                if (partnerId !== "" || agentId !== "") {
                    throw new Error("mcproutes: namespace endpoint cannot include partner or agent identifiers");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE:
                if (!isPathSegment(partnerId)) {
                    throw new Error("mcproutes: partnerId must be a non-empty path segment");
                }
                if (agentId !== "") {
                    throw new Error("mcproutes: partner namespace endpoint cannot include agentId");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT:
                if (!isPathSegment(agentId)) {
                    throw new Error("mcproutes: agentId must be a non-empty path segment");
                }
                if (partnerId !== "") {
                    throw new Error("mcproutes: agent endpoint cannot include partnerId");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT:
                if (!isPathSegment(partnerId)) {
                    throw new Error("mcproutes: partnerId must be a non-empty path segment");
                }
                if (!isPathSegment(agentId)) {
                    throw new Error("mcproutes: agentId must be a non-empty path segment");
                }
                return;
            default:
                throw new Error(`mcproutes: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`);
        }
    }
    /** Build the concrete MCP path for an endpoint. */
    static mcpPath(endpoint) {
        AppTheoryMcpRouteAlgebra.validateEndpointPath(endpoint);
        switch (endpoint.kind) {
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE:
                return `/${endpoint.clientNamespace}/mcp`;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE:
                return `/${endpoint.clientNamespace}/partners/${endpoint.partnerId}/mcp`;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT:
                return `/${endpoint.clientNamespace}/agents/${endpoint.agentId}/mcp`;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT:
                return `/${endpoint.clientNamespace}/partners/${endpoint.partnerId}/agents/${endpoint.agentId}/mcp`;
            default:
                throw new Error(`mcproutes: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`);
        }
    }
    /** Build the endpoint's RFC 9728 protected-resource path. */
    static protectedResourcePath(endpoint) {
        return AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
    /** Build the endpoint's canonical RFC 8414 discovery path. */
    static oauthAuthorizationServerPath(endpoint) {
        return AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
    /** Build the endpoint's authorization facade path. */
    static oauthAuthorizePath(endpoint) {
        return AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
    /** Build the endpoint's token facade path. */
    static oauthTokenPath(endpoint) {
        return AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
    /** Build the endpoint's dynamic-client registration path. */
    static oauthRegisterPath(endpoint) {
        return AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
    /** Build the endpoint's suffix-compatible RFC 8414 discovery path. */
    static oauthAuthorizationServerSuffixPath(endpoint) {
        return AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(AppTheoryMcpRouteAlgebra.mcpPath(endpoint));
    }
}
exports.AppTheoryMcpRouteAlgebra = AppTheoryMcpRouteAlgebra;
function endpointTemplateSeeds() {
    return [
        {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE,
            pattern: AppTheoryMcpRouteAlgebra.NAMESPACE_MCP_PATTERN,
        },
        {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
            pattern: AppTheoryMcpRouteAlgebra.PARTNER_NAMESPACE_MCP_PATTERN,
        },
        {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT,
            pattern: AppTheoryMcpRouteAlgebra.AGENT_MCP_PATTERN,
        },
        {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT,
            pattern: AppTheoryMcpRouteAlgebra.PARTNER_AGENT_MCP_PATTERN,
        },
    ];
}
function endpointFromSegments(segments) {
    if (segments.length === 2 && segments[1] === "mcp") {
        return {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE,
            clientNamespace: segments[0],
        };
    }
    if (segments.length === 4 &&
        segments[1] === "partners" &&
        segments[3] === "mcp") {
        return {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
            clientNamespace: segments[0],
            partnerId: segments[2],
        };
    }
    if (segments.length === 4 &&
        segments[1] === "agents" &&
        segments[3] === "mcp") {
        return {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT,
            clientNamespace: segments[0],
            agentId: segments[2],
        };
    }
    if (segments.length === 6 &&
        segments[1] === "partners" &&
        segments[3] === "agents" &&
        segments[5] === "mcp") {
        return {
            kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT,
            clientNamespace: segments[0],
            partnerId: segments[2],
            agentId: segments[4],
        };
    }
    return undefined;
}
function trimASCIIWhitespace(value) {
    let start = 0;
    while (start < value.length &&
        isASCIIWhitespaceCode(value.charCodeAt(start))) {
        start += 1;
    }
    let end = value.length;
    while (end > start && isASCIIWhitespaceCode(value.charCodeAt(end - 1))) {
        end -= 1;
    }
    return value.slice(start, end);
}
function isASCIIWhitespaceCode(code) {
    return (code === 9 ||
        code === 10 ||
        code === 11 ||
        code === 12 ||
        code === 13 ||
        code === 32);
}
function normalizePath(rawPath) {
    let normalized = trimASCIIWhitespace(rawPath);
    if (normalized === "") {
        return "/";
    }
    if (!normalized.startsWith("/")) {
        normalized = `/${normalized}`;
    }
    const segments = [];
    for (const segment of normalized.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
function splitPathBeforeDotNormalization(rawPath) {
    return trimASCIIWhitespace(rawPath)
        .split("/")
        .filter((segment) => segment !== "");
}
function splitPath(normalizedPath) {
    return normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
}
function isPathSegment(value) {
    const trimmed = trimASCIIWhitespace(value);
    return (trimmed !== "" &&
        trimmed !== "." &&
        trimmed !== ".." &&
        !value.includes("/") &&
        !containsRefusedRoutePathBytes(trimmed));
}
// containsRefusedRoutePathBytes reports whether a route path, already trimmed at
// its edges, carries the bytes the route algebra refuses: a percent-encoded
// slash, an interior ASCII whitespace or control character, or a backslash.
function containsRefusedRoutePathBytes(value) {
    if (value.includes("%2F") || value.includes("%2f")) {
        return true;
    }
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x5c || code <= 0x1f || code === 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBa0VBOzs7Ozs7R0FNRztBQUNILE1BQXNCLHdCQUF3Qjs7SUFDNUMsMENBQTBDO0lBQ25DLE1BQU0sQ0FBVSxnQkFBZ0IsR0FBRywwQkFBMEIsQ0FBQztJQUVyRSxxRkFBcUY7SUFDOUUsTUFBTSxDQUFVLG1CQUFtQixHQUFHLDBCQUEwQixDQUFDO0lBRXhFLHlGQUF5RjtJQUNsRixNQUFNLENBQVUsa0JBQWtCLEdBQUcsUUFBUSxDQUFDO0lBRXJELCtGQUErRjtJQUN4RixNQUFNLENBQVUsaUJBQWlCLEdBQUcsT0FBTyxDQUFDO0lBRW5ELCtCQUErQjtJQUN4QixNQUFNLENBQVUsdUJBQXVCLEdBQUcsV0FBVyxDQUFDO0lBRTdELDhDQUE4QztJQUN2QyxNQUFNLENBQVUsK0JBQStCLEdBQUcsbUJBQW1CLENBQUM7SUFFN0UsMkJBQTJCO0lBQ3BCLE1BQU0sQ0FBVSxtQkFBbUIsR0FBRyxPQUFPLENBQUM7SUFFckQsMENBQTBDO0lBQ25DLE1BQU0sQ0FBVSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7SUFFckUsNkNBQTZDO0lBQ3RDLE1BQU0sQ0FBVSxxQkFBcUIsR0FBRyx5QkFBeUIsQ0FBQztJQUV6RSw0REFBNEQ7SUFDckQsTUFBTSxDQUFVLDZCQUE2QixHQUNsRCwrQ0FBK0MsQ0FBQztJQUVsRCx5Q0FBeUM7SUFDbEMsTUFBTSxDQUFVLGlCQUFpQixHQUN0QywyQ0FBMkMsQ0FBQztJQUU5Qyx3REFBd0Q7SUFDakQsTUFBTSxDQUFVLHlCQUF5QixHQUM5QyxpRUFBaUUsQ0FBQztJQUVwRSxtREFBbUQ7SUFDNUMsTUFBTSxDQUFVLHlCQUF5QixHQUM5Qyx1Q0FBdUMsQ0FBQztJQUUxQyxxREFBcUQ7SUFDOUMsTUFBTSxDQUFVLDJCQUEyQixHQUNoRCx5Q0FBeUMsQ0FBQztJQUU1Qzs7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LE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBBIGNvbmNyZXRlIGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgcGF0aC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBDbGllbnQgbmFtZXNwYWNlIHBhdGggc2VnbWVudC4gKi9cbiAgcmVhZG9ubHkgY2xpZW50TmFtZXNwYWNlOiBzdHJpbmc7XG5cbiAgLyoqIFBhcnRuZXIgaWRlbnRpZmllciBmb3IgcGFydG5lci1zY29wZWQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IHBhcnRuZXJJZD86IHN0cmluZztcblxuICAvKiogQWdlbnQgaWRlbnRpZmllciBmb3IgYWdlbnQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IGFnZW50SWQ/OiBzdHJpbmc7XG59XG5cbi8qKiBBIGNhbm9uaWNhbCBNQ1Agcm91dGUgdGVtcGxhdGUgYW5kIGl0cyBwcm90ZWN0ZWQtcmVzb3VyY2Ugcm91dGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEVuZHBvaW50VGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENhbm9uaWNhbCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6IHN0cmluZztcbn1cblxuLyoqIERlcml2ZWQgT0F1dGggYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aEZhY2FkZVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGF1dGhvcml6YXRpb24gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHRva2VuIGVuZHBvaW50IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIFJGQyA3NTkxIGR5bmFtaWMtY2xpZW50IHJlZ2lzdHJhdGlvbiBwYXR0ZXJuLiAqL1xuICByZWFkb25seSByZWdpc3RlclBhdHRlcm46IHN0cmluZztcbn1cblxuLyoqIENhbm9uaWNhbCBhbmQgc3VmZml4LWNvbXBhdGlibGUgT0F1dGggZGlzY292ZXJ5IHBhdHRlcm5zIGZvciBhbiBNQ1AgZW5kcG9pbnQga2luZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwT0F1dGhEaXNjb3ZlcnlUZW1wbGF0ZSB7XG4gIC8qKiBFbmRwb2ludCBraW5kIGZyb20gdGhlIHZlcnNpb25lZCByb3V0ZS1hbGdlYnJhIHF1YXJ0ZXQuICovXG4gIHJlYWRvbmx5IGtpbmQ6IHN0cmluZztcblxuICAvKiogRGVyaXZlZCBjYW5vbmljYWwgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IGNhbm9uaWNhbFBhdHRlcm46IHN0cmluZztcblxuICAvKiogRGVyaXZlZCBzdWZmaXgtY29tcGF0aWJsZSBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgc3VmZml4UGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogT25lIHJvdXRlIHRoYXQgaXMgaW5zdGFsbGVkIG9uY2UgcGVyIGRlcGxveW1lbnQgaW5zdGVhZCBvZiBwZXIgTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFN0YWdlR2xvYmFsUm91dGUge1xuICAvKiogQ29udHJhY3QgbmFtZSBvZiB0aGUgc3RhZ2UtZ2xvYmFsIHJvdXRlLiAqL1xuICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG5cbiAgLyoqIENhbm9uaWNhbCByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBwYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIEhUVFAgbWV0aG9kcyB3aXJlZCBmb3IgdGhlIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IG1ldGhvZHM6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSdzIGNhbm9uaWNhbCwgdmVyc2lvbmVkIE1DUCByb3V0ZS1hbGdlYnJhIGNvbnRyYWN0LlxuICpcbiAqIEV2ZXJ5IE9BdXRoIHJvdXRlIGlzIGRlcml2ZWQgZnJvbSB0aGUgZm91ciBNQ1AgcGF0dGVybnMgdGhyb3VnaCB0aGUgcHVyZVxuICogZnVuY3Rpb25zIG9uIHRoaXMgY2xhc3MuIENvbmNyZXRlIGVuZHBvaW50IGJ1aWxkZXJzIHZhbGlkYXRlIHRoZSBzYW1lXG4gKiBraW5kLXRvLWlkZW50aWZpZXIgaW52YXJpYW50cyBhcyB0aGUgR28gcnVudGltZSBwYWNrYWdlLlxuICovXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhIHtcbiAgLyoqIE1DUCByb3V0ZS1hbGdlYnJhIGNvbnRyYWN0IHZlcnNpb24uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgQ09OVFJBQ1RfVkVSU0lPTiA9IFwibTE3Lm1jcC1yb3V0ZS1hbGdlYnJhL3YyXCI7XG5cbiAgLyoqIFN1cGVyc2VkZWQgdjEgcm91dGUtYWxnZWJyYSBjb250cmFjdCB2ZXJzaW9uLCByZXRhaW5lZCBmb3IgcmVhZCBjb21wYXRpYmlsaXR5LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IENPTlRSQUNUX1ZFUlNJT05fVjEgPSBcIm0xNy5tY3Atcm91dGUtYWxnZWJyYS92MVwiO1xuXG4gIC8qKiBDbG9zZWQgaXNzdWVyLW1vZGUgdm9jYWJ1bGFyeSBtZW1iZXI6IG9uZSBmYW1pbHktd2lkZSBpc3N1ZXIgZm9yIHRoZSB3aG9sZSBmYWNhZGUuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgSVNTVUVSX01PREVfRkFNSUxZID0gXCJmYW1pbHlcIjtcblxuICAvKiogQ2xvc2VkIGlzc3Vlci1tb2RlIHZvY2FidWxhcnkgbWVtYmVyOiBlYWNoIHJvdXRlIGlzIGl0cyBvd24gYXV0aG9yaXphdGlvbi1zZXJ2ZXIgaXNzdWVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IElTU1VFUl9NT0RFX1JPVVRFID0gXCJyb3V0ZVwiO1xuXG4gIC8qKiBOYW1lc3BhY2UgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX05BTUVTUEFDRSA9IFwibmFtZXNwYWNlXCI7XG5cbiAgLyoqIFBhcnRuZXItc2NvcGVkIG5hbWVzcGFjZSBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UgPSBcInBhcnRuZXJfbmFtZXNwYWNlXCI7XG5cbiAgLyoqIEFnZW50IGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9BR0VOVCA9IFwiYWdlbnRcIjtcblxuICAvKiogUGFydG5lci1zY29wZWQgYWdlbnQgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQgPSBcInBhcnRuZXJfYWdlbnRcIjtcblxuICAvKiogQ2Fub25pY2FsIG5hbWVzcGFjZSBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBOQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPSBcIi97Y2xpZW50X25hbWVzcGFjZX0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBwYXJ0bmVyLXNjb3BlZCBuYW1lc3BhY2UgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9OQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9wYXJ0bmVycy97cGFydG5lcl9pZH0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBhZ2VudCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBBR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L2FnZW50cy97YWdlbnRfaWR9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgcGFydG5lci1zY29wZWQgYWdlbnQgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9BR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L3BhcnRuZXJzL3twYXJ0bmVyX2lkfS9hZ2VudHMve2FnZW50X2lkfS9tY3BcIjtcblxuICAvKiogUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHByZWZpeC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBQUk9URUNURURfUkVTT1VSQ0VfUFJFRklYID1cbiAgICBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIjtcblxuICAvKiogUkZDIDg0MTQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgbWV0YWRhdGEgcHJlZml4LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWCA9XG4gICAgXCIvLndlbGwta25vd24vb2F1dGgtYXV0aG9yaXphdGlvbi1zZXJ2ZXJcIjtcblxuICAvKipcbiAgICogU3RhZ2UtZ2xvYmFsIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrIHBhdGguXG4gICAqXG4gICAqIFRoZSBjYWxsYmFjayBpcyBjb3JyZWxhdGVkIGJ5IHRoZSBzaW5nbGUtdXNlIHVwc3RyZWFtIHN0YXRlIHRoZSBmYWNhZGVcbiAgICogbWludGVkLCBzbyBvbmUgc3RhZ2UtZ2xvYmFsIHJvdXRlIGlzIHN1ZmZpY2llbnQgYW5kIG5vIHBlci1raW5kIGNhbGxiYWNrXG4gICAqIG11bHRpcGxpZXMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IERFRkFVTFRfQ0FMTEJBQ0tfUEFUSCA9IFwiL19vYXV0aC9tY3AvY2FsbGJhY2tcIjtcblxuICAvKiogUmV0dXJuIHRoZSBjbG9zZWQgaXNzdWVyLW1vZGUgdm9jYWJ1bGFyeSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRJc3N1ZXJNb2RlcygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5JU1NVRVJfTU9ERV9GQU1JTFksXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuSVNTVUVSX01PREVfUk9VVEUsXG4gICAgXTtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgYW4gUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgcHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVg7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWCArIG5vcm1hbGl6ZWQ7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBjYW5vbmljYWwgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWCArIG5vcm1hbGl6ZWQ7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHtBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKX0vYXV0aG9yaXplYDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIHRva2VuIGZhY2FkZSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS90b2tlbmA7XG4gIH1cblxuICAvKipcbiAgICogRGVyaXZlIHRoZSBSRkMgNzU5MSBkeW5hbWljLWNsaWVudCByZWdpc3RyYXRpb24gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguXG4gICAqXG4gICAqIFRoZSByb3V0ZWQgZGlzY292ZXJ5IGRvY3VtZW50IGFkdmVydGlzZXMgZXhhY3RseSB0aGlzIHBhdGggYXNcbiAgICogYHJlZ2lzdHJhdGlvbl9lbmRwb2ludGAsIHNvIHRoZSBhZHZlcnRpc2VkIFVSTCBhbmQgdGhlIG1vdW50ZWQgcm91dGVcbiAgICogY2Fubm90IGRyaWZ0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHtBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKX0vcmVnaXN0ZXJgO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZCArIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gIH1cblxuICAvKiogUmVjb3ZlciBhIHJlc291cmNlIHBhdGggZnJvbSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZXNvdXJjZVBhdGhGcm9tUHJvdGVjdGVkUmVzb3VyY2VQYXRoKFxuICAgIHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHByb3RlY3RlZFJlc291cmNlUGF0aCk7XG4gICAgY29uc3QgcHJlZml4ID0gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVg7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IHByZWZpeCkge1xuICAgICAgcmV0dXJuIFwiL1wiO1xuICAgIH1cbiAgICBpZiAoIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChgJHtwcmVmaXh9L2ApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIHByb3RlY3RlZCByZXNvdXJjZSBwYXRoICR7SlNPTi5zdHJpbmdpZnkobm9ybWFsaXplZCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVQYXRoKG5vcm1hbGl6ZWQuc2xpY2UocHJlZml4Lmxlbmd0aCkpO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgcHJvdGVjdGVkLXJlc291cmNlIHBhdGggZm9yIGFuIE1DUCBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aEZyb21NY3BQYXRoKG1jcFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBtY3BQYXRoLFxuICAgICk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBtY3BQYXR0ZXJuOiBwYXR0ZXJuLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE9BdXRoIGF1dGhvcml6YXRpb24gZmFjYWRlIHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZE9BdXRoRmFjYWRlVGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgICAgcmVnaXN0ZXJQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm4gZXZlcnkgc3RhZ2UtZ2xvYmFsIHJvdXRlIGluIGNvbnRyYWN0IG9yZGVyLlxuICAgKlxuICAgKiB2MiBhZGRzIGV4YWN0bHkgb25lIHN0YWdlLWdsb2JhbCByb3V0ZTogdGhlIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrLiBUaGVcbiAgICogY2FsbGJhY2sgcGF0aCBpcyBvdmVycmlkYWJsZSBhdCBydW50aW1lIChgRmFjYWRlQ29uZmlnLlVwc3RyZWFtQ2FsbGJhY2tQYXRoYCk7XG4gICAqIHRoaXMgcmV0dXJucyB0aGUgY29udHJhY3QgZGVmYXVsdC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkU3RhZ2VHbG9iYWxSb3V0ZXMoKTogQXBwVGhlb3J5TWNwU3RhZ2VHbG9iYWxSb3V0ZVtdIHtcbiAgICByZXR1cm4gW1xuICAgICAge1xuICAgICAgICBuYW1lOiBcInVwc3RyZWFtX2NhbGxiYWNrXCIsXG4gICAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEgsXG4gICAgICAgIG1ldGhvZHM6IFtcIkdFVFwiXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIHRoZSBlZmZlY3RpdmUgc3RhZ2UtZ2xvYmFsIGNhbGxiYWNrIHBhdGggZm9yIGEgY29uZmlndXJlZCB2YWx1ZS5cbiAgICpcbiAgICogQW4gdW5zZXQgKG9yIHdoaXRlc3BhY2Utb25seSkgdmFsdWUgcmVzb2x2ZXMgdG8gYERFRkFVTFRfQ0FMTEJBQ0tfUEFUSGA7XG4gICAqIGV2ZXJ5IG90aGVyIHZhbHVlIG11c3Qgbm9ybWFsaXplIHRvIGEgdmFsaWQgYWJzb2x1dGUgY2FsbGJhY2sgcGF0aC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGgoY29uZmlndXJlZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCB0cmltbWVkID0gdHJpbUFTQ0lJV2hpdGVzcGFjZShjb25maWd1cmVkKTtcbiAgICBpZiAodHJpbW1lZCA9PT0gXCJcIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEg7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubm9ybWFsaXplQ2FsbGJhY2tQYXRoKHRyaW1tZWQpO1xuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlIGFuZCBub3JtYWxpemUgYW4gYWJzb2x1dGUgY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIHBhdGggbXVzdCBiZSBhYnNvbHV0ZSwgY29udGFpbiBubyBxdWVyeSBvciBmcmFnbWVudCwgYW5kIG11c3Qgbm90IHVzZSBhXG4gICAqIGRvdCBzZWdtZW50LiBJdCBpcyBub3JtYWxpemVkIHdpdGggdGhlIHNhbWUgcnVsZXMgYXMgZXZlcnkgb3RoZXIgcm91dGUgcGF0aC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbm9ybWFsaXplQ2FsbGJhY2tQYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgdHJpbW1lZCA9IHRyaW1BU0NJSVdoaXRlc3BhY2UocmF3UGF0aCk7XG4gICAgaWYgKHRyaW1tZWQgPT09IFwiXCIgfHwgIXRyaW1tZWQuc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1jcHJvdXRlczogY2FsbGJhY2sgcGF0aCBtdXN0IGJlIGFic29sdXRlICR7SlNPTi5zdHJpbmdpZnkocmF3UGF0aCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChjb250YWluc1JlZnVzZWRSb3V0ZVBhdGhCeXRlcyh0cmltbWVkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiBjYWxsYmFjayBwYXRoIG11c3Qgbm90IGNvbnRhaW4gYSBwZXJjZW50LWVuY29kZWQgc2xhc2gsIGFuIGludGVyaW9yIEFTQ0lJIHdoaXRlc3BhY2Ugb3IgY29udHJvbCBjaGFyYWN0ZXIsIG9yIGEgYmFja3NsYXNoICR7SlNPTi5zdHJpbmdpZnkocmF3UGF0aCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICh0cmltbWVkLmluY2x1ZGVzKFwiP1wiKSB8fCB0cmltbWVkLmluY2x1ZGVzKFwiI1wiKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiBjYWxsYmFjayBwYXRoIG11c3Qgbm90IGluY2x1ZGUgYSBxdWVyeSBvciBmcmFnbWVudCAke0pTT04uc3RyaW5naWZ5KHJhd1BhdGgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICAgIGlmIChzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtY3Byb3V0ZXM6IGNhbGxiYWNrIHBhdGggbXVzdCBub3QgdXNlIGRvdCBzZWdtZW50cyAke0pTT04uc3RyaW5naWZ5KHJhd1BhdGgpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVQYXRoKHRyaW1tZWQpO1xuICB9XG5cbiAgLyoqIFJldHVybiBldmVyeSBjYW5vbmljYWwgT0F1dGggZGlzY292ZXJ5IHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZE9BdXRoRGlzY292ZXJ5VGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcE9BdXRoRGlzY292ZXJ5VGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgY2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgICBzdWZmaXhQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICAgICAgcGF0dGVybixcbiAgICAgICAgKSxcbiAgICB9KSk7XG4gIH1cblxuICAvKiogUGFyc2UgYSBjb25jcmV0ZSBNQ1AgcGF0aCBhZnRlciBjb250cmFjdCBub3JtYWxpemF0aW9uLiAqL1xuICBwdWJsaWMgc3RhdGljIHBhcnNlTWNwUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgge1xuICAgIGNvbnN0IHVubm9ybWFsaXplZEVuZHBvaW50ID0gZW5kcG9pbnRGcm9tU2VnbWVudHMoXG4gICAgICBzcGxpdFBhdGhCZWZvcmVEb3ROb3JtYWxpemF0aW9uKHJhd1BhdGgpLFxuICAgICk7XG4gICAgaWYgKHVubm9ybWFsaXplZEVuZHBvaW50ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS52YWxpZGF0ZUVuZHBvaW50UGF0aCh1bm5vcm1hbGl6ZWRFbmRwb2ludCk7XG4gICAgICByZXR1cm4gdW5ub3JtYWxpemVkRW5kcG9pbnQ7XG4gICAgfVxuXG4gICAgY29uc3QgZW5kcG9pbnQgPSBlbmRwb2ludEZyb21TZWdtZW50cyhzcGxpdFBhdGgobm9ybWFsaXplUGF0aChyYXdQYXRoKSkpO1xuICAgIGlmIChlbmRwb2ludCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIE1DUCBwYXRoICR7SlNPTi5zdHJpbmdpZnkocmF3UGF0aCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS52YWxpZGF0ZUVuZHBvaW50UGF0aChlbmRwb2ludCk7XG4gICAgcmV0dXJuIGVuZHBvaW50O1xuICB9XG5cbiAgLyoqIFZhbGlkYXRlIGVuZHBvaW50IGtpbmQtdG8taWRlbnRpZmllciBjb25zaXN0ZW5jeSBhbmQgcGF0aC1zZWdtZW50IHNhZmV0eS4gKi9cbiAgcHVibGljIHN0YXRpYyB2YWxpZGF0ZUVuZHBvaW50UGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogdm9pZCB7XG4gICAgaWYgKCFpc1BhdGhTZWdtZW50KGVuZHBvaW50LmNsaWVudE5hbWVzcGFjZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJtY3Byb3V0ZXM6IGNsaWVudE5hbWVzcGFjZSBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXJ0bmVySWQgPSBlbmRwb2ludC5wYXJ0bmVySWQgPz8gXCJcIjtcbiAgICBjb25zdCBhZ2VudElkID0gZW5kcG9pbnQuYWdlbnRJZCA/PyBcIlwiO1xuICAgIHN3aXRjaCAoZW5kcG9pbnQua2luZCkge1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0U6XG4gICAgICAgIGlmIChwYXJ0bmVySWQgIT09IFwiXCIgfHwgYWdlbnRJZCAhPT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBuYW1lc3BhY2UgZW5kcG9pbnQgY2Fubm90IGluY2x1ZGUgcGFydG5lciBvciBhZ2VudCBpZGVudGlmaWVyc1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRTpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KHBhcnRuZXJJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogcGFydG5lcklkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYWdlbnRJZCAhPT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBwYXJ0bmVyIG5hbWVzcGFjZSBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBhZ2VudElkXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5UOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQoYWdlbnRJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogYWdlbnRJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhcnRuZXJJZCAhPT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIm1jcHJvdXRlczogYWdlbnQgZW5kcG9pbnQgY2Fubm90IGluY2x1ZGUgcGFydG5lcklkXCIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVDpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KHBhcnRuZXJJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogcGFydG5lcklkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQoYWdlbnRJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogYWdlbnRJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIGVuZHBvaW50IGtpbmQgJHtKU09OLnN0cmluZ2lmeShlbmRwb2ludC5raW5kKX1gLFxuICAgICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgY29uY3JldGUgTUNQIHBhdGggZm9yIGFuIGVuZHBvaW50LiAqL1xuICBwdWJsaWMgc3RhdGljIG1jcFBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnZhbGlkYXRlRW5kcG9pbnRQYXRoKGVuZHBvaW50KTtcbiAgICBzd2l0Y2ggKGVuZHBvaW50LmtpbmQpIHtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vbWNwYDtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0U6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9wYXJ0bmVycy8ke2VuZHBvaW50LnBhcnRuZXJJZH0vbWNwYDtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQ6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9hZ2VudHMvJHtlbmRwb2ludC5hZ2VudElkfS9tY3BgO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5UOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vcGFydG5lcnMvJHtlbmRwb2ludC5wYXJ0bmVySWR9L2FnZW50cy8ke2VuZHBvaW50LmFnZW50SWR9L21jcGA7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgZW5kcG9pbnQga2luZCAke0pTT04uc3RyaW5naWZ5KGVuZHBvaW50LmtpbmQpfWAsXG4gICAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aChcbiAgICBlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgY2Fub25pY2FsIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoQXV0aG9yaXphdGlvblNlcnZlclBhdGgoXG4gICAgZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6ZVBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIHRva2VuIGZhY2FkZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoVG9rZW5QYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGR5bmFtaWMtY2xpZW50IHJlZ2lzdHJhdGlvbiBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoUmVnaXN0ZXJQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIHN1ZmZpeC1jb21wYXRpYmxlIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoQXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGgoXG4gICAgZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCk6IEFycmF5PHsga2luZDogc3RyaW5nOyBwYXR0ZXJuOiBzdHJpbmcgfT4ge1xuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRSxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5OQU1FU1BBQ0VfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRSxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QQVJUTkVSX05BTUVTUEFDRV9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5ULFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFHRU5UX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVCxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QQVJUTkVSX0FHRU5UX01DUF9QQVRURVJOLFxuICAgIH0sXG4gIF07XG59XG5cbmZ1bmN0aW9uIGVuZHBvaW50RnJvbVNlZ21lbnRzKFxuICBzZWdtZW50czogc3RyaW5nW10sXG4pOiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGggfCB1bmRlZmluZWQge1xuICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAyICYmIHNlZ21lbnRzWzFdID09PSBcIm1jcFwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRSxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgfTtcbiAgfVxuICBpZiAoXG4gICAgc2VnbWVudHMubGVuZ3RoID09PSA0ICYmXG4gICAgc2VnbWVudHNbMV0gPT09IFwicGFydG5lcnNcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcIm1jcFwiXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRSxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICBwYXJ0bmVySWQ6IHNlZ21lbnRzWzJdLFxuICAgIH07XG4gIH1cbiAgaWYgKFxuICAgIHNlZ21lbnRzLmxlbmd0aCA9PT0gNCAmJlxuICAgIHNlZ21lbnRzWzFdID09PSBcImFnZW50c1wiICYmXG4gICAgc2VnbWVudHNbM10gPT09IFwibWNwXCJcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5ULFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICAgIGFnZW50SWQ6IHNlZ21lbnRzWzJdLFxuICAgIH07XG4gIH1cbiAgaWYgKFxuICAgIHNlZ21lbnRzLmxlbmd0aCA9PT0gNiAmJlxuICAgIHNlZ21lbnRzWzFdID09PSBcInBhcnRuZXJzXCIgJiZcbiAgICBzZWdtZW50c1szXSA9PT0gXCJhZ2VudHNcIiAmJlxuICAgIHNlZ21lbnRzWzVdID09PSBcIm1jcFwiXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5ULFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICAgIHBhcnRuZXJJZDogc2VnbWVudHNbMl0sXG4gICAgICBhZ2VudElkOiBzZWdtZW50c1s0XSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHRyaW1BU0NJSVdoaXRlc3BhY2UodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBzdGFydCA9IDA7XG4gIHdoaWxlIChcbiAgICBzdGFydCA8IHZhbHVlLmxlbmd0aCAmJlxuICAgIGlzQVNDSUlXaGl0ZXNwYWNlQ29kZSh2YWx1ZS5jaGFyQ29kZUF0KHN0YXJ0KSlcbiAgKSB7XG4gICAgc3RhcnQgKz0gMTtcbiAgfVxuXG4gIGxldCBlbmQgPSB2YWx1ZS5sZW5ndGg7XG4gIHdoaWxlIChlbmQgPiBzdGFydCAmJiBpc0FTQ0lJV2hpdGVzcGFjZUNvZGUodmFsdWUuY2hhckNvZGVBdChlbmQgLSAxKSkpIHtcbiAgICBlbmQgLT0gMTtcbiAgfVxuXG4gIHJldHVybiB2YWx1ZS5zbGljZShzdGFydCwgZW5kKTtcbn1cblxuZnVuY3Rpb24gaXNBU0NJSVdoaXRlc3BhY2VDb2RlKGNvZGU6IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGNvZGUgPT09IDkgfHxcbiAgICBjb2RlID09PSAxMCB8fFxuICAgIGNvZGUgPT09IDExIHx8XG4gICAgY29kZSA9PT0gMTIgfHxcbiAgICBjb2RlID09PSAxMyB8fFxuICAgIGNvZGUgPT09IDMyXG4gICk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG5vcm1hbGl6ZWQgPSB0cmltQVNDSUlXaGl0ZXNwYWNlKHJhd1BhdGgpO1xuICBpZiAobm9ybWFsaXplZCA9PT0gXCJcIikge1xuICAgIHJldHVybiBcIi9cIjtcbiAgfVxuICBpZiAoIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICBub3JtYWxpemVkID0gYC8ke25vcm1hbGl6ZWR9YDtcbiAgfVxuXG4gIGNvbnN0IHNlZ21lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygbm9ybWFsaXplZC5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCJcIiB8fCBzZWdtZW50ID09PSBcIi5cIikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWdtZW50ID09PSBcIi4uXCIpIHtcbiAgICAgIHNlZ21lbnRzLnBvcCgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZ21lbnRzLnB1c2goc2VnbWVudCk7XG4gIH1cbiAgcmV0dXJuIHNlZ21lbnRzLmxlbmd0aCA9PT0gMCA/IFwiL1wiIDogYC8ke3NlZ21lbnRzLmpvaW4oXCIvXCIpfWA7XG59XG5cbmZ1bmN0aW9uIHNwbGl0UGF0aEJlZm9yZURvdE5vcm1hbGl6YXRpb24ocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdHJpbUFTQ0lJV2hpdGVzcGFjZShyYXdQYXRoKVxuICAgIC5zcGxpdChcIi9cIilcbiAgICAuZmlsdGVyKChzZWdtZW50KSA9PiBzZWdtZW50ICE9PSBcIlwiKTtcbn1cblxuZnVuY3Rpb24gc3BsaXRQYXRoKG5vcm1hbGl6ZWRQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBub3JtYWxpemVkUGF0aCA9PT0gXCIvXCIgPyBbXSA6IG5vcm1hbGl6ZWRQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKTtcbn1cblxuZnVuY3Rpb24gaXNQYXRoU2VnbWVudCh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRyaW1tZWQgPSB0cmltQVNDSUlXaGl0ZXNwYWNlKHZhbHVlKTtcbiAgcmV0dXJuIChcbiAgICB0cmltbWVkICE9PSBcIlwiICYmXG4gICAgdHJpbW1lZCAhPT0gXCIuXCIgJiZcbiAgICB0cmltbWVkICE9PSBcIi4uXCIgJiZcbiAgICAhdmFsdWUuaW5jbHVkZXMoXCIvXCIpICYmXG4gICAgIWNvbnRhaW5zUmVmdXNlZFJvdXRlUGF0aEJ5dGVzKHRyaW1tZWQpXG4gICk7XG59XG5cbi8vIGNvbnRhaW5zUmVmdXNlZFJvdXRlUGF0aEJ5dGVzIHJlcG9ydHMgd2hldGhlciBhIHJvdXRlIHBhdGgsIGFscmVhZHkgdHJpbW1lZCBhdFxuLy8gaXRzIGVkZ2VzLCBjYXJyaWVzIHRoZSBieXRlcyB0aGUgcm91dGUgYWxnZWJyYSByZWZ1c2VzOiBhIHBlcmNlbnQtZW5jb2RlZFxuLy8gc2xhc2gsIGFuIGludGVyaW9yIEFTQ0lJIHdoaXRlc3BhY2Ugb3IgY29udHJvbCBjaGFyYWN0ZXIsIG9yIGEgYmFja3NsYXNoLlxuZnVuY3Rpb24gY29udGFpbnNSZWZ1c2VkUm91dGVQYXRoQnl0ZXModmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAodmFsdWUuaW5jbHVkZXMoXCIlMkZcIikgfHwgdmFsdWUuaW5jbHVkZXMoXCIlMmZcIikpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgdmFsdWUubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgY29uc3QgY29kZSA9IHZhbHVlLmNoYXJDb2RlQXQoaW5kZXgpO1xuICAgIGlmIChjb2RlID09PSAweDVjIHx8IGNvZGUgPD0gMHgxZiB8fCBjb2RlID09PSAweDIwIHx8IGNvZGUgPT09IDB4N2YpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG4iXX0=