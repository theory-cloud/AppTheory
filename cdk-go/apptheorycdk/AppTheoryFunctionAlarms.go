package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudwatch"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryFunctionAlarms interface {
	constructs.Construct
	Errors() awscloudwatch.Alarm
	// The tree node.
	Node() constructs.Node
	Throttles() awscloudwatch.Alarm
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

// The jsii proxy struct for AppTheoryFunctionAlarms
type jsiiProxy_AppTheoryFunctionAlarms struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryFunctionAlarms) Errors() awscloudwatch.Alarm {
	var returns awscloudwatch.Alarm
	_jsii_.Get(
		j,
		"errors",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryFunctionAlarms) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryFunctionAlarms) Throttles() awscloudwatch.Alarm {
	var returns awscloudwatch.Alarm
	_jsii_.Get(
		j,
		"throttles",
		&returns,
	)
	return returns
}

func NewAppTheoryFunctionAlarms(scope constructs.Construct, id *string, props *AppTheoryFunctionAlarmsProps) AppTheoryFunctionAlarms {
	_init_.Initialize()

	if err := validateNewAppTheoryFunctionAlarmsParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryFunctionAlarms{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryFunctionAlarms_Override(a AppTheoryFunctionAlarms, scope constructs.Construct, id *string, props *AppTheoryFunctionAlarmsProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms",
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
func AppTheoryFunctionAlarms_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryFunctionAlarms_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryFunctionAlarms",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryFunctionAlarms) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryFunctionAlarms) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
