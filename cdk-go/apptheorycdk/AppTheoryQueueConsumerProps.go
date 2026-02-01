package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
)

// Properties for AppTheoryQueueConsumer construct.
type AppTheoryQueueConsumerProps struct {
	// The Lambda function that will process messages.
	Consumer awslambda.IFunction `field:"required" json:"consumer" yaml:"consumer"`
	// The SQS queue to consume messages from.
	Queue awssqs.IQueue `field:"required" json:"queue" yaml:"queue"`
	// The maximum number of records to retrieve per batch.
	// Default: 10.
	//
	BatchSize *float64 `field:"optional" json:"batchSize" yaml:"batchSize"`
	// Whether the event source mapping is enabled.
	// Default: true.
	//
	Enabled *bool `field:"optional" json:"enabled" yaml:"enabled"`
	// Optional filters to control which messages trigger the Lambda.
	// Default: - All messages trigger the Lambda.
	//
	Filters *[]awslambda.FilterCriteria `field:"optional" json:"filters" yaml:"filters"`
	// Whether to automatically grant consume permissions to the Lambda function.
	// Default: true.
	//
	GrantConsumeMessages *bool `field:"optional" json:"grantConsumeMessages" yaml:"grantConsumeMessages"`
	// The maximum amount of time to wait for a batch to be gathered.
	// Default: - No batching window (messages processed immediately).
	//
	MaxBatchingWindow awscdk.Duration `field:"optional" json:"maxBatchingWindow" yaml:"maxBatchingWindow"`
	// The maximum concurrency setting limits the number of concurrent instances of the function.
	//
	// Valid range: 2-1000.
	// Default: - No concurrency limit.
	//
	MaxConcurrency *float64 `field:"optional" json:"maxConcurrency" yaml:"maxConcurrency"`
	// Whether to report batch item failures.
	//
	// When enabled, the function should return a partial failure response.
	// Default: false.
	//
	ReportBatchItemFailures *bool `field:"optional" json:"reportBatchItemFailures" yaml:"reportBatchItemFailures"`
}

