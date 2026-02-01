package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awssqs"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A combined queue + consumer construct for SQS processing workflows.
//
// This is a convenience construct that combines AppTheoryQueue and AppTheoryQueueConsumer
// into a single, easy-to-use pattern. For more control, use the individual constructs.
//
// Example:
//
//	// Processor with full options
//	new AppTheoryQueueProcessor(stack, 'Processor', {
//	  consumer: myFunction,
//	  queueName: 'my-queue',
//	  enableDlq: true,
//	  batchSize: 100,
//	  maxBatchingWindow: Duration.seconds(10),
//	  reportBatchItemFailures: true,
//	  maxConcurrency: 50,
//	});
type AppTheoryQueueProcessor interface {
	constructs.Construct
	// The underlying AppTheoryQueueConsumer construct.
	ConsumerConstruct() AppTheoryQueueConsumer
	// The Dead Letter Queue, if enabled.
	DeadLetterQueue() awssqs.Queue
	// The tree node.
	Node() constructs.Node
	// The main SQS queue.
	Queue() awssqs.IQueue
	// The underlying AppTheoryQueue construct.
	QueueConstruct() AppTheoryQueue
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryQueueProcessor
type jsiiProxy_AppTheoryQueueProcessor struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryQueueProcessor) ConsumerConstruct() AppTheoryQueueConsumer {
	var returns AppTheoryQueueConsumer
	_jsii_.Get(
		j,
		"consumerConstruct",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueProcessor) DeadLetterQueue() awssqs.Queue {
	var returns awssqs.Queue
	_jsii_.Get(
		j,
		"deadLetterQueue",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueProcessor) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueProcessor) Queue() awssqs.IQueue {
	var returns awssqs.IQueue
	_jsii_.Get(
		j,
		"queue",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryQueueProcessor) QueueConstruct() AppTheoryQueue {
	var returns AppTheoryQueue
	_jsii_.Get(
		j,
		"queueConstruct",
		&returns,
	)
	return returns
}

func NewAppTheoryQueueProcessor(scope constructs.Construct, id *string, props *AppTheoryQueueProcessorProps) AppTheoryQueueProcessor {
	_init_.Initialize()

	if err := validateNewAppTheoryQueueProcessorParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryQueueProcessor{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessor",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryQueueProcessor_Override(a AppTheoryQueueProcessor, scope constructs.Construct, id *string, props *AppTheoryQueueProcessorProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessor",
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
func AppTheoryQueueProcessor_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryQueueProcessor_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryQueueProcessor",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryQueueProcessor) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
