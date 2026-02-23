package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A composable SQS consumer construct that wires a Lambda function to an SQS queue.
//
// This construct creates an event source mapping between an SQS queue and a Lambda function,
// with full control over batching, concurrency, and failure reporting.
//
// Example:
//   // Consumer with full configuration
//   new AppTheoryQueueConsumer(stack, 'Consumer', {
//     queue: myQueue.queue,
//     consumer: myFunction,
//     batchSize: 100,
//     maxBatchingWindow: Duration.seconds(10),
//     reportBatchItemFailures: true,
//     maxConcurrency: 50,
//   });
//
type AppTheoryQueueConsumer interface {
	constructs.Construct
	// The consumer Lambda function.
	Consumer() awslambda.IFunction
	// The event source mapping.
	EventSourceMapping() awslambda.EventSourceMapping
	// The tree node.
	Node() constructs.Node
	// The SQS queue being consumed.
	Queue() awssqs.IQueue
	// Disable the event source mapping.
	//
	// This can be used for circuit breaker patterns.
	Disable()
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryQueueConsumer
type jsiiProxy_AppTheoryQueueConsumer struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryQueueConsumer) Consumer() awslambda.IFunction {
	var returns awslambda.IFunction
	_jsii_.Get(
		j,
		"consumer",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueConsumer) EventSourceMapping() awslambda.EventSourceMapping {
	var returns awslambda.EventSourceMapping
	_jsii_.Get(
		j,
		"eventSourceMapping",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueConsumer) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueConsumer) Queue() awssqs.IQueue {
	var returns awssqs.IQueue
	_jsii_.Get(
		j,
		"queue",
		&returns,
	)
	return returns
}


func NewAppTheoryQueueConsumer(scope constructs.Construct, id *string, props *AppTheoryQueueConsumerProps) AppTheoryQueueConsumer {
	_init_.Initialize()

	if err := validateNewAppTheoryQueueConsumerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryQueueConsumer{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueConsumer",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryQueueConsumer_Override(a AppTheoryQueueConsumer, scope constructs.Construct, id *string, props *AppTheoryQueueConsumerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueConsumer",
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
func AppTheoryQueueConsumer_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryQueueConsumer_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueConsumer",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryQueueConsumer) Disable() {
	_jsii_.InvokeVoid(
		a,
		"disable",
		nil, // no parameters
	)
}

func (a *jsiiProxy_AppTheoryQueueConsumer) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

