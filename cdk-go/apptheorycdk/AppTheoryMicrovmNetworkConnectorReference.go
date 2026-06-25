package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// AppTheory CDK reference to an existing or AWS-managed Lambda MicroVM network connector.
//
// This construct intentionally synthesizes no resources. It gives controller/image constructs a
// typed connector reference without requiring callers to pass raw strings through deployment code.
type AppTheoryMicrovmNetworkConnectorReference interface {
	constructs.Construct
	IAppTheoryMicrovmNetworkConnector
	// The network connector ARN.
	NetworkConnectorArn() *string
	// Optional connector direction/type.
	NetworkConnectorKind() AppTheoryMicrovmNetworkConnectorKind
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

// The jsii proxy struct for AppTheoryMicrovmNetworkConnectorReference
type jsiiProxy_AppTheoryMicrovmNetworkConnectorReference struct {
	internal.Type__constructsConstruct
	jsiiProxy_IAppTheoryMicrovmNetworkConnector
}

func (j *jsiiProxy_AppTheoryMicrovmNetworkConnectorReference) NetworkConnectorArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"networkConnectorArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmNetworkConnectorReference) NetworkConnectorKind() AppTheoryMicrovmNetworkConnectorKind {
	var returns AppTheoryMicrovmNetworkConnectorKind
	_jsii_.Get(
		j,
		"networkConnectorKind",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmNetworkConnectorReference) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func NewAppTheoryMicrovmNetworkConnectorReference(scope constructs.Construct, id *string, props *AppTheoryMicrovmNetworkConnectorReferenceProps) AppTheoryMicrovmNetworkConnectorReference {
	_init_.Initialize()

	if err := validateNewAppTheoryMicrovmNetworkConnectorReferenceParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMicrovmNetworkConnectorReference{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMicrovmNetworkConnectorReference_Override(a AppTheoryMicrovmNetworkConnectorReference, scope constructs.Construct, id *string, props *AppTheoryMicrovmNetworkConnectorReferenceProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		[]interface{}{scope, id, props},
		a,
	)
}

// Reference an AWS-managed Lambda MicroVM connector by name.
func AppTheoryMicrovmNetworkConnectorReference_AwsManaged(scope constructs.Construct, id *string, connector AppTheoryMicrovmManagedNetworkConnector) IAppTheoryMicrovmNetworkConnector {
	_init_.Initialize()

	if err := validateAppTheoryMicrovmNetworkConnectorReference_AwsManagedParameters(scope, id, connector); err != nil {
		panic(err)
	}
	var returns IAppTheoryMicrovmNetworkConnector

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		"awsManaged",
		[]interface{}{scope, id, connector},
		&returns,
	)

	return returns
}

// Import an existing Lambda MicroVM network connector ARN into the AppTheory CDK surface.
func AppTheoryMicrovmNetworkConnectorReference_FromNetworkConnectorArn(scope constructs.Construct, id *string, networkConnectorArn *string, networkConnectorKind AppTheoryMicrovmNetworkConnectorKind) IAppTheoryMicrovmNetworkConnector {
	_init_.Initialize()

	if err := validateAppTheoryMicrovmNetworkConnectorReference_FromNetworkConnectorArnParameters(scope, id, networkConnectorArn); err != nil {
		panic(err)
	}
	var returns IAppTheoryMicrovmNetworkConnector

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		"fromNetworkConnectorArn",
		[]interface{}{scope, id, networkConnectorArn, networkConnectorKind},
		&returns,
	)

	return returns
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
func AppTheoryMicrovmNetworkConnectorReference_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMicrovmNetworkConnectorReference_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmNetworkConnectorReference) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmNetworkConnectorReference) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
