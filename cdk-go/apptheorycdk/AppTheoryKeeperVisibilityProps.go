package apptheorycdk

// Properties for an `AppTheoryKeeperVisibility`.
type AppTheoryKeeperVisibilityProps struct {
	// The naming context.
	//
	// Its app, stage and log-source prefix bind every rule.
	NamingContext AppTheoryNamingContext `field:"required" json:"namingContext" yaml:"namingContext"`
	// The principal allowed to assume the reader role: Keeper's runtime role ARN.
	ReaderPrincipalArn *string `field:"required" json:"readerPrincipalArn" yaml:"readerPrincipalArn"`
	// The consumer's include and exclude selectors.
	Rules *AppTheoryVisibilityRules `field:"required" json:"rules" yaml:"rules"`
	// The SSM parameter tier of the manifest.
	// Default: AppTheoryVisibilityManifestTier.STANDARD
	//
	ManifestTier AppTheoryVisibilityManifestTier `field:"optional" json:"manifestTier" yaml:"manifestTier"`
	// Explicit logical sources.
	//
	// When omitted the stack's declared log groups are
	// discovered at synthesis.
	// Default: undefined.
	//
	Sources *[]*string `field:"optional" json:"sources" yaml:"sources"`
}
