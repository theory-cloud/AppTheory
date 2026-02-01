package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

// Properties for AppTheoryLambdaRole.
type AppTheoryLambdaRoleProps struct {
	// Additional inline policy statements to attach to the role.
	//
	// Use this escape hatch for any additional permissions not covered by the construct.
	AdditionalStatements *[]awsiam.PolicyStatement `field:"optional" json:"additionalStatements" yaml:"additionalStatements"`
	// KMS key(s) for application-level KMS usage (encrypt/decrypt data at runtime).
	//
	// Grants the role full encrypt/decrypt permissions on these keys.
	ApplicationKmsKeys *[]awskms.IKey `field:"optional" json:"applicationKmsKeys" yaml:"applicationKmsKeys"`
	// Optional description for the IAM role.
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Enable X-Ray tracing permissions by attaching AWSXRayDaemonWriteAccess managed policy.
	// Default: false.
	//
	EnableXRay *bool `field:"optional" json:"enableXRay" yaml:"enableXRay"`
	// KMS key(s) for Lambda environment variable encryption.
	//
	// Grants the role permission to decrypt environment variables encrypted with these keys.
	EnvironmentEncryptionKeys *[]awskms.IKey `field:"optional" json:"environmentEncryptionKeys" yaml:"environmentEncryptionKeys"`
	// Optional role name.
	//
	// If not provided, CloudFormation will generate a unique name.
	RoleName *string `field:"optional" json:"roleName" yaml:"roleName"`
	// Tags to apply to the IAM role.
	Tags *map[string]*string `field:"optional" json:"tags" yaml:"tags"`
}

