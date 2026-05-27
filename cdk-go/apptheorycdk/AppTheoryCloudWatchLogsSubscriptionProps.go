package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

// Properties for AppTheoryCloudWatchLogsSubscription.
type AppTheoryCloudWatchLogsSubscriptionProps struct {
	// Destination ARN that receives matching log events.
	//
	// The ARN may point to a Lambda function, Kinesis stream, Firehose delivery stream,
	// or a cross-account CloudWatch Logs destination. AppTheory does not create or
	// validate the destination-side resources.
	DestinationArn *string `field:"required" json:"destinationArn" yaml:"destinationArn"`
	// Method used to distribute log events to Kinesis destinations.
	// Default: - CloudWatch Logs default.
	//
	Distribution awslogs.Distribution `field:"optional" json:"distribution" yaml:"distribution"`
	// Optional physical subscription filter name.
	// Default: - CloudFormation assigns a name.
	//
	FilterName *string `field:"optional" json:"filterName" yaml:"filterName"`
	// CloudWatch Logs filter pattern.
	//
	// Exactly one of `filterPattern` or `filterPatternText` is required.
	FilterPattern awslogs.IFilterPattern `field:"optional" json:"filterPattern" yaml:"filterPattern"`
	// Raw CloudWatch Logs filter pattern text.
	//
	// Use an empty string when the subscription should match all events. Exactly one
	// of `filterPattern` or `filterPatternText` is required.
	FilterPatternText *string `field:"optional" json:"filterPatternText" yaml:"filterPatternText"`
	// Log group to attach the subscription filter to.
	//
	// Exactly one of `logGroup` or `logGroupName` is required.
	LogGroup awslogs.ILogGroup `field:"optional" json:"logGroup" yaml:"logGroup"`
	// Name of an existing log group to attach the subscription filter to.
	//
	// Exactly one of `logGroup` or `logGroupName` is required.
	LogGroupName *string `field:"optional" json:"logGroupName" yaml:"logGroupName"`
	// Delivery role assumed by CloudWatch Logs when the destination requires one.
	//
	// At most one of `role` or `roleArn` may be provided. AppTheory never synthesizes
	// a default delivery role for this source-side construct.
	Role awsiam.IRole `field:"optional" json:"role" yaml:"role"`
	// ARN of a caller-owned delivery role assumed by CloudWatch Logs.
	//
	// At most one of `role` or `roleArn` may be provided.
	RoleArn *string `field:"optional" json:"roleArn" yaml:"roleArn"`
}
