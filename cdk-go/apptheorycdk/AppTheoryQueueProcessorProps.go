package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
)

type AppTheoryQueueProcessorProps struct {
	Consumer          awslambda.Function `field:"required" json:"consumer" yaml:"consumer"`
	BatchSize         *float64           `field:"optional" json:"batchSize" yaml:"batchSize"`
	MaxBatchingWindow awscdk.Duration    `field:"optional" json:"maxBatchingWindow" yaml:"maxBatchingWindow"`
	QueueProps        *awssqs.QueueProps `field:"optional" json:"queueProps" yaml:"queueProps"`
}
