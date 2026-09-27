package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryDynamoDBStreamMappingProps struct {
	Consumer           awslambda.Function `field:"required" json:"consumer" yaml:"consumer"`
	Table              awsdynamodb.ITable `field:"required" json:"table" yaml:"table"`
	BatchSize          *float64           `field:"optional" json:"batchSize" yaml:"batchSize"`
	BisectBatchOnError *bool              `field:"optional" json:"bisectBatchOnError" yaml:"bisectBatchOnError"`
	MaxBatchingWindow  awscdk.Duration    `field:"optional" json:"maxBatchingWindow" yaml:"maxBatchingWindow"`
	MaxRecordAge       awscdk.Duration    `field:"optional" json:"maxRecordAge" yaml:"maxRecordAge"`
	// Destination for the records Lambda discards after retries are exhausted or `maxRecordAge` elapses.
	//
	// Pass an event source DLQ, such as `new lambdaEventSources.SqsDlq(queue)` or
	// `new lambdaEventSources.SnsDlq(topic)`. Binding that DLQ grants the consumer role exactly the
	// permission the destination needs (`sqs:SendMessage` or `sns:Publish`); an Amazon S3 bucket
	// (`new lambdaEventSources.S3OnFailureDestination(bucket)`) is also supported.
	//
	// The destination receives metadata about the discarded batch, not the records themselves: the
	// shard ID and sequence numbers identify records to re-read from the stream while they are still
	// inside the stream retention window. It only receives anything once retries are exhausted or
	// `maxRecordAge` is exceeded, so a mapping that leaves both unbounded (the AWS Lambda default is
	// `-1`, retry until the record expires) has nothing to send. Pair this prop with a bounded
	// `retryAttempts` and `bisectBatchOnError: true` so a poison record is retained for repair instead
	// of blocking its shard.
	// Default: - discarded records are dropped.
	//
	OnFailure               awslambda.IEventSourceDlq  `field:"optional" json:"onFailure" yaml:"onFailure"`
	ParallelizationFactor   *float64                   `field:"optional" json:"parallelizationFactor" yaml:"parallelizationFactor"`
	ReportBatchItemFailures *bool                      `field:"optional" json:"reportBatchItemFailures" yaml:"reportBatchItemFailures"`
	RetryAttempts           *float64                   `field:"optional" json:"retryAttempts" yaml:"retryAttempts"`
	StartingPosition        awslambda.StartingPosition `field:"optional" json:"startingPosition" yaml:"startingPosition"`
}
