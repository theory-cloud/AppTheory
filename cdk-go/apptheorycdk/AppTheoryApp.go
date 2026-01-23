package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryApp interface {
	constructs.Construct
	Api() AppTheoryHttpApi
	DatabaseTable() awsdynamodb.ITable
	Domain() AppTheoryApiDomain
	Fn() AppTheoryFunction
	// The tree node.
	Node() constructs.Node
	RateLimitTable() awsdynamodb.ITable
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryApp
type jsiiProxy_AppTheoryApp struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryApp) Api() AppTheoryHttpApi {
	var returns AppTheoryHttpApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApp) DatabaseTable() awsdynamodb.ITable {
	var returns awsdynamodb.ITable
	_jsii_.Get(
		j,
		"databaseTable",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApp) Domain() AppTheoryApiDomain {
	var returns AppTheoryApiDomain
	_jsii_.Get(
		j,
		"domain",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApp) Fn() AppTheoryFunction {
	var returns AppTheoryFunction
	_jsii_.Get(
		j,
		"fn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApp) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApp) RateLimitTable() awsdynamodb.ITable {
	var returns awsdynamodb.ITable
	_jsii_.Get(
		j,
		"rateLimitTable",
		&returns,
	)
	return returns
}

func NewAppTheoryApp(scope constructs.Construct, id *string, props *AppTheoryAppProps) AppTheoryApp {
	_init_.Initialize()

	if err := validateNewAppTheoryAppParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryApp{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryApp",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryApp_Override(a AppTheoryApp, scope constructs.Construct, id *string, props *AppTheoryAppProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryApp",
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
func AppTheoryApp_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryApp_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryApp",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryApp) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
