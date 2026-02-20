package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

// Stage configuration for the MCP server API Gateway.
type AppTheoryMcpServerStageOptions struct {
	// Enable CloudWatch access logging for the stage.
	// Default: false.
	//
	AccessLogging *bool `field:"optional" json:"accessLogging" yaml:"accessLogging"`
	// Retention period for auto-created access log group.
	//
	// Only applies when accessLogging is true.
	// Default: logs.RetentionDays.ONE_MONTH
	//
	AccessLogRetention awslogs.RetentionDays `field:"optional" json:"accessLogRetention" yaml:"accessLogRetention"`
	// Stage name.
	// Default: "prod".
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
