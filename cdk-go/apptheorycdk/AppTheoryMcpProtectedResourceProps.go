package apptheorycdk

// Props for AppTheoryMcpProtectedResource.
//
// This construct adds the RFC9728 protected resource metadata endpoint required
// by MCP auth (2025-06-18):
// - GET `/.well-known/oauth-protected-resource`
type AppTheoryMcpProtectedResourceProps struct {
	// One or more OAuth Authorization Server issuer/base URLs.
	//
	// Autheory should be the first (and usually only) entry.
	AuthorizationServers *[]*string `field:"required" json:"authorizationServers" yaml:"authorizationServers"`
	// The canonical protected resource identifier.
	//
	// For Claude Remote MCP this should be your MCP endpoint URL (including `/mcp`),
	// e.g. `https://mcp.example.com/mcp`.
	Resource *string `field:"required" json:"resource" yaml:"resource"`
	// The REST API router to attach the well-known endpoint to.
	Router AppTheoryRestApiRouter `field:"required" json:"router" yaml:"router"`
}
