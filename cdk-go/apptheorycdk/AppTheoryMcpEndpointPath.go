package apptheorycdk

// A concrete canonical MCP endpoint path.
type AppTheoryMcpEndpointPath struct {
	// Client namespace path segment.
	ClientNamespace *string `field:"required" json:"clientNamespace" yaml:"clientNamespace"`
	// Endpoint kind from the versioned route-algebra quartet.
	Kind *string `field:"required" json:"kind" yaml:"kind"`
	// Agent identifier for agent endpoint kinds.
	AgentId *string `field:"optional" json:"agentId" yaml:"agentId"`
	// Partner identifier for partner-scoped endpoint kinds.
	PartnerId *string `field:"optional" json:"partnerId" yaml:"partnerId"`
}
