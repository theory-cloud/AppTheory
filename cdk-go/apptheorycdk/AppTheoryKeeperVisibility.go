package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsssm"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/internal"
)

// The reader role, compiled policy and manifest a consumer shares with Keeper.
//
// Create this construct only when the consumer passes a reader principal and
// rules; with no visibility block no role, policy or manifest is created.
type AppTheoryKeeperVisibility interface {
	constructs.Construct
	// The SSM parameter holding the manifest.
	ManifestParameter() awsssm.StringParameter
	// The tree node.
	Node() constructs.Node
	// The reader role Keeper assumes.
	ReaderRole() awsiam.Role
	// The synth-time preview, including the sources the rules do not match yet.
	Preview() *AppTheoryVisibilityPreview
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

// The jsii proxy struct for AppTheoryKeeperVisibility
type jsiiProxy_AppTheoryKeeperVisibility struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryKeeperVisibility) ManifestParameter() awsssm.StringParameter {
	var returns awsssm.StringParameter
	_jsii_.Get(
		j,
		"manifestParameter",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKeeperVisibility) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKeeperVisibility) ReaderRole() awsiam.Role {
	var returns awsiam.Role
	_jsii_.Get(
		j,
		"readerRole",
		&returns,
	)
	return returns
}

func NewAppTheoryKeeperVisibility(scope constructs.Construct, id *string, props *AppTheoryKeeperVisibilityProps) AppTheoryKeeperVisibility {
	_init_.Initialize()

	if err := validateNewAppTheoryKeeperVisibilityParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryKeeperVisibility{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryKeeperVisibility_Override(a AppTheoryKeeperVisibility, scope constructs.Construct, id *string, props *AppTheoryKeeperVisibilityProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility",
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
func AppTheoryKeeperVisibility_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryKeeperVisibility_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryKeeperVisibility",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKeeperVisibility) Preview() *AppTheoryVisibilityPreview {
	var returns *AppTheoryVisibilityPreview

	_jsii_.Invoke(
		a,
		"preview",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKeeperVisibility) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKeeperVisibility) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
