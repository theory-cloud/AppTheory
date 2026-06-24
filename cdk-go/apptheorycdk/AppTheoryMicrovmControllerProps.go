package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// Props for AppTheoryMicrovmController.
type AppTheoryMicrovmControllerProps struct {
	// Lambda request authorizer required for every controller route.
	//
	// The construct fails closed when this is omitted; unauthenticated controller routes
	// are not synthesized.
	Authorizer awslambda.IFunction `field:"required" json:"authorizer" yaml:"authorizer"`
	// Controller Lambda packaging and configuration.
	//
	// The handler code must use AppTheory's MicroVM runtime/controller primitives.
	// This construct does not implement a product control-plane service.
	Controller *AppTheoryMicrovmControllerFunctionProps `field:"required" json:"controller" yaml:"controller"`
	// Egress network connectors the controller is permitted to pass to Lambda MicroVMs.
	//
	// At least one connector reference is required and no more than 10 may be supplied.
	EgressNetworkConnectors *[]IAppTheoryMicrovmNetworkConnector `field:"required" json:"egressNetworkConnectors" yaml:"egressNetworkConnectors"`
	// The MicroVM image the controller is permitted to run.
	MicrovmImage IAppTheoryMicrovmImage `field:"required" json:"microvmImage" yaml:"microvmImage"`
	// Optional API name.
	// Default: undefined.
	//
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Lambda authorizer result cache TTL.
	//
	// Defaults to disabled so stale auth cannot silently broaden controller access.
	// Default: Duration.seconds(0)
	//
	AuthorizerCacheTtl awscdk.Duration `field:"optional" json:"authorizerCacheTtl" yaml:"authorizerCacheTtl"`
	// Header used as the identity source for controller authorization.
	// Default: "Authorization".
	//
	AuthorizerHeaderName *string `field:"optional" json:"authorizerHeaderName" yaml:"authorizerHeaderName"`
	// Friendly authorizer name.
	// Default: undefined.
	//
	AuthorizerName *string `field:"optional" json:"authorizerName" yaml:"authorizerName"`
	// Whether point-in-time recovery should be enabled for the session registry table.
	// Default: true.
	//
	EnableSessionTablePointInTimeRecovery *bool `field:"optional" json:"enableSessionTablePointInTimeRecovery" yaml:"enableSessionTablePointInTimeRecovery"`
	// Optional MicroVM execution role passed to RunMicrovm.
	//
	// When supplied, AppTheory grants the controller Lambda iam:PassRole for this role
	// and exposes the ARN as APPTHEORY_MICROVM_EXECUTION_ROLE_ARN.
	// Default: undefined.
	//
	ExecutionRole awsiam.IRole `field:"optional" json:"executionRole" yaml:"executionRole"`
	// Billing mode for the session registry table.
	// Default: PAY_PER_REQUEST.
	//
	SessionTableBillingMode awsdynamodb.BillingMode `field:"optional" json:"sessionTableBillingMode" yaml:"sessionTableBillingMode"`
	// Whether deletion protection should be enabled for the session registry table.
	// Default: - AWS default (no deletion protection).
	//
	SessionTableDeletionProtection *bool `field:"optional" json:"sessionTableDeletionProtection" yaml:"sessionTableDeletionProtection"`
	// Session registry table encryption setting.
	// Default: AWS_MANAGED.
	//
	SessionTableEncryption awsdynamodb.TableEncryption `field:"optional" json:"sessionTableEncryption" yaml:"sessionTableEncryption"`
	// Customer-managed KMS key for the session registry table.
	//
	// Required when sessionTableEncryption is CUSTOMER_MANAGED.
	SessionTableEncryptionKey awskms.IKey `field:"optional" json:"sessionTableEncryptionKey" yaml:"sessionTableEncryptionKey"`
	// Name for the durable MicroVM session registry DynamoDB table.
	// Default: undefined (CloudFormation-generated).
	//
	SessionTableName *string `field:"optional" json:"sessionTableName" yaml:"sessionTableName"`
	// Provisioned read capacity when sessionTableBillingMode is PROVISIONED.
	// Default: 5.
	//
	SessionTableReadCapacity *float64 `field:"optional" json:"sessionTableReadCapacity" yaml:"sessionTableReadCapacity"`
	// Removal policy for the session registry table.
	// Default: RemovalPolicy.RETAIN
	//
	SessionTableRemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"sessionTableRemovalPolicy" yaml:"sessionTableRemovalPolicy"`
	// Provisioned write capacity when sessionTableBillingMode is PROVISIONED.
	// Default: 5.
	//
	SessionTableWriteCapacity *float64 `field:"optional" json:"sessionTableWriteCapacity" yaml:"sessionTableWriteCapacity"`
	// Optional stage configuration.
	// Default: undefined (default HTTP API stage).
	//
	Stage *AppTheoryMicrovmControllerStageOptions `field:"optional" json:"stage" yaml:"stage"`
}
