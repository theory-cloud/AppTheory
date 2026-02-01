package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
)

// Properties for the AppTheoryQueueProcessor construct.
//
// This construct maintains backwards compatibility with the original API
// while leveraging the new composable AppTheoryQueue and AppTheoryQueueConsumer constructs.
type AppTheoryQueueProcessorProps struct {
	// The Lambda function that will consume messages from the queue.
	Consumer awslambda.IFunction `field:"required" json:"consumer" yaml:"consumer"`
	// The maximum number of records to retrieve per batch.
	// Default: 10.
	//
	BatchSize *float64 `field:"optional" json:"batchSize" yaml:"batchSize"`
	// Whether the event source mapping is enabled.
	// Default: true.
	//
	Enabled *bool `field:"optional" json:"enabled" yaml:"enabled"`
	// Whether to enable a Dead Letter Queue (DLQ).
	// Default: false (for backwards compatibility with original behavior).
	//
	EnableDlq *bool `field:"optional" json:"enableDlq" yaml:"enableDlq"`
	// The maximum amount of time to wait for a batch to be gathered.
	// Default: - No batching window.
	//
	MaxBatchingWindow awscdk.Duration `field:"optional" json:"maxBatchingWindow" yaml:"maxBatchingWindow"`
	// The maximum concurrency setting limits the number of concurrent instances of the function.
	//
	// Valid range: 2-1000.
	// Default: - No concurrency limit.
	//
	MaxConcurrency *float64 `field:"optional" json:"maxConcurrency" yaml:"maxConcurrency"`
	// The maximum number of times a message can be received before being sent to the DLQ.
	//
	// Only applicable when enableDlq is true.
	// Default: 3.
	//
	MaxReceiveCount *float64 `field:"optional" json:"maxReceiveCount" yaml:"maxReceiveCount"`
	// The name of the queue.
	// Default: - CloudFormation-generated name.
	//
	QueueName *string `field:"optional" json:"queueName" yaml:"queueName"`
	// Properties for the underlying SQS queue.
	// Deprecated: Use queueName, visibilityTimeout, and other specific props instead.
	QueueProps *awssqs.QueueProps `field:"optional" json:"queueProps" yaml:"queueProps"`
	// The removal policy for the queue(s).
	// Default: RemovalPolicy.DESTROY
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Whether to report batch item failures.
	//
	// When enabled, the function should return a partial failure response.
	// Default: false.
	//
	ReportBatchItemFailures *bool `field:"optional" json:"reportBatchItemFailures" yaml:"reportBatchItemFailures"`
	// The visibility timeout for messages in the queue.
	// Default: Duration.seconds(30)
	//
	VisibilityTimeout awscdk.Duration `field:"optional" json:"visibilityTimeout" yaml:"visibilityTimeout"`
}
