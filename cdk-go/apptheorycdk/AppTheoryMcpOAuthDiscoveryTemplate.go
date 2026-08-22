package apptheorycdk

// Canonical and suffix-compatible OAuth discovery patterns for an MCP endpoint kind.
type AppTheoryMcpOAuthDiscoveryTemplate struct {
	// Derived canonical RFC 8414 discovery pattern.
	CanonicalPattern *string `field:"required" json:"canonicalPattern" yaml:"canonicalPattern"`
	// Endpoint kind from the versioned route-algebra quartet.
	Kind *string `field:"required" json:"kind" yaml:"kind"`
	// Derived suffix-compatible RFC 8414 discovery pattern.
	SuffixPattern *string `field:"required" json:"suffixPattern" yaml:"suffixPattern"`
}
