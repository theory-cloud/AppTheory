package apptheorycdk

// One derived MCP OAuth facade route family.
type AppTheoryMcpServerFacadeRoute struct {
	AuthorizationRoutesAttached *bool      `field:"required" json:"authorizationRoutesAttached" yaml:"authorizationRoutesAttached"`
	AuthorizePattern            *string    `field:"required" json:"authorizePattern" yaml:"authorizePattern"`
	DiscoveryCanonicalPattern   *string    `field:"required" json:"discoveryCanonicalPattern" yaml:"discoveryCanonicalPattern"`
	DiscoverySuffixPattern      *string    `field:"required" json:"discoverySuffixPattern" yaml:"discoverySuffixPattern"`
	McpMethods                  *[]*string `field:"required" json:"mcpMethods" yaml:"mcpMethods"`
	McpPattern                  *string    `field:"required" json:"mcpPattern" yaml:"mcpPattern"`
	ProtectedResourcePattern    *string    `field:"required" json:"protectedResourcePattern" yaml:"protectedResourcePattern"`
	TokenPattern                *string    `field:"required" json:"tokenPattern" yaml:"tokenPattern"`
}
