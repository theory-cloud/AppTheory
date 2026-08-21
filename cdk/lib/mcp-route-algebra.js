"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpRouteAlgebra = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const ASCII_WHITESPACE_TRIM_PATTERN = /^[\u0009-\u000D\u0020]+|[\u0009-\u000D\u0020]+$/g;
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
    return value.replace(ASCII_WHITESPACE_TRIM_PATTERN, "");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJvdXRlLWFsZ2VicmEuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3Atcm91dGUtYWxnZWJyYS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQW1EQSxNQUFNLDZCQUE2QixHQUNqQyxrREFBa0QsQ0FBQztBQUVyRDs7Ozs7O0dBTUc7QUFDSCxNQUFzQix3QkFBd0I7SUF1QzVDLHVFQUF1RTtJQUNoRSxNQUFNLENBQUMsb0NBQW9DLENBQ2hELFlBQW9CO1FBRXBCLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUMvQyxJQUFJLFVBQVUsS0FBSyxHQUFHLEVBQUUsQ0FBQztZQUN2QixPQUFPLHdCQUF3QixDQUFDLHlCQUF5QixDQUFDO1FBQzVELENBQUM7UUFDRCxPQUFPLHdCQUF3QixDQUFDLHlCQUF5QixHQUFHLFVBQVUsQ0FBQztJQUN6RSxDQUFDO0lBRUQseUVBQXlFO0lBQ2xFLE1BQU0sQ0FBQyxzQ0FBc0MsQ0FDbEQsWUFBb0I7UUFFcEIsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQy9DLElBQUksVUFBVSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sd0JBQXdCLENBQUMsMkJBQTJCLENBQUM7UUFDOUQsQ0FBQztRQUNELE9BQU8sd0JBQXdCLENBQUMsMkJBQTJCLEdBQUcsVUFBVSxDQUFDO0lBQzNFLENBQUM7SUFFRCxpRUFBaUU7SUFDMUQsTUFBTSxDQUFDLHlDQUF5QyxDQUNyRCxZQUFvQjtRQUVwQixPQUFPLEdBQUcsd0JBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQztJQUN0RyxDQUFDO0lBRUQseURBQXlEO0lBQ2xELE1BQU0sQ0FBQyxxQ0FBcUMsQ0FDakQsWUFBb0I7UUFFcEIsT0FBTyxHQUFHLHdCQUF3QixDQUFDLHNDQUFzQyxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUM7SUFDbEcsQ0FBQztJQUVELGlGQUFpRjtJQUMxRSxNQUFNLENBQUMsNENBQTRDLENBQ3hELFlBQW9CO1FBRXBCLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUMvQyxJQUFJLFVBQVUsS0FBSyxHQUFHLEVBQUUsQ0FBQztZQUN2QixPQUFPLHdCQUF3QixDQUFDLDJCQUEyQixDQUFDO1FBQzlELENBQUM7UUFDRCxPQUFPLFVBQVUsR0FBRyx3QkFBd0IsQ0FBQywyQkFBMkIsQ0FBQztJQUMzRSxDQUFDO0lBRUQsd0VBQXdFO0lBQ2pFLE1BQU0sQ0FBQyxxQ0FBcUMsQ0FDakQscUJBQTZCO1FBRTdCLE1BQU0sVUFBVSxHQUFHLGFBQWEsQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQ3hELE1BQU0sTUFBTSxHQUFHLHdCQUF3QixDQUFDLHlCQUF5QixDQUFDO1FBQ2xFLElBQUksVUFBVSxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQzFCLE9BQU8sR0FBRyxDQUFDO1FBQ2IsQ0FBQztRQUNELElBQUksQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3pDLE1BQU0sSUFBSSxLQUFLLENBQ2Isa0RBQWtELElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FDL0UsQ0FBQztRQUNKLENBQUM7UUFDRCxPQUFPLGFBQWEsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFFRCwwREFBMEQ7SUFDbkQsTUFBTSxDQUFDLGdDQUFnQyxDQUFDLE9BQWU7UUFDNUQsT0FBTyx3QkFBd0IsQ0FBQyxvQ0FBb0MsQ0FDbEUsT0FBTyxDQUNSLENBQUM7SUFDSixDQUFDO0lBRUQsc0VBQXNFO0lBQy9ELE1BQU0sQ0FBQywwQkFBMEI7UUFDdEMsT0FBTyxxQkFBcUIsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ3pELElBQUk7WUFDSixVQUFVLEVBQUUsT0FBTztZQUNuQixxQkFBcUIsRUFDbkIsd0JBQXdCLENBQUMsb0NBQW9DLENBQUMsT0FBTyxDQUFDO1NBQ3pFLENBQUMsQ0FBQyxDQUFDO0lBQ04sQ0FBQztJQUVELG9GQUFvRjtJQUM3RSxNQUFNLENBQUMsNkJBQTZCO1FBQ3pDLE9BQU8scUJBQXFCLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUN6RCxJQUFJO1lBQ0osZ0JBQWdCLEVBQ2Qsd0JBQXdCLENBQUMseUNBQXlDLENBQ2hFLE9BQU8sQ0FDUjtZQUNILFlBQVksRUFDVix3QkFBd0IsQ0FBQyxxQ0FBcUMsQ0FBQyxPQUFPLENBQUM7U0FDMUUsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0lBRUQseUVBQXlFO0lBQ2xFLE1BQU0sQ0FBQyxnQ0FBZ0M7UUFDNUMsT0FBTyxxQkFBcUIsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ3pELElBQUk7WUFDSixnQkFBZ0IsRUFDZCx3QkFBd0IsQ0FBQyxzQ0FBc0MsQ0FDN0QsT0FBTyxDQUNSO1lBQ0gsYUFBYSxFQUNYLHdCQUF3QixDQUFDLDRDQUE0QyxDQUNuRSxPQUFPLENBQ1I7U0FDSixDQUFDLENBQUMsQ0FBQztJQUNOLENBQUM7SUFFRCw4REFBOEQ7SUFDdkQsTUFBTSxDQUFDLFlBQVksQ0FBQyxPQUFlO1FBQ3hDLE1BQU0sb0JBQW9CLEdBQUcsb0JBQW9CLENBQy9DLCtCQUErQixDQUFDLE9BQU8sQ0FBQyxDQUN6QyxDQUFDO1FBQ0YsSUFBSSxvQkFBb0IsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUN2Qyx3QkFBd0IsQ0FBQyxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO1lBQ3BFLE9BQU8sb0JBQW9CLENBQUM7UUFDOUIsQ0FBQztRQUVELE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3pFLElBQUksUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLE1BQU0sSUFBSSxLQUFLLENBQ2IsbUNBQW1DLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FDN0QsQ0FBQztRQUNKLENBQUM7UUFDRCx3QkFBd0IsQ0FBQyxvQkFBb0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN4RCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBRUQsZ0ZBQWdGO0lBQ3pFLE1BQU0sQ0FBQyxvQkFBb0IsQ0FBQyxRQUFrQztRQUNuRSxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxDQUFDO1lBQzdDLE1BQU0sSUFBSSxLQUFLLENBQ2IsNkRBQTZELENBQzlELENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUM7UUFDM0MsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUM7UUFDdkMsUUFBUSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDdEIsS0FBSyx3QkFBd0IsQ0FBQyx1QkFBdUI7Z0JBQ25ELElBQUksU0FBUyxLQUFLLEVBQUUsSUFBSSxPQUFPLEtBQUssRUFBRSxFQUFFLENBQUM7b0JBQ3ZDLE1BQU0sSUFBSSxLQUFLLENBQ2IsMkVBQTJFLENBQzVFLENBQUM7Z0JBQ0osQ0FBQztnQkFDRCxPQUFPO1lBQ1QsS0FBSyx3QkFBd0IsQ0FBQywrQkFBK0I7Z0JBQzNELElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztvQkFDOUIsTUFBTSxJQUFJLEtBQUssQ0FDYix1REFBdUQsQ0FDeEQsQ0FBQztnQkFDSixDQUFDO2dCQUNELElBQUksT0FBTyxLQUFLLEVBQUUsRUFBRSxDQUFDO29CQUNuQixNQUFNLElBQUksS0FBSyxDQUNiLDhEQUE4RCxDQUMvRCxDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsT0FBTztZQUNULEtBQUssd0JBQXdCLENBQUMsbUJBQW1CO2dCQUMvQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQzVCLE1BQU0sSUFBSSxLQUFLLENBQ2IscURBQXFELENBQ3RELENBQUM7Z0JBQ0osQ0FBQztnQkFDRCxJQUFJLFNBQVMsS0FBSyxFQUFFLEVBQUUsQ0FBQztvQkFDckIsTUFBTSxJQUFJLEtBQUssQ0FBQyxvREFBb0QsQ0FBQyxDQUFDO2dCQUN4RSxDQUFDO2dCQUNELE9BQU87WUFDVCxLQUFLLHdCQUF3QixDQUFDLDJCQUEyQjtnQkFDdkQsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO29CQUM5QixNQUFNLElBQUksS0FBSyxDQUNiLHVEQUF1RCxDQUN4RCxDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO29CQUM1QixNQUFNLElBQUksS0FBSyxDQUNiLHFEQUFxRCxDQUN0RCxDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsT0FBTztZQUNUO2dCQUNFLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0NBQXdDLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQ3hFLENBQUM7UUFDTixDQUFDO0lBQ0gsQ0FBQztJQUVELG1EQUFtRDtJQUM1QyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQWtDO1FBQ3RELHdCQUF3QixDQUFDLG9CQUFvQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3hELFFBQVEsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3RCLEtBQUssd0JBQXdCLENBQUMsdUJBQXVCO2dCQUNuRCxPQUFPLElBQUksUUFBUSxDQUFDLGVBQWUsTUFBTSxDQUFDO1lBQzVDLEtBQUssd0JBQXdCLENBQUMsK0JBQStCO2dCQUMzRCxPQUFPLElBQUksUUFBUSxDQUFDLGVBQWUsYUFBYSxRQUFRLENBQUMsU0FBUyxNQUFNLENBQUM7WUFDM0UsS0FBSyx3QkFBd0IsQ0FBQyxtQkFBbUI7Z0JBQy9DLE9BQU8sSUFBSSxRQUFRLENBQUMsZUFBZSxXQUFXLFFBQVEsQ0FBQyxPQUFPLE1BQU0sQ0FBQztZQUN2RSxLQUFLLHdCQUF3QixDQUFDLDJCQUEyQjtnQkFDdkQsT0FBTyxJQUFJLFFBQVEsQ0FBQyxlQUFlLGFBQWEsUUFBUSxDQUFDLFNBQVMsV0FBVyxRQUFRLENBQUMsT0FBTyxNQUFNLENBQUM7WUFDdEc7Z0JBQ0UsTUFBTSxJQUFJLEtBQUssQ0FDYix3Q0FBd0MsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FDeEUsQ0FBQztRQUNOLENBQUM7SUFDSCxDQUFDO0lBRUQsNkRBQTZEO0lBQ3RELE1BQU0sQ0FBQyxxQkFBcUIsQ0FDakMsUUFBa0M7UUFFbEMsT0FBTyx3QkFBd0IsQ0FBQyxvQ0FBb0MsQ0FDbEUsd0JBQXdCLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUMzQyxDQUFDO0lBQ0osQ0FBQztJQUVELDhEQUE4RDtJQUN2RCxNQUFNLENBQUMsNEJBQTRCLENBQ3hDLFFBQWtDO1FBRWxDLE9BQU8sd0JBQXdCLENBQUMsc0NBQXNDLENBQ3BFLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FDM0MsQ0FBQztJQUNKLENBQUM7SUFFRCxzREFBc0Q7SUFDL0MsTUFBTSxDQUFDLGtCQUFrQixDQUFDLFFBQWtDO1FBQ2pFLE9BQU8sd0JBQXdCLENBQUMseUNBQXlDLENBQ3ZFLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FDM0MsQ0FBQztJQUNKLENBQUM7SUFFRCw4Q0FBOEM7SUFDdkMsTUFBTSxDQUFDLGNBQWMsQ0FBQyxRQUFrQztRQUM3RCxPQUFPLHdCQUF3QixDQUFDLHFDQUFxQyxDQUNuRSx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQzNDLENBQUM7SUFDSixDQUFDO0lBRUQsc0VBQXNFO0lBQy9ELE1BQU0sQ0FBQyxrQ0FBa0MsQ0FDOUMsUUFBa0M7UUFFbEMsT0FBTyx3QkFBd0IsQ0FBQyw0Q0FBNEMsQ0FDMUUsd0JBQXdCLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUMzQyxDQUFDO0lBQ0osQ0FBQzs7QUE3UkgsNERBOFJDOzs7QUE3UkMsMENBQTBDO0FBQ25CLHlDQUFnQixHQUFHLDBCQUEwQixDQUFDO0FBRXJFLCtCQUErQjtBQUNSLGdEQUF1QixHQUFHLFdBQVcsQ0FBQztBQUU3RCw4Q0FBOEM7QUFDdkIsd0RBQStCLEdBQUcsbUJBQW1CLENBQUM7QUFFN0UsMkJBQTJCO0FBQ0osNENBQW1CLEdBQUcsT0FBTyxDQUFDO0FBRXJELDBDQUEwQztBQUNuQixvREFBMkIsR0FBRyxlQUFlLENBQUM7QUFFckUsNkNBQTZDO0FBQ3RCLDhDQUFxQixHQUFHLHlCQUF5QixDQUFDO0FBRXpFLDREQUE0RDtBQUNyQyxzREFBNkIsR0FDbEQsK0NBQStDLENBQUM7QUFFbEQseUNBQXlDO0FBQ2xCLDBDQUFpQixHQUN0QywyQ0FBMkMsQ0FBQztBQUU5Qyx3REFBd0Q7QUFDakMsa0RBQXlCLEdBQzlDLGlFQUFpRSxDQUFDO0FBRXBFLG1EQUFtRDtBQUM1QixrREFBeUIsR0FDOUMsdUNBQXVDLENBQUM7QUFFMUMscURBQXFEO0FBQzlCLG9EQUEyQixHQUNoRCx5Q0FBeUMsQ0FBQztBQTJQOUMsU0FBUyxxQkFBcUI7SUFDNUIsT0FBTztRQUNMO1lBQ0UsSUFBSSxFQUFFLHdCQUF3QixDQUFDLHVCQUF1QjtZQUN0RCxPQUFPLEVBQUUsd0JBQXdCLENBQUMscUJBQXFCO1NBQ3hEO1FBQ0Q7WUFDRSxJQUFJLEVBQUUsd0JBQXdCLENBQUMsK0JBQStCO1lBQzlELE9BQU8sRUFBRSx3QkFBd0IsQ0FBQyw2QkFBNkI7U0FDaEU7UUFDRDtZQUNFLElBQUksRUFBRSx3QkFBd0IsQ0FBQyxtQkFBbUI7WUFDbEQsT0FBTyxFQUFFLHdCQUF3QixDQUFDLGlCQUFpQjtTQUNwRDtRQUNEO1lBQ0UsSUFBSSxFQUFFLHdCQUF3QixDQUFDLDJCQUEyQjtZQUMxRCxPQUFPLEVBQUUsd0JBQXdCLENBQUMseUJBQXlCO1NBQzVEO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUMzQixRQUFrQjtJQUVsQixJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxJQUFJLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLEVBQUUsQ0FBQztRQUNuRCxPQUFPO1lBQ0wsSUFBSSxFQUFFLHdCQUF3QixDQUFDLHVCQUF1QjtZQUN0RCxlQUFlLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUM3QixDQUFDO0lBQ0osQ0FBQztJQUNELElBQ0UsUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQ3JCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxVQUFVO1FBQzFCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLEVBQ3JCLENBQUM7UUFDRCxPQUFPO1lBQ0wsSUFBSSxFQUFFLHdCQUF3QixDQUFDLCtCQUErQjtZQUM5RCxlQUFlLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUM1QixTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUN2QixDQUFDO0lBQ0osQ0FBQztJQUNELElBQ0UsUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQ3JCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRO1FBQ3hCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLEVBQ3JCLENBQUM7UUFDRCxPQUFPO1lBQ0wsSUFBSSxFQUFFLHdCQUF3QixDQUFDLG1CQUFtQjtZQUNsRCxlQUFlLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUM1QixPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUNyQixDQUFDO0lBQ0osQ0FBQztJQUNELElBQ0UsUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQ3JCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxVQUFVO1FBQzFCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRO1FBQ3hCLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLEVBQ3JCLENBQUM7UUFDRCxPQUFPO1lBQ0wsSUFBSSxFQUFFLHdCQUF3QixDQUFDLDJCQUEyQjtZQUMxRCxlQUFlLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUM1QixTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUN0QixPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUNyQixDQUFDO0lBQ0osQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLEtBQWE7SUFDeEMsT0FBTyxLQUFLLENBQUMsT0FBTyxDQUFDLDZCQUE2QixFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQzFELENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxPQUFlO0lBQ3BDLElBQUksVUFBVSxHQUFHLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzlDLElBQUksVUFBVSxLQUFLLEVBQUUsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sR0FBRyxDQUFDO0lBQ2IsQ0FBQztJQUNELElBQUksQ0FBQyxVQUFVLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDaEMsVUFBVSxHQUFHLElBQUksVUFBVSxFQUFFLENBQUM7SUFDaEMsQ0FBQztJQUVELE1BQU0sUUFBUSxHQUFhLEVBQUUsQ0FBQztJQUM5QixLQUFLLE1BQU0sT0FBTyxJQUFJLFVBQVUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUM1QyxJQUFJLE9BQU8sS0FBSyxFQUFFLElBQUksT0FBTyxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBQ3RDLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxPQUFPLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDckIsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2YsU0FBUztRQUNYLENBQUM7UUFDRCxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFDRCxPQUFPLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO0FBQ2hFLENBQUM7QUFFRCxTQUFTLCtCQUErQixDQUFDLE9BQWU7SUFDdEQsT0FBTyxtQkFBbUIsQ0FBQyxPQUFPLENBQUM7U0FDaEMsS0FBSyxDQUFDLEdBQUcsQ0FBQztTQUNWLE1BQU0sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0FBQ3pDLENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxjQUFzQjtJQUN2QyxPQUFPLGNBQWMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDMUUsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLEtBQWE7SUFDbEMsTUFBTSxPQUFPLEdBQUcsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDM0MsT0FBTyxDQUNMLE9BQU8sS0FBSyxFQUFFO1FBQ2QsT0FBTyxLQUFLLEdBQUc7UUFDZixPQUFPLEtBQUssSUFBSTtRQUNoQixDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQ3JCLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqIEEgY29uY3JldGUgY2Fub25pY2FsIE1DUCBlbmRwb2ludCBwYXRoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIENsaWVudCBuYW1lc3BhY2UgcGF0aCBzZWdtZW50LiAqL1xuICByZWFkb25seSBjbGllbnROYW1lc3BhY2U6IHN0cmluZztcblxuICAvKiogUGFydG5lciBpZGVudGlmaWVyIGZvciBwYXJ0bmVyLXNjb3BlZCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgcGFydG5lcklkPzogc3RyaW5nO1xuXG4gIC8qKiBBZ2VudCBpZGVudGlmaWVyIGZvciBhZ2VudCBlbmRwb2ludCBraW5kcy4gKi9cbiAgcmVhZG9ubHkgYWdlbnRJZD86IHN0cmluZztcbn1cblxuLyoqIEEgY2Fub25pY2FsIE1DUCByb3V0ZSB0ZW1wbGF0ZSBhbmQgaXRzIHByb3RlY3RlZC1yZXNvdXJjZSByb3V0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZSB7XG4gIC8qKiBFbmRwb2ludCBraW5kIGZyb20gdGhlIHZlcnNpb25lZCByb3V0ZS1hbGdlYnJhIHF1YXJ0ZXQuICovXG4gIHJlYWRvbmx5IGtpbmQ6IHN0cmluZztcblxuICAvKiogQ2Fub25pY2FsIE1DUCByb3V0ZSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBtY3BQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIHJvdXRlIHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nO1xufVxuXG4vKiogRGVyaXZlZCBPQXV0aCBhdXRob3JpemF0aW9uIGZhY2FkZSBwYXR0ZXJucyBmb3IgYW4gTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgYXV0aG9yaXphdGlvbiBlbmRwb2ludCBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBhdXRob3JpemVQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgdG9rZW4gZW5kcG9pbnQgcGF0dGVybi4gKi9cbiAgcmVhZG9ubHkgdG9rZW5QYXR0ZXJuOiBzdHJpbmc7XG59XG5cbi8qKiBDYW5vbmljYWwgYW5kIHN1ZmZpeC1jb21wYXRpYmxlIE9BdXRoIGRpc2NvdmVyeSBwYXR0ZXJucyBmb3IgYW4gTUNQIGVuZHBvaW50IGtpbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcE9BdXRoRGlzY292ZXJ5VGVtcGxhdGUge1xuICAvKiogRW5kcG9pbnQga2luZCBmcm9tIHRoZSB2ZXJzaW9uZWQgcm91dGUtYWxnZWJyYSBxdWFydGV0LiAqL1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgY2Fub25pY2FsIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXR0ZXJuLiAqL1xuICByZWFkb25seSBjYW5vbmljYWxQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgLyoqIERlcml2ZWQgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdHRlcm4uICovXG4gIHJlYWRvbmx5IHN1ZmZpeFBhdHRlcm46IHN0cmluZztcbn1cblxuY29uc3QgQVNDSUlfV0hJVEVTUEFDRV9UUklNX1BBVFRFUk4gPVxuICAvXltcXHUwMDA5LVxcdTAwMERcXHUwMDIwXSt8W1xcdTAwMDktXFx1MDAwRFxcdTAwMjBdKyQvZztcblxuLyoqXG4gKiBBcHBUaGVvcnkncyBjYW5vbmljYWwsIHZlcnNpb25lZCBNQ1Agcm91dGUtYWxnZWJyYSBjb250cmFjdC5cbiAqXG4gKiBFdmVyeSBPQXV0aCByb3V0ZSBpcyBkZXJpdmVkIGZyb20gdGhlIGZvdXIgTUNQIHBhdHRlcm5zIHRocm91Z2ggdGhlIHB1cmVcbiAqIGZ1bmN0aW9ucyBvbiB0aGlzIGNsYXNzLiBDb25jcmV0ZSBlbmRwb2ludCBidWlsZGVycyB2YWxpZGF0ZSB0aGUgc2FtZVxuICoga2luZC10by1pZGVudGlmaWVyIGludmFyaWFudHMgYXMgdGhlIEdvIHJ1bnRpbWUgcGFja2FnZS5cbiAqL1xuZXhwb3J0IGFic3RyYWN0IGNsYXNzIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB7XG4gIC8qKiBNQ1Agcm91dGUtYWxnZWJyYSBjb250cmFjdCB2ZXJzaW9uLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IENPTlRSQUNUX1ZFUlNJT04gPSBcIm0xNy5tY3Atcm91dGUtYWxnZWJyYS92MVwiO1xuXG4gIC8qKiBOYW1lc3BhY2UgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX05BTUVTUEFDRSA9IFwibmFtZXNwYWNlXCI7XG5cbiAgLyoqIFBhcnRuZXItc2NvcGVkIG5hbWVzcGFjZSBlbmRwb2ludCBraW5kLiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UgPSBcInBhcnRuZXJfbmFtZXNwYWNlXCI7XG5cbiAgLyoqIEFnZW50IGVuZHBvaW50IGtpbmQuICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgRU5EUE9JTlRfS0lORF9BR0VOVCA9IFwiYWdlbnRcIjtcblxuICAvKiogUGFydG5lci1zY29wZWQgYWdlbnQgZW5kcG9pbnQga2luZC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBFTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQgPSBcInBhcnRuZXJfYWdlbnRcIjtcblxuICAvKiogQ2Fub25pY2FsIG5hbWVzcGFjZSBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBOQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPSBcIi97Y2xpZW50X25hbWVzcGFjZX0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBwYXJ0bmVyLXNjb3BlZCBuYW1lc3BhY2UgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9OQU1FU1BBQ0VfTUNQX1BBVFRFUk4gPVxuICAgIFwiL3tjbGllbnRfbmFtZXNwYWNlfS9wYXJ0bmVycy97cGFydG5lcl9pZH0vbWNwXCI7XG5cbiAgLyoqIENhbm9uaWNhbCBhZ2VudCBNQ1Agcm91dGUgcGF0dGVybi4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBBR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L2FnZW50cy97YWdlbnRfaWR9L21jcFwiO1xuXG4gIC8qKiBDYW5vbmljYWwgcGFydG5lci1zY29wZWQgYWdlbnQgTUNQIHJvdXRlIHBhdHRlcm4uICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgUEFSVE5FUl9BR0VOVF9NQ1BfUEFUVEVSTiA9XG4gICAgXCIve2NsaWVudF9uYW1lc3BhY2V9L3BhcnRuZXJzL3twYXJ0bmVyX2lkfS9hZ2VudHMve2FnZW50X2lkfS9tY3BcIjtcblxuICAvKiogUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHByZWZpeC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBQUk9URUNURURfUkVTT1VSQ0VfUFJFRklYID1cbiAgICBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIjtcblxuICAvKiogUkZDIDg0MTQgYXV0aG9yaXphdGlvbi1zZXJ2ZXIgbWV0YWRhdGEgcHJlZml4LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IEFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWCA9XG4gICAgXCIvLndlbGwta25vd24vb2F1dGgtYXV0aG9yaXphdGlvbi1zZXJ2ZXJcIjtcblxuICAvKiogRGVyaXZlIGFuIFJGQyA5NzI4IHByb3RlY3RlZC1yZXNvdXJjZSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUGF0aChyZXNvdXJjZVBhdGgpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi9cIikge1xuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5QUk9URUNURURfUkVTT1VSQ0VfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVggKyBub3JtYWxpemVkO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgY2Fub25pY2FsIFJGQyA4NDE0IGRpc2NvdmVyeSBwYXRoIGZyb20gYSByZXNvdXJjZSBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIGF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHJlc291cmNlUGF0aCk7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiL1wiKSB7XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkFVVEhPUklaQVRJT05fU0VSVkVSX1BSRUZJWDtcbiAgICB9XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVggKyBub3JtYWxpemVkO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgYXV0aG9yaXphdGlvbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChcbiAgICByZXNvdXJjZVBhdGg6IHN0cmluZyxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYCR7QXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCl9L2F1dGhvcml6ZWA7XG4gIH1cblxuICAvKiogRGVyaXZlIHRoZSB0b2tlbiBmYWNhZGUgcGF0aCBmcm9tIGEgcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBhdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgIHJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHtBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKX0vdG9rZW5gO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgc3VmZml4LWNvbXBhdGlibGUgUkZDIDg0MTQgZGlzY292ZXJ5IHBhdGggZnJvbSBhIHJlc291cmNlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgcmVzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVBhdGgocmVzb3VyY2VQYXRoKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIvXCIpIHtcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuQVVUSE9SSVpBVElPTl9TRVJWRVJfUFJFRklYO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZCArIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BVVRIT1JJWkFUSU9OX1NFUlZFUl9QUkVGSVg7XG4gIH1cblxuICAvKiogUmVjb3ZlciBhIHJlc291cmNlIHBhdGggZnJvbSBhbiBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZXNvdXJjZVBhdGhGcm9tUHJvdGVjdGVkUmVzb3VyY2VQYXRoKFxuICAgIHByb3RlY3RlZFJlc291cmNlUGF0aDogc3RyaW5nLFxuICApOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVQYXRoKHByb3RlY3RlZFJlc291cmNlUGF0aCk7XG4gICAgY29uc3QgcHJlZml4ID0gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLlBST1RFQ1RFRF9SRVNPVVJDRV9QUkVGSVg7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IHByZWZpeCkge1xuICAgICAgcmV0dXJuIFwiL1wiO1xuICAgIH1cbiAgICBpZiAoIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChgJHtwcmVmaXh9L2ApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIHByb3RlY3RlZCByZXNvdXJjZSBwYXRoICR7SlNPTi5zdHJpbmdpZnkobm9ybWFsaXplZCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBub3JtYWxpemVQYXRoKG5vcm1hbGl6ZWQuc2xpY2UocHJlZml4Lmxlbmd0aCkpO1xuICB9XG5cbiAgLyoqIERlcml2ZSB0aGUgcHJvdGVjdGVkLXJlc291cmNlIHBhdGggZm9yIGFuIE1DUCBwYXRoLiAqL1xuICBwdWJsaWMgc3RhdGljIHByb3RlY3RlZFJlc291cmNlUGF0aEZyb21NY3BQYXRoKG1jcFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBtY3BQYXRoLFxuICAgICk7XG4gIH1cblxuICAvKiogUmV0dXJuIGV2ZXJ5IGNhbm9uaWNhbCBNQ1AgZW5kcG9pbnQgdGVtcGxhdGUgaW4gY29udHJhY3Qgb3JkZXIuICovXG4gIHB1YmxpYyBzdGF0aWMgc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRUZW1wbGF0ZVtdIHtcbiAgICByZXR1cm4gZW5kcG9pbnRUZW1wbGF0ZVNlZWRzKCkubWFwKCh7IGtpbmQsIHBhdHRlcm4gfSkgPT4gKHtcbiAgICAgIGtpbmQsXG4gICAgICBtY3BQYXR0ZXJuOiBwYXR0ZXJuLFxuICAgICAgcHJvdGVjdGVkUmVzb3VyY2VQYXRoOlxuICAgICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE9BdXRoIGF1dGhvcml6YXRpb24gZmFjYWRlIHRlbXBsYXRlIGluIGNvbnRyYWN0IG9yZGVyLiAqL1xuICBwdWJsaWMgc3RhdGljIHN1cHBvcnRlZE9BdXRoRmFjYWRlVGVtcGxhdGVzKCk6IEFwcFRoZW9yeU1jcE9BdXRoRmFjYWRlVGVtcGxhdGVbXSB7XG4gICAgcmV0dXJuIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpLm1hcCgoeyBraW5kLCBwYXR0ZXJuIH0pID0+ICh7XG4gICAgICBraW5kLFxuICAgICAgYXV0aG9yaXplUGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgICB0b2tlblBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKHBhdHRlcm4pLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm4gZXZlcnkgY2Fub25pY2FsIE9BdXRoIGRpc2NvdmVyeSB0ZW1wbGF0ZSBpbiBjb250cmFjdCBvcmRlci4gKi9cbiAgcHVibGljIHN0YXRpYyBzdXBwb3J0ZWRPQXV0aERpc2NvdmVyeVRlbXBsYXRlcygpOiBBcHBUaGVvcnlNY3BPQXV0aERpc2NvdmVyeVRlbXBsYXRlW10ge1xuICAgIHJldHVybiBlbmRwb2ludFRlbXBsYXRlU2VlZHMoKS5tYXAoKHsga2luZCwgcGF0dGVybiB9KSA9PiAoe1xuICAgICAga2luZCxcbiAgICAgIGNhbm9uaWNhbFBhdHRlcm46XG4gICAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgICAgICBwYXR0ZXJuLFxuICAgICAgICApLFxuICAgICAgc3VmZml4UGF0dGVybjpcbiAgICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKFxuICAgICAgICAgIHBhdHRlcm4sXG4gICAgICAgICksXG4gICAgfSkpO1xuICB9XG5cbiAgLyoqIFBhcnNlIGEgY29uY3JldGUgTUNQIHBhdGggYWZ0ZXIgY29udHJhY3Qgbm9ybWFsaXphdGlvbi4gKi9cbiAgcHVibGljIHN0YXRpYyBwYXJzZU1jcFBhdGgocmF3UGF0aDogc3RyaW5nKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHtcbiAgICBjb25zdCB1bm5vcm1hbGl6ZWRFbmRwb2ludCA9IGVuZHBvaW50RnJvbVNlZ21lbnRzKFxuICAgICAgc3BsaXRQYXRoQmVmb3JlRG90Tm9ybWFsaXphdGlvbihyYXdQYXRoKSxcbiAgICApO1xuICAgIGlmICh1bm5vcm1hbGl6ZWRFbmRwb2ludCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgodW5ub3JtYWxpemVkRW5kcG9pbnQpO1xuICAgICAgcmV0dXJuIHVubm9ybWFsaXplZEVuZHBvaW50O1xuICAgIH1cblxuICAgIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRGcm9tU2VnbWVudHMoc3BsaXRQYXRoKG5vcm1hbGl6ZVBhdGgocmF3UGF0aCkpKTtcbiAgICBpZiAoZW5kcG9pbnQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBNQ1AgcGF0aCAke0pTT04uc3RyaW5naWZ5KHJhd1BhdGgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEudmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICAgIHJldHVybiBlbmRwb2ludDtcbiAgfVxuXG4gIC8qKiBWYWxpZGF0ZSBlbmRwb2ludCBraW5kLXRvLWlkZW50aWZpZXIgY29uc2lzdGVuY3kgYW5kIHBhdGgtc2VnbWVudCBzYWZldHkuICovXG4gIHB1YmxpYyBzdGF0aWMgdmFsaWRhdGVFbmRwb2ludFBhdGgoZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCk6IHZvaWQge1xuICAgIGlmICghaXNQYXRoU2VnbWVudChlbmRwb2ludC5jbGllbnROYW1lc3BhY2UpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwibWNwcm91dGVzOiBjbGllbnROYW1lc3BhY2UgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcGFydG5lcklkID0gZW5kcG9pbnQucGFydG5lcklkID8/IFwiXCI7XG4gICAgY29uc3QgYWdlbnRJZCA9IGVuZHBvaW50LmFnZW50SWQgPz8gXCJcIjtcbiAgICBzd2l0Y2ggKGVuZHBvaW50LmtpbmQpIHtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfTkFNRVNQQUNFOlxuICAgICAgICBpZiAocGFydG5lcklkICE9PSBcIlwiIHx8IGFnZW50SWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogbmFtZXNwYWNlIGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIHBhcnRuZXIgb3IgYWdlbnQgaWRlbnRpZmllcnNcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0U6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChwYXJ0bmVySWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFnZW50SWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIm1jcHJvdXRlczogcGFydG5lciBuYW1lc3BhY2UgZW5kcG9pbnQgY2Fubm90IGluY2x1ZGUgYWdlbnRJZFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgY2FzZSBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVDpcbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IGFnZW50SWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJ0bmVySWQgIT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJtY3Byb3V0ZXM6IGFnZW50IGVuZHBvaW50IGNhbm5vdCBpbmNsdWRlIHBhcnRuZXJJZFwiKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQ6XG4gICAgICAgIGlmICghaXNQYXRoU2VnbWVudChwYXJ0bmVySWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IHBhcnRuZXJJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHBhdGggc2VnbWVudFwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpc1BhdGhTZWdtZW50KGFnZW50SWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJtY3Byb3V0ZXM6IGFnZW50SWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBwYXRoIHNlZ21lbnRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgbWNwcm91dGVzOiB1bnN1cHBvcnRlZCBlbmRwb2ludCBraW5kICR7SlNPTi5zdHJpbmdpZnkoZW5kcG9pbnQua2luZCl9YCxcbiAgICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKiogQnVpbGQgdGhlIGNvbmNyZXRlIE1DUCBwYXRoIGZvciBhbiBlbmRwb2ludC4gKi9cbiAgcHVibGljIHN0YXRpYyBtY3BQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS52YWxpZGF0ZUVuZHBvaW50UGF0aChlbmRwb2ludCk7XG4gICAgc3dpdGNoIChlbmRwb2ludC5raW5kKSB7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX05BTUVTUEFDRTpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfTkFNRVNQQUNFOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vcGFydG5lcnMvJHtlbmRwb2ludC5wYXJ0bmVySWR9L21jcGA7XG4gICAgICBjYXNlIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX0FHRU5UOlxuICAgICAgICByZXR1cm4gYC8ke2VuZHBvaW50LmNsaWVudE5hbWVzcGFjZX0vYWdlbnRzLyR7ZW5kcG9pbnQuYWdlbnRJZH0vbWNwYDtcbiAgICAgIGNhc2UgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVDpcbiAgICAgICAgcmV0dXJuIGAvJHtlbmRwb2ludC5jbGllbnROYW1lc3BhY2V9L3BhcnRuZXJzLyR7ZW5kcG9pbnQucGFydG5lcklkfS9hZ2VudHMvJHtlbmRwb2ludC5hZ2VudElkfS9tY3BgO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtY3Byb3V0ZXM6IHVuc3VwcG9ydGVkIGVuZHBvaW50IGtpbmQgJHtKU09OLnN0cmluZ2lmeShlbmRwb2ludC5raW5kKX1gLFxuICAgICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBwcm90ZWN0ZWRSZXNvdXJjZVBhdGgoXG4gICAgZW5kcG9pbnQ6IEFwcFRoZW9yeU1jcEVuZHBvaW50UGF0aCxcbiAgKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGNhbm9uaWNhbCBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG5cbiAgLyoqIEJ1aWxkIHRoZSBlbmRwb2ludCdzIGF1dGhvcml6YXRpb24gZmFjYWRlIHBhdGguICovXG4gIHB1YmxpYyBzdGF0aWMgb2F1dGhBdXRob3JpemVQYXRoKGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgpOiBzdHJpbmcge1xuICAgIHJldHVybiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyB0b2tlbiBmYWNhZGUgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aFRva2VuUGF0aChlbmRwb2ludDogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEubWNwUGF0aChlbmRwb2ludCksXG4gICAgKTtcbiAgfVxuXG4gIC8qKiBCdWlsZCB0aGUgZW5kcG9pbnQncyBzdWZmaXgtY29tcGF0aWJsZSBSRkMgODQxNCBkaXNjb3ZlcnkgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyBvYXV0aEF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoKFxuICAgIGVuZHBvaW50OiBBcHBUaGVvcnlNY3BFbmRwb2ludFBhdGgsXG4gICk6IHN0cmluZyB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5tY3BQYXRoKGVuZHBvaW50KSxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVuZHBvaW50VGVtcGxhdGVTZWVkcygpOiBBcnJheTx7IGtpbmQ6IHN0cmluZzsgcGF0dGVybjogc3RyaW5nIH0+IHtcbiAgcmV0dXJuIFtcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuTkFNRVNQQUNFX01DUF9QQVRURVJOLFxuICAgIH0sXG4gICAge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUEFSVE5FUl9OQU1FU1BBQ0VfTUNQX1BBVFRFUk4sXG4gICAgfSxcbiAgICB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVCxcbiAgICAgIHBhdHRlcm46IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5BR0VOVF9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICAgIHtcbiAgICAgIGtpbmQ6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5FTkRQT0lOVF9LSU5EX1BBUlRORVJfQUdFTlQsXG4gICAgICBwYXR0ZXJuOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuUEFSVE5FUl9BR0VOVF9NQ1BfUEFUVEVSTixcbiAgICB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBlbmRwb2ludEZyb21TZWdtZW50cyhcbiAgc2VnbWVudHM6IHN0cmluZ1tdLFxuKTogQXBwVGhlb3J5TWNwRW5kcG9pbnRQYXRoIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHNlZ21lbnRzLmxlbmd0aCA9PT0gMiAmJiBzZWdtZW50c1sxXSA9PT0gXCJtY3BcIikge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9OQU1FU1BBQ0UsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgIH07XG4gIH1cbiAgaWYgKFxuICAgIHNlZ21lbnRzLmxlbmd0aCA9PT0gNCAmJlxuICAgIHNlZ21lbnRzWzFdID09PSBcInBhcnRuZXJzXCIgJiZcbiAgICBzZWdtZW50c1szXSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9OQU1FU1BBQ0UsXG4gICAgICBjbGllbnROYW1lc3BhY2U6IHNlZ21lbnRzWzBdLFxuICAgICAgcGFydG5lcklkOiBzZWdtZW50c1syXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDQgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJhZ2VudHNcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcIm1jcFwiXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuRU5EUE9JTlRfS0lORF9BR0VOVCxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICBhZ2VudElkOiBzZWdtZW50c1syXSxcbiAgICB9O1xuICB9XG4gIGlmIChcbiAgICBzZWdtZW50cy5sZW5ndGggPT09IDYgJiZcbiAgICBzZWdtZW50c1sxXSA9PT0gXCJwYXJ0bmVyc1wiICYmXG4gICAgc2VnbWVudHNbM10gPT09IFwiYWdlbnRzXCIgJiZcbiAgICBzZWdtZW50c1s1XSA9PT0gXCJtY3BcIlxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkVORFBPSU5UX0tJTkRfUEFSVE5FUl9BR0VOVCxcbiAgICAgIGNsaWVudE5hbWVzcGFjZTogc2VnbWVudHNbMF0sXG4gICAgICBwYXJ0bmVySWQ6IHNlZ21lbnRzWzJdLFxuICAgICAgYWdlbnRJZDogc2VnbWVudHNbNF0sXG4gICAgfTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB0cmltQVNDSUlXaGl0ZXNwYWNlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZShBU0NJSV9XSElURVNQQUNFX1RSSU1fUEFUVEVSTiwgXCJcIik7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGgocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG5vcm1hbGl6ZWQgPSB0cmltQVNDSUlXaGl0ZXNwYWNlKHJhd1BhdGgpO1xuICBpZiAobm9ybWFsaXplZCA9PT0gXCJcIikge1xuICAgIHJldHVybiBcIi9cIjtcbiAgfVxuICBpZiAoIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICBub3JtYWxpemVkID0gYC8ke25vcm1hbGl6ZWR9YDtcbiAgfVxuXG4gIGNvbnN0IHNlZ21lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygbm9ybWFsaXplZC5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCJcIiB8fCBzZWdtZW50ID09PSBcIi5cIikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWdtZW50ID09PSBcIi4uXCIpIHtcbiAgICAgIHNlZ21lbnRzLnBvcCgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZ21lbnRzLnB1c2goc2VnbWVudCk7XG4gIH1cbiAgcmV0dXJuIHNlZ21lbnRzLmxlbmd0aCA9PT0gMCA/IFwiL1wiIDogYC8ke3NlZ21lbnRzLmpvaW4oXCIvXCIpfWA7XG59XG5cbmZ1bmN0aW9uIHNwbGl0UGF0aEJlZm9yZURvdE5vcm1hbGl6YXRpb24ocmF3UGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdHJpbUFTQ0lJV2hpdGVzcGFjZShyYXdQYXRoKVxuICAgIC5zcGxpdChcIi9cIilcbiAgICAuZmlsdGVyKChzZWdtZW50KSA9PiBzZWdtZW50ICE9PSBcIlwiKTtcbn1cblxuZnVuY3Rpb24gc3BsaXRQYXRoKG5vcm1hbGl6ZWRQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBub3JtYWxpemVkUGF0aCA9PT0gXCIvXCIgPyBbXSA6IG5vcm1hbGl6ZWRQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKTtcbn1cblxuZnVuY3Rpb24gaXNQYXRoU2VnbWVudCh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRyaW1tZWQgPSB0cmltQVNDSUlXaGl0ZXNwYWNlKHZhbHVlKTtcbiAgcmV0dXJuIChcbiAgICB0cmltbWVkICE9PSBcIlwiICYmXG4gICAgdHJpbW1lZCAhPT0gXCIuXCIgJiZcbiAgICB0cmltbWVkICE9PSBcIi4uXCIgJiZcbiAgICAhdmFsdWUuaW5jbHVkZXMoXCIvXCIpXG4gICk7XG59XG4iXX0=