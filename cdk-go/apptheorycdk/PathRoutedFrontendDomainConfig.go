package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

// Domain configuration for the CloudFront distribution.
type PathRoutedFrontendDomainConfig struct {
	// The domain name for the distribution (e.g., "app.example.com").
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// ACM certificate for HTTPS.
	//
	// Must be in us-east-1 for CloudFront.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ARN of an existing ACM certificate.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Whether to create an AAAA alias record in addition to the A alias record.
	// Default: false.
	//
	CreateAAAARecord *bool `field:"optional" json:"createAAAARecord" yaml:"createAAAARecord"`
	// Route53 hosted zone for DNS record creation.
	//
	// When provided, an A record alias will be created for the domain.
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
}
