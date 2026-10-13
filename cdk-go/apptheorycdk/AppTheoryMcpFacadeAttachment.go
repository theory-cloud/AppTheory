package apptheorycdk

// Presence-only skeleton of the upstream-provider attachment that selects the facade-scoped default.
type AppTheoryMcpFacadeAttachment struct {
	// Identifies the upstream authorization provider this server fronts (for example `autheory`).
	//
	// Provider wiring lands in M3; this milestone validates the attachment shape and uses its presence to select the `runtime-bearer` default.
	ProviderId *string `field:"required" json:"providerId" yaml:"providerId"`
}
