package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// Opinionated DynamoDB table for import pipeline job ledgers.
//
// Canonical schema:
// - PK: `pk` (string)
// - SK: `sk` (string)
//
// Canonical GSIs (locked by ADR 0002):
// - `status-created-index`: `status` (pk) + `created_at` (sk)
// - `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)
//
// Canonical TTL attribute:
// - `ttl` (configurable).
type AppTheoryJobsTable interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
	Table() awsdynamodb.Table
	// Binds the canonical jobs table env var to a Lambda function.
	BindEnvironment(fn awslambda.Function)
	// Grant DynamoDB read permissions.
	GrantReadTo(grantee awsiam.IGrantable)
	// Grant DynamoDB read/write permissions.
	GrantReadWriteTo(grantee awsiam.IGrantable)
	// Grant DynamoDB write permissions.
	GrantWriteTo(grantee awsiam.IGrantable)
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

// The jsii proxy struct for AppTheoryJobsTable
type jsiiProxy_AppTheoryJobsTable struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryJobsTable) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryJobsTable) Table() awsdynamodb.Table {
	var returns awsdynamodb.Table
	_jsii_.Get(
		j,
		"table",
		&returns,
	)
	return returns
}


func NewAppTheoryJobsTable(scope constructs.Construct, id *string, props *AppTheoryJobsTableProps) AppTheoryJobsTable {
	_init_.Initialize()

	if err := validateNewAppTheoryJobsTableParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryJobsTable{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryJobsTable",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryJobsTable_Override(a AppTheoryJobsTable, scope constructs.Construct, id *string, props *AppTheoryJobsTableProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryJobsTable",
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
func AppTheoryJobsTable_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryJobsTable_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryJobsTable",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryJobsTable) BindEnvironment(fn awslambda.Function) {
	if err := a.validateBindEnvironmentParameters(fn); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"bindEnvironment",
		[]interface{}{fn},
	)
}

func (a *jsiiProxy_AppTheoryJobsTable) GrantReadTo(grantee awsiam.IGrantable) {
	if err := a.validateGrantReadToParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantReadTo",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryJobsTable) GrantReadWriteTo(grantee awsiam.IGrantable) {
	if err := a.validateGrantReadWriteToParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantReadWriteTo",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryJobsTable) GrantWriteTo(grantee awsiam.IGrantable) {
	if err := a.validateGrantWriteToParameters(grantee); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantWriteTo",
		[]interface{}{grantee},
	)
}

func (a *jsiiProxy_AppTheoryJobsTable) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryJobsTable) With(mixins ...constructs.IMixin) constructs.IConstruct {
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

