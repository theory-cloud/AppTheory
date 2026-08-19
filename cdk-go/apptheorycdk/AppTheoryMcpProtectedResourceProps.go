package apptheorycdk

// Props for AppTheoryMcpProtectedResource.
//
// This construct adds the RFC9728 protected resource metadata endpoint required
// by MCP auth (2025-06-18):
// - GET `/.well-known/oauth-protected-resource/...resource path...`
type AppTheoryMcpProtectedResourceProps struct {
	// One or more OAuth Authorization Server issuer/base URLs.
	//
	// Autheory should be the first (and usually only) entry.
	// Deprecated: Use AppTheoryMcpServer authorizationServerIssuer and jwksUri
	// props with the Go runtime discovery helper.
	AuthorizationServers *[]*string `field:"required" json:"authorizationServers" yaml:"authorizationServers"`
	// The canonical protected resource identifier.
	//
	// For Claude Remote MCP this should be your MCP endpoint URL (including `/mcp`),
	// e.g. `https://mcp.example.com/mcp`.
	// Deprecated: Use AppTheoryMcpServer with runtime-served discovery. This
	// URL-valued compatibility prop is retained for existing static documents.
	Resource *string `field:"required" json:"resource" yaml:"resource"`
	// The REST API router to attach the well-known endpoint to.
	Router AppTheoryRestApiRouter `field:"required" json:"router" yaml:"router"`
	// Explicit literal route path for the secondary synth-time-static document.
	//
	// When omitted, the path is derived from a literal `resource` URL for full
	// backwards compatibility. Set this only when a static mock integration is
	// genuinely required; namespace applications should use AppTheoryMcpServer
	// and runtime-served discovery instead.
	// Default: derived from resource.
	//
	MetadataPath *string `field:"optional" json:"metadataPath" yaml:"metadataPath"`
}
