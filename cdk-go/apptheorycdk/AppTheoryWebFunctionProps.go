package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

// Properties for an AppTheory Web Function.
//
// A Web Function is a Lambda function that serves HTTP directly: the application starts its own
// HTTP server and one execution environment answers many concurrent requests. That is a different
// execution model from the request/response runtime in `runtime/`, and this construct composes the
// deployment for it.
type AppTheoryWebFunctionProps struct {
	// The deployment package: a directory to asset, or a bucket object holding the application.
	Code awslambda.WebFunctionCode `field:"required" json:"code" yaml:"code"`
	// The managed runtime the revision runs.
	//
	// Only `nodejs24.x` and `nodejs26.x` are accepted; any other runtime is refused at synthesis.
	// Default: undefined - a runtime is required.
	//
	Runtime awslambda.WebFunctionRuntime `field:"required" json:"runtime" yaml:"runtime"`
	// The minimum log level of application logs.
	// Default: undefined - no application log level filtering.
	//
	ApplicationLogLevel awslambda.ApplicationLogLevel `field:"optional" json:"applicationLogLevel" yaml:"applicationLogLevel"`
	// Who authorizes requests to the endpoint.
	//
	// `IAM_AUTH` is the default: the endpoint is not public and Lambda authorizes every request
	// against IAM. `APPLICATION_MANAGED` makes the endpoint public and leaves authorization to the
	// application, and is therefore never a default.
	// Default: lambda.WebFunctionAuthType.IAM_AUTH
	//
	AuthType awslambda.WebFunctionAuthType `field:"optional" json:"authType" yaml:"authType"`
	// A description of the revision.
	// Default: undefined - no description.
	//
	Description *string `field:"optional" json:"description" yaml:"description"`
	// Settings of the endpoint the function serves requests on.
	// Default: undefined - a home-Region endpoint named `prod`.
	//
	Endpoint *AppTheoryWebFunctionEndpointProps `field:"optional" json:"endpoint" yaml:"endpoint"`
	// The entry file the runtime loads, relative to the root of the deployment package.
	//
	// Only supported for Node.js runtimes. When set, it is passed to the runtime through
	// `AWS_LAMBDA_NODEJS_ENTRYPOINT`; do not also set that variable in `environment`.
	// Default: undefined - the runtime's default entry point, `index.js`
	//
	EntryPoint *string `field:"optional" json:"entryPoint" yaml:"entryPoint"`
	// Environment variables for the revision.
	//
	// `AWS_LAMBDA_HTTP_ENDPOINT` is set by the Lambda service and must not be set here: the
	// application reads it to learn where to listen.
	// Default: undefined - no environment variables.
	//
	Environment *map[string]*string `field:"optional" json:"environment" yaml:"environment"`
	// The log group the function sends its logs to.
	// Default: undefined - a log group is created and retained when the stack is deleted.
	//
	LogGroup awslogs.ILogGroup `field:"optional" json:"logGroup" yaml:"logGroup"`
	// The maximum number of concurrent requests one execution environment answers.
	//
	// Must be an integer between 1 and 128.
	// Default: undefined - the service default of 64.
	//
	MaxConcurrencyPerEnvironment *float64 `field:"optional" json:"maxConcurrencyPerEnvironment" yaml:"maxConcurrencyPerEnvironment"`
	// The execution role.
	// Default: undefined - a new role with `AWSLambdaBasicExecutionRole` is created.
	//
	Role awsiam.IRole `field:"optional" json:"role" yaml:"role"`
	// The minimum log level of system logs.
	// Default: undefined - no system log level filtering.
	//
	SystemLogLevel awslambda.SystemLogLevel `field:"optional" json:"systemLogLevel" yaml:"systemLogLevel"`
	// The timeout of one request, in seconds.
	// Default: undefined - the service default of 30 seconds.
	//
	Timeout awscdk.Duration `field:"optional" json:"timeout" yaml:"timeout"`
}
