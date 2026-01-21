package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/constructs-go/constructs/v10"

	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryRestApi interface {
	constructs.Construct
	Api() awsapigateway.RestApi
	// The tree node.
	Node() constructs.Node
	AddRoute(path *string, methods *[]*string, options *AppTheoryRestApiRouteOptions)
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryRestApi
type jsiiProxy_AppTheoryRestApi struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryRestApi) Api() awsapigateway.RestApi {
	var returns awsapigateway.RestApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestApi) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func NewAppTheoryRestApi(scope constructs.Construct, id *string, props *AppTheoryRestApiProps) AppTheoryRestApi {
	_init_.Initialize()

	if err := validateNewAppTheoryRestApiParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryRestApi{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApi",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryRestApi_Override(a AppTheoryRestApi, scope constructs.Construct, id *string, props *AppTheoryRestApiProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApi",
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
func AppTheoryRestApi_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryRestApi_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryRestApi",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRestApi) AddRoute(path *string, methods *[]*string, options *AppTheoryRestApiRouteOptions) {
	if err := a.validateAddRouteParameters(path, options); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"addRoute",
		[]interface{}{path, methods, options},
	)
}

func (a *jsiiProxy_AppTheoryRestApi) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
