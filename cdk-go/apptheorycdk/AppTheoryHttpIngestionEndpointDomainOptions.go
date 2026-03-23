package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

type AppTheoryHttpIngestionEndpointDomainOptions struct {
	// The custom domain name (for example `ingest.example.com`).
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// Optional API mapping key under the custom domain.
	// Default: undefined.
	//
	BasePath *string `field:"optional" json:"basePath" yaml:"basePath"`
	// ACM certificate for the domain.
	//
	// Provide either `certificate` or `certificateArn`.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ACM certificate ARN.
	//
	// Provide either `certificate` or `certificateArn`.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Route53 hosted zone for automatic DNS record creation.
	//
	// If provided, a CNAME record will be created pointing to the API Gateway domain.
	// Default: undefined.
	//
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
}

