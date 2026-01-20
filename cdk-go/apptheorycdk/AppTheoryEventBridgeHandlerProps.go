package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryEventBridgeHandlerProps struct {
	Handler     awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	Schedule    awsevents.Schedule  `field:"required" json:"schedule" yaml:"schedule"`
	Description *string             `field:"optional" json:"description" yaml:"description"`
	Enabled     *bool               `field:"optional" json:"enabled" yaml:"enabled"`
	RuleName    *string             `field:"optional" json:"ruleName" yaml:"ruleName"`
}
