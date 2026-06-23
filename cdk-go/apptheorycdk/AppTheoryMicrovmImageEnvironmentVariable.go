package apptheorycdk

// Environment variable for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageEnvironmentVariable struct {
	// Environment variable key.
	Key *string `field:"required" json:"key" yaml:"key"`
	// Environment variable value.
	Value *string `field:"required" json:"value" yaml:"value"`
}
