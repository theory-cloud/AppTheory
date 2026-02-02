package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/aws-cdk-go/awscdk/v2/awseventstargets"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryEventBridgeHandlerProps struct {
	Handler     awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	Schedule    awsevents.Schedule  `field:"required" json:"schedule" yaml:"schedule"`
	Description *string             `field:"optional" json:"description" yaml:"description"`
	Enabled     *bool               `field:"optional" json:"enabled" yaml:"enabled"`
	RuleName    *string             `field:"optional" json:"ruleName" yaml:"ruleName"`
	// Optional configuration for the Lambda target (DLQ, input, retries, max event age, etc).
	//
	// Passed through to `aws-events-targets.LambdaFunction`.
	TargetProps *awseventstargets.LambdaFunctionProps `field:"optional" json:"targetProps" yaml:"targetProps"`
}
