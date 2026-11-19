package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/internal"
)

// An S3 bucket whose physical name comes from the resource-naming contract.
//
// With a derived profile the bucket uses the account-regional namespace and the
// contract's prefix. With a legacy profile a pin supplies the full name
// verbatim, and a generated entry sets no name at all so CloudFormation keeps
// today's name and global namespace. The pinned aws-cdk-lib L2
// (`aws-cdk-lib` 2.277.0) exposes `bucketNamespace` and `bucketNamePrefix`, so
// no L1 property override is needed; CloudFormation appends
// `-{account}-{region}-an` to the prefix.
type AppTheoryBucket interface {
	constructs.Construct
	// The bucket.
	Bucket() awss3.Bucket
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

// The jsii proxy struct for AppTheoryBucket
type jsiiProxy_AppTheoryBucket struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryBucket) Bucket() awss3.Bucket {
	var returns awss3.Bucket
	_jsii_.Get(
		j,
		"bucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryBucket) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func NewAppTheoryBucket(scope constructs.Construct, id *string, props *AppTheoryBucketProps) AppTheoryBucket {
	_init_.Initialize()

	if err := validateNewAppTheoryBucketParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryBucket{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryBucket",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryBucket_Override(a AppTheoryBucket, scope constructs.Construct, id *string, props *AppTheoryBucketProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryBucket",
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
func AppTheoryBucket_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryBucket_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryBucket",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryBucket) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryBucket) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
