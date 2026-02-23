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
	RecordTtl               awscdk.Duration                    `field:"optional" json:"recordTtl" yaml:"recordTtl"`
	SecurityPolicy          awsapigatewayv2.SecurityPolicy     `field:"optional" json:"securityPolicy" yaml:"securityPolicy"`
	Stage                   awsapigatewayv2.IStage             `field:"optional" json:"stage" yaml:"stage"`
}
