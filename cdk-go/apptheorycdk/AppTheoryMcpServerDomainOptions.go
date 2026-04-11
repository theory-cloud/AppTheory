package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

// Custom domain configuration for the MCP server.
type AppTheoryMcpServerDomainOptions struct {
	// The custom domain name (e.g., "mcp.example.com").
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// ACM certificate for the domain.
	//
	// Provide either certificate or certificateArn.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ACM certificate ARN.
	//
	// Provide either certificate or certificateArn.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Route53 hosted zone for automatic DNS record creation.
	//
	// If provided, a CNAME record will be created pointing to the API Gateway domain.
	// Default: undefined (no DNS record created).
	//
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
}
