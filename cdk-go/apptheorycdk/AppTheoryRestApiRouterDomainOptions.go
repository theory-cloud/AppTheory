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
	// Default: TLS_1_2.
	//
	SecurityPolicy awsapigateway.SecurityPolicy `field:"optional" json:"securityPolicy" yaml:"securityPolicy"`
}
