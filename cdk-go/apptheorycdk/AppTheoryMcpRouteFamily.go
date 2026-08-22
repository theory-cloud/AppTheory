package apptheorycdk

// Ordered MCP route-pattern family wired as one facade.
type AppTheoryMcpRouteFamily struct {
	// Ordered synthesis-time MCP route patterns.
	//
	// Each segment is either a literal RFC 3986 path segment or a complete
	// `{parameter_name}` segment. CDK tokens, origins, empty segments, dot
	// segments, greedy parameters, and duplicate patterns are rejected.
	Patterns *[]*string `field:"required" json:"patterns" yaml:"patterns"`
	// Wire the algebra-derived unscoped authorization-server discovery route.
	//
	// The runtime must supply `FacadeConfig.RootAuthorizationServer` too.
	// Default: false.
	//
	RootAuthorizationServerDiscovery *bool `field:"optional" json:"rootAuthorizationServerDiscovery" yaml:"rootAuthorizationServerDiscovery"`
}
