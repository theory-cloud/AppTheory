package apptheorycdk

// Attach-mode record of the owning API's defense-in-depth decisions (required under `runtime-bearer` and `none-public`).
type AppTheoryMcpOwningApiDefenseOptions struct {
	// Whether the owning API's stage has access logging enabled.
	//
	// Must be true.
	AccessLogging *bool `field:"required" json:"accessLogging" yaml:"accessLogging"`
	// The owning API's stage throttling decision.
	Throttling *AppTheoryMcpOwningApiThrottlingOptions `field:"required" json:"throttling" yaml:"throttling"`
}
