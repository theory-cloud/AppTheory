package apptheorycdk

// One route that is installed once per deployment instead of per MCP endpoint kind.
type AppTheoryMcpStageGlobalRoute struct {
	// HTTP methods wired for the pattern.
	Methods *[]*string `field:"required" json:"methods" yaml:"methods"`
	// Contract name of the stage-global route.
	Name *string `field:"required" json:"name" yaml:"name"`
	// Canonical route pattern.
	Pattern *string `field:"required" json:"pattern" yaml:"pattern"`
}
