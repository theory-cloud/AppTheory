package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// An MCP (Model Context Protocol) server construct that provisions an HTTP API Gateway v2 with a Lambda integration on POST /mcp, optional DynamoDB session table, and optional custom domain with Route53.
//
// Example:
//
//	const server = new AppTheoryMcpServer(this, 'McpServer', {
//	  handler: mcpFn,
//	  enableSessionTable: true,
//	  sessionTtlMinutes: 120,
//	});
type AppTheoryMcpServer interface {
	constructs.Construct
	// The access log group (if access logging is enabled).
	AccessLogGroup() awslogs.ILogGroup
	// The underlying HTTP API Gateway v2.
	Api() awsapigatewayv2.HttpApi
	// The API mapping for the custom domain (if domain is configured).
	ApiMapping() awsapigatewayv2.ApiMapping
	// The Route53 CNAME record (if domain and hostedZone are configured).
	CnameRecord() awsroute53.CnameRecord
	// The custom domain name resource (if domain is configured).
	DomainName() awsapigatewayv2.DomainName
	// The MCP endpoint URL (POST /mcp).
	Endpoint() *string
	// The tree node.
	Node() constructs.Node
	// The DynamoDB session table (if enableSessionTable is true).
	SessionTable() awsdynamodb.ITable
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryMcpServer
type jsiiProxy_AppTheoryMcpServer struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryMcpServer) AccessLogGroup() awslogs.ILogGroup {
	var returns awslogs.ILogGroup
	_jsii_.Get(
		j,
		"accessLogGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) Api() awsapigatewayv2.HttpApi {
	var returns awsapigatewayv2.HttpApi
	_jsii_.Get(
		j,
		"api",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) ApiMapping() awsapigatewayv2.ApiMapping {
	var returns awsapigatewayv2.ApiMapping
	_jsii_.Get(
		j,
		"apiMapping",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) CnameRecord() awsroute53.CnameRecord {
	var returns awsroute53.CnameRecord
	_jsii_.Get(
		j,
		"cnameRecord",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) DomainName() awsapigatewayv2.DomainName {
	var returns awsapigatewayv2.DomainName
	_jsii_.Get(
		j,
		"domainName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) Endpoint() *string {
	var returns *string
	_jsii_.Get(
		j,
		"endpoint",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMcpServer) SessionTable() awsdynamodb.ITable {
	var returns awsdynamodb.ITable
	_jsii_.Get(
		j,
		"sessionTable",
		&returns,
	)
	return returns
}

func NewAppTheoryMcpServer(scope constructs.Construct, id *string, props *AppTheoryMcpServerProps) AppTheoryMcpServer {
	_init_.Initialize()

	if err := validateNewAppTheoryMcpServerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMcpServer{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServer",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMcpServer_Override(a AppTheoryMcpServer, scope constructs.Construct, id *string, props *AppTheoryMcpServerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServer",
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
func AppTheoryMcpServer_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMcpServer_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMcpServer",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMcpServer) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
