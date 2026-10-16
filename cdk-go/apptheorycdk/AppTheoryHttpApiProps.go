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
	//
	// When `domain.mutualTlsAuthentication` is set, AppTheory fails closed and
	// disables the default `execute-api` endpoint so the API is reachable only
	// through the mutual-TLS custom domain. Without mutual TLS the default
	// endpoint keeps the AWS default (enabled), so ordinary custom domains are
	// unaffected.
	// Default: undefined.
	//
	Domain *AppTheoryHttpApiDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Explicit, semantically identified routes added alongside the construct's greedy `ANY /` and `ANY /{proxy+}` routes.
	//
	// Use this where a stricter per-path gateway posture (for example
	// `AppTheoryHttpApiRouteAuthorizer.IAM`) must win over the greedy routes: a
	// full method+path match outranks the greedy route by API Gateway precedence,
	// and a wrong-method request on such a path is denied by the runtime with the
	// fail-closed 404/405 envelope.
	//
	// Route construct ids are derived from the method and path, so inserting,
	// removing, or reordering an entry never renames an unrelated route.
	//
	// A declared `OPTIONS` route coexists with, and can be shadowed by, the
	// API-level CORS configuration `cors` installs. `buildCorsPreflight` includes
	// `OPTIONS` in its default `allowMethods`, and while `OPTIONS` is in that
	// list API Gateway answers matching preflight requests itself before the
	// route integration runs, so a declared `OPTIONS` route on the same path is
	// never reached. Setting `cors.allowMethods` without `OPTIONS` removes gateway
	// preflight handling entirely; a declared `OPTIONS` route is then the only
	// thing that answers a preflight request, and it is subject to that route's
	// own authorizer. Declare the methods you need in `cors.allowMethods` rather
	// than depending on a declared `OPTIONS` route.
	// Default: undefined.
	//
	Routes *[]*AppTheoryHttpApiRouteOptions `field:"optional" json:"routes" yaml:"routes"`
	// Route-level throttling keyed by API Gateway route key (for example `"ANY /{proxy+}"`). Applied to the stage's route settings.
	//
	// Every key is validated at synthesis time against the route keys this
	// construct emits — the greedy `ANY /` and `ANY /{proxy+}` routes plus one
	// `<METHOD> <path>` key per `routes` entry. A key that matches no emitted
	// route fails synthesis with a named error listing the emitted keys, rather
	// than being silently ignored by API Gateway.
	// Default: undefined.
	//
	RouteSettings *map[string]*AppTheoryHttpApiRouteThrottling `field:"optional" json:"routeSettings" yaml:"routeSettings"`
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
