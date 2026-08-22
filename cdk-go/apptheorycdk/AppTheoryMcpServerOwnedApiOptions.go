package apptheorycdk

// Owned-API specialization for standalone MCP servers.
type AppTheoryMcpServerOwnedApiOptions struct {
	// Optional API name.
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Optional custom domain owned by this construct.
	Domain *AppTheoryMcpServerDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Stage configuration.
	//
	// Access logging and throttling default on.
	// Default: production defaults.
	//
	Stage *AppTheoryMcpServerStageOptions `field:"optional" json:"stage" yaml:"stage"`
}
