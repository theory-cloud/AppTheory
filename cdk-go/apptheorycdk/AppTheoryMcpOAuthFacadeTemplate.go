package apptheorycdk

// Derived OAuth authorization facade patterns for an MCP endpoint kind.
type AppTheoryMcpOAuthFacadeTemplate struct {
	// Derived authorization endpoint pattern.
	AuthorizePattern *string `field:"required" json:"authorizePattern" yaml:"authorizePattern"`
	// Endpoint kind from the versioned route-algebra quartet.
	Kind *string `field:"required" json:"kind" yaml:"kind"`
	// Derived RFC 7591 dynamic-client registration pattern.
	RegisterPattern *string `field:"required" json:"registerPattern" yaml:"registerPattern"`
	// Derived token endpoint pattern.
	TokenPattern *string `field:"required" json:"tokenPattern" yaml:"tokenPattern"`
}
