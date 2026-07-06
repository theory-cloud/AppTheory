package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

type AppTheoryHttpApiStageOptions struct {
	// Enable CloudWatch access logging or provide a log group.
	// Default: false.
	//
	AccessLogging interface{} `field:"optional" json:"accessLogging" yaml:"accessLogging"`
	// Retention period for an auto-created access log group.
	// Default: logs.RetentionDays.ONE_MONTH
	//
	AccessLogRetention awslogs.RetentionDays `field:"optional" json:"accessLogRetention" yaml:"accessLogRetention"`
	// Stage name.
	// Default: "$default".
	//
	StageName *string `field:"optional" json:"stageName" yaml:"stageName"`
	// Throttling burst limit.
	// Default: undefined.
	//
	ThrottlingBurstLimit *float64 `field:"optional" json:"throttlingBurstLimit" yaml:"throttlingBurstLimit"`
	// Throttling rate limit.
	// Default: undefined.
	//
	ThrottlingRateLimit *float64 `field:"optional" json:"throttlingRateLimit" yaml:"throttlingRateLimit"`
}
