/**
 * Canonical route paths for AppTheory MCP servers and OAuth discovery.
 *
 * These are paths, never origins or full URLs. Namespace applications derive
 * their protected resource host from each request at runtime.
 */
export abstract class AppTheoryMcpPaths {
  /** Conventional MCP endpoint path. */
  public static readonly MCP = "/mcp";

  /** Generic RFC 9728 protected-resource metadata path. */
  public static readonly OAUTH_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

  /** RFC 9728 protected-resource metadata path for the conventional MCP endpoint. */
  public static readonly OAUTH_PROTECTED_RESOURCE_MCP = "/.well-known/oauth-protected-resource/mcp";

  /** RFC 8414 authorization-server metadata path for an MCP resource. */
  public static readonly OAUTH_AUTHORIZATION_SERVER_MCP = "/.well-known/oauth-authorization-server/mcp";
}
