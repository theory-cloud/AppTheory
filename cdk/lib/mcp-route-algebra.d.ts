/** A concrete canonical MCP endpoint path. */
export interface AppTheoryMcpEndpointPath {
    /** Endpoint kind from the versioned route-algebra quartet. */
    readonly kind: string;
    /** Client namespace path segment. */
    readonly clientNamespace: string;
    /** Partner identifier for partner-scoped endpoint kinds. */
    readonly partnerId?: string;
    /** Agent identifier for agent endpoint kinds. */
    readonly agentId?: string;
}
/** A canonical MCP route template and its protected-resource route. */
export interface AppTheoryMcpEndpointTemplate {
    /** Endpoint kind from the versioned route-algebra quartet. */
    readonly kind: string;
    /** Canonical MCP route pattern. */
    readonly mcpPattern: string;
    /** Derived RFC 9728 protected-resource route pattern. */
    readonly protectedResourcePath: string;
}
/** Derived OAuth authorization facade patterns for an MCP endpoint kind. */
export interface AppTheoryMcpOAuthFacadeTemplate {
    /** Endpoint kind from the versioned route-algebra quartet. */
    readonly kind: string;
    /** Derived authorization endpoint pattern. */
    readonly authorizePattern: string;
    /** Derived token endpoint pattern. */
    readonly tokenPattern: string;
}
/** Canonical and suffix-compatible OAuth discovery patterns for an MCP endpoint kind. */
export interface AppTheoryMcpOAuthDiscoveryTemplate {
    /** Endpoint kind from the versioned route-algebra quartet. */
    readonly kind: string;
    /** Derived canonical RFC 8414 discovery pattern. */
    readonly canonicalPattern: string;
    /** Derived suffix-compatible RFC 8414 discovery pattern. */
    readonly suffixPattern: string;
}
/**
 * AppTheory's canonical, versioned MCP route-algebra contract.
 *
 * Every OAuth route is derived from the four MCP patterns through the pure
 * functions on this class. Concrete endpoint builders validate the same
 * kind-to-identifier invariants as the Go runtime package.
 */
export declare abstract class AppTheoryMcpRouteAlgebra {
    /** MCP route-algebra contract version. */
    static readonly CONTRACT_VERSION = "m17.mcp-route-algebra/v1";
    /** Namespace endpoint kind. */
    static readonly ENDPOINT_KIND_NAMESPACE = "namespace";
    /** Partner-scoped namespace endpoint kind. */
    static readonly ENDPOINT_KIND_PARTNER_NAMESPACE = "partner_namespace";
    /** Agent endpoint kind. */
    static readonly ENDPOINT_KIND_AGENT = "agent";
    /** Partner-scoped agent endpoint kind. */
    static readonly ENDPOINT_KIND_PARTNER_AGENT = "partner_agent";
    /** Canonical namespace MCP route pattern. */
    static readonly NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";
    /** Canonical partner-scoped namespace MCP route pattern. */
    static readonly PARTNER_NAMESPACE_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/mcp";
    /** Canonical agent MCP route pattern. */
    static readonly AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp";
    /** Canonical partner-scoped agent MCP route pattern. */
    static readonly PARTNER_AGENT_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";
    /** RFC 9728 protected-resource metadata prefix. */
    static readonly PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";
    /** RFC 8414 authorization-server metadata prefix. */
    static readonly AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server";
    /** Derive an RFC 9728 protected-resource path from a resource path. */
    static protectedResourcePathForResourcePath(resourcePath: string): string;
    /** Derive the canonical RFC 8414 discovery path from a resource path. */
    static authorizationServerPathForResourcePath(resourcePath: string): string;
    /** Derive the authorization facade path from a resource path. */
    static authorizationAuthorizePathForResourcePath(resourcePath: string): string;
    /** Derive the token facade path from a resource path. */
    static authorizationTokenPathForResourcePath(resourcePath: string): string;
    /** Derive the suffix-compatible RFC 8414 discovery path from a resource path. */
    static authorizationServerSuffixPathForResourcePath(resourcePath: string): string;
    /** Recover a resource path from an RFC 9728 protected-resource path. */
    static resourcePathFromProtectedResourcePath(protectedResourcePath: string): string;
    /** Derive the protected-resource path for an MCP path. */
    static protectedResourcePathFromMcpPath(mcpPath: string): string;
    /** Return every canonical MCP endpoint template in contract order. */
    static supportedEndpointTemplates(): AppTheoryMcpEndpointTemplate[];
    /** Return every canonical OAuth authorization facade template in contract order. */
    static supportedOAuthFacadeTemplates(): AppTheoryMcpOAuthFacadeTemplate[];
    /** Return every canonical OAuth discovery template in contract order. */
    static supportedOAuthDiscoveryTemplates(): AppTheoryMcpOAuthDiscoveryTemplate[];
    /** Parse a concrete MCP path after contract normalization. */
    static parseMcpPath(rawPath: string): AppTheoryMcpEndpointPath;
    /** Validate endpoint kind-to-identifier consistency and path-segment safety. */
    static validateEndpointPath(endpoint: AppTheoryMcpEndpointPath): void;
    /** Build the concrete MCP path for an endpoint. */
    static mcpPath(endpoint: AppTheoryMcpEndpointPath): string;
    /** Build the endpoint's RFC 9728 protected-resource path. */
    static protectedResourcePath(endpoint: AppTheoryMcpEndpointPath): string;
    /** Build the endpoint's canonical RFC 8414 discovery path. */
    static oauthAuthorizationServerPath(endpoint: AppTheoryMcpEndpointPath): string;
    /** Build the endpoint's authorization facade path. */
    static oauthAuthorizePath(endpoint: AppTheoryMcpEndpointPath): string;
    /** Build the endpoint's token facade path. */
    static oauthTokenPath(endpoint: AppTheoryMcpEndpointPath): string;
    /** Build the endpoint's suffix-compatible RFC 8414 discovery path. */
    static oauthAuthorizationServerSuffixPath(endpoint: AppTheoryMcpEndpointPath): string;
}
