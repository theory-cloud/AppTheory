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
export abstract class AppTheoryMcpRouteAlgebra {
  /** MCP route-algebra contract version. */
  public static readonly CONTRACT_VERSION = "m17.mcp-route-algebra/v1";

  /** Namespace endpoint kind. */
  public static readonly ENDPOINT_KIND_NAMESPACE = "namespace";

  /** Partner-scoped namespace endpoint kind. */
  public static readonly ENDPOINT_KIND_PARTNER_NAMESPACE = "partner_namespace";

  /** Agent endpoint kind. */
  public static readonly ENDPOINT_KIND_AGENT = "agent";

  /** Partner-scoped agent endpoint kind. */
  public static readonly ENDPOINT_KIND_PARTNER_AGENT = "partner_agent";

  /** Canonical namespace MCP route pattern. */
  public static readonly NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";

  /** Canonical partner-scoped namespace MCP route pattern. */
  public static readonly PARTNER_NAMESPACE_MCP_PATTERN =
    "/{client_namespace}/partners/{partner_id}/mcp";

  /** Canonical agent MCP route pattern. */
  public static readonly AGENT_MCP_PATTERN =
    "/{client_namespace}/agents/{agent_id}/mcp";

  /** Canonical partner-scoped agent MCP route pattern. */
  public static readonly PARTNER_AGENT_MCP_PATTERN =
    "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";

  /** RFC 9728 protected-resource metadata prefix. */
  public static readonly PROTECTED_RESOURCE_PREFIX =
    "/.well-known/oauth-protected-resource";

  /** RFC 8414 authorization-server metadata prefix. */
  public static readonly AUTHORIZATION_SERVER_PREFIX =
    "/.well-known/oauth-authorization-server";

  /** Derive an RFC 9728 protected-resource path from a resource path. */
  public static protectedResourcePathForResourcePath(resourcePath: string): string {
    const normalized = normalizePath(resourcePath);
    if (normalized === "/") {
      return AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX;
    }
    return AppTheoryMcpRouteAlgebra.PROTECTED_RESOURCE_PREFIX + normalized;
  }

  /** Derive the canonical RFC 8414 discovery path from a resource path. */
  public static authorizationServerPathForResourcePath(resourcePath: string): string {
    const normalized = normalizePath(resourcePath);
    if (normalized === "/") {
      return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
    }
    return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX + normalized;
  }

  /** Derive the authorization facade path from a resource path. */
  public static authorizationAuthorizePathForResourcePath(resourcePath: string): string {
    return `${AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath)}/authorize`;
  }

  /** Derive the token facade path from a resource path. */
  public static authorizationTokenPathForResourcePath(resourcePath: string): string {
    return `${AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath)}/token`;
  }

  /** Derive the suffix-compatible RFC 8414 discovery path from a resource path. */
  public static authorizationServerSuffixPathForResourcePath(resourcePath: string): string {
    const normalized = normalizePath(resourcePath);
    if (normalized === "/") {
      return AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
    }
    return normalized + AppTheoryMcpRouteAlgebra.AUTHORIZATION_SERVER_PREFIX;
  }

