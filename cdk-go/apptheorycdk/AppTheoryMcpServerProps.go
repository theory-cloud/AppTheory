package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

// Props for the AppTheoryMcpServer construct.
type AppTheoryMcpServerProps struct {
	// Lambda function handling the runtime-composed MCP facade.
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Existing HTTP API to attach to.
	//
	// Attach mode is the primary front-door
	// topology and never creates an `AWS::ApiGatewayV2::Api` resource.
	// Default: a construct-owned HttpApi.
	//
	Api awsapigatewayv2.IHttpApi `field:"optional" json:"api" yaml:"api"`
	// Deprecated: Use `ownedApi.apiName`.
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Stage name used when deriving attach-mode execute-api endpoint templates.
	//
	// Use `$default` for the API Gateway default stage. When omitted, the stage
	// is not determinable and the templates retain the bare execute-api origin.
	// This prop does not create, import, or mutate a stage.
	// Default: undefined.
	//
	AttachedApiStageName *string `field:"optional" json:"attachedApiStageName" yaml:"attachedApiStageName"`
	// Authorization-server issuer from the v3.1.x A6 environment contract.
	// Deprecated: Configure `runtime/mcpfacade.FacadeConfig.IssuerURL` in the
	// application. The construct no longer injects issuer environment values.
	AuthorizationServerIssuer *string `field:"optional" json:"authorizationServerIssuer" yaml:"authorizationServerIssuer"`
	// Deprecated: Use `ownedApi.domain`. Domains are invalid in attach mode.
	Domain *AppTheoryMcpServerDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Deprecated: Use `sessionState.enabled`. Session state now defaults on.
	EnableSessionTable *bool `field:"optional" json:"enableSessionTable" yaml:"enableSessionTable"`
	// JWKS URI from the v3.1.x A6 environment contract.
	// Deprecated: Configure `runtime/mcpfacade.FacadeConfig.JWKSURI` in the
	// application. The construct no longer injects JWKS environment values.
	JwksUri *string `field:"optional" json:"jwksUri" yaml:"jwksUri"`
	// Single MCP route path from the v3.1.x A6 surface.
	// Deprecated: Use `routeFamily.patterns`. The new default is the canonical
	// four-pattern family; use `{ patterns: ['/mcp'] }` for the old singleton.
	McpPath *string `field:"optional" json:"mcpPath" yaml:"mcpPath"`
	// Owned-API configuration for standalone mode.
	//
	// Invalid with `api`.
	// Default: production-owned API defaults.
	//
	OwnedApi *AppTheoryMcpServerOwnedApiOptions `field:"optional" json:"ownedApi" yaml:"ownedApi"`
	// Ordered MCP route family.
	//
	// Go `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical default
	// family. Noncanonical patterns require app-owned runtime route registration
	// that matches the construct's `routeInventory`.
	// Default: AppTheoryMcpRouteAlgebra.supportedEndpointTemplates()
	//
	RouteFamily *AppTheoryMcpRouteFamily `field:"optional" json:"routeFamily" yaml:"routeFamily"`
	// Session-state table configuration.
	//
	// The table defaults on.
	// Default: enabled with production defaults.
	//
	SessionState *AppTheoryMcpSessionStateOptions `field:"optional" json:"sessionState" yaml:"sessionState"`
	// Deprecated: Use `sessionState.tableName`.
	SessionTableName *string `field:"optional" json:"sessionTableName" yaml:"sessionTableName"`
	// Deprecated: Use `sessionState.ttlMinutes`.
	SessionTtlMinutes *float64 `field:"optional" json:"sessionTtlMinutes" yaml:"sessionTtlMinutes"`
	// Deprecated: Use `ownedApi.stage`. Stage options are invalid in attach mode.
	Stage *AppTheoryMcpServerStageOptions `field:"optional" json:"stage" yaml:"stage"`
	// Explicitly opt out of the OAuth facade and wire only MCP transport routes.
	//
	// This cannot be combined with legacy authorization props or root discovery.
	// `runtime/mcpfacade.RegisterMCPFacade` always installs the authenticated
	// canonical facade, so applications using this opt-out must own runtime
	// registration for the transport routes.
	// Default: false.
	//
	UnauthenticatedMcp *bool `field:"optional" json:"unauthenticatedMcp" yaml:"unauthenticatedMcp"`
}
