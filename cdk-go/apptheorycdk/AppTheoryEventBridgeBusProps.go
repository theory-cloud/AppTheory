package apptheorycdk

type AppTheoryEventBridgeBusProps struct {
	// Explicit cross-account allowlist for `events:PutEvents`.
	//
	// Partners can be onboarded one account at a time by adding IDs here.
	// Default: [].
	//
	AllowedAccountIds *[]*string `field:"optional" json:"allowedAccountIds" yaml:"allowedAccountIds"`
	// Optional event bus description.
	// Default: - no description.
	//
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Optional custom event bus name.
	// Default: - CloudFormation-generated name.
	//
	EventBusName *string `field:"optional" json:"eventBusName" yaml:"eventBusName"`
}
