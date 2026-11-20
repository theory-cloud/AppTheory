package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

type AppTheoryApiDomainProps struct {
	Certificate             awscertificatemanager.ICertificate `field:"required" json:"certificate" yaml:"certificate"`
	DomainName              *string                            `field:"required" json:"domainName" yaml:"domainName"`
	HttpApi                 awsapigatewayv2.IHttpApi           `field:"required" json:"httpApi" yaml:"httpApi"`
	ApiMappingKey           *string                            `field:"optional" json:"apiMappingKey" yaml:"apiMappingKey"`
	CreateCname             *bool                              `field:"optional" json:"createCname" yaml:"createCname"`
	HostedZone              awsroute53.IHostedZone             `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	MutualTlsAuthentication *awsapigatewayv2.MTLSConfig        `field:"optional" json:"mutualTlsAuthentication" yaml:"mutualTlsAuthentication"`
	// Optional naming context that selects the Security Hub-aligned defaults.
	// Default: undefined.
	//
	NamingContext AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
	RecordTtl     awscdk.Duration        `field:"optional" json:"recordTtl" yaml:"recordTtl"`
	// TLS security policy for the custom domain.
	//
	// With a derived naming context the default is TLS 1.2, the strongest policy
	// API Gateway v2 offers. Security Hub APIGateway.11 always fails a custom
	// domain attached to an HTTP API, so no policy can satisfy it.
	// Default: TLS 1.2 under a derived naming context, otherwise the API Gateway default
	//
	SecurityPolicy awsapigatewayv2.SecurityPolicy `field:"optional" json:"securityPolicy" yaml:"securityPolicy"`
	Stage          awsapigatewayv2.IStage         `field:"optional" json:"stage" yaml:"stage"`
}
