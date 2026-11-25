package apptheorycdk

// One physically named resource a stack declares, as the synth check (contract section 11.4) consumes it. A generated entry carries no name: CloudFormation owns the name, so there is nothing to reserve.
type AppTheoryDerivedNameInput struct {
	// The CloudFormation logical id of the resource carrying the name.
	LogicalId *string `field:"required" json:"logicalId" yaml:"logicalId"`
	// The contract resource type, for example `lambda_function`.
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
