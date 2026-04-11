package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// Adds path-scoped `/.well-known/oauth-protected-resource/...` metadata (RFC9728) to a REST API.
type AppTheoryMcpProtectedResource interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
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

// The jsii proxy struct for AppTheoryMcpProtectedResource
type jsiiProxy_AppTheoryMcpProtectedResource struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryMcpProtectedResource) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}


func NewAppTheoryMcpProtectedResource(scope constructs.Construct, id *string, props *AppTheoryMcpProtectedResourceProps) AppTheoryMcpProtectedResource {
	_init_.Initialize()

	if err := validateNewAppTheoryMcpProtectedResourceParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMcpProtectedResource{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMcpProtectedResource_Override(a AppTheoryMcpProtectedResource, scope constructs.Construct, id *string, props *AppTheoryMcpProtectedResourceProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource",
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
func AppTheoryMcpProtectedResource_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMcpProtectedResource_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMcpProtectedResource) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMcpProtectedResource) With(mixins ...constructs.IMixin) constructs.IConstruct {
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

