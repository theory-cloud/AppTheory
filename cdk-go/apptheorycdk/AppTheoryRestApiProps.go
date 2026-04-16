package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryRestApiProps struct {
	Handler awslambda.IFunction `field:"required" json:"handler" yaml:"handler"`
	// Whether API Gateway console test invocations should be granted Lambda invoke permissions.
	//
	// When false, the construct suppresses the extra `test-invoke-stage` Lambda permissions
	// that CDK adds for each REST API method. This reduces Lambda resource policy size while
	// preserving deployed-stage invoke permissions.
	// Default: true.
	//
	AllowTestInvoke *bool   `field:"optional" json:"allowTestInvoke" yaml:"allowTestInvoke"`
	ApiName         *string `field:"optional" json:"apiName" yaml:"apiName"`
	// Whether Lambda invoke permissions should be scoped to individual REST API methods.
	//
	// When false, the construct grants one API-scoped invoke permission per Lambda instead of
	// one permission per method/path pair. This is the scalable choice for large front-controller
	// APIs that route many REST paths to the same Lambda.
	// Default: true.
	//
	ScopePermissionToMethod *bool `field:"optional" json:"scopePermissionToMethod" yaml:"scopePermissionToMethod"`
}
