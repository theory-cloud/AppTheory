package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

// Custom domain configuration for the REST API router.
type AppTheoryRestApiRouterDomainOptions struct {
	// The custom domain name (e.g., "api.example.com").
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// The base path mapping for the API under this domain.
	// Default: undefined (maps to the root).
	//
	BasePath *string `field:"optional" json:"basePath" yaml:"basePath"`
	// ACM certificate (must be in us-east-1 for edge endpoints, same region for regional).
	//
	// Provide either certificate or certificateArn.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ACM certificate ARN.
	//
	// Provide either certificate or certificateArn.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Whether to create an AAAA alias record in addition to the A alias record.
	//
	// Only applies when `hostedZone` is provided.
	// Default: false.
	//
	CreateAAAARecord *bool `field:"optional" json:"createAAAARecord" yaml:"createAAAARecord"`
	// Endpoint access mode for an enhanced (`SecurityPolicy_*`) security policy.
	//
	// API Gateway requires this for an enhanced policy and rejects it for a
	// legacy one. When unset, an enhanced effective policy takes `STRICT` and a
	// legacy policy takes no mode.
	// Default: STRICT for an enhanced effective policy, otherwise undefined.
	//
	EndpointAccessMode awsapigateway.EndpointAccessMode `field:"optional" json:"endpointAccessMode" yaml:"endpointAccessMode"`
	// Endpoint type for the domain.
	// Default: REGIONAL.
	//
	EndpointType awsapigateway.EndpointType `field:"optional" json:"endpointType" yaml:"endpointType"`
	// Route53 hosted zone for automatic DNS record creation.
	//
	// If provided, an A record (alias) will be created pointing to the API Gateway domain.
	// Default: undefined (no DNS record created).
	//
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Security policy for the domain.
	//
	// With a derived naming context the default is the policy Security Hub
	// APIGateway.11 accepts for the endpoint type (regional:
	// `TLS13_1_2_PFS_PQ_2025_09`, edge: `TLS12_PFS_2025_EDGE`). Without a
	// naming context the default is `TLS_1_2`.
	//
	// The 2025 policies are also a cipher-policy change for clients, the same
	// caveat as the CloudFront.15 `TLSv1.2_2025` policy: a client that only
	// negotiates an older TLS 1.2 cipher suite is excluded. An enhanced policy
	// requires an endpoint access mode alongside it: AppTheory derives `STRICT`
	// (the recommended mode), and `BASIC` remains available through
	// `domain.endpointAccessMode`.
	// Default: TLS_1_2, or the APIGateway.11 policy under a derived naming context
	//
	SecurityPolicy awsapigateway.SecurityPolicy `field:"optional" json:"securityPolicy" yaml:"securityPolicy"`
}
