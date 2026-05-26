package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskinesis"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// AppTheory Kinesis Data Stream construct.
//
// Creates or wraps a single Kinesis Data Stream and exposes the stable stream
// identity plus AppTheory grant helpers. Event source mappings and CloudWatch
// Logs destinations are intentionally separate constructs.
type AppTheoryKinesisStream interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
	// The Kinesis stream, created or imported.
	Stream() awskinesis.IStream
	// The ARN of the stream.
	StreamArn() *string
	// The name of the stream.
	StreamName() *string
	// Grant read permissions for this stream and its contents.
	GrantRead(grantee awsiam.IGrantable) awsiam.Grant
	// Grant read/write permissions for this stream and its contents.
	GrantReadWrite(grantee awsiam.IGrantable) awsiam.Grant
	// Grant write permissions for this stream and its contents.
	GrantWrite(grantee awsiam.IGrantable) awsiam.Grant
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

// The jsii proxy struct for AppTheoryKinesisStream
type jsiiProxy_AppTheoryKinesisStream struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryKinesisStream) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKinesisStream) Stream() awskinesis.IStream {
	var returns awskinesis.IStream
	_jsii_.Get(
		j,
		"stream",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKinesisStream) StreamArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"streamArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryKinesisStream) StreamName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"streamName",
		&returns,
	)
	return returns
}

func NewAppTheoryKinesisStream(scope constructs.Construct, id *string, props *AppTheoryKinesisStreamProps) AppTheoryKinesisStream {
	_init_.Initialize()

	if err := validateNewAppTheoryKinesisStreamParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryKinesisStream{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStream",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryKinesisStream_Override(a AppTheoryKinesisStream, scope constructs.Construct, id *string, props *AppTheoryKinesisStreamProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStream",
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
func AppTheoryKinesisStream_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryKinesisStream_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryKinesisStream",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKinesisStream) GrantRead(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantReadParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantRead",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKinesisStream) GrantReadWrite(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantReadWriteParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantReadWrite",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKinesisStream) GrantWrite(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantWriteParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantWrite",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKinesisStream) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryKinesisStream) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
