package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
)

// Properties for AppTheoryQueue construct.
type AppTheoryQueueProps struct {
	// Whether to enable content-based deduplication for FIFO queues.
	//
	// Only applicable for FIFO queues.
	// Default: false.
	//
	ContentBasedDeduplication *bool `field:"optional" json:"contentBasedDeduplication" yaml:"contentBasedDeduplication"`
	// The retention period for the DLQ.
	// Default: Duration.days(14)
	//
	DlqRetentionPeriod awscdk.Duration `field:"optional" json:"dlqRetentionPeriod" yaml:"dlqRetentionPeriod"`
	// The visibility timeout for the DLQ.
	// Default: - Same as the main queue.
	//
	DlqVisibilityTimeout awscdk.Duration `field:"optional" json:"dlqVisibilityTimeout" yaml:"dlqVisibilityTimeout"`
	// Whether to enable a Dead Letter Queue (DLQ).
	// Default: true.
	//
	EnableDlq *bool `field:"optional" json:"enableDlq" yaml:"enableDlq"`
	// Whether messages delivered to the queue will be encrypted.
	// Default: - AWS managed encryption is used.
	//
	Encryption awssqs.QueueEncryption `field:"optional" json:"encryption" yaml:"encryption"`
	// Whether the queue is a FIFO queue.
	// Default: false.
	//
	Fifo *bool `field:"optional" json:"fifo" yaml:"fifo"`
	// Principals to grant send messages permission to.
	// Default: - No additional principals.
	//
	GrantSendMessagesTo *[]awslambda.IFunction `field:"optional" json:"grantSendMessagesTo" yaml:"grantSendMessagesTo"`
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
	// The removal policy for the queue(s).
	// Default: RemovalPolicy.DESTROY
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// The number of seconds that Amazon SQS retains a message.
	// Default: Duration.days(4)
	//
	RetentionPeriod awscdk.Duration `field:"optional" json:"retentionPeriod" yaml:"retentionPeriod"`
	// The visibility timeout for messages in the queue.
	// Default: Duration.seconds(30)
	//
	VisibilityTimeout awscdk.Duration `field:"optional" json:"visibilityTimeout" yaml:"visibilityTimeout"`
}
