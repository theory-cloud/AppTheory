package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

type AppTheoryHttpApiDomainOptions struct {
	// Custom domain name, for example `api.example.com`.
	DomainName *string `field:"required" json:"domainName" yaml:"domainName"`
	// API mapping key under the custom domain.
	// Default: undefined.
	//
	ApiMappingKey *string `field:"optional" json:"apiMappingKey" yaml:"apiMappingKey"`
	// ACM certificate for the domain.
	//
	// Provide either certificate or certificateArn.
	Certificate awscertificatemanager.ICertificate `field:"optional" json:"certificate" yaml:"certificate"`
	// ACM certificate ARN.
	//
	// Provide either certificate or certificateArn.
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Whether to create a CNAME when hostedZone is provided.
	// Default: true when hostedZone is provided.
	//
	CreateCname *bool `field:"optional" json:"createCname" yaml:"createCname"`
	// Route53 hosted zone for optional CNAME record creation.
	// Default: undefined.
	//
	HostedZone awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Mutual TLS configuration.
	// Default: undefined.
	//
	MutualTlsAuthentication *awsapigatewayv2.MTLSConfig `field:"optional" json:"mutualTlsAuthentication" yaml:"mutualTlsAuthentication"`
	// CNAME record TTL.
	// Default: Duration.seconds(300)
	//
	RecordTtl awscdk.Duration `field:"optional" json:"recordTtl" yaml:"recordTtl"`
	// TLS security policy.
	// Default: API Gateway default.
	//
	SecurityPolicy awsapigatewayv2.SecurityPolicy `field:"optional" json:"securityPolicy" yaml:"securityPolicy"`
	// Stage to map.
	//
	// Defaults to this construct's stage.
	// Default: this.stage
	//
	Stage awsapigatewayv2.IStage `field:"optional" json:"stage" yaml:"stage"`
}
