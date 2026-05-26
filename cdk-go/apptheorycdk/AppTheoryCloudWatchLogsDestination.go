package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// CloudWatch Logs destination that delivers subscription records to Kinesis.
//
// The construct owns the destination, the CloudWatch Logs service role, and a fail-closed
// destination policy. Subscription filter writers must be explicitly allowed by source account
// and/or AWS Organization ID; no unconstrained wildcard principal is synthesized.
type AppTheoryCloudWatchLogsDestination interface {
	constructs.Construct
	// The CloudWatch Logs destination resource.
	Destination() awslogs.CfnDestination
	// The destination ARN.
	DestinationArn() *string
	// The destination name.
	DestinationName() *string
	// The tree node.
	Node() constructs.Node
	// IAM role assumed by CloudWatch Logs to write records to the target stream.
	ServiceRole() awsiam.Role
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

// The jsii proxy struct for AppTheoryCloudWatchLogsDestination
type jsiiProxy_AppTheoryCloudWatchLogsDestination struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryCloudWatchLogsDestination) Destination() awslogs.CfnDestination {
	var returns awslogs.CfnDestination
	_jsii_.Get(
		j,
		"destination",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCloudWatchLogsDestination) DestinationArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"destinationArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCloudWatchLogsDestination) DestinationName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"destinationName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCloudWatchLogsDestination) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCloudWatchLogsDestination) ServiceRole() awsiam.Role {
	var returns awsiam.Role
	_jsii_.Get(
		j,
		"serviceRole",
		&returns,
	)
	return returns
}

func NewAppTheoryCloudWatchLogsDestination(scope constructs.Construct, id *string, props *AppTheoryCloudWatchLogsDestinationProps) AppTheoryCloudWatchLogsDestination {
	_init_.Initialize()

	if err := validateNewAppTheoryCloudWatchLogsDestinationParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryCloudWatchLogsDestination{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestination",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryCloudWatchLogsDestination_Override(a AppTheoryCloudWatchLogsDestination, scope constructs.Construct, id *string, props *AppTheoryCloudWatchLogsDestinationProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestination",
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
func AppTheoryCloudWatchLogsDestination_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryCloudWatchLogsDestination_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestination",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryCloudWatchLogsDestination) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryCloudWatchLogsDestination) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
