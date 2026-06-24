package apptheorycdk

// Code artifact location for AWS::Lambda::MicrovmImage.
type AppTheoryMicrovmImageCodeArtifact struct {
	// The URI of the code artifact, such as an Amazon S3 path or Amazon ECR image URI.
	Uri *string `field:"required" json:"uri" yaml:"uri"`
}
