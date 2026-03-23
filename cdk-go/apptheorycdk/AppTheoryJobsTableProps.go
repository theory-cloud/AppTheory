package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

type AppTheoryJobsTableProps struct {
	// Billing mode for the table.
	// Default: PAY_PER_REQUEST.
	//
	BillingMode awsdynamodb.BillingMode `field:"optional" json:"billingMode" yaml:"billingMode"`
	// Whether deletion protection should be enabled for the table.
	// Default: - AWS default (no deletion protection).
	//
	DeletionProtection *bool `field:"optional" json:"deletionProtection" yaml:"deletionProtection"`
	// Whether point-in-time recovery should be enabled.
	// Default: true.
	//
	EnablePointInTimeRecovery *bool `field:"optional" json:"enablePointInTimeRecovery" yaml:"enablePointInTimeRecovery"`
	// Table encryption setting.
	// Default: AWS_MANAGED.
	//
	Encryption awsdynamodb.TableEncryption `field:"optional" json:"encryption" yaml:"encryption"`
	// Customer-managed KMS key (required when encryption is CUSTOMER_MANAGED).
	EncryptionKey awskms.IKey `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	// Principals to grant DynamoDB read permissions to.
	GrantReadTo *[]awsiam.IGrantable `field:"optional" json:"grantReadTo" yaml:"grantReadTo"`
	// Principals to grant DynamoDB read/write permissions to.
	GrantReadWriteTo *[]awsiam.IGrantable `field:"optional" json:"grantReadWriteTo" yaml:"grantReadWriteTo"`
	// Principals to grant DynamoDB write permissions to.
	GrantWriteTo *[]awsiam.IGrantable `field:"optional" json:"grantWriteTo" yaml:"grantWriteTo"`
	// Provisioned read capacity (only used when billingMode is PROVISIONED).
	// Default: 5.
	//
	ReadCapacity *float64 `field:"optional" json:"readCapacity" yaml:"readCapacity"`
	// Removal policy for the table.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Optional table name.
	// Default: - CloudFormation-generated name.
	//
	TableName *string `field:"optional" json:"tableName" yaml:"tableName"`
	// TTL attribute name.
	// Default: "ttl".
	//
	TimeToLiveAttribute *string `field:"optional" json:"timeToLiveAttribute" yaml:"timeToLiveAttribute"`
	// Provisioned write capacity (only used when billingMode is PROVISIONED).
	// Default: 5.
	//
	WriteCapacity *float64 `field:"optional" json:"writeCapacity" yaml:"writeCapacity"`
}

