package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// Props for the AppTheoryMcpServer construct.
type AppTheoryMcpServerProps struct {
	// The Lambda function handling MCP requests.
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Optional API name.
	// Default: undefined.
	//
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Custom domain configuration.
	// Default: undefined (no custom domain).
	//
	Domain *AppTheoryMcpServerDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Create a DynamoDB table for session state storage.
	// Default: false.
	//
	EnableSessionTable *bool `field:"optional" json:"enableSessionTable" yaml:"enableSessionTable"`
	// Name for the session DynamoDB table.
	//
	// Only used when enableSessionTable is true.
	// Default: undefined (auto-generated).
	//
	SessionTableName *string `field:"optional" json:"sessionTableName" yaml:"sessionTableName"`
	// TTL in minutes for session records.
	//
	// Only used when enableSessionTable is true.
	// Default: 60.
	//
	SessionTtlMinutes *float64 `field:"optional" json:"sessionTtlMinutes" yaml:"sessionTtlMinutes"`
	// Stage configuration.
	// Default: undefined (defaults applied).
	//
	Stage *AppTheoryMcpServerStageOptions `field:"optional" json:"stage" yaml:"stage"`
}
