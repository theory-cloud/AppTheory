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
            throw new Error(`routing: unsupported protected resource path ${JSON.stringify(normalized)}`);
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
        const segments = splitPath(normalizePath(rawPath));
        let endpoint;
        if (segments.length === 2 && segments[1] === "mcp") {
            endpoint = {
                kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE,
                clientNamespace: segments[0],
            };
        }
        else if (segments.length === 4 &&
            segments[1] === "partners" &&
            segments[3] === "mcp") {
            endpoint = {
                kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
                clientNamespace: segments[0],
                partnerId: segments[2],
            };
        }
        else if (segments.length === 4 &&
            segments[1] === "agents" &&
            segments[3] === "mcp") {
            endpoint = {
                kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT,
                clientNamespace: segments[0],
                agentId: segments[2],
            };
        }
        else if (segments.length === 6 &&
            segments[1] === "partners" &&
            segments[3] === "agents" &&
            segments[5] === "mcp") {
            endpoint = {
                kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT,
                clientNamespace: segments[0],
                partnerId: segments[2],
                agentId: segments[4],
            };
        }
        if (endpoint === undefined) {
            throw new Error(`routing: unsupported MCP path ${JSON.stringify(rawPath)}`);
        }
        AppTheoryMcpRouteAlgebra.validateEndpointPath(endpoint);
        return endpoint;
    }
    /** Validate endpoint kind-to-identifier consistency and path-segment safety. */
    static validateEndpointPath(endpoint) {
        if (!isPathSegment(endpoint.clientNamespace)) {
            throw new Error("routing: clientNamespace must be a non-empty path segment");
        }
        const partnerId = endpoint.partnerId ?? "";
        const agentId = endpoint.agentId ?? "";
        switch (endpoint.kind) {
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE:
                if (partnerId !== "" || agentId !== "") {
                    throw new Error("routing: namespace endpoint cannot include partner or agent identifiers");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE:
                if (!isPathSegment(partnerId)) {
                    throw new Error("routing: partnerId must be a non-empty path segment");
                }
                if (agentId !== "") {
                    throw new Error("routing: partner namespace endpoint cannot include agentId");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT:
                if (!isPathSegment(agentId)) {
                    throw new Error("routing: agentId must be a non-empty path segment");
                }
                if (partnerId !== "") {
                    throw new Error("routing: agent endpoint cannot include partnerId");
                }
                return;
            case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_AGENT:
                if (!isPathSegment(partnerId)) {
                    throw new Error("routing: partnerId must be a non-empty path segment");
                }
                if (!isPathSegment(agentId)) {
                    throw new Error("routing: agentId must be a non-empty path segment");
                }
                return;
            default:
                throw new Error(`routing: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`);
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
                throw new Error(`routing: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`);
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
AppTheoryMcpRouteAlgebra[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpRouteAlgebra", version: "3.1.1" };
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
function normalizePath(rawPath) {
    let normalized = rawPath.trim();
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
function splitPath(normalizedPath) {
    return normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
}
function isPathSegment(value) {
    return value.trim() !== "" && !value.includes("/");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQW1EQTs7Ozs7O0dBTUc7QUFDSCxNQUFzQix3QkFBd0I7SUF1QzVDLHVFQUF1RTtJQUNoRSxNQUFNLENBQUMsb0NBQW9DLENBQUMsWUFBb0I7UUFDckUsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQy9DLElBQUksVUFBVSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sd0JBQXdCLENBQUMseUJBQXlCLENBQUM7UUFDNUQsQ0FBQztRQUNELE9BQU8sd0JBQXdCLENBQUMseUJBQXlCLEdBQUcsVUFBVSxDQUFDO0lBQ3pFLENBQUM7SUFFRCx5RUFBeUU7SUFDbEUsTUFBTSxDQUFDLHNDQUFzQyxDQUFDLFlBQW9CO1FBQ3ZFLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUMvQyxJQUFJLFVBQVUsS0FBSyxHQUFHLEVBQUUsQ0FBQztZQUN2QixPQUFPLHdCQUF3QixDQUFDLDJCQUEyQixDQUFDO1FBQzlELENBQUM7UUFDRCxPQUFPLHdCQUF3QixDQUFDLDJCQUEyQixHQUFHLFVBQVUsQ0FBQztJQUMzRSxDQUFDO0lBRUQsaUVBQWlFO0lBQzFELE1BQU0sQ0FBQyx5Q0FBeUMsQ0FBQyxZQUFvQjtRQUMxRSxPQUFPLEdBQUcsd0JBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQztJQUN0RyxDQUFDO0lBRUQseURBQXlEO0lBQ2xELE1BQU0sQ0FBQyxxQ0FBcUMsQ0FBQyxZQUFvQjtRQUN0RSxPQUFPLEdBQUcsd0JBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQztJQUNsRyxDQUFDO0lBRUQsaUZBQWlGO0lBQzFFLE1BQU0sQ0FBQyw0Q0FBNEMsQ0FBQyxZQUFvQjtRQUM3RSxNQUFNLFVBQVUsR0FBRyxhQUFhLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDL0MsSUFBSSxVQUFVLEtBQUssR0FBRyxFQUFFLENBQUM7WUFDdkIsT0FBTyx3QkFBd0IsQ0FBQywyQkFBMkIsQ0FBQztRQUM5RCxDQUFDO1FBQ0QsT0FBTyxVQUFVLEdBQUcsd0JBQXdCLENBQUMsMkJBQTJCLENBQUM7SUFDM0UsQ0FBQztJQUVELHdFQUF3RTtJQUNqRSxNQUFNLENBQUMscUNBQXFDLENBQUMscUJBQTZCO1FBQy9FLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQ3hELE1BQU0sTUFBTSxHQUFHLHdCQUF3QixDQUFDLHlCQUF5QixDQUFDO1FBQ2xFLElBQUksVUFBVSxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQzFCLE9BQU8sR0FBRyxDQUFDO1FBQ2IsQ0FBQztRQUNELElBQUksQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3pDLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0RBQWdELElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2hHLENBQUM7UUFDRCxPQUFPLGFBQWEsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFFRCwwREFBMEQ7SUFDbkQsTUFBTSxDQUFDLGdDQUFnQyxDQUFDLE9BQWU7UUFDNUQsT0FBTyx3QkFBd0IsQ0FBQyxvQ0FBb0MsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNoRixDQUFDO0lBRUQsc0VBQXNFO0lBQy9ELE1BQU0sQ0FBQywwQkFBMEI7UUFDdEMsT0FBTyxxQkFBcUIsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ3pELElBQUk7WUFDSixVQUFVLEVBQUUsT0FBTztZQUNuQixxQkFBcUIsRUFDbkIsd0JBQXdCLENBQUMsb0NBQW9DLENBQUMsT0FBTyxDQUFDO1NBQ3pFLENBQUMsQ0FBQyxDQUFDO0lBQ04sQ0FBQztJQUVELG9GQUFvRjtJQUM3RSxNQUFNLENBQUMsNkJBQTZCO1FBQ3pDLE9BQU8scUJBQXFCLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUN6RCxJQUFJO1lBQ0osZ0JBQWdCLEVBQ2Qsd0JBQXdCLENBQUMseUNBQXlDLENBQUMsT0FBTyxDQUFDO1lBQzdFLFlBQVksRUFDVix3QkFBd0IsQ0FBQyxxQ0FBcUMsQ0FBQyxPQUFPLENBQUM7U0FDMUUsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0lBRUQseUVBQXlFO0lBQ2xFLE1BQU0sQ0FBQyxnQ0FBZ0M7UUFDNUMsT0FBTyxxQkFBcUIsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ3pELElBQUk7WUFDSixnQkFBZ0IsRUFDZCx3QkFBd0IsQ0FBQyxzQ0FBc0MsQ0FBQyxPQUFPLENBQUM7WUFDMUUsYUFBYSxFQUNYLHdCQUF3QixDQUFDLDRDQUE0QyxDQUFDLE9BQU8sQ0FBQztTQUNqRixDQUFDLENBQUMsQ0FBQztJQUNOLENBQUM7SUFFRCw4REFBOEQ7SUFDdkQsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFlO1FBQ3hDLE1BQU0sUUFBUSxHQUFHLFNBQVMsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztRQUNuRCxJQUFJLFFBQThDLENBQUM7UUFFbkQsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDbkQsUUFBUSxHQUFHO2dCQUNULElBQUksRUFBRSx3QkFBd0IsQ0FBQyx1QkFBdUI7Z0JBQ3RELGVBQWUsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO2FBQzdCLENBQUM7UUFDSixDQUFDO2FBQU0sSUFDTCxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUM7WUFDckIsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLFVBQVU7WUFDMUIsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssRUFDckIsQ0FBQztZQUNELFFBQVEsR0FBRztnQkFDVCxJQUFJLEVBQUUsd0JBQXdCLENBQUMsK0JBQStCO2dCQUM5RCxlQUFlLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztnQkFDNUIsU0FBUyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7YUFDdkIsQ0FBQztRQUNKLENBQUM7YUFBTSxJQUNMLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQztZQUNyQixRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUTtZQUN4QixRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxFQUNyQixDQUFDO1lBQ0QsUUFBUSxHQUFHO2dCQUNULElBQUksRUFBRSx3QkFBd0IsQ0FBQyxtQkFBbUI7Z0JBQ2xELGVBQWUsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO2dCQUM1QixPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQzthQUNyQixDQUFDO1FBQ0osQ0FBQzthQUFNLElBQ0wsUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQ3JCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxVQUFVO1lBQzFCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRO1lBQ3hCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLEVBQ3JCLENBQUM7WUFDRCxRQUFRLEdBQUc7Z0JBQ1QsSUFBSSxFQUFFLHdCQUF3QixDQUFDLDJCQUEyQjtnQkFDMUQsZUFBZSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7Z0JBQzVCLFNBQVMsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO2dCQUN0QixPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQzthQUNyQixDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLE1BQU0sSUFBSSxLQUFLLENBQUMsaUNBQWlDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzlFLENBQUM7UUFDRCx3QkFBd0IsQ0FBQyxvQkFBb0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN4RCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBRUQsZ0ZBQWdGO0lBQ3pFLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxRQUFrQztRQUNuRSxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxDQUFDO1lBQzdDLE1BQU0sSUFBSSxLQUFLLENBQUMsMkRBQTJELENBQUMsQ0FBQztRQUMvRSxDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUM7UUFDM0MsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDdkMsUUFBUSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDdEIsS0FBSyx3QkFBd0IsQ0FBQyx1QkFBdUI7Z0JBQ25ELElBQUksU0FBUyxLQUFLLEVBQUUsSUFBSSxPQUFPLEtBQUssRUFBRSxFQUFFLENBQUM7b0JBQ3ZDLE1BQU0sSUFBSSxLQUFLLENBQ2IseUVBQXlFLENBQzFFLENBQUM7Z0JBQ0osQ0FBQztnQkFDRCxPQUFPO1lBQ1QsS0FBSyx3QkFBd0IsQ0FBQywrQkFBK0I7Z0JBQzNELElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztvQkFDOUIsTUFBTSxJQUFJLEtBQUssQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO2dCQUN6RSxDQUFDO2dCQUNELElBQUksT0FBTyxLQUFLLEVBQUUsRUFBRSxDQUFDO29CQUNuQixNQUFNLElBQUksS0FBSyxDQUFDLDREQUE0RCxDQUFDLENBQUM7Z0JBQ2hGLENBQUM7Z0JBQ0QsT0FBTztZQUNULEtBQUssd0JBQXdCLENBQUMsbUJBQW1CO2dCQUMvQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQzVCLE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztnQkFDdkUsQ0FBQztnQkFDRCxJQUFJLFNBQVMsS0FBSyxFQUFFLEVBQUUsQ0FBQztvQkFDckIsTUFBTSxJQUFJLEtBQUssQ0FBQyxrREFBa0QsQ0FBQyxDQUFDO2dCQUN0RSxDQUFDO2dCQUNELE9BQU87WUFDVCxLQUFLLHdCQUF3QixDQUFDLDJCQUEyQjtnQkFDdkQsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO29CQUM5QixNQUFNLElBQUksS0FBSyxDQUFDLHFEQUFxRCxDQUFDLENBQUM7Z0JBQ3pFLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO29CQUM1QixNQUFNLElBQUksS0FBSyxDQUFDLG1EQUFtRCxDQUFDLENBQUM7Z0JBQ3ZFLENBQUM7Z0JBQ0QsT0FBTztZQUNUO2dCQUNFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMzRixDQUFDO0lBQ0gsQ0FBQztJQUVELG1EQUFtRDtJQUM1QyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQWtDO1FBQ3RELHdCQUF3QixDQUFDLG9CQUFvQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3hELFFBQVEsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RCLEtBQUssd0JBQXdCLENBQUMsdUJBQXVCO2dCQUNuRCxPQUFPLElBQUksUUFBUSxDQUFDLGVBQWUsTUFBTSxDQUFDO1lBQzVDLEtBQUssd0JBQXdCLENBQUMsK0JBQStCO2dCQUMzRCxPQUFPLElBQUksUUFBUSxDQUFDLGVBQWUsYUFBYSxRQUFRLENBQUMsU0FBUyxNQUFNLENBQUM7WUFDM0UsS0FBSyx3QkFBd0IsQ0FBQyxtQkFBbUI7Z0JBQy9DLE9BQU8sSUFBSSxRQUFRLENBQUMsZUFBZSxXQUFXLFFBQVEsQ0FBQyxPQUFPLE1BQU0sQ0FBQztZQUN2RSxLQUFLLHdCQUF3QixDQUFDLDJCQUEyQjtnQkFDdkQsT0FBTyxJQUFJLFFBQVEsQ0FBQyxlQUFlLGFBQWEsUUFBUSxDQUFDLFNBQVMsV0FBVyxRQUFRLENBQUMsT0FBTyxNQUFNLENBQUM7WUFDdEc7Z0JBQ0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzNGLENBQUM7SUFDSCxDQUFDO0lBRUQsNkRBQTZEO0lBQ3RELE1BQU0sQ0FBQyxxQkFBcUIsQ0FBQyxRQUFrQztRQUNwRSxPQUFPLHdCQUF3QixDQUFDLG9DQUFvQyxDQUNsRSx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQzNDLENBQUM7SUFDSixDQUFDO0lBRUQsOERBQThEO0lBQ3ZELE1BQU0sQ0FBQyw0QkFBNEIsQ0FBQyxRQUFrQztRQUMzRSxPQUFPLHdCQUF3QixDQUFDLHNDQUFzQyxDQUNwRSx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQzNDLENBQUM7SUFDSixDQUFDO0lBRUQsc0RBQXNEO0lBQy9DLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxRQUFrQztRQUNqRSxPQUFPLHdCQUF3QixDQUFDLHlDQUF5QyxDQUN2RSx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQzNDLENBQUM7SUFDSixDQUFDO0lBRUQsOENBQThDO0lBQ3ZDLE1BQU0sQ0FBQyxjQUFjLENBQUMsUUFBa0M7UUFDN0QsT0FBTyx3QkFBd0IsQ0FBQyxxQ0FBcUMsQ0FDbkUsd0JBQXdCLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUMzQyxDQUFDO0lBQ0osQ0FBQztJQUVELHNFQUFzRTtJQUMvRCxNQUFNLENBQUMsa0NBQWtDLENBQUMsUUFBa0M7UUFDakYsT0FBTyx3QkFBd0IsQ0FBQyw0Q0FBNEMsQ0FDMUUsd0JBQXdCLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUMzQyxDQUFDO0lBQ0osQ0FBQzs7QUFoUkgsNERBaVJDOzs7QUFoUkMsMENBQTBDO0FBQ25CLHlDQUFnQixHQUFHLDBCQUEwQixDQUFDO0FBRXJFLCtCQUErQjtBQUNSLGdEQUF1QixHQUFHLFdBQVcsQ0FBQztBQUU3RCw4Q0FBOEM7QUFDdkIsd0RBQStCLEdBQUcsbUJBQW1CLENBQUM7QUFFN0UsMkJBQTJCO0FBQ0osNENBQW1CLEdBQUcsT0FBTyxDQUFDO0FBRXJELDBDQUEwQztBQUNuQixvREFBMkIsR0FBRyxlQUFlLENBQUM7QUFFckUsNkNBQTZDO0FBQ3RCLDhDQUFxQixHQUFHLHlCQUF5QixDQUFDO0FBRXpFLDREQUE0RDtBQUNyQyxzREFBNkIsR0FDbEQsK0NBQStDLENBQUM7QUFFbEQseUNBQXlDO0FBQ2xCLDBDQUFpQixHQUN0QywyQ0FBMkMsQ0FBQztBQUU5Qyx3REFBd0Q7QUFDakMsa0RBQXlCLEdBQzlDLGlFQUFpRSxDQUFDO0FBRXBFLG1EQUFtRDtBQUM1QixrREFBeUIsR0FDOUMsdUNBQXVDLENBQUM7QUFFMUMscURBQXFEO0FBQzlCLG9EQUEyQixHQUNoRCx5Q0FBeUMsQ0FBQztBQThPOUMsU0FBUyxxQkFBcUI7SUFDNUIsT0FBTztRQUNMO1lBQ0UsSUFBSSxFQUFFLHdCQUF3QixDQUFDLHVCQUF1QjtZQUN0RCxPQUFPLEVBQUUsd0JBQXdCLENBQUMscUJBQXFCO1NBQ3hEO1FBQ0Q7WUFDRSxJQUFJLEVBQUUsd0JBQXdCLENBQUMsK0JBQStCO1lBQzlELE9BQU8sRUFBRSx3QkFBd0IsQ0FBQyw2QkFBNkI7U0FDaEU7UUFDRDtZQUNFLElBQUksRUFBRSx3QkFBd0IsQ0FBQyxtQkFBbUI7WUFDbEQsT0FBTyxFQUFFLHdCQUF3QixDQUFDLGlCQUFpQjtTQUNwRDtRQUNEO1lBQ0UsSUFBSSxFQUFFLHdCQUF3QixDQUFDLDJCQUEyQjtZQUMxRCxPQUFPLEVBQUUsd0JBQXdCLENBQUMseUJBQXlCO1NBQzVEO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxPQUFlO0lBQ3BDLElBQUksVUFBVSxHQUFHLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNoQyxJQUFJLFVBQVUsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUN0QixPQUFPLEdBQUcsQ0FBQztJQUNiLENBQUM7SUFDRCxJQUFJLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2hDLFVBQVUsR0FBRyxJQUFJLFVBQVUsRUFBRSxDQUFDO0lBQ2hDLENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBYSxFQUFFLENBQUM7SUFDOUIsS0FBSyxNQUFNLE9BQU8sSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDNUMsSUFBSSxPQUFPLEtBQUssRUFBRSxJQUFJLE9BQU8sS0FBSyxHQUFHLEVBQUUsQ0FBQztZQUN0QyxTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksT0FBTyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQ3JCLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNmLFNBQVM7UUFDWCxDQUFDO1FBQ0QsUUFBUSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztBQUNoRSxDQUFDO0FBRUQsU0FBUyxTQUFTLENBQUMsY0FBc0I7SUFDdkMsT0FBTyxjQUFjLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzFFLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxLQUFhO0lBQ2xDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDckQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKiBBIGNvbmNyZXRlIGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgcGF0aC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBDbGllbnQgbmFtZXNwYWNlIHBhdGggc2VnbWVudC4gKi9cbiAgcmVhZG9ubHkgY2xpZW50TmFtZXNwYWNlOiBzdHJpbmc7XG5cbiAgLyoqIFBhcnRuZXIgaWRlbnRpZmllciBmb3IgcGFydG5lci1zY29wZWQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IHBhcnRuZXJJZD86IHN0cmluZztcblxuICAvKiogQWdlbnQgaWRlbnRpZmllciBmb3IgYWdlbnQgZW5kcG9pbnQga2luZHMuICovXG4gIHJlYWRvbmx5IGFnZW50SWQ/OiBzdHJpbmc7XG59XG5cbi8qKiBBIGNhbm9uaWNhbCBNQ1Agcm91dGUgdGVtcGxhdGUgYW5kIGl0cyBwcm90ZWN0ZWQtcmVzb3VyY2Ugcm91dGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcEVuZHBvaW50VGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENhbm9uaWNhbCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgbWNwUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBwcm90ZWN0ZWRSZXNvdXJjZVBhdGg6IHN0cmluZztcbn1cblxuLyoqIERlcml2ZWQgT0F1dGggYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aEZhY2FkZVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGF1dGhvcml6YXRpb24gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHRva2VuIGVuZHBvaW50IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHRva2VuUGF0dGVybjogc3RyaW5nO1xufVxuXG4vKiogQ2Fub25pY2FsIGFuZCBzdWZmaXgtY29tcGF0aWJsZSBPQXV0aCBkaXNjb3ZlcnkgcGF0dGVybnMgZm9yIGFuIE1DUCBlbmRwb2ludCBraW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BPQXV0aERpc2NvdmVyeVRlbXBsYXRlIHtcbiAgLyoqIEVuZHBvaW50IGtpbmQgZnJvbSB0aGUgdmVyc2lvbmVkIHJvdXRlLWFsZ2VicmEgcXVhcnRldC4gKi9cbiAgcmVhZG9ubHkga2luZDogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgY2Fub25pY2FsUGF0dGVybjogc3RyaW5nO1xuXG4gIC8qKiBEZXJpdmVkIHN1ZmZpeC1jb21wYXRpYmxlIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBzdWZmaXhQYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQXBwVGhlb3J5J3MgY2Fub25pY2FsLCB2ZXJzaW9uZWQgTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QuXG4gKlxuICogRXZlcnkgT0F1dGggcm91dGUgaXMgZGVyaXZlZCBmcm9tIHRoZSBmb3VyIE1DUCBwYXR0ZXJucyB0aHJvdWdoIHRoZSBwdXJlXG4gKiBmdW5jdGlvbnMgb24gdGhpcyBjbGFzcy4gQ29uY3JldGUgZW5kcG9pbnQgYnVpbGRlcnMgdmFsaWRhdGUgdGhlIHNhbWVcbiAqIGtpbmQtdG8taWRlbnRpZmllciBpbnZhcmlhbnRzIGFzIHRoZSBHbyBydW50aW1lIHBhY2thZ2UuXG4gKi9cbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEge1xuICAvKiogTUNQIHJvdXRlLWFsZ2VicmEgY29udHJhY3QgdmVyc2lvbi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBDT05UUkFDVF9WRVJTSU9OID0gXCJtMTcubWNwLXJvdXRlLWFsZ2VicmEvdjFcIjtcblxuICAvKiogTmFtZXNwYWNlIGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UgPSBcIm5hbWVzcGFjZVwiO1xuXG4gIC8qKiBQYXJ0bmVyLXNjb3BlZCBuYW1lc3BhY2UgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFID0gXCJwYXJ0bmVyX25hbWVzcGFjZVwiO1xuXG4gIC8qKiBBZ2VudCBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfQUdFTlQgPSBcImFnZW50XCI7XG5cbiAgLyoqIFBhcnRuZXItc2NvcGVkIGFnZW50IGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9QQVJUTkVSX0FHRU5UID0gXCJwYXJ0bmVyX2FnZW50XCI7XG5cbiAgLyoqIENhbm9uaWNhbCBuYW1lc3BhY2UgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgTkFNRVNQQUNFX01DUF9QQVRURVJOID0gXCIve2NsaWVudF9uYW1lc3BhY2V9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgcGFydG5lci1zY29wZWQgbmFtZXNwYWNlIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IFBBUlRORVJfTkFNRVNQQUNFX01DUF9QQVRURVJOID1cbiAgICBcIi97Y2xpZW50X25hbWVzcGFjZX0vcGFydG5lcnMve3BhcnRuZXJfaWR9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgYWdlbnQgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgQUdFTlRfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9hZ2VudHMve2FnZW50X2lkfS9tY3BcIjtcblxuICAvKiogQ2Fub25pY2FsIHBhcnRuZXItc2NvcGVkIGFnZW50IE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IFBBUlRORVJfQUdFTlRfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9wYXJ0bmVycy97cGFydG5lcl9pZH0vYWdlbnRzL3thZ2VudF9pZH0vbWNwXCI7XG5cbiAgLyoqIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBtZXRhZGF0YSBwcmVmaXguICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWCA9XG4gICAgXCIvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlXCI7XG5cbiAgLyoqIFJGQyA4NDE0IGF1dGhvcml6YXRpb24tc2VydmVyIG1ldGFkYXRhIHByZWZpeC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBBVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVggPVxuICAgIFwiLy53ZWxsLWtub3duL29hdXRoLWF1dGhvcml6YXRpb24tc2VydmVyXCI7XG5cbiAgLyoqIERlcml2ZSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVg7XG4gICAgfVxuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUFJPVEVDVEVEX1JFU09VUkNFX1BSRUZJWCArIG5vcm1hbGl6ZWQ7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBjYW5vbmljYWwgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVggKyBub3JtYWxpemVkO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS9hdXRob3JpemVgO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgdG9rZW4gZmFjYWRlIHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGAke0FwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpfS90b2tlbmA7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSBzdWZmaXgtY29tcGF0aWJsZSBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZCArIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gIH1cblxuICAvKiogUmVjb3ZlciBhIHJlc291cmNlIHBhdGggZnJvbSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZXNvdXJjZVBhdGhGcm9tUHJvdGVjdGVkUmVzb3VyY2VQYXRoKHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChwcm90ZWN0ZWRSZXNvdXJjZVBhdGgpO1xuICAgIGNvbnN0IHByZWZpeCA9IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYO1xuICAgIGlmIChub3JtYWxpemVkID09PSBwcmVmaXgpIHtcbiAgICAgIHJldHVybiBcIi9cIjtcbiAgICB9XG4gICAgaWYgKCFub3JtYWxpemVkLnN0YXJ0c1dpdGgoYCR7cHJlZml4fS9gKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGByb3V0aW5nOiB1bnN1cHBvcnRlZCBwcm90ZWN0ZWQgcmVzb3VyY2UgcGF0aCAke0pTT04uc3RyaW5naWZ5KG5vcm1hbGl6ZWQpfWApO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplUGF0aChub3JtYWxpemVkLnNsaWNlKHByZWZpeC5sZW5ndGgpKTtcbiAgfVxuXG4gIC8qKiBEZXJpdmUgdGhlIHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoIGZvciBhbiBNQ1AgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGhGcm9tTWNwUGF0aChtY3BQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKG1jcFBhdGgpO1xuICB9XG5cbiAgLyoqIFJldHVybiBldmVyeSBjYW5vbmljYWwgTUNQIGVuZHBvaW50IHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcEVuZHBvaW50VGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgbWNwUGF0dGVybjogcGF0dGVybixcbiAgICAgIHByb3RlY3RlZFJlc291cmNlUGF0aDpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChwYXR0ZXJuKSxcbiAgICB9KSk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBPQXV0aCBhdXRob3JpemF0aW9uIGZhY2FkZSB0ZW1wbGF0ZSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRPQXV0aEZhY2FkZVRlbXBsYXRlcygpOiBBcHBUaGVvcnlNY3BPQXV0aEZhY2FkZVRlbXBsYXRlW10ge1xuICAgIHJldHVybiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKS5tYXAoKHsga2luZCwgcGF0dGVybiB9KSA9PiAoe1xuICAgICAga2luZCxcbiAgICAgIGF1dGhvcml6ZVBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChwYXR0ZXJuKSxcbiAgICAgIHRva2VuUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgocGF0dGVybiksXG4gICAgfSkpO1xuICB9XG5cbiAgLyoqIFJldHVybiBldmVyeSBjYW5vbmljYWwgT0F1dGggZGlzY292ZXJ5IHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZE9BdXRoRGlzY292ZXJ5VGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcE9BdXRoRGlzY292ZXJ5VGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgY2Fub25pY2FsUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgICAgc3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBQYXJzZSBhIGNvbmNyZXRlIE1DUCBwYXRoIGFmdGVyIGNvbnRyYWN0IG5vcm1hbGl6YXRpb24uICovXG4gIHB1YmxpYyBzdGF0aWMgcGFyc2VNY3BQYXRoKHJhd1BhdGg6IHN0cmluZyk6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCB7XG4gICAgY29uc3Qgc2VnbWVudHMgPSBzcGxpdFBhdGgobm9ybWFsaXplUGF0aChyYXdQYXRoKSk7XG4gICAgbGV0IGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGggfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoc2VnbWVudHMubGVuZ3RoID09PSAyICYmIHNlZ21lbnRzWzFdID09PSBcIm1jcFwiKSB7XG4gICAgICBlbmRwb2ludCA9IHtcbiAgICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFLFxuICAgICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgc2VnbWVudHMubGVuZ3RoID09PSA0ICYmXG4gICAgICBzZWdtZW50c1sxXSA9PT0gXCJwYXJ0bmVyc1wiICYmXG4gICAgICBzZWdtZW50c1szXSA9PT0gXCJtY3BcIlxuICAgICkge1xuICAgICAgZW5kcG9pbnQgPSB7XG4gICAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFLFxuICAgICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgICBwYXJ0bmVySWQ6IHNlZ21lbnRzWzJdLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgc2VnbWVudHMubGVuZ3RoID09PSA0ICYmXG4gICAgICBzZWdtZW50c1sxXSA9PT0gXCJhZ2VudHNcIiAmJlxuICAgICAgc2VnbWVudHNbM10gPT09IFwibWNwXCJcbiAgICApIHtcbiAgICAgIGVuZHBvaW50ID0ge1xuICAgICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVCxcbiAgICAgICAgY2xpZW50TmFtZXNwYWNlOiBzZWdtZW50c1swXSxcbiAgICAgICAgYWdlbnRJZDogc2VnbWVudHNbMl0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICBzZWdtZW50cy5sZW5ndGggPT09IDYgJiZcbiAgICAgIHNlZ21lbnRzWzFdID09PSBcInBhcnRuZXJzXCIgJiZcbiAgICAgIHNlZ21lbnRzWzNdID09PSBcImFnZW50c1wiICYmXG4gICAgICBzZWdtZW50c1s1XSA9PT0gXCJtY3BcIlxuICAgICkge1xuICAgICAgZW5kcG9pbnQgPSB7XG4gICAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQsXG4gICAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICAgIHBhcnRuZXJJZDogc2VnbWVudHNbMl0sXG4gICAgICAgIGFnZW50SWQ6IHNlZ21lbnRzWzRdLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoZW5kcG9pbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGByb3V0aW5nOiB1bnN1cHBvcnRlZCBNQ1AgcGF0aCAke0pTT04uc3RyaW5naWZ5KHJhd1BhdGgpfWApO1xuICAgIH1cbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICAgIHJldHVybiBlbmRwb2ludDtcbiAgfVxuXG4gIC8qKiBWYWxpZGF0ZSBlbmRwb2ludCBraW5kLXRvLWlkZW50aWZpZXIgY29uc2lzdGVuY3kgYW5kIHBhdGgtc2VnbWVudCBzYWZldHkuICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHZvaWQge1xuICAgIGlmICghaXNQYXRoU2VnbWVudChlbmRwb2ludC5jbGllbnROYW1lc3BhY2UpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyb3V0aW5nOiBjbGllbnROYW1lc3BhY2UgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcGFydG5lcklkID0gZW5kcG9pbnQucGFydG5lcklkID8/IFwiXCI7XG4gICAgY29uc3QgYWdlbnRJZCA9IGVuZHBvaW50LmFnZW50SWQgPz8gXCJcIjtcbiAgICBzd2l0Y2ggKGVuZHBvaW50LmtpbmQpIHtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFOlxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiIHx8IGFnZW50SWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcInJvdXRpbmc6IG5hbWVzcGFjZSBlbmRwb2ludCBjYW5ub3QgaW5jbHVkZSBwYXJ0bmVyIG9yIGFnZW50IGlkZW50aWZpZXJzXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICBpZiAoIWlzUGF0aFNlZ21lbnQocGFydG5lcklkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInJvdXRpbmc6IHBhcnRuZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYWdlbnRJZCAhPT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInJvdXRpbmc6IHBhcnRuZXIgbmFtZXNwYWNlIGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIGFnZW50SWRcIik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVDpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicm91dGluZzogYWdlbnRJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicm91dGluZzogYWdlbnQgZW5kcG9pbnQgY2Fubm90IGluY2x1ZGUgcGFydG5lcklkXCIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVDpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KHBhcnRuZXJJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyb3V0aW5nOiBwYXJ0bmVySWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicm91dGluZzogYWdlbnRJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHJvdXRpbmc6IHVuc3VwcG9ydGVkIGVuZHBvaW50IGtpbmQgJHtKU09OLnN0cmluZ2lmeShlbmRwb2ludC5raW5kKX1gKTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGNvbmNyZXRlIE1DUCBwYXRoIGZvciBhbiBlbmRwb2ludC4gKi9cbiAgcHVibGljIHN0YXRpYyBtY3BQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS52YWxpZGF0ZUVuZHBvaW50UGF0aChlbmRwb2ludCk7XG4gICAgc3dpdGNoIChlbmRwb2ludC5raW5kKSB7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRTpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vcGFydG5lcnMvJHtlbmRwb2ludC5wYXJ0bmVySWR9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5UOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vYWdlbnRzLyR7ZW5kcG9pbnQuYWdlbnRJZH0vbWNwYDtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVDpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L3BhcnRuZXJzLyR7ZW5kcG9pbnQucGFydG5lcklkfS9hZ2VudHMvJHtlbmRwb2ludC5hZ2VudElkfS9tY3BgO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByb3V0aW5nOiB1bnN1cHBvcnRlZCBlbmRwb2ludCBraW5kICR7SlNPTi5zdHJpbmdpZnkoZW5kcG9pbnQua2luZCl9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIG9hdXRoQXV0aG9yaXplUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3MgdG9rZW4gZmFjYWRlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhUb2tlblBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGVuZHBvaW50J3Mgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLm1jcFBhdGgoZW5kcG9pbnQpLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCk6IEFycmF5PHsga2luZDogc3RyaW5nOyBwYXR0ZXJuOiBzdHJpbmcgfT4ge1xuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRSxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5OQU1FU1BBQ0VfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9QQVJUTkVSX05BTUVTUEFDRSxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QQVJUTkVSX05BTUVTUEFDRV9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5ULFxuICAgICAgcGF0dGVybjogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFHRU5UX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVCxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QQVJUTkVSX0FHRU5UX01DUF9QQVRURVJOLFxuICAgIH0sXG4gIF07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG5vcm1hbGl6ZWQgPSByYXdQYXRoLnRyaW0oKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiXCIpIHtcbiAgICByZXR1cm4gXCIvXCI7XG4gIH1cbiAgaWYgKCFub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgbm9ybWFsaXplZCA9IGAvJHtub3JtYWxpemVkfWA7XG4gIH1cblxuICBjb25zdCBzZWdtZW50czogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIG5vcm1hbGl6ZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiXCIgfHwgc2VnbWVudCA9PT0gXCIuXCIpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2VnbWVudCA9PT0gXCIuLlwiKSB7XG4gICAgICBzZWdtZW50cy5wb3AoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBzZWdtZW50cy5wdXNoKHNlZ21lbnQpO1xuICB9XG4gIHJldHVybiBzZWdtZW50cy5sZW5ndGggPT09IDAgPyBcIi9cIiA6IGAvJHtzZWdtZW50cy5qb2luKFwiL1wiKX1gO1xufVxuXG5mdW5jdGlvbiBzcGxpdFBhdGgobm9ybWFsaXplZFBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZWRQYXRoID09PSBcIi9cIiA/IFtdIDogbm9ybWFsaXplZFBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpO1xufVxuXG5mdW5jdGlvbiBpc1BhdGhTZWdtZW50KHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHZhbHVlLnRyaW0oKSAhPT0gXCJcIiAmJiAhdmFsdWUuaW5jbHVkZXMoXCIvXCIpO1xufVxuIl19