package apptheorycdk

// Lifecycle hook mode for Lambda MicroVM image hooks.
type AppTheoryMicrovmHookMode string

const (
	// Disable the lifecycle hook.
	AppTheoryMicrovmHookMode_DISABLED AppTheoryMicrovmHookMode = "DISABLED"
	// Enable the lifecycle hook.
	AppTheoryMicrovmHookMode_ENABLED AppTheoryMicrovmHookMode = "ENABLED"
)
