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
	// OAuth authorization server issuer passed to the Lambda runtime config.
	//
	// AppTheory does not parse this value or use it to synthesize resource URLs.
	// Supply `jwksUri` with this prop to enable the runtime-served RFC 9728
	// discovery routes.
	// Default: undefined (legacy POST-only MCP route).
	//
	AuthorizationServerIssuer *string `field:"optional" json:"authorizationServerIssuer" yaml:"authorizationServerIssuer"`
	// Custom domain configuration.
	// Default: undefined (no custom domain).
	//
	Domain *AppTheoryMcpServerDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Create a DynamoDB table for session state storage.
	// Default: false.
	//
	EnableSessionTable *bool `field:"optional" json:"enableSessionTable" yaml:"enableSessionTable"`
	// OAuth JSON Web Key Set URL passed to the Lambda runtime config.
	//
	// Supply `authorizationServerIssuer` with this prop. CDK tokens are accepted
	// because the value is forwarded, not parsed during synthesis.
	// Default: undefined (legacy POST-only MCP route).
	//
	JwksUri *string `field:"optional" json:"jwksUri" yaml:"jwksUri"`
	// Literal route path for the MCP endpoint.
	//
	// This is a synthesis-time path, never an origin or full resource URL.
	// Default: AppTheoryMcpPaths.MCP
	//
	McpPath *string `field:"optional" json:"mcpPath" yaml:"mcpPath"`
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
