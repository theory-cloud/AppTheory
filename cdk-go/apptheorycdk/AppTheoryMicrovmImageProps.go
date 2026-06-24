package apptheorycdk

// Properties for AppTheoryMicrovmImage.
type AppTheoryMicrovmImageProps struct {
	// The ARN of the base MicroVM image used.
	BaseImageArn *string `field:"required" json:"baseImageArn" yaml:"baseImageArn"`
	// The specific version of the base MicroVM image.
	BaseImageVersion *string `field:"required" json:"baseImageVersion" yaml:"baseImageVersion"`
	// The ARN of the IAM build role.
	BuildRoleArn *string `field:"required" json:"buildRoleArn" yaml:"buildRoleArn"`
	// The code artifact for this version.
	CodeArtifact *AppTheoryMicrovmImageCodeArtifact `field:"required" json:"codeArtifact" yaml:"codeArtifact"`
	// The description of the version.
	Description *string `field:"required" json:"description" yaml:"description"`
	// The list of egress network connectors available to the MicroVM at runtime.
	//
	// Pass `AppTheoryMicrovmNetworkConnector` instances or compatible connector references.
	// At least one connector reference is required and no more than 10 may be supplied.
	EgressNetworkConnectors *[]IAppTheoryMicrovmNetworkConnector `field:"required" json:"egressNetworkConnectors" yaml:"egressNetworkConnectors"`
	// Lifecycle hook configuration for MicroVMs and MicroVM images.
	Hooks *AppTheoryMicrovmImageHooks `field:"required" json:"hooks" yaml:"hooks"`
	// Configuration for MicroVM logging output.
	//
	// Specify exactly one of `cloudWatch` or `disabled: true`.
	Logging *AppTheoryMicrovmImageLogging `field:"required" json:"logging" yaml:"logging"`
	// The name of the MicroVM image.
	Name *string `field:"required" json:"name" yaml:"name"`
	// The resource requirements for the MicroVM.
	//
	// AWS::Lambda::MicrovmImage currently accepts exactly one Resources entry.
	Resources *[]*AppTheoryMicrovmImageResources `field:"required" json:"resources" yaml:"resources"`
	// Additional OS capabilities granted to the MicroVM runtime environment.
	// Default: [AppTheoryMicrovmImageOsCapability.ALL]
	//
	AdditionalOsCapabilities *[]AppTheoryMicrovmImageOsCapability `field:"optional" json:"additionalOsCapabilities" yaml:"additionalOsCapabilities"`
	// The list of supported CPU configurations for the MicroVM.
	// Default: [{ architecture: AppTheoryMicrovmImageCpuArchitecture.ARM_64 }]
	//
	CpuConfigurations *[]*AppTheoryMicrovmImageCpuConfiguration `field:"optional" json:"cpuConfigurations" yaml:"cpuConfigurations"`
	// Environment variables set in the MicroVM runtime environment.
	// Default: [].
	//
	EnvironmentVariables *[]*AppTheoryMicrovmImageEnvironmentVariable `field:"optional" json:"environmentVariables" yaml:"environmentVariables"`
	// Additional CloudFormation tags to apply to the MicroVM image.
	Tags *map[string]*string `field:"optional" json:"tags" yaml:"tags"`
}
