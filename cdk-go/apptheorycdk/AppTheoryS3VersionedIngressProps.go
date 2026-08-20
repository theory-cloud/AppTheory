package apptheorycdk

// Props for the AppTheoryS3VersionedIngress construct.
type AppTheoryS3VersionedIngressProps struct {
	// Physical name for the artifact ingress bucket.
	//
	// Token-valued names pass through to the S3 construct unchanged.
	// Default: undefined (CloudFormation-generated name).
	//
	BucketName *string `field:"optional" json:"bucketName" yaml:"bucketName"`
}
