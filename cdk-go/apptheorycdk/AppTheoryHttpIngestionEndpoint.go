package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2authorizers"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// Authenticated HTTPS ingestion endpoint backed by Lambda.
//
// This construct is intended for server-to-server submission paths where callers
// authenticate with a shared secret key via a Lambda request authorizer.
type AppTheoryHttpIngestionEndpoint interface {
	constructs.Construct
	AccessLogGroup() awslogs.ILogGroup
	Api() awsapigatewayv2.HttpApi
	ApiMapping() awsapigatewayv2.ApiMapping
	CnameRecord() awsroute53.CnameRecord
	DomainName() awsapigatewayv2.DomainName
	Endpoint() *string
	// The tree node.
	Node() constructs.Node
	RouteAuthorizer() awsapigatewayv2authorizers.HttpLambdaAuthorizer
	Stage() awsapigatewayv2.IStage
	// Returns a string representation of this construct.
	ToString() *string
	// Applies one or more mixins to this construct.
	//
	// Mixins are applied in order. The list of constructs is captured at the
	// start of the call, so constructs added by a mixin will not be visited.
	// Use multiple `with()` calls if subsequent mixins should apply to added
	// constructs.
	//
	// Returns: This construct for chaining.
	With(mixins ...constructs.IMixin) constructs.IConstruct
}

// The jsii proxy struct for AppTheoryHttpIngestionEndpoint
type jsiiProxy_AppTheoryHttpIngestionEndpoint struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) AccessLogGroup() awslogs.ILogGroup {
	var returns awslogs.ILogGroup
	_jsii_.Get(
		j,
		"accessLogGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) Api() awsapigatewayv2.HttpApi {
	var returns awsapigatewayv2.HttpApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) ApiMapping() awsapigatewayv2.ApiMapping {
	var returns awsapigatewayv2.ApiMapping
	_jsii_.Get(
		j,
		"apiMapping",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) CnameRecord() awsroute53.CnameRecord {
	var returns awsroute53.CnameRecord
	_jsii_.Get(
		j,
		"cnameRecord",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) DomainName() awsapigatewayv2.DomainName {
	var returns awsapigatewayv2.DomainName
	_jsii_.Get(
		j,
		"domainName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) Endpoint() *string {
	var returns *string
	_jsii_.Get(
		j,
		"endpoint",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) RouteAuthorizer() awsapigatewayv2authorizers.HttpLambdaAuthorizer {
	var returns awsapigatewayv2authorizers.HttpLambdaAuthorizer
	_jsii_.Get(
		j,
		"routeAuthorizer",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHttpIngestionEndpoint) Stage() awsapigatewayv2.IStage {
	var returns awsapigatewayv2.IStage
	_jsii_.Get(
		j,
		"stage",
		&returns,
	)
	return returns
}

func NewAppTheoryHttpIngestionEndpoint(scope constructs.Construct, id *string, props *AppTheoryHttpIngestionEndpointProps) AppTheoryHttpIngestionEndpoint {
	_init_.Initialize()

	if err := validateNewAppTheoryHttpIngestionEndpointParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryHttpIngestionEndpoint{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryHttpIngestionEndpoint_Override(a AppTheoryHttpIngestionEndpoint, scope constructs.Construct, id *string, props *AppTheoryHttpIngestionEndpointProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint",
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
func AppTheoryHttpIngestionEndpoint_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryHttpIngestionEndpoint_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHttpIngestionEndpoint) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHttpIngestionEndpoint) With(mixins ...constructs.IMixin) constructs.IConstruct {
	args := []interface{}{}
	for _, a := range mixins {
		args = append(args, a)
	}

	var returns constructs.IConstruct

	_jsii_.Invoke(
		a,
		"with",
		args,
		&returns,
	)

	return returns
}
