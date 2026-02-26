package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A Claude-first Remote MCP server construct that provisions: - API Gateway REST API v1 - Streaming-enabled Lambda proxy integrations for `/mcp` (POST/GET) using   Lambda response streaming (`/response-streaming-invocations`) - Optional DynamoDB tables for sessions and stream/event log state.
//
// This construct is designed for MCP Streamable HTTP (2025-06-18).
type AppTheoryRemoteMcpServer interface {
	constructs.Construct
	// The MCP endpoint URL (`.../mcp`).
	Endpoint() *string
	// The tree node.
	Node() constructs.Node
	// The underlying REST API router.
	Router() AppTheoryRestApiRouter
	// The DynamoDB session table (if enabled).
	SessionTable() awsdynamodb.ITable
	// The DynamoDB stream/event log table (if enabled).
	StreamTable() awsdynamodb.ITable
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

// The jsii proxy struct for AppTheoryRemoteMcpServer
type jsiiProxy_AppTheoryRemoteMcpServer struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryRemoteMcpServer) Endpoint() *string {
	var returns *string
	_jsii_.Get(
		j,
		"endpoint",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRemoteMcpServer) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRemoteMcpServer) Router() AppTheoryRestApiRouter {
	var returns AppTheoryRestApiRouter
	_jsii_.Get(
		j,
		"router",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRemoteMcpServer) SessionTable() awsdynamodb.ITable {
	var returns awsdynamodb.ITable
	_jsii_.Get(
		j,
		"sessionTable",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRemoteMcpServer) StreamTable() awsdynamodb.ITable {
	var returns awsdynamodb.ITable
	_jsii_.Get(
		j,
		"streamTable",
		&returns,
	)
	return returns
}

func NewAppTheoryRemoteMcpServer(scope constructs.Construct, id *string, props *AppTheoryRemoteMcpServerProps) AppTheoryRemoteMcpServer {
	_init_.Initialize()

	if err := validateNewAppTheoryRemoteMcpServerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryRemoteMcpServer{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryRemoteMcpServer_Override(a AppTheoryRemoteMcpServer, scope constructs.Construct, id *string, props *AppTheoryRemoteMcpServerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer",
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
func AppTheoryRemoteMcpServer_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryRemoteMcpServer_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryRemoteMcpServer",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRemoteMcpServer) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRemoteMcpServer) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
