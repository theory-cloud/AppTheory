package apptheorycdk

// Properties for an `AppTheoryNamingContext`.
//
// The context holds the bound naming and logging values from stage config.
// Constructs take it as an optional prop; with no context every construct
// synthesizes exactly as it did before this contract existed.
type AppTheoryNamingContextProps struct {
	// Twelve-digit account id from stage config. An unresolved token fails synthesis.
	//
	// This is the account the derived-name artifact claims. AppTheory does not
	// compare it with the account of the stack that declares a resource;
	// TheoryCloud.ai's installer validates the artifact's account against the
	// stack it deploys.
	Account *string `field:"required" json:"account" yaml:"account"`
	// App instance id from stage config.
	App *string `field:"required" json:"app" yaml:"app"`
	// Full Region code, for example `us-east-1`.
	//
	// This is the Region the derived-name artifact claims. AppTheory does not
	// compare it with the Region of the stack that declares a resource;
	// TheoryCloud.ai's installer validates it against the stack it deploys.
	Region *string `field:"required" json:"region" yaml:"region"`
	// Stage id from stage config.
	Stage *string `field:"required" json:"stage" yaml:"stage"`
	// Generated-name entries keyed `{type}:{logical}`.
	//
	// An entry means
	// CloudFormation generates the name today, so the construct sets no
	// physical-name property. Valid only under the legacy naming profile.
	// Default: [].
	//
	Generated *[]*string `field:"optional" json:"generated" yaml:"generated"`
	// `true` for a deployment TheoryCloud.ai places on a tenant's behalf (contract section 1, r5): a pooled, isolated or dedicated managed-account placement.
	//
	// TheoryCloud.ai sets this flag and the tenant `namespace` on every deployment
	// it places, and injects `account` and `region` from its own placement logic.
	// Only first-party platform apps omit it; for them the platform default
	// (namespace `theorycloud`, the r4 forms) is unchanged.
	//
	// A hosted context always supplies a `namespace`, never uses the reserved
	// platform namespace, carries the namespace in every derived name, and takes
	// no legacy naming profile and no generated entries. A context that breaks any
	// of these fails synthesis.
	// Default: false.
	//
	Hosted *bool `field:"optional" json:"hosted" yaml:"hosted"`
	// Logging profile.
	//
	// `standard` opts every construct that receives the context
	// into the contract's log groups and access logging. `legacy` keeps each
	// construct's pre-contract behaviour.
	// Default: AppTheoryLoggingProfile.LEGACY
	//
	LoggingProfile AppTheoryLoggingProfile `field:"optional" json:"loggingProfile" yaml:"loggingProfile"`
	// Namespace segment.
	// Default: "theorycloud".
	//
	Namespace *string `field:"optional" json:"namespace" yaml:"namespace"`
	// Naming profile.
	// Default: AppTheoryNamingProfile.DERIVED
	//
	NamingProfile AppTheoryNamingProfile `field:"optional" json:"namingProfile" yaml:"namingProfile"`
	// Physical pins keyed `{type}:{logical}`, used verbatim under a legacy naming profile.
	// Default: {}.
	//
	Pins *map[string]*string `field:"optional" json:"pins" yaml:"pins"`
	// Retention in days for standard-profile log groups.
	//
	// Must be a value
	// CloudWatch Logs accepts.
	// Default: 30.
	//
	RetentionDays *float64 `field:"optional" json:"retentionDays" yaml:"retentionDays"`
}
