package apptheorycdk

// A canonical MCP route template and its protected-resource route.
type AppTheoryMcpEndpointTemplate struct {
	// Endpoint kind from the versioned route-algebra quartet.
	Kind *string `field:"required" json:"kind" yaml:"kind"`
	// Canonical MCP route pattern.
	McpPattern *string `field:"required" json:"mcpPattern" yaml:"mcpPattern"`
	// Derived RFC 9728 protected-resource route pattern.
	ProtectedResourcePath *string `field:"required" json:"protectedResourcePath" yaml:"protectedResourcePath"`
}
