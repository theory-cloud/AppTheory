package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

// Stage-level configuration for the REST API router.
type AppTheoryRestApiRouterStageOptions struct {
	// Access log format.
	// Default: AccessLogFormat.clf() (Common Log Format)
	//
	AccessLogFormat awsapigateway.AccessLogFormat `field:"optional" json:"accessLogFormat" yaml:"accessLogFormat"`
	// Enable CloudWatch access logging for the stage.
	//
	// If true, a log group will be created automatically.
	// Provide a LogGroup for custom logging configuration.
	// Default: false.
	//
	AccessLogging interface{} `field:"optional" json:"accessLogging" yaml:"accessLogging"`
	// Retention period for auto-created access log group.
	//
	// Only applies when accessLogging is true (boolean).
	// Default: logs.RetentionDays.ONE_MONTH
	//
	AccessLogRetention awslogs.RetentionDays `field:"optional" json:"accessLogRetention" yaml:"accessLogRetention"`
	// Enable detailed CloudWatch metrics at method/resource level.
	// Default: false.
	//
	DetailedMetrics *bool `field:"optional" json:"detailedMetrics" yaml:"detailedMetrics"`
	// Stage name.
	// Default: 'prod'.
	//
	StageName *string `field:"optional" json:"stageName" yaml:"stageName"`
	// Throttling burst limit for the stage.
	// Default: undefined (no throttling).
	//
	ThrottlingBurstLimit *float64 `field:"optional" json:"throttlingBurstLimit" yaml:"throttlingBurstLimit"`
	// Throttling rate limit (requests per second) for the stage.
	// Default: undefined (no throttling).
	//
	ThrottlingRateLimit *float64 `field:"optional" json:"throttlingRateLimit" yaml:"throttlingRateLimit"`
}

