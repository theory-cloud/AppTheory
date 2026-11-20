package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
)

// DynamoDB-backed MCP session-state configuration.
type AppTheoryMcpSessionStateOptions struct {
	// Whether deletion protection should be enabled for the session table.
	//
	// Valid only when session state is enabled.
	// Default: undefined (with no naming context: the AWS default, no deletion
	// protection; under a derived naming context: on for a RETAIN table, off otherwise).
	//
	DeletionProtection *bool `field:"optional" json:"deletionProtection" yaml:"deletionProtection"`
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
