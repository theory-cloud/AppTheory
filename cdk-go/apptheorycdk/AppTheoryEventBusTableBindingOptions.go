package apptheorycdk

type AppTheoryEventBusTableBindingOptions struct {
	// Environment variable name used for the table name binding.
	//
	// AppTheory runtime code reads `APPTHEORY_EVENTBUS_TABLE_NAME` by default.
	// Default: APPTHEORY_EVENTBUS_TABLE_NAME.
	//
	EnvVarName *string `field:"optional" json:"envVarName" yaml:"envVarName"`
	// Grant read-only access for replay/query consumers.
	//
	// When false, the handler receives read/write access for publish + replay flows.
	// Default: false.
	//
	ReadOnly *bool `field:"optional" json:"readOnly" yaml:"readOnly"`
}
