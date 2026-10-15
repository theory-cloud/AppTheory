package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
)

// Properties for `AppTheoryRestV1ChallengeRestoration`.
type AppTheoryRestV1ChallengeRestorationProps struct {
	// The REST API v1 origin whose `WWW-Authenticate` responses must be restored.
	//
	// Only an AWS API Gateway REST API v1 (a non-empty `restApiId` and a non-empty
	// `restApiRootResourceId`) is accepted; the restoration is a documented no-op
	// on HTTP API v2.
	Origin awsapigateway.IRestApi `field:"required" json:"origin" yaml:"origin"`
	// Optional challenge alias bridge.
	// Default: disabled.
	//
	AliasBridge *AppTheoryChallengeAliasBridgeOptions `field:"optional" json:"aliasBridge" yaml:"aliasBridge"`
	// Certificate for `domainNames`.
	//
	// Required when `domainNames` is set.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// Optional custom domain names for the distribution.
	//
	// When set, `certificate` is required.
	DomainNames *[]*string `field:"optional" json:"domainNames" yaml:"domainNames"`
	// Optional CloudFront price class.
	PriceClass awscloudfront.PriceClass `field:"optional" json:"priceClass" yaml:"priceClass"`
	// MCP resource paths whose derived routes receive an explicit ordered cache behavior.
	//
	// The effective route set is derived from the shared route algebra, never
	// hand-wired. A supplied-but-empty array is treated as the default.
	// Default: the standard MCP patterns from the shared route algebra
	// (`AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().mcpPattern`)
	//
	ResourcePaths *[]*string `field:"optional" json:"resourcePaths" yaml:"resourcePaths"`
}
