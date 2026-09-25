package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryHttpIngestionEndpointProps struct {
	// Lambda request authorizer used for secret-key validation.
	Authorizer awslambda.IFunction `field:"required" json:"authorizer" yaml:"authorizer"`
	// Lambda function that handles the ingestion request.
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Optional API name.
	// Default: undefined.
	//
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Lambda authorizer result cache TTL.
	//
	// Defaults to disabled to match the upstream backoffice-api-authorizer behavior.
	// Default: Duration.seconds(0)
	//
	AuthorizerCacheTtl awscdk.Duration `field:"optional" json:"authorizerCacheTtl" yaml:"authorizerCacheTtl"`
	// Header used as the identity source for secret-key authorization.
	//
	// This defaults to `Authorization` to mirror the backoffice-api-authorizer pattern.
	// Default: "Authorization".
	//
	AuthorizerHeaderName *string `field:"optional" json:"authorizerHeaderName" yaml:"authorizerHeaderName"`
	// Friendly authorizer name.
	// Default: undefined.
	//
	AuthorizerName *string `field:"optional" json:"authorizerName" yaml:"authorizerName"`
	// Optional custom domain configuration.
	// Default: undefined.
	//
	Domain *AppTheoryHttpIngestionEndpointDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// HTTPS path exposed by the endpoint.
	// Default: "/ingest".
	//
	EndpointPath *string `field:"optional" json:"endpointPath" yaml:"endpointPath"`
	// Whether the Lambda invoke permission should be scoped to the ingestion route.
	//
	// When false, the construct grants one API-scoped invoke permission instead of one
	// permission scoped to the ingestion path. This is the scalable choice when the ingestion
	// Lambda is shared with other routes on the same HTTP API, where the per-route permissions
	// can exhaust the Lambda resource policy size limit.
	//
	// The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
	// to invoke the handler, not only the ingestion route this construct owns.
	// Default: true.
	//
	ScopePermissionToRoute *bool `field:"optional" json:"scopePermissionToRoute" yaml:"scopePermissionToRoute"`
	// Optional stage configuration.
	// Default: undefined.
	//
	Stage *AppTheoryHttpIngestionEndpointStageOptions `field:"optional" json:"stage" yaml:"stage"`
}
