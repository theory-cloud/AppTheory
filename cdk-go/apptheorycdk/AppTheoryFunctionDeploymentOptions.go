package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudwatch"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscodedeploy"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// CodeDeploy deployment preferences for an AppTheory Lambda alias.
type AppTheoryFunctionDeploymentOptions struct {
	// CloudWatch alarms that stop and roll back deployments.
	// Default: [].
	//
	Alarms *[]awscloudwatch.IAlarm `field:"optional" json:"alarms" yaml:"alarms"`
	// CodeDeploy auto-rollback configuration.
	// Default: CodeDeploy defaults.
	//
	AutoRollback *awscodedeploy.AutoRollbackConfig `field:"optional" json:"autoRollback" yaml:"autoRollback"`
	// Time between traffic shifts.
	// Default: Duration.minutes(5) for canary, Duration.minutes(1) for linear
	//
	Interval awscdk.Duration `field:"optional" json:"interval" yaml:"interval"`
	// Percentage shifted at each canary or linear increment.
	// Default: 10.
	//
	Percentage *float64 `field:"optional" json:"percentage" yaml:"percentage"`
	// Lambda post-traffic hook.
	// Default: undefined.
	//
	PostHook awslambda.IFunction `field:"optional" json:"postHook" yaml:"postHook"`
	// Lambda pre-traffic hook.
	// Default: undefined.
	//
	PreHook awslambda.IFunction `field:"optional" json:"preHook" yaml:"preHook"`
	// Traffic shifting mode.
	// Default: AppTheoryLambdaTrafficShiftType.CANARY
	//
	TrafficShiftType AppTheoryLambdaTrafficShiftType `field:"optional" json:"trafficShiftType" yaml:"trafficShiftType"`
}
