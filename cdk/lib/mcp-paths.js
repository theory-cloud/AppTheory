"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpPaths = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
/**
 * Canonical route paths for AppTheory MCP servers and OAuth discovery.
 *
 * These are paths, never origins or full URLs. Namespace applications derive
 * their protected resource host from each request at runtime.
 */
class AppTheoryMcpPaths {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpPaths", version: "4.3.0" };
    /** Conventional MCP endpoint path. */
    static MCP = "/mcp";
    /** Generic RFC 9728 protected-resource metadata path. */
    static OAUTH_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
    /** RFC 9728 protected-resource metadata path for the conventional MCP endpoint. */
    static OAUTH_PROTECTED_RESOURCE_MCP = "/.well-known/oauth-protected-resource/mcp";
    /** RFC 8414 authorization-server metadata path for an MCP resource. */
    static OAUTH_AUTHORIZATION_SERVER_MCP = "/.well-known/oauth-authorization-server/mcp";
}
exports.AppTheoryMcpPaths = AppTheoryMcpPaths;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXBhdGhzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWNwLXBhdGhzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7QUFBQTs7Ozs7R0FLRztBQUNILE1BQXNCLGlCQUFpQjs7SUFDckMsc0NBQXNDO0lBQy9CLE1BQU0sQ0FBVSxHQUFHLEdBQUcsTUFBTSxDQUFDO0lBRXBDLHlEQUF5RDtJQUNsRCxNQUFNLENBQVUsd0JBQXdCLEdBQUcsdUNBQXVDLENBQUM7SUFFMUYsbUZBQW1GO0lBQzVFLE1BQU0sQ0FBVSw0QkFBNEIsR0FBRywyQ0FBMkMsQ0FBQztJQUVsRyx1RUFBdUU7SUFDaEUsTUFBTSxDQUFVLDhCQUE4QixHQUFHLDZDQUE2QyxDQUFDOztBQVh4Ryw4Q0FZQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2Fub25pY2FsIHJvdXRlIHBhdGhzIGZvciBBcHBUaGVvcnkgTUNQIHNlcnZlcnMgYW5kIE9BdXRoIGRpc2NvdmVyeS5cbiAqXG4gKiBUaGVzZSBhcmUgcGF0aHMsIG5ldmVyIG9yaWdpbnMgb3IgZnVsbCBVUkxzLiBOYW1lc3BhY2UgYXBwbGljYXRpb25zIGRlcml2ZVxuICogdGhlaXIgcHJvdGVjdGVkIHJlc291cmNlIGhvc3QgZnJvbSBlYWNoIHJlcXVlc3QgYXQgcnVudGltZS5cbiAqL1xuZXhwb3J0IGFic3RyYWN0IGNsYXNzIEFwcFRoZW9yeU1jcFBhdGhzIHtcbiAgLyoqIENvbnZlbnRpb25hbCBNQ1AgZW5kcG9pbnQgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBNQ1AgPSBcIi9tY3BcIjtcblxuICAvKiogR2VuZXJpYyBSRkMgOTcyOCBwcm90ZWN0ZWQtcmVzb3VyY2UgbWV0YWRhdGEgcGF0aC4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBPQVVUSF9QUk9URUNURURfUkVTT1VSQ0UgPSBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIjtcblxuICAvKiogUkZDIDk3MjggcHJvdGVjdGVkLXJlc291cmNlIG1ldGFkYXRhIHBhdGggZm9yIHRoZSBjb252ZW50aW9uYWwgTUNQIGVuZHBvaW50LiAqL1xuICBwdWJsaWMgc3RhdGljIHJlYWRvbmx5IE9BVVRIX1BST1RFQ1RFRF9SRVNPVVJDRV9NQ1AgPSBcIi8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvbWNwXCI7XG5cbiAgLyoqIFJGQyA4NDE0IGF1dGhvcml6YXRpb24tc2VydmVyIG1ldGFkYXRhIHBhdGggZm9yIGFuIE1DUCByZXNvdXJjZS4gKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBPQVVUSF9BVVRIT1JJWkFUSU9OX1NFUlZFUl9NQ1AgPSBcIi8ud2VsbC1rbm93bi9vYXV0aC1hdXRob3JpemF0aW9uLXNlcnZlci9tY3BcIjtcbn1cbiJdfQ==