  /** Recover a resource path from an RFC 9728 protected-resource path. */
  public static resourcePathFromProtectedResourcePath(protectedResourcePath: string): string {
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
  public static protectedResourcePathFromMcpPath(mcpPath: string): string {
    return AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(mcpPath);
  }

  /** Return every canonical MCP endpoint template in contract order. */
  public static supportedEndpointTemplates(): AppTheoryMcpEndpointTemplate[] {
    return endpointTemplateSeeds().map(({ kind, pattern }) => ({
      kind,
      mcpPattern: pattern,
      protectedResourcePath:
        AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(pattern),
    }));
  }

  /** Return every canonical OAuth authorization facade template in contract order. */
  public static supportedOAuthFacadeTemplates(): AppTheoryMcpOAuthFacadeTemplate[] {
    return endpointTemplateSeeds().map(({ kind, pattern }) => ({
      kind,
      authorizePattern:
        AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(pattern),
      tokenPattern:
        AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(pattern),
    }));
  }

  /** Return every canonical OAuth discovery template in contract order. */
  public static supportedOAuthDiscoveryTemplates(): AppTheoryMcpOAuthDiscoveryTemplate[] {
    return endpointTemplateSeeds().map(({ kind, pattern }) => ({
      kind,
      canonicalPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(pattern),
      suffixPattern:
        AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(pattern),
    }));
  }

  /** Parse a concrete MCP path after contract normalization. */
  public static parseMcpPath(rawPath: string): AppTheoryMcpEndpointPath {
    const segments = splitPath(normalizePath(rawPath));
    let endpoint: AppTheoryMcpEndpointPath | undefined;

    if (segments.length === 2 && segments[1] === "mcp") {
      endpoint = {
        kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE,
        clientNamespace: segments[0],
      };
    } else if (
      segments.length === 4 &&
      segments[1] === "partners" &&
      segments[3] === "mcp"
    ) {
      endpoint = {
        kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
        clientNamespace: segments[0],
        partnerId: segments[2],
      };
    } else if (
      segments.length === 4 &&
      segments[1] === "agents" &&
      segments[3] === "mcp"
    ) {
      endpoint = {
        kind: AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_AGENT,
        clientNamespace: segments[0],
        agentId: segments[2],
      };
    } else if (
      segments.length === 6 &&
      segments[1] === "partners" &&
      segments[3] === "agents" &&
      segments[5] === "mcp"
    ) {
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
  public static validateEndpointPath(endpoint: AppTheoryMcpEndpointPath): void {
    if (!isPathSegment(endpoint.clientNamespace)) {
      throw new Error("routing: clientNamespace must be a non-empty path segment");
    }

    const partnerId = endpoint.partnerId ?? "";
    const agentId = endpoint.agentId ?? "";
    switch (endpoint.kind) {
      case AppTheoryMcpRouteAlgebra.ENDPOINT_KIND_NAMESPACE:
        if (partnerId !== "" || agentId !== "") {
          throw new Error(
            "routing: namespace endpoint cannot include partner or agent identifiers",
          );
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
  public static mcpPath(endpoint: AppTheoryMcpEndpointPath): string {
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
  public static protectedResourcePath(endpoint: AppTheoryMcpEndpointPath): string {
    return AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(
      AppTheoryMcpRouteAlgebra.mcpPath(endpoint),
    );
  }

  /** Build the endpoint's canonical RFC 8414 discovery path. */
  public static oauthAuthorizationServerPath(endpoint: AppTheoryMcpEndpointPath): string {
    return AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(
      AppTheoryMcpRouteAlgebra.mcpPath(endpoint),
    );
  }

  /** Build the endpoint's authorization facade path. */
  public static oauthAuthorizePath(endpoint: AppTheoryMcpEndpointPath): string {
    return AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(
      AppTheoryMcpRouteAlgebra.mcpPath(endpoint),
    );
  }

  /** Build the endpoint's token facade path. */
  public static oauthTokenPath(endpoint: AppTheoryMcpEndpointPath): string {
    return AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(
      AppTheoryMcpRouteAlgebra.mcpPath(endpoint),
    );
  }

  /** Build the endpoint's suffix-compatible RFC 8414 discovery path. */
  public static oauthAuthorizationServerSuffixPath(endpoint: AppTheoryMcpEndpointPath): string {
    return AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(
      AppTheoryMcpRouteAlgebra.mcpPath(endpoint),
    );
  }
}

function endpointTemplateSeeds(): Array<{ kind: string; pattern: string }> {
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

function normalizePath(rawPath: string): string {
  let normalized = rawPath.trim();
  if (normalized === "") {
    return "/";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const segments: string[] = [];
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

function splitPath(normalizedPath: string): string[] {
  return normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
}

function isPathSegment(value: string): boolean {
  return value.trim() !== "" && !value.includes("/");
}
