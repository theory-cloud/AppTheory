package apptheorycdk

// Hook configuration for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageHooks struct {
	// Lifecycle hooks for MicroVM events.
	MicrovmHooks *AppTheoryMicrovmRuntimeHooks `field:"optional" json:"microvmHooks" yaml:"microvmHooks"`
	// Lifecycle hooks for MicroVM image build events.
	MicrovmImageHooks *AppTheoryMicrovmImageBuildHooks `field:"optional" json:"microvmImageHooks" yaml:"microvmImageHooks"`
	// The port number on which the hooks listener runs.
	Port *float64 `field:"optional" json:"port" yaml:"port"`
}
