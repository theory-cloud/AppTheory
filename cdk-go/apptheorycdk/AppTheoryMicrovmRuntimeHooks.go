package apptheorycdk

// Lifecycle hooks invoked during MicroVM events.
type AppTheoryMicrovmRuntimeHooks struct {
	// Whether the resume hook is enabled.
	Resume AppTheoryMicrovmHookMode `field:"optional" json:"resume" yaml:"resume"`
	// The maximum time in seconds for the resume hook to complete.
	ResumeTimeoutInSeconds *float64 `field:"optional" json:"resumeTimeoutInSeconds" yaml:"resumeTimeoutInSeconds"`
	// Whether the run hook is enabled.
	Run AppTheoryMicrovmHookMode `field:"optional" json:"run" yaml:"run"`
	// The maximum time in seconds for the run hook to complete.
	RunTimeoutInSeconds *float64 `field:"optional" json:"runTimeoutInSeconds" yaml:"runTimeoutInSeconds"`
	// Whether the suspend hook is enabled.
	Suspend AppTheoryMicrovmHookMode `field:"optional" json:"suspend" yaml:"suspend"`
	// The maximum time in seconds for the suspend hook to complete.
	SuspendTimeoutInSeconds *float64 `field:"optional" json:"suspendTimeoutInSeconds" yaml:"suspendTimeoutInSeconds"`
	// Whether the terminate hook is enabled.
	Terminate AppTheoryMicrovmHookMode `field:"optional" json:"terminate" yaml:"terminate"`
	// The maximum time in seconds for the terminate hook to complete.
	TerminateTimeoutInSeconds *float64 `field:"optional" json:"terminateTimeoutInSeconds" yaml:"terminateTimeoutInSeconds"`
}
