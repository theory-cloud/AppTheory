package apptheorycdk

// Properties for an `AppTheoryNamingContext`.
//
// The context holds the bound naming and logging values from stage config.
// Constructs take it as an optional prop; with no context every construct
// synthesizes exactly as it did before this contract existed.
type AppTheoryNamingContextProps struct {
	// Twelve-digit account id from stage config.
	//
	// An unresolved token fails
	// synthesis.
	Account *string `field:"required" json:"account" yaml:"account"`
	// App instance id from stage config.
	App *string `field:"required" json:"app" yaml:"app"`
	// Full Region code, for example `us-east-1`.
	Region *string `field:"required" json:"region" yaml:"region"`
	// Stage id from stage config.
	Stage *string `field:"required" json:"stage" yaml:"stage"`
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
