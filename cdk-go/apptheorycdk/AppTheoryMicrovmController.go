package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2authorizers"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// AppTheory CDK construct for the first-class Lambda MicroVM controller deployment surface.
//
// The construct provisions the protected HTTP API routes from the M16 real controller contract,
// the controller Lambda, the canonical durable session registry table, IAM grants, and
// fail-closed auth environment wiring. Runtime command handling remains in the AppTheory
// runtime contract; this construct only wires the deployment path.
type AppTheoryMicrovmController interface {
	constructs.Construct
	// The access log group (if access logging is enabled).
	AccessLogGroup() awslogs.ILogGroup
	// The underlying HTTP API Gateway v2 API.
	Api() awsapigatewayv2.HttpApi
	// The controller Lambda function created by this construct.
	ControllerFunction() awslambda.Function
	// The controller base endpoint (`/microvms`).
	Endpoint() *string
	// The tree node.
	Node() constructs.Node
	// Lambda request authorizer attached to every controller route.
	RouteAuthorizer() awsapigatewayv2authorizers.HttpLambdaAuthorizer
	// The durable TableTheory-shaped session registry DynamoDB table.
	SessionTable() awsdynamodb.Table
	// The API Gateway stage.
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

// The jsii proxy struct for AppTheoryMicrovmController
type jsiiProxy_AppTheoryMicrovmController struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryMicrovmController) AccessLogGroup() awslogs.ILogGroup {
	var returns awslogs.ILogGroup
	_jsii_.Get(
		j,
		"accessLogGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) Api() awsapigatewayv2.HttpApi {
	var returns awsapigatewayv2.HttpApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) ControllerFunction() awslambda.Function {
	var returns awslambda.Function
	_jsii_.Get(
		j,
		"controllerFunction",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) Endpoint() *string {
	var returns *string
	_jsii_.Get(
		j,
		"endpoint",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) RouteAuthorizer() awsapigatewayv2authorizers.HttpLambdaAuthorizer {
	var returns awsapigatewayv2authorizers.HttpLambdaAuthorizer
	_jsii_.Get(
		j,
		"routeAuthorizer",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) SessionTable() awsdynamodb.Table {
	var returns awsdynamodb.Table
	_jsii_.Get(
		j,
		"sessionTable",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmController) Stage() awsapigatewayv2.IStage {
	var returns awsapigatewayv2.IStage
	_jsii_.Get(
		j,
		"stage",
		&returns,
	)
	return returns
}

func NewAppTheoryMicrovmController(scope constructs.Construct, id *string, props *AppTheoryMicrovmControllerProps) AppTheoryMicrovmController {
	_init_.Initialize()

	if err := validateNewAppTheoryMicrovmControllerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMicrovmController{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmController",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMicrovmController_Override(a AppTheoryMicrovmController, scope constructs.Construct, id *string, props *AppTheoryMicrovmControllerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmController",
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
func AppTheoryMicrovmController_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMicrovmController_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmController",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmController) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmController) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
