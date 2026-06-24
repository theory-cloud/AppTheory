package apptheorycdk

// CPU configuration for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageCpuConfiguration struct {
	// The CPU architecture.
	// Default: AppTheoryMicrovmImageCpuArchitecture.ARM_64
	//
	Architecture AppTheoryMicrovmImageCpuArchitecture `field:"optional" json:"architecture" yaml:"architecture"`
}
