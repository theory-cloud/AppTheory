package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

type AppTheoryDynamoTableProps struct {
	PartitionKeyName          *string                          `field:"required" json:"partitionKeyName" yaml:"partitionKeyName"`
	SortKeyName               *string                          `field:"required" json:"sortKeyName" yaml:"sortKeyName"`
	TableName                 *string                          `field:"required" json:"tableName" yaml:"tableName"`
	BillingMode               awsdynamodb.BillingMode          `field:"optional" json:"billingMode" yaml:"billingMode"`
	DeletionProtection        *bool                            `field:"optional" json:"deletionProtection" yaml:"deletionProtection"`
	EnablePointInTimeRecovery *bool                            `field:"optional" json:"enablePointInTimeRecovery" yaml:"enablePointInTimeRecovery"`
	EnableStream              *bool                            `field:"optional" json:"enableStream" yaml:"enableStream"`
	Encryption                awsdynamodb.TableEncryption      `field:"optional" json:"encryption" yaml:"encryption"`
	EncryptionKey             awskms.IKey                      `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	GlobalSecondaryIndexes    *[]*AppTheoryDynamoTableGsiProps `field:"optional" json:"globalSecondaryIndexes" yaml:"globalSecondaryIndexes"`
	GrantReadTo               *[]awsiam.IGrantable             `field:"optional" json:"grantReadTo" yaml:"grantReadTo"`
	GrantReadWriteTo          *[]awsiam.IGrantable             `field:"optional" json:"grantReadWriteTo" yaml:"grantReadWriteTo"`
	GrantStreamReadTo         *[]awsiam.IGrantable             `field:"optional" json:"grantStreamReadTo" yaml:"grantStreamReadTo"`
	GrantWriteTo              *[]awsiam.IGrantable             `field:"optional" json:"grantWriteTo" yaml:"grantWriteTo"`
	PartitionKeyType          awsdynamodb.AttributeType        `field:"optional" json:"partitionKeyType" yaml:"partitionKeyType"`
	ReadCapacity              *float64                         `field:"optional" json:"readCapacity" yaml:"readCapacity"`
	RemovalPolicy             awscdk.RemovalPolicy             `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	SortKeyType               awsdynamodb.AttributeType        `field:"optional" json:"sortKeyType" yaml:"sortKeyType"`
	StreamViewType            awsdynamodb.StreamViewType       `field:"optional" json:"streamViewType" yaml:"streamViewType"`
	TimeToLiveAttribute       *string                          `field:"optional" json:"timeToLiveAttribute" yaml:"timeToLiveAttribute"`
	WriteCapacity             *float64                         `field:"optional" json:"writeCapacity" yaml:"writeCapacity"`
}
