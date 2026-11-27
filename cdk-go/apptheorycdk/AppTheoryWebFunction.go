package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/internal"
)

// A Lambda Web Function: a function that serves HTTP through its own endpoint.
//
// One composition creates the function, its first revision, and the endpoint it answers on, with
// an endpoint that defaults to `IamAuth` so a function is never public by accident. How the
// application serves HTTP is decided by its runtime:
//
//   - **Node.js** (`nodejs24.x`, `nodejs26.x`) — the application starts its own HTTP server and reads
//     `AWS_LAMBDA_HTTP_ENDPOINT` for the address to listen on. `entryPoint` names the entry file.
//   - **Python** (`python3.15`, upstream public preview) — Lambda manages the HTTP server and passes
//     each request to an ASGI or WSGI application. `pythonApp` names the module, the callable and the
//     interface; the construct writes the entry point, and no environment variable decides it.
//
// There is no adapter and no second entry point either way: `runtime/` serves request/response
// Lambda events, and this construct composes the function that serves HTTP directly.
//
// Example:
//
//	// A Python ASGI application (`apptheory.ASGIApp` in main.py), on an IAM-authorized endpoint
//	const pythonApp = new AppTheoryWebFunction(stack, 'PythonWeb', {
//	  code: lambda.WebFunctionCode.fromAssetToManagedBucket('app'),
//	  runtime: lambda.WebFunctionRuntime.of('python3.15'),
//	  pythonApp: { module: 'main', interface: AppTheoryPythonInterface.ASGI },
//	});
type AppTheoryWebFunction interface {
	constructs.Construct
	// The domain name to send requests to.
	DomainName() *string
	// The endpoint requests reach, and the grants that authorize them.
	Endpoint() awslambda.WebFunctionEndpoint
	// The tree node.
	Node() constructs.Node
	// The ID of the revision this construct created.
	//
	// This is the revision the endpoint sends all of its traffic to. To shift traffic between
	// revisions, set `endpoint.resource.revisionWeights` on the underlying L1 resource: the
	// `WebFunctionTraffic` helper only expresses `single(revisionId)`, so a weighted split is the
	// documented L1 escape hatch.
	RevisionId() *string
	// The Web Function, its revision, and the endpoint it creates.
	WebFunction() awslambda.WebFunction
	// The ARN of the function.
	WebFunctionArn() *string
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

// The jsii proxy struct for AppTheoryWebFunction
type jsiiProxy_AppTheoryWebFunction struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryWebFunction) DomainName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"domainName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryWebFunction) Endpoint() awslambda.WebFunctionEndpoint {
	var returns awslambda.WebFunctionEndpoint
	_jsii_.Get(
		j,
		"endpoint",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryWebFunction) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryWebFunction) RevisionId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"revisionId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryWebFunction) WebFunction() awslambda.WebFunction {
	var returns awslambda.WebFunction
	_jsii_.Get(
		j,
		"webFunction",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryWebFunction) WebFunctionArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"webFunctionArn",
		&returns,
	)
	return returns
}

func NewAppTheoryWebFunction(scope constructs.Construct, id *string, props *AppTheoryWebFunctionProps) AppTheoryWebFunction {
	_init_.Initialize()

	if err := validateNewAppTheoryWebFunctionParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryWebFunction{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryWebFunction",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryWebFunction_Override(a AppTheoryWebFunction, scope constructs.Construct, id *string, props *AppTheoryWebFunctionProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryWebFunction",
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
func AppTheoryWebFunction_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryWebFunction_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryWebFunction",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryWebFunction) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryWebFunction) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
