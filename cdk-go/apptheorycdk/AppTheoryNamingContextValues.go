package apptheorycdk

// Bound naming and logging context values from stage config.
type AppTheoryNamingContextValues struct {
	// Twelve-digit account id.
	//
	// An unresolved token fails synthesis.
	Account *string `field:"required" json:"account" yaml:"account"`
	// App instance id.
	App *string `field:"required" json:"app" yaml:"app"`
	// Full Region code, for example `us-east-1`.
	Region *string `field:"required" json:"region" yaml:"region"`
	// Stage id.
	Stage *string `field:"required" json:"stage" yaml:"stage"`
	// Logging profile.
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
	// Physical pins keyed `{type}:{logical}`.
	// Default: {}.
	//
	Pins *map[string]*string `field:"optional" json:"pins" yaml:"pins"`
	// Log retention in days for standard-profile log groups.
	// Default: 30.
	//
	RetentionDays *float64 `field:"optional" json:"retentionDays" yaml:"retentionDays"`
}
