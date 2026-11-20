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
	// The mandatory DD-2 direct-origin reachability decision.
	//
	// Required. `DISABLED` and `LOCKED` synthesize; anything else — in particular a
	// directly reachable origin — fails synthesis with an error that names the
	// rejected decision.
	OriginReachability AppTheoryRestV1OriginReachability `field:"required" json:"originReachability" yaml:"originReachability"`
	// Optional challenge alias bridge.
	// Default: disabled.
	//
	AliasBridge *AppTheoryChallengeAliasBridgeOptions `field:"optional" json:"aliasBridge" yaml:"aliasBridge"`
	// Certificate for `domainNames`.
	//
	// Required when `domainNames` is set.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// The caller's assertion that the REST API's `disableExecuteApiEndpoint` is set, required with `originReachability: DISABLED`.
	//
	// This construct fronts an external `IRestApi` it cannot mutate, so it cannot
	// set the property for the caller; it requires the assertion instead and
	// records it in the distribution metadata.
	DisableExecuteApiEndpointAsserted *bool `field:"optional" json:"disableExecuteApiEndpointAsserted" yaml:"disableExecuteApiEndpointAsserted"`
	// Optional custom domain names for the distribution.
	//
	// When set, `certificate` is required.
	DomainNames *[]*string `field:"optional" json:"domainNames" yaml:"domainNames"`
	// Minimum TLS protocol version for viewers of `domainNames`.
	// Default: TLS_V1_2_2025 under a derived naming context with a certificate,
	// otherwise the CloudFront default for the certificate.
	//
	MinimumProtocolVersion awscloudfront.SecurityPolicyProtocol `field:"optional" json:"minimumProtocolVersion" yaml:"minimumProtocolVersion"`
	// Optional naming context that selects the Security Hub-aligned defaults.
	//
	// Under a derived context a distribution that serves `domainNames` through
	// `certificate` takes the CloudFront.15 `TLS_V1_2_2025` viewer policy. The
	// root is the REST API origin, a custom origin CloudFront.1 does not
	// evaluate, so no default root object applies.
	// Default: undefined.
	//
	NamingContext AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
	// The mandatory origin lock, required with `originReachability: LOCKED`.
	OriginLock *AppTheoryRestV1OriginLockOptions `field:"optional" json:"originLock" yaml:"originLock"`
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
