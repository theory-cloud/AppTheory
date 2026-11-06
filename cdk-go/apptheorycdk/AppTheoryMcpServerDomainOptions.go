package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

// Custom domain configuration for an AppTheory-owned MCP HTTP API.
type AppTheoryMcpServerDomainOptions struct {
	// The custom domain name (for example, `mcp.example.com`).
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// ACM certificate for the domain.
	//
	// Provide this or `certificateArn`.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ACM certificate ARN.
	//
	// Provide this or `certificate`.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Route53 hosted zone for an automatically created CNAME record.
	// Default: undefined.
	//
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Mutual TLS truststore for the owned custom domain.
	//
	// Supplying this is the concrete `AppTheoryMcpOriginReachability.LOCKED`
	// evidence: the construct disables the default execute-api endpoint and
	// requires every API mapping bound to the owned API to target a domain whose
	// `MutualTlsAuthentication` carries a truststore URI. Supplying it with any
	// other origin decision, or selecting `LOCKED` without it, fails synthesis.
	// Default: undefined.
	//
	MutualTlsAuthentication *awsapigatewayv2.MTLSConfig `field:"optional" json:"mutualTlsAuthentication" yaml:"mutualTlsAuthentication"`
}
