package apptheorycdk

// One row of the derived-name artifact: the complete set the name reservation index (contract section 11.2) reserves.
type AppTheoryDerivedName struct {
	// The CloudFormation logical id of the resource carrying the name.
	LogicalId *string `field:"required" json:"logicalId" yaml:"logicalId"`
	// The scope in which AWS requires the name to be unique: `account`, `account_region`, or `not_unique`.
	Scope *string `field:"required" json:"scope" yaml:"scope"`
	// The contract resource type.
	Type *string `field:"required" json:"type" yaml:"type"`
	// Whether CloudFormation generates the name, so nothing is reserved.
	// Default: false.
	//
	Generated *bool `field:"optional" json:"generated" yaml:"generated"`
	// The physical name.
	//
	// Absent for a generated entry.
	// Default: undefined.
	//
	Name *string `field:"optional" json:"name" yaml:"name"`
}
