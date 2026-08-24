"use strict";
var _a;
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMcpRouteAlgebra[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra", version: "4.0.0" };
/** MCP route-algebra contract version. */
AppTheoryMcpRouteAlgebra.CONTRACT_VERSION = "m17.mcp-route-algebra/v1";
/** Namespace endpoint kind. */
AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE = "namespace";
/** Partner-scoped namespace endpoint kind. */
AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE = "partner_namespace";
/** Agent endpoint kind. */
AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT = "agent";
/** Partner-scoped agent endpoint kind. */
AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT = "partner_agent";
/** Canonical namespace MCP route pattern. */
AppTheoryMcpRouteAlgebra.NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";
/** Canonical partner-scoped namespace MCP route pattern. */
AppTheoryMcpRouteAlgebra.PARTNER_NAMESPACE_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/mcp";
/** Canonical agent MCP route pattern. */
AppTheoryMcpRouteAlgebra.AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp";
/** Canonical partner-scoped agent MCP route pattern. */
AppTheoryMcpRouteAlgebra.PARTNER_AGENT_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";
/** RFC 9728 protected-resource metadata prefix. */
AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";
/** RFC 8414 authorization-server metadata prefix. */
AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQW1EQTs7Ozs7O0dBTUc7QUFDSCxNQUFzQix3QkFBd0I7SUF1QzVDLHVFQUF1RTtJQUNoRSxNQUFNLENBQUMsb0NBQW9DLENBQ2hELFlBQW9CO1FBRXBCLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUMvQyxJQUFJLFVBQVUsS0FBSyxHQUFHLEVBQUUsQ0FBQztZQUN2QixPQUFPLHdCQUF3QixDQUFDLHlCQUF5QixDQUFDO1FBQzVELENBQUM7UUFDRCxPQUFPLHdCQUF3QixDQUFDLHlCQUF5QixHQUFHLFVBQVUsQ0FBQztJQUN6RSxDQUFDO0lBRUQseUVBQXlFO0lBQ2xFLE1BQU0sQ0FBQyxzQ0FBc0MsQ0FDbEQsWUFBb0I7UUFFcEIsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQy9DLElBQUksVUFBVSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sd0JBQXdCLENBQUMsMkJBQTJCLENBQUM7UUFDOUQsQ0FBQztRQUNELE9BQU8sd0JBQXdCLENBQUMsMkJBQTJCLEdBQUcsVUFBVSxDQUFDO0lBQzNFLENBQUM7SUFFRCxpRUFBaUU7SUFDMUQsTUFBTSxDQUFDLHlDQUF5QyxDQUNyRCxZQUFvQjtRQUVwQixPQUFPLEdBQUcsd0JBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQztJQUN0RyxDQUFDO0lBRUQseURBQXlEO0lBQ2xELE1BQU0sQ0FBQyxxQ0FBcUMsQ0FDakQsWUFBb0I7UUFFcEIsT0FBTyxHQUFHLHdCQUF3QixDQUFDLHNDQUFzQyxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUM7SUFDbEcsQ0FBQztJQUVELGlGQUFpRjtJQUMxRSxNQUFNLENBQUMsNENBQTRDLENBQ3hELFlBQW9C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QUFDO0FBQzFFLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxLQUFhO0lBQ2xDLE1BQU0sT0FBTyxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzNDLE9BQU8sQ0FDTCxPQUFPLEtBQUssRUFBRTtRQUNkLE9BQU8sS0FBSyxHQUFHO1FBQ2YsT0FBTyxLQUFLLElBQUk7UUFDaEIsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUNyQixDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBBIGNvbmNyZXRlIGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgcGF0aC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBDbGllbnQgbmFtZXNwYWNlIHBhdGggc2VnbWVudC4gKi9cbiAgcmVhZG9ubHkgY2xpZW50TmFtZXNwYWNlOiBzdHJpbmc7XG5cbiAgLyoqIFBhcnRuZXIgaWRlbnRpZmllciBmb3IgcGFydG5lci1zY29wZWQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IHBhcnRuZXJJZD86IHN0cmluZztcblxuICAvKiogQWdlbnQgaWRlbnRpZmllciBmb3IgYWdlbnQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IGFnZW50SWQ/OiBzdHJpbmc7XG59XG5cbi8qKiBBIGNhbm9uaWNhbCBNQ1Agcm91dGUgdGVtcGxhdGUgYW5kIGl0cyBwcm90ZWN0ZWQtcmVzb3VyY2Ugcm91dGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEVuZHBvaW50VGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENhbm9uaWNhbCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6IHN0cmluZztcbn1cblxuLyoqIERlcml2ZWQgT0F1dGggYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aEZhY2FkZVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGF1dGhvcml6YXRpb24gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHRva2VuIGVuZHBvaW50IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogQ2Fub25pY2FsIGFuZCBzdWZmaXgtY29tcGF0aWJsZSBPQXV0aCBkaXNjb3ZlcnkgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aERpc2NvdmVyeVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgY2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHN1ZmZpeC1jb21wYXRpYmxlIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBzdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQXBwVGhlb3J5J3MgY2Fub25pY2FsLCB2ZXJzaW9uZWQgTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QuXG4gKlxuICogRXZlcnkgT0F1dGggcm91dGUgaXMgZGVyaXZlZCBmcm9tIHRoZSBmb3VyIE1DUCBwYXR0ZXJucyB0aHJvdWdoIHRoZSBwdXJlXG4gKiBmdW5jdGlvbnMgb24gdGhpcyBjbGFzcy4gQ29uY3JldGUgZW5kcG9pbnQgYnVpbGRlcnMgdmFsaWRhdGUgdGhlIHNhbWVcbiAqIGtpbmQtdG8taWRlbnRpZmllciBpbnZhcmlhbnRzIGFzIHRoZSBHbyBydW50aW1lIHBhY2thZ2UuXG4gKi9cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEge1xuICAvKiogTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QgdmVyc2lvbi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBDT05UUkFDVF9WRVJTSU9OID0gXCJtMTcubWNwLXJvdXRlLWFsZ2VicmEvdjFcIjtcblxuICAvKiogTmFtZXNwYWNlIGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UgPSBcIm5hbWVzcGFjZVwiO1xuXG4gIC8qKiBQYXJ0bmVyLXNjb3BlZCBuYW1lc3BhY2UgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFID0gXCJwYXJ0bmVyX25hbWVzcGFjZVwiO1xuXG4gIC8qKiBBZ2VudCBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfQUdFTlQgPSBcImFnZW50XCI7XG5cbiAgLyoqIFBhcnRuZXItc2NvcGVkIGFnZW50IGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5UID0gXCJwYXJ0bmVyX2FnZW50XCI7XG5cbiAgLyoqIENhbm9uaWNhbCBuYW1lc3BhY2UgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgTkFNRVNQQUNFX01DUF9QQVRURVJOID0gXCIve2NsaWVudF9uYW1lc3BhY2V9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgcGFydG5lci1zY29wZWQgbmFtZXNwYWNlIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IFBBUlRORVJfTkFNRVNQQUNFX01DUF9QQVRURVJOID1cbiAgICBcIi97Y2xpZW50X25hbWVzcGFjZX0vcGFydG5lcnMve3BhcnRuZXJfaWR9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgYWdlbnQgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgQUdFTlRfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9hZ2VudHMve2FnZW50X2lkfS9tY3BcIjtcblxuICAvKiogQ2Fub25pY2FsIHBhcnRuZXItc2NvcGVkIGFnZW50IE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IFBBUlRORVJfQUdFTlRfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9wYXJ0bmVycy97cGFydG5lcl9pZH0vYWdlbnRzL3thZ2VudF9pZH0vbWNwXCI7XG5cbiAgLyoqIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBtZXRhZGF0YSBwcmVmaXguICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWCA9XG4gICAgXCIvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlXCI7XG5cbiAgLyoqIFJGQyA4NDE0IGF1dGhvcml6YXRpb24tc2VydmVyIG1ldGFkYXRhIHByZWZpeC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBBVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVggPVxuICAgIFwiLy53ZWxsLWtub3duL29hdXRoLWF1dGhvcml6YXRpb24tc2VydmVyXCI7XG5cbiAgLyoqIERlcml2ZSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYICsgbm9ybWFsaXplZDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChyZXNvdXJjZVBhdGgpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi9cIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYICsgbm9ybWFsaXplZDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIGF1dGhvcml6YXRpb24gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS9hdXRob3JpemVgO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgdG9rZW4gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7QXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCl9L3Rva2VuYDtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIHN1ZmZpeC1jb21wYXRpYmxlIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIG5vcm1hbGl6ZWQgKyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICB9XG5cbiAgLyoqIFJlY292ZXIgYSByZXNvdXJjZSBwYXRoIGZyb20gYW4gUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgcmVzb3VyY2VQYXRoRnJvbVByb3RlY3RlZFJlc291cmNlUGF0aChcbiAgICBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChwcm90ZWN0ZWRSZXNvdXJjZVBhdGgpO1xuICAgIGNvbnN0IHByZWZpeCA9IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYO1xuICAgIGlmIChub3JtYWxpemVkID09PSBwcmVmaXgpIHtcbiAgICAgIHJldHVybiBcIi9cIjtcbiAgICB9XG4gICAgaWYgKCFub3JtYWxpemVkLnN0YXJ0c1dpdGgoYCR7cHJlZml4fS9gKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBwcm90ZWN0ZWQgcmVzb3VyY2UgcGF0aCAke0pTT04uc3RyaW5naWZ5KG5vcm1hbGl6ZWQpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplUGF0aChub3JtYWxpemVkLnNsaWNlKHByZWZpeC5sZW5ndGgpKTtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoIGZvciBhbiBNQ1AgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGhGcm9tTWNwUGF0aChtY3BQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgbWNwUGF0aCxcbiAgICApO1xuICB9XG5cbiAgLyoqIFJldHVybiBldmVyeSBjYW5vbmljYWwgTUNQIGVuZHBvaW50IHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcEVuZHBvaW50VGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgbWNwUGF0dGVybjogcGF0dGVybixcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0aDpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChwYXR0ZXJuKSxcbiAgICB9KSk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBPQXV0aCBhdXRob3JpemF0aW9uIGZhY2FkZSB0ZW1wbGF0ZSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRPQXV0aEZhY2FkZVRlbXBsYXRlcygpOiBBcHBUaGVvcnlNY3BPQXV0aEZhY2FkZVRlbXBsYXRlW10ge1xuICAgIHJldHVybiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKS5tYXAoKHsga2luZCwgcGF0dGVybiB9KSA9PiAoe1xuICAgICAga2luZCxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgICAgdG9rZW5QYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChwYXR0ZXJuKSxcbiAgICB9KSk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBPQXV0aCBkaXNjb3ZlcnkgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkT0F1dGhEaXNjb3ZlcnlUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwT0F1dGhEaXNjb3ZlcnlUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBjYW5vbmljYWxQYXR0ZXJuOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICAgICAgcGF0dGVybixcbiAgICAgICAgKSxcbiAgICAgIHN1ZmZpeFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBQYXJzZSBhIGNvbmNyZXRlIE1DUCBwYXRoIGFmdGVyIGNvbnRyYWN0IG5vcm1hbGl6YXRpb24uICovXG4gIHB1YmxpYyBzdGF0aWMgcGFyc2VNY3BQYXRoKHJhd1BhdGg6IHN0cmluZyk6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCB7XG4gICAgY29uc3QgdW5ub3JtYWxpemVkRW5kcG9pbnQgPSBlbmRwb2ludEZyb21TZWdtZW50cyhcbiAgICAgIHNwbGl0UGF0aEJlZm9yZURvdE5vcm1hbGl6YXRpb24ocmF3UGF0aCksXG4gICAgKTtcbiAgICBpZiAodW5ub3JtYWxpemVkRW5kcG9pbnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnZhbGlkYXRlRW5kcG9pbnRQYXRoKHVubm9ybWFsaXplZEVuZHBvaW50KTtcbiAgICAgIHJldHVybiB1bm5vcm1hbGl6ZWRFbmRwb2ludDtcbiAgICB9XG5cbiAgICBjb25zdCBlbmRwb2ludCA9IGVuZHBvaW50RnJvbVNlZ21lbnRzKHNwbGl0UGF0aChub3JtYWxpemVQYXRoKHJhd1BhdGgpKSk7XG4gICAgaWYgKGVuZHBvaW50ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgTUNQIHBhdGggJHtKU09OLnN0cmluZ2lmeShyYXdQYXRoKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnZhbGlkYXRlRW5kcG9pbnRQYXRoKGVuZHBvaW50KTtcbiAgICByZXR1cm4gZW5kcG9pbnQ7XG4gIH1cblxuICAvKiogVmFsaWRhdGUgZW5kcG9pbnQga2luZC10by1pZGVudGlmaWVyIGNvbnNpc3RlbmN5IGFuZCBwYXRoLXNlZ21lbnQgc2FmZXR5LiAqL1xuICBwdWJsaWMgc3RhdGljIHZhbGlkYXRlRW5kcG9pbnRQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiB2b2lkIHtcbiAgICBpZiAoIWlzUGF0aFNlZ21lbnQoZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIm1jcHJvdXRlczogY2xpZW50TmFtZXNwYWNlIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHBhcnRuZXJJZCA9IGVuZHBvaW50LnBhcnRuZXJJZCA/PyBcIlwiO1xuICAgIGNvbnN0IGFnZW50SWQgPSBlbmRwb2ludC5hZ2VudElkID8/IFwiXCI7XG4gICAgc3dpdGNoIChlbmRwb2ludC5raW5kKSB7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRTpcbiAgICAgICAgaWYgKHBhcnRuZXJJZCAhPT0gXCJcIiB8fCBhZ2VudElkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IG5hbWVzcGFjZSBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBwYXJ0bmVyIG9yIGFnZW50IGlkZW50aWZpZXJzXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQocGFydG5lcklkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBwYXJ0bmVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhZ2VudElkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXIgbmFtZXNwYWNlIGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIGFnZW50SWRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQ6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChhZ2VudElkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBhZ2VudElkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibWNwcm91dGVzOiBhZ2VudCBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBwYXJ0bmVySWRcIik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5UOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQocGFydG5lcklkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBwYXJ0bmVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChhZ2VudElkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIFwibWNwcm91dGVzOiBhZ2VudElkIG11c3QgYmUgYSBub24tZW1wdHkgcGF0aCBzZWdtZW50XCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYG1jcHJvdXRlczogdW5zdXBwb3J0ZWQgZW5kcG9pbnQga2luZCAke0pTT04uc3RyaW5naWZ5KGVuZHBvaW50LmtpbmQpfWAsXG4gICAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBjb25jcmV0ZSBNQ1AgcGF0aCBmb3IgYW4gZW5kcG9pbnQuICovXG4gIHB1YmxpYyBzdGF0aWMgbWNwUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICAgIHN3aXRjaCAoZW5kcG9pbnQua2luZCkge1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0U6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9tY3BgO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRTpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L3BhcnRuZXJzLyR7ZW5kcG9pbnQucGFydG5lcklkfS9tY3BgO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVDpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L2FnZW50cy8ke2VuZHBvaW50LmFnZW50SWR9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQ6XG4gICAgICAgIHJldHVybiBgLyR7ZW5kcG9pbnQuY2xpZW50TmFtZXNwYWNlfS9wYXJ0bmVycy8ke2VuZHBvaW50LnBhcnRuZXJJZH0vYWdlbnRzLyR7ZW5kcG9pbnQuYWdlbnRJZH0vbWNwYDtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBlbmRwb2ludCBraW5kICR7SlNPTi5zdHJpbmdpZnkoZW5kcG9pbnQua2luZCl9YCxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgcHJvdGVjdGVkUmVzb3VyY2VQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBjYW5vbmljYWwgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemF0aW9uU2VydmVyUGF0aChcbiAgICBlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoQXV0aG9yaXplUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgdG9rZW4gZmFjYWRlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhUb2tlblBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3Mgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aChcbiAgICBlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKTogQXJyYXk8eyBraW5kOiBzdHJpbmc7IHBhdHRlcm46IHN0cmluZyB9PiB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFLFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLk5BTUVTUEFDRV9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFLFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBBUlRORVJfTkFNRVNQQUNFX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQUdFTlRfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5ULFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBBUlRORVJfQUdFTlRfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gZW5kcG9pbnRGcm9tU2VnbWVudHMoXG4gIHNlZ21lbnRzOiBzdHJpbmdbXSxcbik6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCB8IHVuZGVmaW5lZCB7XG4gIGlmIChzZWdtZW50cy5sZW5ndGggPT09IDIgJiYgc2VnbWVudHNbMV0gPT09IFwibWNwXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFLFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDQgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJwYXJ0bmVyc1wiICYmXG4gICAgc2VnbWVudHNbM10gPT09IFwibWNwXCJcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFLFxuICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICAgIHBhcnRuZXJJZDogc2VnbWVudHNbMl0sXG4gICAgfTtcbiAgfVxuICBpZiAoXG4gICAgc2VnbWVudHMubGVuZ3RoID09PSA0ICYmXG4gICAgc2VnbWVudHNbMV0gPT09IFwiYWdlbnRzXCIgJiZcbiAgICBzZWdtZW50c1szXSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfQUdFTlQsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgYWdlbnRJZDogc2VnbWVudHNbMl0sXG4gICAgfTtcbiAgfVxuICBpZiAoXG4gICAgc2VnbWVudHMubGVuZ3RoID09PSA2ICYmXG4gICAgc2VnbWVudHNbMV0gPT09IFwicGFydG5lcnNcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcImFnZW50c1wiICYmXG4gICAgc2VnbWVudHNbNV0gPT09IFwibWNwXCJcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgcGFydG5lcklkOiBzZWdtZW50c1syXSxcbiAgICAgIGFnZW50SWQ6IHNlZ21lbnRzWzRdLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdHJpbUFTQ0lJV2hpdGVzcGFjZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKFxuICAgIHN0YXJ0IDwgdmFsdWUubGVuZ3RoICYmXG4gICAgaXNBU0NJSVdoaXRlc3BhY2VDb2RlKHZhbHVlLmNoYXJDb2RlQXQoc3RhcnQpKVxuICApIHtcbiAgICBzdGFydCArPSAxO1xuICB9XG5cbiAgbGV0IGVuZCA9IHZhbHVlLmxlbmd0aDtcbiAgd2hpbGUgKGVuZCA+IHN0YXJ0ICYmIGlzQVNDSUlXaGl0ZXNwYWNlQ29kZSh2YWx1ZS5jaGFyQ29kZUF0KGVuZCAtIDEpKSkge1xuICAgIGVuZCAtPSAxO1xuICB9XG5cbiAgcmV0dXJuIHZhbHVlLnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiBpc0FTQ0lJV2hpdGVzcGFjZUNvZGUoY29kZTogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgY29kZSA9PT0gOSB8fFxuICAgIGNvZGUgPT09IDEwIHx8XG4gICAgY29kZSA9PT0gMTEgfHxcbiAgICBjb2RlID09PSAxMiB8fFxuICAgIGNvZGUgPT09IDEzIHx8XG4gICAgY29kZSA9PT0gMzJcbiAgKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGF0aChyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgbm9ybWFsaXplZCA9IHRyaW1BU0NJSVdoaXRlc3BhY2UocmF3UGF0aCk7XG4gIGlmIChub3JtYWxpemVkID09PSBcIlwiKSB7XG4gICAgcmV0dXJuIFwiL1wiO1xuICB9XG4gIGlmICghbm9ybWFsaXplZC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgIG5vcm1hbGl6ZWQgPSBgLyR7bm9ybWFsaXplZH1gO1xuICB9XG5cbiAgY29uc3Qgc2VnbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBub3JtYWxpemVkLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgc2VnbWVudHMucG9wKCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgc2VnbWVudHMucHVzaChzZWdtZW50KTtcbiAgfVxuICByZXR1cm4gc2VnbWVudHMubGVuZ3RoID09PSAwID8gXCIvXCIgOiBgLyR7c2VnbWVudHMuam9pbihcIi9cIil9YDtcbn1cblxuZnVuY3Rpb24gc3BsaXRQYXRoQmVmb3JlRG90Tm9ybWFsaXphdGlvbihyYXdQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB0cmltQVNDSUlXaGl0ZXNwYWNlKHJhd1BhdGgpXG4gICAgLnNwbGl0KFwiL1wiKVxuICAgIC5maWx0ZXIoKHNlZ21lbnQpID0+IHNlZ21lbnQgIT09IFwiXCIpO1xufVxuXG5mdW5jdGlvbiBzcGxpdFBhdGgobm9ybWFsaXplZFBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZWRQYXRoID09PSBcIi9cIiA/IFtdIDogbm9ybWFsaXplZFBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xufVxuXG5mdW5jdGlvbiBpc1BhdGhTZWdtZW50KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdHJpbW1lZCA9IHRyaW1BU0NJSVdoaXRlc3BhY2UodmFsdWUpO1xuICByZXR1cm4gKFxuICAgIHRyaW1tZWQgIT09IFwiXCIgJiZcbiAgICB0cmltbWVkICE9PSBcIi5cIiAmJlxuICAgIHRyaW1tZWQgIT09IFwiLi5cIiAmJlxuICAgICF2YWx1ZS5pbmNsdWRlcyhcIi9cIilcbiAgKTtcbn1cbiJdfQ==