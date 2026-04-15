package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
)

// Props for the AppTheoryRestApiRouter construct.
type AppTheoryRestApiRouterProps struct {
	// Whether API Gateway console test invocations should be granted Lambda invoke permissions.
	//
	// When false, the construct suppresses the extra `test-invoke-stage` Lambda permissions
	// that CDK adds for each REST API method. This reduces Lambda resource policy size while
	// preserving deployed-stage invoke permissions.
	// Default: true.
	//
	AllowTestInvoke *bool `field:"optional" json:"allowTestInvoke" yaml:"allowTestInvoke"`
	// API key source type.
	// Default: HEADER.
	//
	ApiKeySourceType awsapigateway.ApiKeySourceType `field:"optional" json:"apiKeySourceType" yaml:"apiKeySourceType"`
	// Name of the REST API.
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Whether the REST API uses binary media types.
	//
	// Specify media types that should be treated as binary.
	// Default: undefined.
	//
	BinaryMediaTypes *[]*string `field:"optional" json:"binaryMediaTypes" yaml:"binaryMediaTypes"`
	// CORS configuration.
	//
	// Set to true for sensible defaults,
	// or provide custom options.
	// Default: undefined (no CORS).
	//
	Cors interface{} `field:"optional" json:"cors" yaml:"cors"`
	// Enable deploy on construct creation.
	// Default: true.
	//
	Deploy *bool `field:"optional" json:"deploy" yaml:"deploy"`
	// Description of the REST API.
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Custom domain configuration.
	// Default: undefined (no custom domain).
	//
	Domain *AppTheoryRestApiRouterDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Endpoint types for the REST API.
	// Default: [REGIONAL].
	//
	EndpointTypes *[]awsapigateway.EndpointType `field:"optional" json:"endpointTypes" yaml:"endpointTypes"`
	// Minimum compression size in bytes.
	// Default: undefined (no compression).
	//
	MinimumCompressionSize *float64 `field:"optional" json:"minimumCompressionSize" yaml:"minimumCompressionSize"`
	// Retain deployment history when deployments change.
	// Default: false.
	//
	RetainDeployments *bool `field:"optional" json:"retainDeployments" yaml:"retainDeployments"`
	// Whether Lambda invoke permissions should be scoped to individual REST API methods.
	//
	// When false, the construct grants one API-scoped invoke permission per Lambda instead of
	// one permission per method/path pair. This is the scalable choice for large front-controller
	// APIs that route many REST paths to the same Lambda.
	// Default: true.
	//
	ScopePermissionToMethod *bool `field:"optional" json:"scopePermissionToMethod" yaml:"scopePermissionToMethod"`
	// Stage configuration.
	Stage *AppTheoryRestApiRouterStageOptions `field:"optional" json:"stage" yaml:"stage"`
}
