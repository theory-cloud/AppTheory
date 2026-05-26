package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskinesis"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// Properties for AppTheoryKinesisStreamMapping.
type AppTheoryKinesisStreamMappingProps struct {
	// The Lambda function that will consume records from the stream.
	Consumer awslambda.IFunction `field:"required" json:"consumer" yaml:"consumer"`
	// The Kinesis Data Stream to consume.
	Stream awskinesis.IStream `field:"required" json:"stream" yaml:"stream"`
	// The largest number of records that AWS Lambda retrieves per invocation.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	BatchSize *float64 `field:"optional" json:"batchSize" yaml:"batchSize"`
	// Split a failed batch in two and retry.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	BisectBatchOnError *bool `field:"optional" json:"bisectBatchOnError" yaml:"bisectBatchOnError"`
	// The maximum amount of time to gather records before invoking the function.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	MaxBatchingWindow awscdk.Duration `field:"optional" json:"maxBatchingWindow" yaml:"maxBatchingWindow"`
	// The maximum age of a record that Lambda sends to the consumer.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	MaxRecordAge awscdk.Duration `field:"optional" json:"maxRecordAge" yaml:"maxRecordAge"`
	// The number of batches to process from each shard concurrently.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	ParallelizationFactor *float64 `field:"optional" json:"parallelizationFactor" yaml:"parallelizationFactor"`
	// Allow partial-batch failure responses from the consumer.
	//
	// AppTheory defaults this on so Kinesis consumers can fail closed per record
	// instead of replaying successfully processed records.
	// Default: true.
	//
	ReportBatchItemFailures *bool `field:"optional" json:"reportBatchItemFailures" yaml:"reportBatchItemFailures"`
	// Maximum number of retry attempts for failed records.
	// Default: - AWS Lambda default for Kinesis event source mappings.
	//
	RetryAttempts *float64 `field:"optional" json:"retryAttempts" yaml:"retryAttempts"`
	// Where to begin consuming the stream.
	// Default: lambda.StartingPosition.LATEST
	//
	StartingPosition awslambda.StartingPosition `field:"optional" json:"startingPosition" yaml:"startingPosition"`
	// The Unix timestamp, in seconds, used with lambda.StartingPosition.AT_TIMESTAMP.
	// Default: - no timestamp.
	//
	StartingPositionTimestamp *float64 `field:"optional" json:"startingPositionTimestamp" yaml:"startingPositionTimestamp"`
	// The tumbling window used to group records before invocation.
	// Default: - no tumbling window.
	//
	TumblingWindow awscdk.Duration `field:"optional" json:"tumblingWindow" yaml:"tumblingWindow"`
}
