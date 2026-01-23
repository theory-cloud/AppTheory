package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsssm"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryKmsKey interface {
	constructs.Construct
	Alias() awskms.Alias
	Key() awskms.IKey
	KeyArn() *string
	KeyId() *string
	// The tree node.
	Node() constructs.Node
	SsmParameter() awsssm.StringParameter
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryKmsKey
type jsiiProxy_AppTheoryKmsKey struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryKmsKey) Alias() awskms.Alias {
	var returns awskms.Alias
	_jsii_.Get(
		j,
		"alias",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKmsKey) Key() awskms.IKey {
	var returns awskms.IKey
	_jsii_.Get(
		j,
		"key",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKmsKey) KeyArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"keyArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKmsKey) KeyId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"keyId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKmsKey) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKmsKey) SsmParameter() awsssm.StringParameter {
	var returns awsssm.StringParameter
	_jsii_.Get(
		j,
		"ssmParameter",
		&returns,
	)
	return returns
}

func NewAppTheoryKmsKey(scope constructs.Construct, id *string, props *AppTheoryKmsKeyProps) AppTheoryKmsKey {
	_init_.Initialize()

	if err := validateNewAppTheoryKmsKeyParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryKmsKey{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKmsKey",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryKmsKey_Override(a AppTheoryKmsKey, scope constructs.Construct, id *string, props *AppTheoryKmsKeyProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKmsKey",
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
func AppTheoryKmsKey_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryKmsKey_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryKmsKey",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKmsKey) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
