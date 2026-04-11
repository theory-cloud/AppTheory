package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A composable SQS queue construct with optional DLQ support.
//
// This construct creates an SQS queue with optional Dead Letter Queue (DLQ) configuration.
// It can be used standalone (for manual message production/consumption) or composed
// with AppTheoryQueueConsumer for Lambda integration.
//
// Example:
//   // Queue with custom DLQ configuration
//   const queue = new AppTheoryQueue(stack, 'Queue', {
//     queueName: 'my-queue',
//     maxReceiveCount: 5,
//     dlqRetentionPeriod: Duration.days(14),
//   });
//
type AppTheoryQueue interface {
	constructs.Construct
	// The Dead Letter Queue, if enabled.
	DeadLetterQueue() awssqs.Queue
	// The tree node.
	Node() constructs.Node
	// The main SQS queue.
	Queue() awssqs.Queue
	// The ARN of the main queue.
	QueueArn() *string
	// The name of the main queue.
	QueueName() *string
	// The URL of the main queue.
	QueueUrl() *string
	// Grant consume messages permission to a Lambda function.
	GrantConsumeMessages(grantee awslambda.IFunction)
	// Grant purge messages permission to a Lambda function.
	GrantPurge(grantee awslambda.IFunction)
	// Grant send messages permission to a Lambda function.
	GrantSendMessages(grantee awslambda.IFunction)
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

// The jsii proxy struct for AppTheoryQueue
type jsiiProxy_AppTheoryQueue struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryQueue) DeadLetterQueue() awssqs.Queue {
	var returns awssqs.Queue
	_jsii_.Get(
		j,
		"deadLetterQueue",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueue) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueue) Queue() awssqs.Queue {
	var returns awssqs.Queue
	_jsii_.Get(
		j,
		"queue",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueue) QueueArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"queueArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueue) QueueName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"queueName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueue) QueueUrl() *string {
	var returns *string
	_jsii_.Get(
		j,
		"queueUrl",
		&returns,
	)
	return returns
}


func NewAppTheoryQueue(scope constructs.Construct, id *string, props *AppTheoryQueueProps) AppTheoryQueue {
	_init_.Initialize()

	if err := validateNewAppTheoryQueueParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryQueue{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueue",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryQueue_Override(a AppTheoryQueue, scope constructs.Construct, id *string, props *AppTheoryQueueProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueue",
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
func AppTheoryQueue_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryQueue_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryQueue",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryQueue) GrantConsumeMessages(grantee awslambda.IFunction) {
	if err := a.validateGrantConsumeMessagesParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantConsumeMessages",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryQueue) GrantPurge(grantee awslambda.IFunction) {
	if err := a.validateGrantPurgeParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantPurge",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryQueue) GrantSendMessages(grantee awslambda.IFunction) {
	if err := a.validateGrantSendMessagesParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantSendMessages",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryQueue) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryQueue) With(mixins ...constructs.IMixin) constructs.IConstruct {
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

