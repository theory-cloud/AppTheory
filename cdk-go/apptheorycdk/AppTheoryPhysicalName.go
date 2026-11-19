package apptheorycdk

// The composed physical name of one resource.
type AppTheoryPhysicalName struct {
	// The account-regional bucket-name prefix, when the type uses one.
	// Default: undefined.
	//
	BucketNamePrefix *string `field:"optional" json:"bucketNamePrefix" yaml:"bucketNamePrefix"`
	// The bucket namespace, when the type uses one.
	// Default: undefined.
	//
	BucketNamespace *string `field:"optional" json:"bucketNamespace" yaml:"bucketNamespace"`
	// Whether CloudFormation generates the name, so no physical-name property is set.
	// Default: false.
	//
	Generated *bool `field:"optional" json:"generated" yaml:"generated"`
	// The full physical name.
	//
	// Absent when CloudFormation generates the name.
	// Default: undefined.
	//
	Name *string `field:"optional" json:"name" yaml:"name"`
	// Whether the name came from a pin.
	// Default: false.
	//
	Pinned *bool `field:"optional" json:"pinned" yaml:"pinned"`
}
