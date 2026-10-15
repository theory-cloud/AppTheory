package apptheorycdk

// Options for the optional challenge alias bridge.
type AppTheoryChallengeAliasBridgeOptions struct {
	// Enables the optional challenge alias bridge.
	//
	// When enabled the restoration consults the bridge aliases
	// (`x-theory-www-authenticate`, then `mcp-www-authenticate`) after the AWS
	// REST v1 remap artifact. When disabled only the remap artifact is consulted
	// and the alias spellings never appear in the deployed function source.
	// Default: false.
	//
	Enabled *bool `field:"optional" json:"enabled" yaml:"enabled"`
}
