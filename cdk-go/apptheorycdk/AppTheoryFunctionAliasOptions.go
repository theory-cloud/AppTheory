package apptheorycdk

// Alias and provisioned-concurrency options for an AppTheory function.
type AppTheoryFunctionAliasOptions struct {
	// Optional CodeDeploy traffic shifting for this alias.
	// Default: undefined.
	//
	Deployment *AppTheoryFunctionDeploymentOptions `field:"optional" json:"deployment" yaml:"deployment"`
	// Alias description.
	// Default: undefined.
	//
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Lambda alias name.
	// Default: "live".
	//
	Name *string `field:"optional" json:"name" yaml:"name"`
	// Provisioned concurrency configured on the alias.
	// Default: undefined.
	//
	ProvisionedConcurrentExecutions *float64 `field:"optional" json:"provisionedConcurrentExecutions" yaml:"provisionedConcurrentExecutions"`
}
