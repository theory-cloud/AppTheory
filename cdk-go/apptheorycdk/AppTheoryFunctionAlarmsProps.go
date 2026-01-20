package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryFunctionAlarmsProps struct {
	Fn                awslambda.IFunction `field:"required" json:"fn" yaml:"fn"`
	ErrorThreshold    *float64            `field:"optional" json:"errorThreshold" yaml:"errorThreshold"`
	Period            awscdk.Duration     `field:"optional" json:"period" yaml:"period"`
	ThrottleThreshold *float64            `field:"optional" json:"throttleThreshold" yaml:"throttleThreshold"`
}
