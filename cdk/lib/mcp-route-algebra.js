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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra", version: "4.3.0" };
    /** MCP route-algebra contract version. */
    static CONTRACT_VERSION = "m17.mcp-route-algebra/v1";
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
        }));
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
        !value.includes("/"));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBbURBOzs7Ozs7R0FNRztBQUNILE1BQXNCLHdCQUF3Qjs7SUFDNUMsMENBQTBDO0lBQ25DLE1BQU0sQ0FBVSxnQkFBZ0IsR0FBRywwQkFBMEIsQ0FBQztJQUVyRSwrQkFBK0I7SUFDeEIsTUFBTSxDQUFVLHVCQUF1QixHQUFHLFdBQVcsQ0FBQztJQUU3RCw4Q0FBOEM7SUFDdkMsTUFBTSxDQUFVLCtCQUErQixHQUFHLG1CQUFtQixDQUFDO0lBRTdFLDJCQUEyQjtJQUNwQixNQUFNLENBQVUsbUJBQW1CLEdBQUcsT0FBTyxDQUFDO0lBRXJELDBDQUEwQztJQUNuQyxNQUFNLENBQVUsMkJBQTJCLEdBQUcsZUFBZSxDQUFDO0lBRXJFLDZDQUE2QztJQUN0QyxNQUFNLENBQVUscUJBQXFCLEdBQUcseUJBQXlCLENBQUM7SUFFekUsNERBQTREO0lBQ3JELE1BQU0sQ0FBVSw2QkFBNkIsR0FDbEQsK0NBQStDLENBQUM7SUFFbEQseUNBQXlDO0lBQ2xDLE1BQU0sQ0FBVSxpQkFBaUIsR0FDdEMsMkNBQTJDLENBQUM7SUFFOUMsd0RBQXdEO0lBQ2pELE1BQU0sQ0FBVSx5QkFBeUIsR0FDOUMsaUVBQWlFLENBQUM7SUFFcEUsbURBQW1EO0lBQzVDLE1BQU0sQ0FBVSx5QkFBeUIsR0FDOUMsdUNBQXVDLENBQUM7SUFFMUMscURBQXFEO0lBQzlDLE1BQU0sQ0FBVSwyQkFBMkIsR0FDaEQseUNBQXlDLENBQUM7SUFFNUMsdUVBQXVFO0lBQ2hFLE1BQU0sQ0FBQyxvQ0FBb0MsQ0FDaEQsWUFBb0I7UUFFcEIsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQy9DLElBQUksVUFBVSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sd0JBQXdCLENBQUMseUJBQXlCLENB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LGNBQWMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDMUUsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLEtBQWE7SUFDbEMsTUFBTSxPQUFPLEdBQUcsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0MsT0FBTyxDQUNMLE9BQU8sS0FBSyxFQUFFO1FBQ2QsT0FBTyxLQUFLLEdBQUc7UUFDZixPQUFPLEtBQUssSUFBSTtRQUNoQixDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQ3JCLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEEgY29uY3JldGUgY2Fub25pY2FsIE1DUCBlbmRwb2ludCBwYXRoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENsaWVudCBuYW1lc3BhY2UgcGF0aCBzZWdtZW50LiAqL1xuICByZWFkb25seSBjbGllbnROYW1lc3BhY2U6IHN0cmluZztcblxuICAvKiogUGFydG5lciBpZGVudGlmaWVyIGZvciBwYXJ0bmVyLXNjb3BlZCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgcGFydG5lcklkPzogc3RyaW5nO1xuXG4gIC8qKiBBZ2VudCBpZGVudGlmaWVyIGZvciBhZ2VudCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgYWdlbnRJZD86IHN0cmluZztcbn1cblxuLyoqIEEgY2Fub25pY2FsIE1DUCByb3V0ZSB0ZW1wbGF0ZSBhbmQgaXRzIHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZSB7XG4gIC8qKiBFbmRwb2ludCBraW5kIGZyb20gdGhlIHZlcnNpb25lZCByb3V0ZS1hbGdlYnJhIHF1YXJ0ZXQuICovXG4gIHJlYWRvbmx5IGtpbmQ6IHN0cmluZztcblxuICAvKiogQ2Fub25pY2FsIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHJvdXRlIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nO1xufVxuXG4vKiogRGVyaXZlZCBPQXV0aCBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXR0ZXJucyBmb3IgYW4gTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgYXV0aG9yaXphdGlvbiBlbmRwb2ludCBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgdG9rZW4gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBDYW5vbmljYWwgYW5kIHN1ZmZpeC1jb21wYXRpYmxlIE9BdXRoIGRpc2NvdmVyeSBwYXR0ZXJucyBmb3IgYW4gTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE9BdXRoRGlzY292ZXJ5VGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgY2Fub25pY2FsIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBjYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHN1ZmZpeFBhdHRlcm46IHN0cmluZztcbn1cblxuLyoqXG4gKiBBcHBUaGVvcnkncyBjYW5vbmljYWwsIHZlcnNpb25lZCBNQ1Agcm91dGUtYWxnZWJyYSBjb250cmFjdC5cbiAqXG4gKiBFdmVyeSBPQXV0aCByb3V0ZSBpcyBkZXJpdmVkIGZyb20gdGhlIGZvdXIgTUNQIHBhdHRlcm5zIHRocm91Z2ggdGhlIHB1cmVcbiAqIGZ1bmN0aW9ucyBvbiB0aGlzIGNsYXNzLiBDb25jcmV0ZSBlbmRwb2ludCBidWlsZGVycyB2YWxpZGF0ZSB0aGUgc2FtZVxuICoga2luZC10by1pZGVudGlmaWVyIGludmFyaWFudHMgYXMgdGhlIEdvIHJ1bnRpbWUgcGFja2FnZS5cbiAqL1xuZXhwb3J0IGFic3RyYWN0IGNsYXNzIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB7XG4gIC8qKiBNQ1Agcm91dGUtYWxnZWJyYSBjb250cmFjdCB2ZXJzaW9uLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IENPTlRSQUNUX1ZFUlNJT04gPSBcIm0xNy5tY3Atcm91dGUtYWxnZWJyYS92MVwiO1xuXG4gIC8qKiBOYW1lc3BhY2UgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX05BTUVTUEFDRSA9IFwibmFtZXNwYWNlXCI7XG5cbiAgLyoqIFBhcnRuZXItc2NvcGVkIG5hbWVzcGFjZSBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UgPSBcInBhcnRuZXJfbmFtZXNwYWNlXCI7XG5cbiAgLyoqIEFnZW50IGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9BR0VOVCA9IFwiYWdlbnRcIjtcblxuICAvKiogUGFydG5lci1zY29wZWQgYWdlbnQgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQgPSBcInBhcnRuZXJfYWdlbnRcIjtcblxuICAvKiogQ2Fub25pY2FsIG5hbWVzcGFjZSBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBOQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPSBcIi97Y2xpZW50X25hbWVzcGFjZX0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBwYXJ0bmVyLXNjb3BlZCBuYW1lc3BhY2UgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9OQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9wYXJ0bmVycy97cGFydG5lcl9pZH0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBhZ2VudCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBBR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L2FnZW50cy97YWdlbnRfaWR9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgcGFydG5lci1zY29wZWQgYWdlbnQgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9BR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L3BhcnRuZXJzL3twYXJ0bmVyX2lkfS9hZ2VudHMve2FnZW50X2lkfS9tY3BcIjtcblxuICAvKiogUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHByZWZpeC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBQUk9URUNURURfUkVTT1VSQ0VfUFJFRklYID1cbiAgICBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIjtcblxuICAvKiogUkZDIDg0MTQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgbWV0YWRhdGEgcHJlZml4LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWCA9XG4gICAgXCIvLndlbGwta25vd24vb2F1dGgtYXV0aG9yaXphdGlvbi1zZXJ2ZXJcIjtcblxuICAvKiogRGVyaXZlIGFuIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChyZXNvdXJjZVBhdGgpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi9cIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVggKyBub3JtYWxpemVkO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgY2Fub25pY2FsIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVggKyBub3JtYWxpemVkO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7QXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCl9L2F1dGhvcml6ZWA7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSB0b2tlbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHtBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKX0vdG9rZW5gO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZCArIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gIH1cblxuICAvKiogUmVjb3ZlciBhIHJlc291cmNlIHBhdGggZnJvbSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZXNvdXJjZVBhdGhGcm9tUHJvdGVjdGVkUmVzb3VyY2VQYXRoKFxuICAgIHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHByb3RlY3RlZFJlc291cmNlUGF0aCk7XG4gICAgY29uc3QgcHJlZml4ID0gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVg7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IHByZWZpeCkge1xuICAgICAgcmV0dXJuIFwiL1wiO1xuICAgIH1cbiAgICBpZiAoIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChgJHtwcmVmaXh9L2ApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIHByb3RlY3RlZCByZXNvdXJjZSBwYXRoICR7SlNPTi5zdHJpbmdpZnkobm9ybWFsaXplZCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVQYXRoKG5vcm1hbGl6ZWQuc2xpY2UocHJlZml4Lmxlbmd0aCkpO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgcHJvdGVjdGVkLXJlc291cmNlIHBhdGggZm9yIGFuIE1DUCBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aEZyb21NY3BQYXRoKG1jcFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBtY3BQYXRoLFxuICAgICk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBtY3BQYXR0ZXJuOiBwYXR0ZXJuLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE9BdXRoIGF1dGhvcml6YXRpb24gZmFjYWRlIHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZE9BdXRoRmFjYWRlVGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE9BdXRoIGRpc2NvdmVyeSB0ZW1wbGF0ZSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRPQXV0aERpc2NvdmVyeVRlbXBsYXRlcygpOiBBcHBUaGVvcnlNY3BPQXV0aERpc2NvdmVyeVRlbXBsYXRlW10ge1xuICAgIHJldHVybiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKS5tYXAoKHsga2luZCwgcGF0dGVybiB9KSA9PiAoe1xuICAgICAga2luZCxcbiAgICAgIGNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgICAgc3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgfSkpO1xuICB9XG5cbiAgLyoqIFBhcnNlIGEgY29uY3JldGUgTUNQIHBhdGggYWZ0ZXIgY29udHJhY3Qgbm9ybWFsaXphdGlvbi4gKi9cbiAgcHVibGljIHN0YXRpYyBwYXJzZU1jcFBhdGgocmF3UGF0aDogc3RyaW5nKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHtcbiAgICBjb25zdCB1bm5vcm1hbGl6ZWRFbmRwb2ludCA9IGVuZHBvaW50RnJvbVNlZ21lbnRzKFxuICAgICAgc3BsaXRQYXRoQmVmb3JlRG90Tm9ybWFsaXphdGlvbihyYXdQYXRoKSxcbiAgICApO1xuICAgIGlmICh1bm5vcm1hbGl6ZWRFbmRwb2ludCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgodW5ub3JtYWxpemVkRW5kcG9pbnQpO1xuICAgICAgcmV0dXJuIHVubm9ybWFsaXplZEVuZHBvaW50O1xuICAgIH1cblxuICAgIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRGcm9tU2VnbWVudHMoc3BsaXRQYXRoKG5vcm1hbGl6ZVBhdGgocmF3UGF0aCkpKTtcbiAgICBpZiAoZW5kcG9pbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBNQ1AgcGF0aCAke0pTT04uc3RyaW5naWZ5KHJhd1BhdGgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICAgIHJldHVybiBlbmRwb2ludDtcbiAgfVxuXG4gIC8qKiBWYWxpZGF0ZSBlbmRwb2ludCBraW5kLXRvLWlkZW50aWZpZXIgY29uc2lzdGVuY3kgYW5kIHBhdGgtc2VnbWVudCBzYWZldHkuICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHZvaWQge1xuICAgIGlmICghaXNQYXRoU2VnbWVudChlbmRwb2ludC5jbGllbnROYW1lc3BhY2UpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwibWNwcm91dGVzOiBjbGllbnROYW1lc3BhY2UgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcGFydG5lcklkID0gZW5kcG9pbnQucGFydG5lcklkID8/IFwiXCI7XG4gICAgY29uc3QgYWdlbnRJZCA9IGVuZHBvaW50LmFnZW50SWQgPz8gXCJcIjtcbiAgICBzd2l0Y2ggKGVuZHBvaW50LmtpbmQpIHtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFOlxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiIHx8IGFnZW50SWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogbmFtZXNwYWNlIGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIHBhcnRuZXIgb3IgYWdlbnQgaWRlbnRpZmllcnNcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0U6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChwYXJ0bmVySWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFnZW50SWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogcGFydG5lciBuYW1lc3BhY2UgZW5kcG9pbnQgY2Fubm90IGluY2x1ZGUgYWdlbnRJZFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVDpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IGFnZW50SWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJ0bmVySWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJtY3Byb3V0ZXM6IGFnZW50IGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIHBhcnRuZXJJZFwiKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQ6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChwYXJ0bmVySWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IGFnZW50SWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBlbmRwb2ludCBraW5kICR7SlNPTi5zdHJpbmdpZnkoZW5kcG9pbnQua2luZCl9YCxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGNvbmNyZXRlIE1DUCBwYXRoIGZvciBhbiBlbmRwb2ludC4gKi9cbiAgcHVibGljIHN0YXRpYyBtY3BQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS52YWxpZGF0ZUVuZHBvaW50UGF0aChlbmRwb2ludCk7XG4gICAgc3dpdGNoIChlbmRwb2ludC5raW5kKSB7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRTpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vcGFydG5lcnMvJHtlbmRwb2ludC5wYXJ0bmVySWR9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5UOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vYWdlbnRzLyR7ZW5kcG9pbnQuYWdlbnRJZH0vbWNwYDtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVDpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L3BhcnRuZXJzLyR7ZW5kcG9pbnQucGFydG5lcklkfS9hZ2VudHMvJHtlbmRwb2ludC5hZ2VudElkfS9tY3BgO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIGVuZHBvaW50IGtpbmQgJHtKU09OLnN0cmluZ2lmeShlbmRwb2ludC5raW5kKX1gLFxuICAgICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGgoXG4gICAgZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGF1dGhvcml6YXRpb24gZmFjYWRlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemVQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyB0b2tlbiBmYWNhZGUgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aFRva2VuUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBzdWZmaXgtY29tcGF0aWJsZSBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpOiBBcnJheTx7IGtpbmQ6IHN0cmluZzsgcGF0dGVybjogc3RyaW5nIH0+IHtcbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuTkFNRVNQQUNFX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUEFSVE5FUl9OQU1FU1BBQ0VfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVCxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BR0VOVF9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUEFSVE5FUl9BR0VOVF9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBlbmRwb2ludEZyb21TZWdtZW50cyhcbiAgc2VnbWVudHM6IHN0cmluZ1tdLFxuKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMiAmJiBzZWdtZW50c1sxXSA9PT0gXCJtY3BcIikge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgIH07XG4gIH1cbiAgaWYgKFxuICAgIHNlZ21lbnRzLmxlbmd0aCA9PT0gNCAmJlxuICAgIHNlZ21lbnRzWzFdID09PSBcInBhcnRuZXJzXCIgJiZcbiAgICBzZWdtZW50c1szXSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgcGFydG5lcklkOiBzZWdtZW50c1syXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDQgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJhZ2VudHNcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcIm1jcFwiXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVCxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICBhZ2VudElkOiBzZWdtZW50c1syXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDYgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJwYXJ0bmVyc1wiICYmXG4gICAgc2VnbWVudHNbM10gPT09IFwiYWdlbnRzXCIgJiZcbiAgICBzZWdtZW50c1s1XSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVCxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICBwYXJ0bmVySWQ6IHNlZ21lbnRzWzJdLFxuICAgICAgYWdlbnRJZDogc2VnbWVudHNbNF0sXG4gICAgfTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB0cmltQVNDSUlXaGl0ZXNwYWNlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgc3RhcnQgPSAwO1xuICB3aGlsZSAoXG4gICAgc3RhcnQgPCB2YWx1ZS5sZW5ndGggJiZcbiAgICBpc0FTQ0lJV2hpdGVzcGFjZUNvZGUodmFsdWUuY2hhckNvZGVBdChzdGFydCkpXG4gICkge1xuICAgIHN0YXJ0ICs9IDE7XG4gIH1cblxuICBsZXQgZW5kID0gdmFsdWUubGVuZ3RoO1xuICB3aGlsZSAoZW5kID4gc3RhcnQgJiYgaXNBU0NJSVdoaXRlc3BhY2VDb2RlKHZhbHVlLmNoYXJDb2RlQXQoZW5kIC0gMSkpKSB7XG4gICAgZW5kIC09IDE7XG4gIH1cblxuICByZXR1cm4gdmFsdWUuc2xpY2Uoc3RhcnQsIGVuZCk7XG59XG5cbmZ1bmN0aW9uIGlzQVNDSUlXaGl0ZXNwYWNlQ29kZShjb2RlOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBjb2RlID09PSA5IHx8XG4gICAgY29kZSA9PT0gMTAgfHxcbiAgICBjb2RlID09PSAxMSB8fFxuICAgIGNvZGUgPT09IDEyIHx8XG4gICAgY29kZSA9PT0gMTMgfHxcbiAgICBjb2RlID09PSAzMlxuICApO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBub3JtYWxpemVkID0gdHJpbUFTQ0lJV2hpdGVzcGFjZShyYXdQYXRoKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiXCIpIHtcbiAgICByZXR1cm4gXCIvXCI7XG4gIH1cbiAgaWYgKCFub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgbm9ybWFsaXplZCA9IGAvJHtub3JtYWxpemVkfWA7XG4gIH1cblxuICBjb25zdCBzZWdtZW50czogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIG5vcm1hbGl6ZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiXCIgfHwgc2VnbWVudCA9PT0gXCIuXCIpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuLlwiKSB7XG4gICAgICBzZWdtZW50cy5wb3AoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBzZWdtZW50cy5wdXNoKHNlZ21lbnQpO1xuICB9XG4gIHJldHVybiBzZWdtZW50cy5sZW5ndGggPT09IDAgPyBcIi9cIiA6IGAvJHtzZWdtZW50cy5qb2luKFwiL1wiKX1gO1xufVxuXG5mdW5jdGlvbiBzcGxpdFBhdGhCZWZvcmVEb3ROb3JtYWxpemF0aW9uKHJhd1BhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRyaW1BU0NJSVdoaXRlc3BhY2UocmF3UGF0aClcbiAgICAuc3BsaXQoXCIvXCIpXG4gICAgLmZpbHRlcigoc2VnbWVudCkgPT4gc2VnbWVudCAhPT0gXCJcIik7XG59XG5cbmZ1bmN0aW9uIHNwbGl0UGF0aChub3JtYWxpemVkUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gbm9ybWFsaXplZFBhdGggPT09IFwiL1wiID8gW10gOiBub3JtYWxpemVkUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIik7XG59XG5cbmZ1bmN0aW9uIGlzUGF0aFNlZ21lbnQodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB0cmltbWVkID0gdHJpbUFTQ0lJV2hpdGVzcGFjZSh2YWx1ZSk7XG4gIHJldHVybiAoXG4gICAgdHJpbW1lZCAhPT0gXCJcIiAmJlxuICAgIHRyaW1tZWQgIT09IFwiLlwiICYmXG4gICAgdHJpbW1lZCAhPT0gXCIuLlwiICYmXG4gICAgIXZhbHVlLmluY2x1ZGVzKFwiL1wiKVxuICApO1xufVxuIl19