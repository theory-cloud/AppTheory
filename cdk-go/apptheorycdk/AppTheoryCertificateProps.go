package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

type AppTheoryCertificateProps struct {
	DomainName                 *string                `field:"required" json:"domainName" yaml:"domainName"`
	HostedZone                 awsroute53.IHostedZone `field:"required" json:"hostedZone" yaml:"hostedZone"`
	CertificateName            *string                `field:"optional" json:"certificateName" yaml:"certificateName"`
	SubjectAlternativeNames    *[]*string             `field:"optional" json:"subjectAlternativeNames" yaml:"subjectAlternativeNames"`
	TransparencyLoggingEnabled *bool                  `field:"optional" json:"transparencyLoggingEnabled" yaml:"transparencyLoggingEnabled"`
	ValidationZone             awsroute53.IHostedZone `field:"optional" json:"validationZone" yaml:"validationZone"`
}
