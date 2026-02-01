package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
)

// Props for the AppTheoryRestApiRouter construct.
type AppTheoryRestApiRouterProps struct {
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
	// Stage configuration.
	Stage *AppTheoryRestApiRouterStageOptions `field:"optional" json:"stage" yaml:"stage"`
}

