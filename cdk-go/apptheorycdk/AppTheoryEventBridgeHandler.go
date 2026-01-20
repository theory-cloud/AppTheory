package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryEventBridgeHandler interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
	Rule() awsevents.Rule
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryEventBridgeHandler
type jsiiProxy_AppTheoryEventBridgeHandler struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryEventBridgeHandler) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEventBridgeHandler) Rule() awsevents.Rule {
	var returns awsevents.Rule
	_jsii_.Get(
		j,
		"rule",
		&returns,
	)
	return returns
}


func NewAppTheoryEventBridgeHandler(scope constructs.Construct, id *string, props *AppTheoryEventBridgeHandlerProps) AppTheoryEventBridgeHandler {
	_init_.Initialize()

	if err := validateNewAppTheoryEventBridgeHandlerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryEventBridgeHandler{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryEventBridgeHandler_Override(a AppTheoryEventBridgeHandler, scope constructs.Construct, id *string, props *AppTheoryEventBridgeHandlerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler",
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
func AppTheoryEventBridgeHandler_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryEventBridgeHandler_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryEventBridgeHandler",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEventBridgeHandler) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

