package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

// Stage configuration for an AppTheory-owned MCP HTTP API.
type AppTheoryMcpServerStageOptions struct {
	// Default: true.
	//
	AccessLogging *bool `field:"optional" json:"accessLogging" yaml:"accessLogging"`
	// Retention period for the access log group.
	//
	// Valid only when access logging
	// is enabled.
	// Default: logs.RetentionDays.ONE_MONTH
	//
	AccessLogRetention awslogs.RetentionDays `field:"optional" json:"accessLogRetention" yaml:"accessLogRetention"`
	// Default: "$default".
	//
	StageName *string `field:"optional" json:"stageName" yaml:"stageName"`
	// Default-stage burst limit.
	// Default: 200.
	//
	ThrottlingBurstLimit *float64 `field:"optional" json:"throttlingBurstLimit" yaml:"throttlingBurstLimit"`
	// Default: true.
	//
	ThrottlingEnabled *bool `field:"optional" json:"throttlingEnabled" yaml:"throttlingEnabled"`
	// Default-stage rate limit in requests per second.
	// Default: 100.
	//
	ThrottlingRateLimit *float64 `field:"optional" json:"throttlingRateLimit" yaml:"throttlingRateLimit"`
}
