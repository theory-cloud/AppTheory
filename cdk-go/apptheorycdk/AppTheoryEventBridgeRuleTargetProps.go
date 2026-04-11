package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/aws-cdk-go/awscdk/v2/awseventstargets"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryEventBridgeRuleTargetProps struct {
	// The Lambda function to invoke when the rule matches.
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Optional rule description.
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Whether the rule is enabled.
	// Default: true.
	//
	Enabled *bool `field:"optional" json:"enabled" yaml:"enabled"`
	// Optional event bus to attach the rule to.
	// Default: - the account default event bus.
	//
	EventBus awsevents.IEventBus `field:"optional" json:"eventBus" yaml:"eventBus"`
	// EventBridge event pattern for rule matching.
	//
	// Mutually exclusive with `schedule`.
	EventPattern *awsevents.EventPattern `field:"optional" json:"eventPattern" yaml:"eventPattern"`
	// Optional rule name.
	// Default: - CloudFormation-generated name.
	//
	RuleName *string `field:"optional" json:"ruleName" yaml:"ruleName"`
	// Schedule for rule triggering.
	//
	// Mutually exclusive with `eventPattern`.
	Schedule awsevents.Schedule `field:"optional" json:"schedule" yaml:"schedule"`
	// Optional configuration for the Lambda target (DLQ, input, retries, max event age, etc).
	//
	// Passed through to `aws-events-targets.LambdaFunction`.
	TargetProps *awseventstargets.LambdaFunctionProps `field:"optional" json:"targetProps" yaml:"targetProps"`
}

