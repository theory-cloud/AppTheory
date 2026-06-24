package apptheorycdk

// Logging configuration for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageLogging struct {
	// Configuration for sending logs to Amazon CloudWatch Logs.
	CloudWatch *AppTheoryMicrovmImageCloudWatchLogging `field:"optional" json:"cloudWatch" yaml:"cloudWatch"`
	// Set to true to disable MicroVM logging.
	Disabled *bool `field:"optional" json:"disabled" yaml:"disabled"`
}
