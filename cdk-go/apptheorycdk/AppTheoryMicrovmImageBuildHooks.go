package apptheorycdk

// Lifecycle hooks invoked during MicroVM image build events.
type AppTheoryMicrovmImageBuildHooks struct {
	// Whether the ready hook is enabled.
	Ready AppTheoryMicrovmHookMode `field:"optional" json:"ready" yaml:"ready"`
	// The maximum time in seconds for the ready hook to complete.
	ReadyTimeoutInSeconds *float64 `field:"optional" json:"readyTimeoutInSeconds" yaml:"readyTimeoutInSeconds"`
	// Whether the validate hook is enabled.
	Validate AppTheoryMicrovmHookMode `field:"optional" json:"validate" yaml:"validate"`
	// The maximum time in seconds for the validate hook to complete.
	ValidateTimeoutInSeconds *float64 `field:"optional" json:"validateTimeoutInSeconds" yaml:"validateTimeoutInSeconds"`
}
