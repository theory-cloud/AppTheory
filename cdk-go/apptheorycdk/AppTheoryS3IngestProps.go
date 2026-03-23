package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
)

type AppTheoryS3IngestProps struct {
	// Whether to auto-delete objects in a created bucket when removalPolicy is DESTROY.
	// Default: false.
	//
	AutoDeleteObjects *bool `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
	// Optional existing S3 bucket to use for ingest.
	//
	// If not provided, a new bucket will be created with secure defaults.
	Bucket awss3.IBucket `field:"optional" json:"bucket" yaml:"bucket"`
	// Name for the ingest bucket (only used if bucket is not provided).
	BucketName *string `field:"optional" json:"bucketName" yaml:"bucketName"`
	// Whether to enable EventBridge notifications for the bucket.
	//
	// When creating a bucket, this sets `eventBridgeEnabled`.
	// When using an existing bucket, this calls `enableEventBridgeNotification()`.
	// Default: false.
	//
	EnableEventBridge *bool `field:"optional" json:"enableEventBridge" yaml:"enableEventBridge"`
	// Optional bucket encryption setting (only used when creating a bucket).
	// Default: s3.BucketEncryption.S3_MANAGED
	//
	Encryption awss3.BucketEncryption `field:"optional" json:"encryption" yaml:"encryption"`
	// Optional customer-managed KMS key (only used when creating a bucket).
	//
	// Only valid when `encryption` is `s3.BucketEncryption.KMS`.
	EncryptionKey awskms.IKey `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	// Principals to grant read permissions to.
	GrantReadTo *[]awsiam.IGrantable `field:"optional" json:"grantReadTo" yaml:"grantReadTo"`
	// Principals to grant write permissions to.
	GrantWriteTo *[]awsiam.IGrantable `field:"optional" json:"grantWriteTo" yaml:"grantWriteTo"`
	// Object key prefixes to match for S3 -> SQS notifications.
	Prefixes *[]*string `field:"optional" json:"prefixes" yaml:"prefixes"`
	// Optional queue props to create an SQS queue for direct S3 -> SQS notifications.
	//
	// Mutually exclusive with `queueTarget`.
	QueueProps *AppTheoryQueueProps `field:"optional" json:"queueProps" yaml:"queueProps"`
	// Optional SQS queue target for direct S3 -> SQS notifications.
	QueueTarget awssqs.IQueue `field:"optional" json:"queueTarget" yaml:"queueTarget"`
	// Removal policy for created resources.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Object key suffixes to match for S3 -> SQS notifications.
	Suffixes *[]*string `field:"optional" json:"suffixes" yaml:"suffixes"`
	// Cross-account writer principals to allow via bucket policy.
	//
	// This is intentionally explicit (bucket policy), rather than implicit magic.
	WriterPrincipals *[]awsiam.IPrincipal `field:"optional" json:"writerPrincipals" yaml:"writerPrincipals"`
}
