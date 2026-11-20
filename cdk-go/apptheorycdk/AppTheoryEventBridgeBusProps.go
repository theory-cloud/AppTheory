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
	// Optional naming context.
	//
	// Under a derived context the bus takes a
	// resource-based policy that admits only the owning account, which is what
	// Security Hub EventBridge.3 asks for.
	//
	// With no context the construct synthesizes exactly as before.
	// Default: undefined.
	//
	NamingContext AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
	// Whether to attach the owning-account resource policy.
	//
	// Attaching it closes the bus to every principal except the owning account,
	// which preserves today's same-account behaviour while satisfying
	// EventBridge.3. Set false to attach only your own statements.
	// Default: true under a derived naming context, otherwise undefined.
	//
	OwningAccountResourcePolicy *bool `field:"optional" json:"owningAccountResourcePolicy" yaml:"owningAccountResourcePolicy"`
}
