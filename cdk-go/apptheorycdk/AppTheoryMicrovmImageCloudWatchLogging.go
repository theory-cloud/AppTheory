package apptheorycdk

// CloudWatch Logs configuration for AWS::Lambda::MicrovmImage logging.
type AppTheoryMicrovmImageCloudWatchLogging struct {
	// The name of the CloudWatch Logs log group to send logs to.
	LogGroup *string `field:"optional" json:"logGroup" yaml:"logGroup"`
	// The name of the CloudWatch Logs log stream within the log group.
	LogStream *string `field:"optional" json:"logStream" yaml:"logStream"`
}
