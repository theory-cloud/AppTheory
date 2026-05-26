package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskinesis"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

// Properties for AppTheoryKinesisStream.
type AppTheoryKinesisStreamProps struct {
	// Server-side encryption for a newly created stream.
	//
	// AppTheory supports AWS-managed Kinesis encryption and explicit
	// customer-managed KMS keys. Unencrypted streams are rejected.
	// Default: kinesis.StreamEncryption.MANAGED
	//
	Encryption awskinesis.StreamEncryption `field:"optional" json:"encryption" yaml:"encryption"`
	// Customer-managed KMS key for stream encryption.
	//
	// Requires encryption to be kinesis.StreamEncryption.KMS.
	// Default: - no customer-managed KMS key.
	//
	EncryptionKey awskms.IKey `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	// Principals to grant read permissions to.
	// Default: - No additional read grants.
	//
	GrantReadTo *[]awsiam.IGrantable `field:"optional" json:"grantReadTo" yaml:"grantReadTo"`
	// Principals to grant read/write permissions to.
	// Default: - No additional read/write grants.
	//
	GrantReadWriteTo *[]awsiam.IGrantable `field:"optional" json:"grantReadWriteTo" yaml:"grantReadWriteTo"`
	// Principals to grant write permissions to.
	// Default: - No additional write grants.
	//
	GrantWriteTo *[]awsiam.IGrantable `field:"optional" json:"grantWriteTo" yaml:"grantWriteTo"`
	// Capacity mode for a newly created stream.
	// Default: kinesis.StreamMode.ON_DEMAND
	//
	Mode awskinesis.StreamMode `field:"optional" json:"mode" yaml:"mode"`
	// Removal policy for a newly created stream.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Retention period for stream records.
	// Default: - Kinesis default retention period.
	//
	RetentionPeriod awscdk.Duration `field:"optional" json:"retentionPeriod" yaml:"retentionPeriod"`
	// Shard count for provisioned streams.
	//
	// Only valid when mode is kinesis.StreamMode.PROVISIONED.
	// Default: 1 when mode is PROVISIONED.
	//
	ShardCount *float64 `field:"optional" json:"shardCount" yaml:"shardCount"`
	// Existing Kinesis stream to wrap.
	//
	// When provided, create-time properties such as streamName, mode,
	// shardCount, retentionPeriod, encryption, encryptionKey, and
	// removalPolicy are rejected so imports cannot accidentally synthesize a
	// replacement stream.
	// Default: - create a new Kinesis Data Stream.
	//
	Stream awskinesis.IStream `field:"optional" json:"stream" yaml:"stream"`
	// Optional physical stream name for a newly created stream.
	// Default: - CloudFormation-generated name.
	//
	StreamName *string `field:"optional" json:"streamName" yaml:"streamName"`
}
