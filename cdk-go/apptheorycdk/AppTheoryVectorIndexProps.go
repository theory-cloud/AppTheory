package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

type AppTheoryVectorIndexProps struct {
	// Required vector dimension.
	//
	// Titan Text Embeddings V2 commonly uses 1024.
	Dimension *float64 `field:"required" json:"dimension" yaml:"dimension"`
	// Required vector index name.
	IndexName *string `field:"required" json:"indexName" yaml:"indexName"`
	// Whether to create the vector bucket.
	// Default: true unless existingVectorBucketName is provided.
	//
	CreateVectorBucket *bool `field:"optional" json:"createVectorBucket" yaml:"createVectorBucket"`
	// Vector data type.
	// Default: "float32".
	//
	DataType *string `field:"optional" json:"dataType" yaml:"dataType"`
	// Distance metric used by the vector index.
	// Default: "cosine".
	//
	DistanceMetric *string `field:"optional" json:"distanceMetric" yaml:"distanceMetric"`
	// KMS key for vector bucket/index encryption.
	//
	// When omitted, S3-managed AES256 encryption is used.
	EncryptionKey awskms.IKey `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	// Existing vector bucket name to attach the index to without creating a bucket.
	//
	// Mutually exclusive with `vectorBucketName` when `createVectorBucket` is true.
	ExistingVectorBucketName *string `field:"optional" json:"existingVectorBucketName" yaml:"existingVectorBucketName"`
	// Principals to grant read, query, write, and management permissions to.
	GrantManageTo *[]awsiam.IGrantable `field:"optional" json:"grantManageTo" yaml:"grantManageTo"`
	// Principals to grant QueryVectors permissions to.
	GrantQueryTo *[]awsiam.IGrantable `field:"optional" json:"grantQueryTo" yaml:"grantQueryTo"`
	// Principals to grant Get/List vector permissions to.
	GrantReadVectorsTo *[]awsiam.IGrantable `field:"optional" json:"grantReadVectorsTo" yaml:"grantReadVectorsTo"`
	// Principals to grant Put/Delete vector permissions to.
	GrantWriteVectorsTo *[]awsiam.IGrantable `field:"optional" json:"grantWriteVectorsTo" yaml:"grantWriteVectorsTo"`
	// Metadata keys that may be returned but not used as query filters.
	NonFilterableMetadataKeys *[]*string `field:"optional" json:"nonFilterableMetadataKeys" yaml:"nonFilterableMetadataKeys"`
	// Removal policy for created vector bucket and index resources.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Optional name for a created vector bucket.
	//
	// Mutually exclusive with `existingVectorBucketName`.
	VectorBucketName *string `field:"optional" json:"vectorBucketName" yaml:"vectorBucketName"`
}
