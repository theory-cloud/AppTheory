package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryHttpApiProps struct {
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	ApiName *string             `field:"optional" json:"apiName" yaml:"apiName"`
	// CORS configuration.
	//
	// Set to true for AppTheory defaults.
	// Default: undefined.
	//
	Cors interface{} `field:"optional" json:"cors" yaml:"cors"`
	// Custom domain configuration.
	// Default: undefined.
	//
	Domain *AppTheoryHttpApiDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Whether Lambda invoke permissions should be scoped to individual HTTP API v2 routes.
	//
	// When false, the construct grants one API-scoped invoke permission per Lambda instead of
	// one permission per route. This is the scalable choice for route families that share one
	// Lambda, where the per-route permissions can exhaust the Lambda resource policy size
	// limit.
	//
	// The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
	// to invoke the handler, not only the routes this construct owns.
	// Default: true.
	//
	ScopePermissionToRoute *bool `field:"optional" json:"scopePermissionToRoute" yaml:"scopePermissionToRoute"`
	// Stage configuration.
	// Default: undefined.
	//
	Stage *AppTheoryHttpApiStageOptions `field:"optional" json:"stage" yaml:"stage"`
	// Regional WAF attachment is intentionally unavailable for API Gateway v2 HTTP APIs.
	//
	// Supplying this prop fails closed during synthesis instead of
	// producing an unsupported `/apis/.../stages/...` WebACL association.
	//
	// Use AppTheoryRestApi or AppTheoryRestApiRouter when a WAF-protected API
	// Gateway stage is required.
	// Default: undefined.
	//
	// Deprecated: HTTP API WAF association is unsupported by AWS WAFv2.
	Waf interface{} `field:"optional" json:"waf" yaml:"waf"`
}
