package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscodebuild"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

type AppTheoryCodeBuildJobRunnerProps struct {
	// Build specification.
	BuildSpec awscodebuild.BuildSpec `field:"required" json:"buildSpec" yaml:"buildSpec"`
	// Additional IAM policy statements to attach to the CodeBuild role.
	AdditionalStatements *[]awsiam.PolicyStatement `field:"optional" json:"additionalStatements" yaml:"additionalStatements"`
	// Build image.
	// Default: codebuild.LinuxBuildImage.STANDARD_7_0
	//
	BuildImage awscodebuild.IBuildImage `field:"optional" json:"buildImage" yaml:"buildImage"`
	// Compute type.
	// Default: codebuild.ComputeType.SMALL
	//
	ComputeType awscodebuild.ComputeType `field:"optional" json:"computeType" yaml:"computeType"`
	// Optional description.
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Whether to create an EventBridge rule for build state changes.
	// Default: false.
	//
	EnableStateChangeRule *bool `field:"optional" json:"enableStateChangeRule" yaml:"enableStateChangeRule"`
	// Optional KMS key for encrypting build artifacts/logs.
	EncryptionKey awskms.IKey `field:"optional" json:"encryptionKey" yaml:"encryptionKey"`
	// Environment variables.
	EnvironmentVariables *map[string]*awscodebuild.BuildEnvironmentVariable `field:"optional" json:"environmentVariables" yaml:"environmentVariables"`
	// Optional log group to use for CodeBuild logs.
	LogGroup awslogs.ILogGroup `field:"optional" json:"logGroup" yaml:"logGroup"`
	// Retention for auto-managed log group.
	// Default: logs.RetentionDays.ONE_MONTH
	//
	LogRetention awslogs.RetentionDays `field:"optional" json:"logRetention" yaml:"logRetention"`
	// Optional project name.
	// Default: - CloudFormation-generated name.
	//
	ProjectName *string `field:"optional" json:"projectName" yaml:"projectName"`
	// CodeBuild source configuration.
	// Default: - NoSource.
	//
	Source awscodebuild.ISource `field:"optional" json:"source" yaml:"source"`
	// Optional EventBus for the state change rule.
	// Default: - Default event bus.
	//
	StateChangeEventBus awsevents.IEventBus `field:"optional" json:"stateChangeEventBus" yaml:"stateChangeEventBus"`
	// Optional rule description for the state change rule.
	StateChangeRuleDescription *string `field:"optional" json:"stateChangeRuleDescription" yaml:"stateChangeRuleDescription"`
	// Whether the state change rule should be enabled.
	// Default: true.
	//
	StateChangeRuleEnabled *bool `field:"optional" json:"stateChangeRuleEnabled" yaml:"stateChangeRuleEnabled"`
	// Optional rule name for the state change rule.
	// Default: - CloudFormation-generated name.
	//
	StateChangeRuleName *string `field:"optional" json:"stateChangeRuleName" yaml:"stateChangeRuleName"`
	// Timeout for a single build.
	// Default: Duration.minutes(60)
	//
	Timeout awscdk.Duration `field:"optional" json:"timeout" yaml:"timeout"`
}

