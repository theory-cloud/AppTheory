package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// Props for the AppTheoryRemoteMcpServer construct.
//
// This construct is intended for Claude-first Remote MCP deployments:
// - API Gateway REST API v1 (required for response streaming)
// - Streamable HTTP mount at `/mcp` (POST/GET/DELETE).
type AppTheoryRemoteMcpServerProps struct {
	// The Lambda function that handles MCP Streamable HTTP requests.
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Enable per-actor MCP endpoint bundles.
	//
	// When enabled, the construct mounts the transport at `/mcp/{actor}` and
	// co-registers the RFC 9728 discovery route at
	// `/.well-known/oauth-protected-resource/mcp/{actor}`.
	//
	// The public `endpoint` and injected `MCP_ENDPOINT` environment variable
	// become a template string ending in `/mcp/{actor}`.
	// Default: false.
	//
	ActorPath *bool `field:"optional" json:"actorPath" yaml:"actorPath"`
	// Optional API name.
	// Default: undefined.
	//
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// CORS configuration for the REST API.
	//
	// Note: For browser clients, your Lambda handler still needs to emit
	// the appropriate `Access-Control-Allow-Origin` headers.
	// Default: undefined (no CORS preflight).
	//
	Cors interface{} `field:"optional" json:"cors" yaml:"cors"`
	// Optional API description.
	// Default: undefined.
	//
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Optional custom domain configuration.
	// Default: undefined.
	//
	Domain *AppTheoryRestApiRouterDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Create a DynamoDB table for MCP session storage.
	// Default: false.
	//
	EnableSessionTable *bool `field:"optional" json:"enableSessionTable" yaml:"enableSessionTable"`
	// Create a DynamoDB table for stream/event log storage.
	//
	// This is intended for durable resumable SSE implementations where stream
	// events must survive Lambda container recycling.
	// Default: false.
	//
	EnableStreamTable *bool `field:"optional" json:"enableStreamTable" yaml:"enableStreamTable"`
	// Register `GET /.well-known/mcp.json` and route it to the handler.
	//
	// This lets the construct own the final MCP discovery route alongside the
	// transport and protected-resource metadata routes. The handler remains
	// responsible for serving the discovery document content.
	// Default: false.
	//
	EnableWellKnownMcpDiscovery *bool `field:"optional" json:"enableWellKnownMcpDiscovery" yaml:"enableWellKnownMcpDiscovery"`
	// Session DynamoDB table name (only used when enableSessionTable is true).
	// Default: undefined (auto-generated).
	//
	SessionTableName *string `field:"optional" json:"sessionTableName" yaml:"sessionTableName"`
	// Session TTL in minutes (exposed to the handler as MCP_SESSION_TTL_MINUTES).
	// Default: 60.
	//
	SessionTtlMinutes *float64 `field:"optional" json:"sessionTtlMinutes" yaml:"sessionTtlMinutes"`
	// Stage configuration.
	// Default: undefined (router defaults applied).
	//
	Stage *AppTheoryRestApiRouterStageOptions `field:"optional" json:"stage" yaml:"stage"`
	// Stream DynamoDB table name (only used when enableStreamTable is true).
	// Default: undefined (auto-generated).
	//
	StreamTableName *string `field:"optional" json:"streamTableName" yaml:"streamTableName"`
	// Stream/event TTL in minutes (exposed to the handler as MCP_STREAM_TTL_MINUTES).
	// Default: 60.
	//
	StreamTtlMinutes *float64 `field:"optional" json:"streamTtlMinutes" yaml:"streamTtlMinutes"`
}

