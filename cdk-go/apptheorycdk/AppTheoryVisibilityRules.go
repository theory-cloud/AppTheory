package apptheorycdk

// Include and exclude visibility selectors.
type AppTheoryVisibilityRules struct {
	// Selectors whose sources are never shared.
	//
	// Exclusions win.
	// Default: [].
	//
	Exclude *[]*string `field:"optional" json:"exclude" yaml:"exclude"`
	// Selectors whose sources are shared.
	// Default: [].
	//
	Include *[]*string `field:"optional" json:"include" yaml:"include"`
}
