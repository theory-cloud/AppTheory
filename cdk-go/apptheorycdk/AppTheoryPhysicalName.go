package apptheorycdk

// The composed physical name of one resource.
type AppTheoryPhysicalName struct {
	// The full physical name.
	Name *string `field:"required" json:"name" yaml:"name"`
	// The account-regional bucket-name prefix, when the type uses one.
	// Default: undefined.
	//
	BucketNamePrefix *string `field:"optional" json:"bucketNamePrefix" yaml:"bucketNamePrefix"`
	// The bucket namespace, when the type uses one.
	// Default: undefined.
	//
	BucketNamespace *string `field:"optional" json:"bucketNamespace" yaml:"bucketNamespace"`
	// Whether the name came from a pin.
	// Default: false.
	//
	Pinned *bool `field:"optional" json:"pinned" yaml:"pinned"`
}
