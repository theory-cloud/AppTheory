package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// AppTheory CDK construct for AWS Lambda MicroVM images.
//
// This construct is intentionally deployment-only: it creates the CloudFormation
// `AWS::Lambda::MicrovmImage` resource from caller-provided code artifact, base image,
// build role, lifecycle hooks, logging configuration, resource requirements, and
// AppTheory MicroVM network-connector references. Runtime controller behavior stays in
// the AppTheory runtime contract.
type AppTheoryMicrovmImage interface {
	constructs.Construct
	// The timestamp when the image was created.
	CreatedAt() *string
	// The latest active image version.
	LatestActiveImageVersion() *string
	// The latest failed image version, if any.
	LatestFailedImageVersion() *string
	// The underlying CloudFormation MicroVM image resource.
	MicrovmImage() awscdk.CfnResource
	// The ARN of the MicroVM image.
	MicrovmImageArn() *string
	// The MicroVM image name returned by Ref.
	MicrovmImageName() *string
	// The current image state.
	MicrovmImageState() *string
	// The tree node.
	Node() constructs.Node
	// The timestamp when the image was last updated.
	UpdatedAt() *string
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

// The jsii proxy struct for AppTheoryMicrovmImage
type jsiiProxy_AppTheoryMicrovmImage struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryMicrovmImage) CreatedAt() *string {
	var returns *string
	_jsii_.Get(
		j,
		"createdAt",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) LatestActiveImageVersion() *string {
	var returns *string
	_jsii_.Get(
		j,
		"latestActiveImageVersion",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) LatestFailedImageVersion() *string {
	var returns *string
	_jsii_.Get(
		j,
		"latestFailedImageVersion",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) MicrovmImage() awscdk.CfnResource {
	var returns awscdk.CfnResource
	_jsii_.Get(
		j,
		"microvmImage",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) MicrovmImageArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"microvmImageArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) MicrovmImageName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"microvmImageName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) MicrovmImageState() *string {
	var returns *string
	_jsii_.Get(
		j,
		"microvmImageState",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMicrovmImage) UpdatedAt() *string {
	var returns *string
	_jsii_.Get(
		j,
		"updatedAt",
		&returns,
	)
	return returns
}

func NewAppTheoryMicrovmImage(scope constructs.Construct, id *string, props *AppTheoryMicrovmImageProps) AppTheoryMicrovmImage {
	_init_.Initialize()

	if err := validateNewAppTheoryMicrovmImageParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMicrovmImage{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMicrovmImage_Override(a AppTheoryMicrovmImage, scope constructs.Construct, id *string, props *AppTheoryMicrovmImageProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage",
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
func AppTheoryMicrovmImage_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMicrovmImage_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMicrovmImage",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmImage) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMicrovmImage) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
