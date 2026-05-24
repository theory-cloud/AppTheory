package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheorySsrSiteBearerFunctionUrlOrigin struct {
	// Lambda function that AppTheory exposes as a bearer-auth Function URL co-origin.
	//
	// AppTheory creates the Function URL with `lambda.FunctionUrlAuthType.NONE`; authentication remains
	// the responsibility of the Lambda handler.
	Function awslambda.IFunction `field:"required" json:"function" yaml:"function"`
	// CloudFront path patterns that route to this co-origin.
	//
	// Patterns are normalized the same way as `ssrPathPatterns`. A pattern ending in `/*` also creates
	// a root behavior without the wildcard so `/api/*` covers both `/api` and `/api/...`.
	PathPatterns *[]*string `field:"required" json:"pathPatterns" yaml:"pathPatterns"`
	// Lambda Function URL invoke mode for this co-origin.
	// Default: lambda.InvokeMode.BUFFERED
	//
	InvokeMode awslambda.InvokeMode `field:"optional" json:"invokeMode" yaml:"invokeMode"`
}
