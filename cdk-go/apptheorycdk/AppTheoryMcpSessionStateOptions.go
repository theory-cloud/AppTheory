package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
)

// DynamoDB-backed MCP session-state configuration.
type AppTheoryMcpSessionStateOptions struct {
	// Default: true.
	//
	Enabled *bool `field:"optional" json:"enabled" yaml:"enabled"`
	// Session table removal policy.
	//
	// Valid only when session state is enabled.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Session table name.
	//
	// Valid only when session state is enabled.
	// Default: auto-generated.
	//
	TableName *string `field:"optional" json:"tableName" yaml:"tableName"`
	// TTL in minutes for session records.
	//
	// Valid only when session state is
	// enabled.
	// Default: 60.
	//
	TtlMinutes *float64 `field:"optional" json:"ttlMinutes" yaml:"ttlMinutes"`
}
