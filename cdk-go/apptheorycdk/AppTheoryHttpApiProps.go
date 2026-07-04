package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryHttpApiProps struct {
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	ApiName *string             `field:"optional" json:"apiName" yaml:"apiName"`
	// CORS configuration.
	//
	// Set to true for AppTheory defaults.
	// Default: undefined.
	//
	Cors interface{} `field:"optional" json:"cors" yaml:"cors"`
	// Custom domain configuration.
	// Default: undefined.
	//
	Domain *AppTheoryHttpApiDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	// Stage configuration.
	// Default: undefined.
	//
	Stage *AppTheoryHttpApiStageOptions `field:"optional" json:"stage" yaml:"stage"`
	// Regional WAF attachment.
	//
	// Set to true for an AppTheory-managed WebACL.
	// Default: undefined.
	//
	Waf interface{} `field:"optional" json:"waf" yaml:"waf"`
}
