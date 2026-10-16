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
	// CORS preflight for a construct-owned API.
	//
	// Set to `true` for AppTheory
	// defaults or supply an `AppTheoryHttpApiCorsOptions` object. Invalid in
	// attach mode, where the owning API configures CORS.
	// Default: undefined.
	//
	Cors interface{} `field:"optional" json:"cors" yaml:"cors"`
	// Denial-telemetry declaration required under RUNTIME_BEARER only.
	// Default: undefined.
	//
	DenialSignal *AppTheoryMcpDenialSignalOptions `field:"optional" json:"denialSignal" yaml:"denialSignal"`
	// Deprecated: Use `ownedApi.domain`. Domains are invalid in attach mode.
	Domain *AppTheoryMcpServerDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Deprecated: Use `sessionState.enabled`. Session state now defaults on.
	EnableSessionTable *bool `field:"optional" json:"enableSessionTable" yaml:"enableSessionTable"`
	// Upstream-provider attachment that marks this server as facade-configured.
	//
	// The attachment's presence selects the `runtime-bearer` posture default.
	// Provider wiring lands in M3; this milestone validates the attachment shape.
	// Default: undefined.
	//
	Facade *AppTheoryMcpFacadeAttachment `field:"optional" json:"facade" yaml:"facade"`
	// JWKS URI from the v3.1.x A6 environment contract.
	// Deprecated: Configure `runtime/mcpfacade.FacadeConfig.JWKSURI` in the
	// application. The construct no longer injects JWKS environment values.
	JwksUri *string `field:"optional" json:"jwksUri" yaml:"jwksUri"`
	// Single MCP route path from the v3.1.x A6 surface.
	// Deprecated: Use `routeFamily.patterns`. The new default is the canonical
	// four-pattern family; use `{ patterns: ['/mcp'] }` for the old singleton.
	McpPath *string `field:"optional" json:"mcpPath" yaml:"mcpPath"`
	// Direct-origin reachability decision required under RUNTIME_BEARER and NONE_PUBLIC.
	//
	// A directly reachable origin is refused.
	// Default: undefined.
	//
	OriginReachability AppTheoryMcpOriginReachability `field:"optional" json:"originReachability" yaml:"originReachability"`
	// Owned-API configuration for standalone mode.
	//
	// Invalid with `api`.
	// Default: production-owned API defaults.
	//
	OwnedApi *AppTheoryMcpServerOwnedApiOptions `field:"optional" json:"ownedApi" yaml:"ownedApi"`
	// Attach-mode record of the owning API's throttling and access-logging decisions, required under RUNTIME_BEARER and NONE_PUBLIC.
	// Default: undefined.
	//
	OwningApiDefense *AppTheoryMcpOwningApiDefenseOptions `field:"optional" json:"owningApiDefense" yaml:"owningApiDefense"`
	// Ordered MCP route family.
	//
	// Go `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical default
	// family. Noncanonical patterns require app-owned runtime route registration
	// that matches the construct's `routeInventory`.
	// Default: AppTheoryMcpRouteAlgebra.supportedEndpointTemplates()
	//
	RouteFamily *AppTheoryMcpRouteFamily `field:"optional" json:"routeFamily" yaml:"routeFamily"`
	// Route-emission model.
	//
	// `explicit` (the default) wires the full derived route inventory as one HTTP
	// API v2 route per route key and is byte-stable for deployed stacks.
	// `consolidated` wires exactly two greedy routes, `ANY /` and `ANY /{proxy+}`,
	// and is valid only for the `runtime-bearer` and `none-public` transport
	// postures; `iam` and `jwt` are refused at synthesis.
	//
	// Consolidated mode is allowed on a construct-owned API, or on an attached
	// API that has no routes at attach time. A consumer may add explicit, more
	// specific routes with a stricter authorizer on the same API afterwards; a
	// full method+path match beats the greedy routes by API Gateway precedence,
	// and a wrong-method hit on such a path falls to the runtime's fail-closed
	// 404/405.
	// Default: AppTheoryMcpRouteModel.EXPLICIT
	//
	RouteModel AppTheoryMcpRouteModel `field:"optional" json:"routeModel" yaml:"routeModel"`
	// Runtime-side RFC 9728 bearer validation declaration.
	//
	// Required by `transportPosture: RUNTIME_BEARER` and refused under every
	// other posture.
	// Default: undefined.
	//
	RuntimePosture *AppTheoryMcpRuntimePostureOptions `field:"optional" json:"runtimePosture" yaml:"runtimePosture"`
	// Whether Lambda invoke permissions should be scoped to individual HTTP API v2 routes.
	//
	// When false, the construct grants one API-scoped invoke permission per Lambda instead of
	// one permission per route. This is the scalable choice for large MCP facade families that
	// share one Lambda, where the per-route permissions can exhaust the Lambda resource policy
	// size limit.
	//
	// The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
	// to invoke the handler, not only the routes this construct owns.
	// Default: true.
	//
	ScopePermissionToRoute *bool `field:"optional" json:"scopePermissionToRoute" yaml:"scopePermissionToRoute"`
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
	// Static JWT configuration for the MCP transport routes.
	//
	// Transport routes are the POST, GET, and DELETE routes on every MCP pattern.
	// This prop is only valid with `transportPosture: JWT`, which requires an
	// issuer and a non-empty audience. Discovery, protected-resource metadata,
	// authorize, and token routes remain explicitly public (`NONE`) because OAuth
	// clients must fetch them before they hold a token.
	// Default: undefined.
	//
	TransportAuthorizer *AppTheoryMcpTransportAuthorizerOptions `field:"optional" json:"transportAuthorizer" yaml:"transportAuthorizer"`
	// Transport-route authorization posture.
	//
	// An explicit selection overrides the facade-scoped default. When it is
	// omitted, a server that attaches `facade` resolves to `runtime-bearer` and a
	// plain transport server resolves to `iam`. `none-public` is never a default
	// and carries the defense-in-depth floor.
	// Default: AppTheoryMcpTransportPosture.RUNTIME_BEARER when `facade` is attached, otherwise AppTheoryMcpTransportPosture.IAM
	//
	TransportPosture AppTheoryMcpTransportPosture `field:"optional" json:"transportPosture" yaml:"transportPosture"`
	// Stage-global upstream OAuth callback path.
	//
	// The CDK-mounted callback route and the runtime-registered one must not
	// diverge: this prop is resolved by
	// `AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath`, the same algebra
	// the runtime applies to `FacadeConfig.UpstreamCallbackPath`. Supply a
	// synthesis-time literal absolute path with no query, fragment, or dot
	// segment; an empty value keeps the contract default, and a value that
	// collides with another derived route fails synthesis. Refused under
	// `transportPosture: none-public`, which attaches no OAuth surface.
	// Default: AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH
	//
	UpstreamCallbackPath *string `field:"optional" json:"upstreamCallbackPath" yaml:"upstreamCallbackPath"`
}
