package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryRestApiProps struct {
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	ApiName *string `field:"optional" json:"apiName" yaml:"apiName"`
}

