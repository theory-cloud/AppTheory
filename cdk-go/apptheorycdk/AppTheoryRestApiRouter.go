package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A REST API v1 router that supports multi-Lambda routing with full streaming parity.
//
// This construct addresses the gaps in AppTheoryRestApi by allowing:
// - Multiple Lambda functions attached to different routes
// - Complete response streaming integration (responseTransferMode, URI suffix, timeout)
// - Stage controls (access logging, metrics, throttling, CORS)
// - Custom domain wiring with optional Route53 record.
//
// Example:
//
//	const router = new AppTheoryRestApiRouter(this, 'Router', {
//	  apiName: 'my-api',
//	  stage: { stageName: 'prod', accessLogging: true, detailedMetrics: true },
//	  cors: true,
//	});
//
//	router.addLambdaIntegration('/sse', ['GET'], sseFn, { streaming: true });
//	router.addLambdaIntegration('/api/graphql', ['POST'], graphqlFn);
//	router.addLambdaIntegration('/{proxy+}', ['ANY'], apiFn);
type AppTheoryRestApiRouter interface {
	constructs.Construct
	// The Route53 AAAA record (if domain, hostedZone, and createAAAARecord are configured).
	AaaaRecord() awsroute53.AaaaRecord
	// The access log group (if access logging is enabled).
	AccessLogGroup() awslogs.ILogGroup
	// The underlying API Gateway REST API.
	Api() awsapigateway.RestApi
	// The Route53 A record (if domain and hostedZone are configured).
	ARecord() awsroute53.ARecord
	// The base path mapping (if domain is configured).
	BasePathMapping() awsapigateway.BasePathMapping
	// The custom domain name (if configured).
	DomainName() awsapigateway.DomainName
	// The tree node.
	Node() constructs.Node
	// The deployment stage.
	Stage() awsapigateway.Stage
	// Add a Lambda integration for the specified path and HTTP methods.
	AddLambdaIntegration(path *string, methods *[]*string, handler awslambda.IFunction, options *AppTheoryRestApiRouterIntegrationOptions)
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryRestApiRouter
type jsiiProxy_AppTheoryRestApiRouter struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryRestApiRouter) AaaaRecord() awsroute53.AaaaRecord {
	var returns awsroute53.AaaaRecord
	_jsii_.Get(
		j,
		"aaaaRecord",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) AccessLogGroup() awslogs.ILogGroup {
	var returns awslogs.ILogGroup
	_jsii_.Get(
		j,
		"accessLogGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) Api() awsapigateway.RestApi {
	var returns awsapigateway.RestApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) ARecord() awsroute53.ARecord {
	var returns awsroute53.ARecord
	_jsii_.Get(
		j,
		"aRecord",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) BasePathMapping() awsapigateway.BasePathMapping {
	var returns awsapigateway.BasePathMapping
	_jsii_.Get(
		j,
		"basePathMapping",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) DomainName() awsapigateway.DomainName {
	var returns awsapigateway.DomainName
	_jsii_.Get(
		j,
		"domainName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApiRouter) Stage() awsapigateway.Stage {
	var returns awsapigateway.Stage
	_jsii_.Get(
		j,
		"stage",
		&returns,
	)
	return returns
}

func NewAppTheoryRestApiRouter(scope constructs.Construct, id *string, props *AppTheoryRestApiRouterProps) AppTheoryRestApiRouter {
	_init_.Initialize()

	if err := validateNewAppTheoryRestApiRouterParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryRestApiRouter{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryRestApiRouter_Override(a AppTheoryRestApiRouter, scope constructs.Construct, id *string, props *AppTheoryRestApiRouterProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter",
		[]interface{}{scope, id, props},
		a,
	)
}

// Checks if `x` is a construct.
//
// Use this method instead of `instanceof` to properly detect `Construct`
// instances, even when the construct library is symlinked.
//
// Explanation: in JavaScript, multiple copies of the `constructs` library on
// disk are seen as independent, completely different libraries. As a
// consequence, the class `Construct` in each copy of the `constructs` library
// is seen as a different class, and an instance of one class will not test as
// `instanceof` the other class. `npm install` will not create installations
// like this, but users may manually symlink construct libraries together or
// use a monorepo tool: in those cases, multiple copies of the `constructs`
// library can be accidentally installed, and `instanceof` will behave
// unpredictably. It is safest to avoid using `instanceof`, and using
// this type-testing method instead.
//
// Returns: true if `x` is an object created from a class which extends `Construct`.
func AppTheoryRestApiRouter_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryRestApiRouter_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApiRouter",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRestApiRouter) AddLambdaIntegration(path *string, methods *[]*string, handler awslambda.IFunction, options *AppTheoryRestApiRouterIntegrationOptions) {
	if err := a.validateAddLambdaIntegrationParameters(path, methods, handler, options); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"addLambdaIntegration",
		[]interface{}{path, methods, handler, options},
	)
}

func (a *jsiiProxy_AppTheoryRestApiRouter) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
