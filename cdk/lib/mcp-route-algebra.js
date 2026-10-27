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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra", version: "6.4.0-rc" };
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
// A percent-encoded ASCII control byte: %00-%1F or %7F, in either hex case.
// Literal control bytes are already refused by the code-point scan below; the
// escaped form is refused because a downstream proxy, CDN, or client may
// percent-decode the route path before matching it, which would let the decoded
// route differ from the mounted one. This is the one shared rule, mirrored in
// Go (runtime/mcproutes + runtime/oauth), TypeScript, and Python.
const PERCENT_ENCODED_CONTROL_BYTE_PATTERN = /%[01][0-9A-Fa-f]|%7[Ff]/u;
// containsRefusedRoutePathBytes reports whether a route path, already trimmed at
// its edges, carries the bytes the route algebra refuses: a percent-encoded
// slash, a percent-encoded ASCII control byte, an interior ASCII whitespace or
// control character, or a backslash.
function containsRefusedRoutePathBytes(value) {
    if (value.includes("%2F") || value.includes("%2f")) {
        return true;
    }
    if (PERCENT_ENCODED_CONTROL_BYTE_PATTERN.test(value)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBa0VBOzs7Ozs7R0FNRztBQUNILE1BQXNCLHdCQUF3Qjs7SUFDNUMsMENBQTBDO0lBQ25DLE1BQU0sQ0FBVSxnQkFBZ0IsR0FBRywwQkFBMEIsQ0FBQztJQUVyRSxxRkFBcUY7SUFDOUUsTUFBTSxDQUFVLG1CQUFtQixHQUFHLDBCQUEwQixDQUFDO0lBRXhFLHlGQUF5RjtJQUNsRixNQUFNLENBQVUsa0JBQWtCLEdBQUcsUUFBUSxDQUFDO0lBRXJELCtGQUErRjtJQUN4RixNQUFNLENBQVUsaUJBQWlCLEdBQUcsT0FBTyxDQUFDO0lBRW5ELCtCQUErQjtJQUN4QixNQUFNLENBQVUsdUJBQXVCLEdBQUcsV0FBVyxDQUFDO0lBRTdELDhDQUE4QztJQUN2QyxNQUFNLENBQVUsK0JBQStCLEdBQUcsbUJBQW1CLENBQUM7SUFFN0UsMkJBQTJCO0lBQ3BCLE1BQU0sQ0FBVSxtQkFBbUIsR0FBRyxPQUFPLENBQUM7SUFFckQsMENBQTBDO0lBQ25DLE1BQU0sQ0FBVSwyQkFBMkIsR0FBRyxlQUFlLENBQUM7SUFFckUsNkNBQTZDO0lBQ3RDLE1BQU0sQ0FBVSxxQkFBcUIsR0FBRyx5QkFBeUIsQ0FBQztJQUV6RSw0REFBNEQ7SUFDckQsTUFBTSxDQUFVLDZCQUE2QixHQUNsRCwrQ0FBK0MsQ0FBQztJQUVsRCx5Q0FBeUM7SUFDbEMsTUFBTSxDQUFVLGlCQUFpQixHQUN0QywyQ0FBMkMsQ0FBQztJQUU5Qyx3REFBd0Q7SUFDakQsTUFBTSxDQUFVLHlCQUF5QixHQUM5QyxpRUFBaUUsQ0FBQztJQUVwRSxtREFBbUQ7SUFDNUMsTUFBTSxDQUFVLHlCQUF5QixHQUM5Qyx1Q0FBdUMsQ0FBQztJQUUxQyxxREFBcUQ7SUFDOUMsTUFBTSxDQUFVLDJCQUEyQixHQUNoRCx5Q0FBeUMsQ0FBQztJQUU1Qzs7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QyxFQUFFLENBQUM7UUFDckQsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUNwRSxPQUFPLElBQUksQ0FBQztRQUNkLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEEgY29uY3JldGUgY2Fub25pY2FsIE1DUCBlbmRwb2ludCBwYXRoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENsaWVudCBuYW1lc3BhY2UgcGF0aCBzZWdtZW50LiAqL1xuICByZWFkb25seSBjbGllbnROYW1lc3BhY2U6IHN0cmluZztcblxuICAvKiogUGFydG5lciBpZGVudGlmaWVyIGZvciBwYXJ0bmVyLXNjb3BlZCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgcGFydG5lcklkPzogc3RyaW5nO1xuXG4gIC8qKiBBZ2VudCBpZGVudGlmaWVyIGZvciBhZ2VudCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgYWdlbnRJZD86IHN0cmluZztcbn1cblxuLyoqIEEgY2Fub25pY2FsIE1DUCByb3V0ZSB0ZW1wbGF0ZSBhbmQgaXRzIHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZSB7XG4gIC8qKiBFbmRwb2ludCBraW5kIGZyb20gdGhlIHZlcnNpb25lZCByb3V0ZS1hbGdlYnJhIHF1YXJ0ZXQuICovXG4gIHJlYWRvbmx5IGtpbmQ6IHN0cmluZztcblxuICAvKiogQ2Fub25pY2FsIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHJvdXRlIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nO1xufVxuXG4vKiogRGVyaXZlZCBPQXV0aCBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXR0ZXJucyBmb3IgYW4gTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgYXV0aG9yaXphdGlvbiBlbmRwb2ludCBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgdG9rZW4gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgUkZDIDc1OTEgZHluYW1pYy1jbGllbnQgcmVnaXN0cmF0aW9uIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHJlZ2lzdGVyUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogQ2Fub25pY2FsIGFuZCBzdWZmaXgtY29tcGF0aWJsZSBPQXV0aCBkaXNjb3ZlcnkgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aERpc2NvdmVyeVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgY2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHN1ZmZpeC1jb21wYXRpYmxlIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBzdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBPbmUgcm91dGUgdGhhdCBpcyBpbnN0YWxsZWQgb25jZSBwZXIgZGVwbG95bWVudCBpbnN0ZWFkIG9mIHBlciBNQ1AgZW5kcG9pbnQga2luZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU3RhZ2VHbG9iYWxSb3V0ZSB7XG4gIC8qKiBDb250cmFjdCBuYW1lIG9mIHRoZSBzdGFnZS1nbG9iYWwgcm91dGUuICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcblxuICAvKiogQ2Fub25pY2FsIHJvdXRlIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHBhdHRlcm46IHN0cmluZztcblxuICAvKiogSFRUUCBtZXRob2RzIHdpcmVkIGZvciB0aGUgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgbWV0aG9kczogc3RyaW5nW107XG59XG5cbi8qKlxuICogQXBwVGhlb3J5J3MgY2Fub25pY2FsLCB2ZXJzaW9uZWQgTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QuXG4gKlxuICogRXZlcnkgT0F1dGggcm91dGUgaXMgZGVyaXZlZCBmcm9tIHRoZSBmb3VyIE1DUCBwYXR0ZXJucyB0aHJvdWdoIHRoZSBwdXJlXG4gKiBmdW5jdGlvbnMgb24gdGhpcyBjbGFzcy4gQ29uY3JldGUgZW5kcG9pbnQgYnVpbGRlcnMgdmFsaWRhdGUgdGhlIHNhbWVcbiAqIGtpbmQtdG8taWRlbnRpZmllciBpbnZhcmlhbnRzIGFzIHRoZSBHbyBydW50aW1lIHBhY2thZ2UuXG4gKi9cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEge1xuICAvKiogTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QgdmVyc2lvbi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBDT05UUkFDVF9WRVJTSU9OID0gXCJtMTcubWNwLXJvdXRlLWFsZ2VicmEvdjJcIjtcblxuICAvKiogU3VwZXJzZWRlZCB2MSByb3V0ZS1hbGdlYnJhIGNvbnRyYWN0IHZlcnNpb24sIHJldGFpbmVkIGZvciByZWFkIGNvbXBhdGliaWxpdHkuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgQ09OVFJBQ1RfVkVSU0lPTl9WMSA9IFwibTE3Lm1jcC1yb3V0ZS1hbGdlYnJhL3YxXCI7XG5cbiAgLyoqIENsb3NlZCBpc3N1ZXItbW9kZSB2b2NhYnVsYXJ5IG1lbWJlcjogb25lIGZhbWlseS13aWRlIGlzc3VlciBmb3IgdGhlIHdob2xlIGZhY2FkZS4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBJU1NVRVJfTU9ERV9GQU1JTFkgPSBcImZhbWlseVwiO1xuXG4gIC8qKiBDbG9zZWQgaXNzdWVyLW1vZGUgdm9jYWJ1bGFyeSBtZW1iZXI6IGVhY2ggcm91dGUgaXMgaXRzIG93biBhdXRob3JpemF0aW9uLXNlcnZlciBpc3N1ZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgSVNTVUVSX01PREVfUk9VVEUgPSBcInJvdXRlXCI7XG5cbiAgLyoqIE5hbWVzcGFjZSBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfTkFNRVNQQUNFID0gXCJuYW1lc3BhY2VcIjtcblxuICAvKiogUGFydG5lci1zY29wZWQgbmFtZXNwYWNlIGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRSA9IFwicGFydG5lcl9uYW1lc3BhY2VcIjtcblxuICAvKiogQWdlbnQgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX0FHRU5UID0gXCJhZ2VudFwiO1xuXG4gIC8qKiBQYXJ0bmVyLXNjb3BlZCBhZ2VudCBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVCA9IFwicGFydG5lcl9hZ2VudFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgbmFtZXNwYWNlIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IE5BTUVTUEFDRV9NQ1BfUEFUVEVSTiA9IFwiL3tjbGllbnRfbmFtZXNwYWNlfS9tY3BcIjtcblxuICAvKiogQ2Fub25pY2FsIHBhcnRuZXItc2NvcGVkIG5hbWVzcGFjZSBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBQQVJUTkVSX05BTUVTUEFDRV9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L3BhcnRuZXJzL3twYXJ0bmVyX2lkfS9tY3BcIjtcblxuICAvKiogQ2Fub25pY2FsIGFnZW50IE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEFHRU5UX01DUF9QQVRURVJOID1cbiAgICBcIi97Y2xpZW50X25hbWVzcGFjZX0vYWdlbnRzL3thZ2VudF9pZH0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBwYXJ0bmVyLXNjb3BlZCBhZ2VudCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBQQVJUTkVSX0FHRU5UX01DUF9QQVRURVJOID1cbiAgICBcIi97Y2xpZW50X25hbWVzcGFjZX0vcGFydG5lcnMve3BhcnRuZXJfaWR9L2FnZW50cy97YWdlbnRfaWR9L21jcFwiO1xuXG4gIC8qKiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEgcHJlZml4LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IFBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVggPVxuICAgIFwiLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZVwiO1xuXG4gIC8qKiBSRkMgODQxNCBhdXRob3JpemF0aW9uLXNlcnZlciBtZXRhZGF0YSBwcmVmaXguICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYID1cbiAgICBcIi8ud2VsbC1rbm93bi9vYXV0aC1hdXRob3JpemF0aW9uLXNlcnZlclwiO1xuXG4gIC8qKlxuICAgKiBTdGFnZS1nbG9iYWwgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgcGF0aC5cbiAgICpcbiAgICogVGhlIGNhbGxiYWNrIGlzIGNvcnJlbGF0ZWQgYnkgdGhlIHNpbmdsZS11c2UgdXBzdHJlYW0gc3RhdGUgdGhlIGZhY2FkZVxuICAgKiBtaW50ZWQsIHNvIG9uZSBzdGFnZS1nbG9iYWwgcm91dGUgaXMgc3VmZmljaWVudCBhbmQgbm8gcGVyLWtpbmQgY2FsbGJhY2tcbiAgICogbXVsdGlwbGllcy5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgREVGQVVMVF9DQUxMQkFDS19QQVRIID0gXCIvX29hdXRoL21jcC9jYWxsYmFja1wiO1xuXG4gIC8qKiBSZXR1cm4gdGhlIGNsb3NlZCBpc3N1ZXItbW9kZSB2b2NhYnVsYXJ5IGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZElzc3Vlck1vZGVzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gW1xuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLklTU1VFUl9NT0RFX0ZBTUlMWSxcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5JU1NVRVJfTU9ERV9ST1VURSxcbiAgICBdO1xuICB9XG5cbiAgLyoqIERlcml2ZSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYICsgbm9ybWFsaXplZDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChyZXNvdXJjZVBhdGgpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi9cIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYICsgbm9ybWFsaXplZDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIGF1dGhvcml6YXRpb24gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS9hdXRob3JpemVgO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgdG9rZW4gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7QXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCl9L3Rva2VuYDtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZXJpdmUgdGhlIFJGQyA3NTkxIGR5bmFtaWMtY2xpZW50IHJlZ2lzdHJhdGlvbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC5cbiAgICpcbiAgICogVGhlIHJvdXRlZCBkaXNjb3ZlcnkgZG9jdW1lbnQgYWR2ZXJ0aXNlcyBleGFjdGx5IHRoaXMgcGF0aCBhc1xuICAgKiBgcmVnaXN0cmF0aW9uX2VuZHBvaW50YCwgc28gdGhlIGFkdmVydGlzZWQgVVJMIGFuZCB0aGUgbW91bnRlZCByb3V0ZVxuICAgKiBjYW5ub3QgZHJpZnQuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25SZWdpc3RlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS9yZWdpc3RlcmA7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBzdWZmaXgtY29tcGF0aWJsZSBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChyZXNvdXJjZVBhdGgpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi9cIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVkICsgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWDtcbiAgfVxuXG4gIC8qKiBSZWNvdmVyIGEgcmVzb3VyY2UgcGF0aCBmcm9tIGFuIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlc291cmNlUGF0aEZyb21Qcm90ZWN0ZWRSZXNvdXJjZVBhdGgoXG4gICAgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocHJvdGVjdGVkUmVzb3VyY2VQYXRoKTtcbiAgICBjb25zdCBwcmVmaXggPSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWDtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gcHJlZml4KSB7XG4gICAgICByZXR1cm4gXCIvXCI7XG4gICAgfVxuICAgIGlmICghbm9ybWFsaXplZC5zdGFydHNXaXRoKGAke3ByZWZpeH0vYCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgcHJvdGVjdGVkIHJlc291cmNlIHBhdGggJHtKU09OLnN0cmluZ2lmeShub3JtYWxpemVkKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVBhdGgobm9ybWFsaXplZC5zbGljZShwcmVmaXgubGVuZ3RoKSk7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aCBmb3IgYW4gTUNQIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgcHJvdGVjdGVkUmVzb3VyY2VQYXRoRnJvbU1jcFBhdGgobWNwUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIG1jcFBhdGgsXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE1DUCBlbmRwb2ludCB0ZW1wbGF0ZSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpOiBBcHBUaGVvcnlNY3BFbmRwb2ludFRlbXBsYXRlW10ge1xuICAgIHJldHVybiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKS5tYXAoKHsga2luZCwgcGF0dGVybiB9KSA9PiAoe1xuICAgICAga2luZCxcbiAgICAgIG1jcFBhdHRlcm46IHBhdHRlcm4sXG4gICAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgocGF0dGVybiksXG4gICAgfSkpO1xuICB9XG5cbiAgLyoqIFJldHVybiBldmVyeSBjYW5vbmljYWwgT0F1dGggYXV0aG9yaXphdGlvbiBmYWNhZGUgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkT0F1dGhGYWNhZGVUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwT0F1dGhGYWNhZGVUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBhdXRob3JpemVQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICAgICAgcGF0dGVybixcbiAgICAgICAgKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgocGF0dGVybiksXG4gICAgICByZWdpc3RlclBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgfSkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybiBldmVyeSBzdGFnZS1nbG9iYWwgcm91dGUgaW4gY29udHJhY3Qgb3JkZXIuXG4gICAqXG4gICAqIHYyIGFkZHMgZXhhY3RseSBvbmUgc3RhZ2UtZ2xvYmFsIHJvdXRlOiB0aGUgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2suIFRoZVxuICAgKiBjYWxsYmFjayBwYXRoIGlzIG92ZXJyaWRhYmxlIGF0IHJ1bnRpbWUgKGBGYWNhZGVDb25maWcuVXBzdHJlYW1DYWxsYmFja1BhdGhgKTtcbiAgICogdGhpcyByZXR1cm5zIHRoZSBjb250cmFjdCBkZWZhdWx0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRTdGFnZUdsb2JhbFJvdXRlcygpOiBBcHBUaGVvcnlNY3BTdGFnZUdsb2JhbFJvdXRlW10ge1xuICAgIHJldHVybiBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6IFwidXBzdHJlYW1fY2FsbGJhY2tcIixcbiAgICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSCxcbiAgICAgICAgbWV0aG9kczogW1wiR0VUXCJdLFxuICAgICAgfSxcbiAgICBdO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc29sdmUgdGhlIGVmZmVjdGl2ZSBzdGFnZS1nbG9iYWwgY2FsbGJhY2sgcGF0aCBmb3IgYSBjb25maWd1cmVkIHZhbHVlLlxuICAgKlxuICAgKiBBbiB1bnNldCAob3Igd2hpdGVzcGFjZS1vbmx5KSB2YWx1ZSByZXNvbHZlcyB0byBgREVGQVVMVF9DQUxMQkFDS19QQVRIYDtcbiAgICogZXZlcnkgb3RoZXIgdmFsdWUgbXVzdCBub3JtYWxpemUgdG8gYSB2YWxpZCBhYnNvbHV0ZSBjYWxsYmFjayBwYXRoLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBjYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChjb25maWd1cmVkOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHRyaW1tZWQgPSB0cmltQVNDSUlXaGl0ZXNwYWNlKGNvbmZpZ3VyZWQpO1xuICAgIGlmICh0cmltbWVkID09PSBcIlwiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ub3JtYWxpemVDYWxsYmFja1BhdGgodHJpbW1lZCk7XG4gIH1cblxuICAvKipcbiAgICogVmFsaWRhdGUgYW5kIG5vcm1hbGl6ZSBhbiBhYnNvbHV0ZSBjYWxsYmFjayBwYXRoLlxuICAgKlxuICAgKiBUaGUgcGF0aCBtdXN0IGJlIGFic29sdXRlLCBjb250YWluIG5vIHF1ZXJ5IG9yIGZyYWdtZW50LCBhbmQgbXVzdCBub3QgdXNlIGFcbiAgICogZG90IHNlZ21lbnQuIEl0IGlzIG5vcm1hbGl6ZWQgd2l0aCB0aGUgc2FtZSBydWxlcyBhcyBldmVyeSBvdGhlciByb3V0ZSBwYXRoLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBub3JtYWxpemVDYWxsYmFja1BhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCB0cmltbWVkID0gdHJpbUFTQ0lJV2hpdGVzcGFjZShyYXdQYXRoKTtcbiAgICBpZiAodHJpbW1lZCA9PT0gXCJcIiB8fCAhdHJpbW1lZC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiBjYWxsYmFjayBwYXRoIG11c3QgYmUgYWJzb2x1dGUgJHtKU09OLnN0cmluZ2lmeShyYXdQYXRoKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGNvbnRhaW5zUmVmdXNlZFJvdXRlUGF0aEJ5dGVzKHRyaW1tZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IGNhbGxiYWNrIHBhdGggbXVzdCBub3QgY29udGFpbiBhIHBlcmNlbnQtZW5jb2RlZCBzbGFzaCwgYW4gaW50ZXJpb3IgQVNDSUkgd2hpdGVzcGFjZSBvciBjb250cm9sIGNoYXJhY3Rlciwgb3IgYSBiYWNrc2xhc2ggJHtKU09OLnN0cmluZ2lmeShyYXdQYXRoKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHRyaW1tZWQuaW5jbHVkZXMoXCI/XCIpIHx8IHRyaW1tZWQuaW5jbHVkZXMoXCIjXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IGNhbGxiYWNrIHBhdGggbXVzdCBub3QgaW5jbHVkZSBhIHF1ZXJ5IG9yIGZyYWdtZW50ICR7SlNPTi5zdHJpbmdpZnkocmF3UGF0aCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgICAgaWYgKHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYG1jcHJvdXRlczogY2FsbGJhY2sgcGF0aCBtdXN0IG5vdCB1c2UgZG90IHNlZ21lbnRzICR7SlNPTi5zdHJpbmdpZnkocmF3UGF0aCl9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVBhdGgodHJpbW1lZCk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBPQXV0aCBkaXNjb3ZlcnkgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkT0F1dGhEaXNjb3ZlcnlUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwT0F1dGhEaXNjb3ZlcnlUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBjYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICAgICAgcGF0dGVybixcbiAgICAgICAgKSxcbiAgICAgIHN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBQYXJzZSBhIGNvbmNyZXRlIE1DUCBwYXRoIGFmdGVyIGNvbnRyYWN0IG5vcm1hbGl6YXRpb24uICovXG4gIHB1YmxpYyBzdGF0aWMgcGFyc2VNY3BQYXRoKHJhd1BhdGg6IHN0cmluZyk6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCB7XG4gICAgY29uc3QgdW5ub3JtYWxpemVkRW5kcG9pbnQgPSBlbmRwb2ludEZyb21TZWdtZW50cyhcbiAgICAgIHNwbGl0UGF0aEJlZm9yZURvdE5vcm1hbGl6YXRpb24ocmF3UGF0aCksXG4gICAgKTtcbiAgICBpZiAodW5ub3JtYWxpemVkRW5kcG9pbnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnZhbGlkYXRlRW5kcG9pbnRQYXRoKHVubm9ybWFsaXplZEVuZHBvaW50KTtcbiAgICAgIHJldHVybiB1bm5vcm1hbGl6ZWRFbmRwb2ludDtcbiAgICB9XG5cbiAgICBjb25zdCBlbmRwb2ludCA9IGVuZHBvaW50RnJvbVNlZ21lbnRzKHNwbGl0UGF0aChub3JtYWxpemVQYXRoKHJhd1BhdGgpKSk7XG4gICAgaWYgKGVuZHBvaW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgTUNQIHBhdGggJHtKU09OLnN0cmluZ2lmeShyYXdQYXRoKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnZhbGlkYXRlRW5kcG9pbnRQYXRoKGVuZHBvaW50KTtcbiAgICByZXR1cm4gZW5kcG9pbnQ7XG4gIH1cblxuICAvKiogVmFsaWRhdGUgZW5kcG9pbnQga2luZC10by1pZGVudGlmaWVyIGNvbnNpc3RlbmN5IGFuZCBwYXRoLXNlZ21lbnQgc2FmZXR5LiAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlRW5kcG9pbnRQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiB2b2lkIHtcbiAgICBpZiAoIWlzUGF0aFNlZ21lbnQoZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIm1jcHJvdXRlczogY2xpZW50TmFtZXNwYWNlIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHBhcnRuZXJJZCA9IGVuZHBvaW50LnBhcnRuZXJJZCA/PyBcIlwiO1xuICAgIGNvbnN0IGFnZW50SWQgPSBlbmRwb2ludC5hZ2VudElkID8/IFwiXCI7XG4gICAgc3dpdGNoIChlbmRwb2ludC5raW5kKSB7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRTpcbiAgICAgICAgaWYgKHBhcnRuZXJJZCAhPT0gXCJcIiB8fCBhZ2VudElkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IG5hbWVzcGFjZSBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBwYXJ0bmVyIG9yIGFnZW50IGlkZW50aWZpZXJzXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQocGFydG5lcklkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBwYXJ0bmVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhZ2VudElkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXIgbmFtZXNwYWNlIGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIGFnZW50SWRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQ6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChhZ2VudElkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBhZ2VudElkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibWNwcm91dGVzOiBhZ2VudCBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBwYXJ0bmVySWRcIik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5UOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQocGFydG5lcklkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBwYXJ0bmVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChhZ2VudElkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBhZ2VudElkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgZW5kcG9pbnQga2luZCAke0pTT04uc3RyaW5naWZ5KGVuZHBvaW50LmtpbmQpfWAsXG4gICAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBjb25jcmV0ZSBNQ1AgcGF0aCBmb3IgYW4gZW5kcG9pbnQuICovXG4gIHB1YmxpYyBzdGF0aWMgbWNwUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICAgIHN3aXRjaCAoZW5kcG9pbnQua2luZCkge1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0U6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9tY3BgO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRTpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L3BhcnRuZXJzLyR7ZW5kcG9pbnQucGFydG5lcklkfS9tY3BgO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVDpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L2FnZW50cy8ke2VuZHBvaW50LmFnZW50SWR9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQ6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9wYXJ0bmVycy8ke2VuZHBvaW50LnBhcnRuZXJJZH0vYWdlbnRzLyR7ZW5kcG9pbnQuYWdlbnRJZH0vbWNwYDtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBlbmRwb2ludCBraW5kICR7SlNPTi5zdHJpbmdpZnkoZW5kcG9pbnQua2luZCl9YCxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgcHJvdGVjdGVkUmVzb3VyY2VQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBjYW5vbmljYWwgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemF0aW9uU2VydmVyUGF0aChcbiAgICBlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoQXV0aG9yaXplUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgdG9rZW4gZmFjYWRlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhUb2tlblBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgZHluYW1pYy1jbGllbnQgcmVnaXN0cmF0aW9uIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhSZWdpc3RlclBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3Mgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aChcbiAgICBlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKTogQXJyYXk8eyBraW5kOiBzdHJpbmc7IHBhdHRlcm46IHN0cmluZyB9PiB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFLFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLk5BTUVTUEFDRV9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFLFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBBUlRORVJfTkFNRVNQQUNFX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQUdFTlRfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5ULFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBBUlRORVJfQUdFTlRfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gZW5kcG9pbnRGcm9tU2VnbWVudHMoXG4gIHNlZ21lbnRzOiBzdHJpbmdbXSxcbik6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCB8IHVuZGVmaW5lZCB7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDIgJiYgc2VnbWVudHNbMV0gPT09IFwibWNwXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFLFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDQgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJwYXJ0bmVyc1wiICYmXG4gICAgc2VnbWVudHNbM10gPT09IFwibWNwXCJcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFLFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICAgIHBhcnRuZXJJZDogc2VnbWVudHNbMl0sXG4gICAgfTtcbiAgfVxuICBpZiAoXG4gICAgc2VnbWVudHMubGVuZ3RoID09PSA0ICYmXG4gICAgc2VnbWVudHNbMV0gPT09IFwiYWdlbnRzXCIgJiZcbiAgICBzZWdtZW50c1szXSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgYWdlbnRJZDogc2VnbWVudHNbMl0sXG4gICAgfTtcbiAgfVxuICBpZiAoXG4gICAgc2VnbWVudHMubGVuZ3RoID09PSA2ICYmXG4gICAgc2VnbWVudHNbMV0gPT09IFwicGFydG5lcnNcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcImFnZW50c1wiICYmXG4gICAgc2VnbWVudHNbNV0gPT09IFwibWNwXCJcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgcGFydG5lcklkOiBzZWdtZW50c1syXSxcbiAgICAgIGFnZW50SWQ6IHNlZ21lbnRzWzRdLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdHJpbUFTQ0lJV2hpdGVzcGFjZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKFxuICAgIHN0YXJ0IDwgdmFsdWUubGVuZ3RoICYmXG4gICAgaXNBU0NJSVdoaXRlc3BhY2VDb2RlKHZhbHVlLmNoYXJDb2RlQXQoc3RhcnQpKVxuICApIHtcbiAgICBzdGFydCArPSAxO1xuICB9XG5cbiAgbGV0IGVuZCA9IHZhbHVlLmxlbmd0aDtcbiAgd2hpbGUgKGVuZCA+IHN0YXJ0ICYmIGlzQVNDSUlXaGl0ZXNwYWNlQ29kZSh2YWx1ZS5jaGFyQ29kZUF0KGVuZCAtIDEpKSkge1xuICAgIGVuZCAtPSAxO1xuICB9XG5cbiAgcmV0dXJuIHZhbHVlLnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiBpc0FTQ0lJV2hpdGVzcGFjZUNvZGUoY29kZTogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgY29kZSA9PT0gOSB8fFxuICAgIGNvZGUgPT09IDEwIHx8XG4gICAgY29kZSA9PT0gMTEgfHxcbiAgICBjb2RlID09PSAxMiB8fFxuICAgIGNvZGUgPT09IDEzIHx8XG4gICAgY29kZSA9PT0gMzJcbiAgKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgbm9ybWFsaXplZCA9IHRyaW1BU0NJSVdoaXRlc3BhY2UocmF3UGF0aCk7XG4gIGlmIChub3JtYWxpemVkID09PSBcIlwiKSB7XG4gICAgcmV0dXJuIFwiL1wiO1xuICB9XG4gIGlmICghbm9ybWFsaXplZC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgIG5vcm1hbGl6ZWQgPSBgLyR7bm9ybWFsaXplZH1gO1xuICB9XG5cbiAgY29uc3Qgc2VnbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBub3JtYWxpemVkLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgc2VnbWVudHMucG9wKCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgc2VnbWVudHMucHVzaChzZWdtZW50KTtcbiAgfVxuICByZXR1cm4gc2VnbWVudHMubGVuZ3RoID09PSAwID8gXCIvXCIgOiBgLyR7c2VnbWVudHMuam9pbihcIi9cIil9YDtcbn1cblxuZnVuY3Rpb24gc3BsaXRQYXRoQmVmb3JlRG90Tm9ybWFsaXphdGlvbihyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0cmltQVNDSUlXaGl0ZXNwYWNlKHJhd1BhdGgpXG4gICAgLnNwbGl0KFwiL1wiKVxuICAgIC5maWx0ZXIoKHNlZ21lbnQpID0+IHNlZ21lbnQgIT09IFwiXCIpO1xufVxuXG5mdW5jdGlvbiBzcGxpdFBhdGgobm9ybWFsaXplZFBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZWRQYXRoID09PSBcIi9cIiA/IFtdIDogbm9ybWFsaXplZFBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xufVxuXG5mdW5jdGlvbiBpc1BhdGhTZWdtZW50KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdHJpbW1lZCA9IHRyaW1BU0NJSVdoaXRlc3BhY2UodmFsdWUpO1xuICByZXR1cm4gKFxuICAgIHRyaW1tZWQgIT09IFwiXCIgJiZcbiAgICB0cmltbWVkICE9PSBcIi5cIiAmJlxuICAgIHRyaW1tZWQgIT09IFwiLi5cIiAmJlxuICAgICF2YWx1ZS5pbmNsdWRlcyhcIi9cIikgJiZcbiAgICAhY29udGFpbnNSZWZ1c2VkUm91dGVQYXRoQnl0ZXModHJpbW1lZClcbiAgKTtcbn1cblxuLy8gQSBwZXJjZW50LWVuY29kZWQgQVNDSUkgY29udHJvbCBieXRlOiAlMDAtJTFGIG9yICU3RiwgaW4gZWl0aGVyIGhleCBjYXNlLlxuLy8gTGl0ZXJhbCBjb250cm9sIGJ5dGVzIGFyZSBhbHJlYWR5IHJlZnVzZWQgYnkgdGhlIGNvZGUtcG9pbnQgc2NhbiBiZWxvdzsgdGhlXG4vLyBlc2NhcGVkIGZvcm0gaXMgcmVmdXNlZCBiZWNhdXNlIGEgZG93bnN0cmVhbSBwcm94eSwgQ0ROLCBvciBjbGllbnQgbWF5XG4vLyBwZXJjZW50LWRlY29kZSB0aGUgcm91dGUgcGF0aCBiZWZvcmUgbWF0Y2hpbmcgaXQsIHdoaWNoIHdvdWxkIGxldCB0aGUgZGVjb2RlZFxuLy8gcm91dGUgZGlmZmVyIGZyb20gdGhlIG1vdW50ZWQgb25lLiBUaGlzIGlzIHRoZSBvbmUgc2hhcmVkIHJ1bGUsIG1pcnJvcmVkIGluXG4vLyBHbyAocnVudGltZS9tY3Byb3V0ZXMgKyBydW50aW1lL29hdXRoKSwgVHlwZVNjcmlwdCwgYW5kIFB5dGhvbi5cbmNvbnN0IFBFUkNFTlRfRU5DT0RFRF9DT05UUk9MX0JZVEVfUEFUVEVSTiA9IC8lWzAxXVswLTlBLUZhLWZdfCU3W0ZmXS91O1xuXG4vLyBjb250YWluc1JlZnVzZWRSb3V0ZVBhdGhCeXRlcyByZXBvcnRzIHdoZXRoZXIgYSByb3V0ZSBwYXRoLCBhbHJlYWR5IHRyaW1tZWQgYXRcbi8vIGl0cyBlZGdlcywgY2FycmllcyB0aGUgYnl0ZXMgdGhlIHJvdXRlIGFsZ2VicmEgcmVmdXNlczogYSBwZXJjZW50LWVuY29kZWRcbi8vIHNsYXNoLCBhIHBlcmNlbnQtZW5jb2RlZCBBU0NJSSBjb250cm9sIGJ5dGUsIGFuIGludGVyaW9yIEFTQ0lJIHdoaXRlc3BhY2Ugb3Jcbi8vIGNvbnRyb2wgY2hhcmFjdGVyLCBvciBhIGJhY2tzbGFzaC5cbmZ1bmN0aW9uIGNvbnRhaW5zUmVmdXNlZFJvdXRlUGF0aEJ5dGVzKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKHZhbHVlLmluY2x1ZGVzKFwiJTJGXCIpIHx8IHZhbHVlLmluY2x1ZGVzKFwiJTJmXCIpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKFBFUkNFTlRfRU5DT0RFRF9DT05UUk9MX0JZVEVfUEFUVEVSTi50ZXN0KHZhbHVlKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB2YWx1ZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBjb2RlID0gdmFsdWUuY2hhckNvZGVBdChpbmRleCk7XG4gICAgaWYgKGNvZGUgPT09IDB4NWMgfHwgY29kZSA8PSAweDFmIHx8IGNvZGUgPT09IDB4MjAgfHwgY29kZSA9PT0gMHg3Zikge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cbiJdfQ==