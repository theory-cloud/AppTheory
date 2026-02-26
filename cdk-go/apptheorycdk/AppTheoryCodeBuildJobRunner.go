package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscodebuild"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsevents"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssecretsmanager"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// Opinionated CodeBuild wrapper for running import/batch jobs outside Lambda.
//
// This construct creates a CodeBuild project with:
// - safe defaults for image/compute/timeout
// - deterministic log group retention (auto-managed by default)
// - an optional EventBridge state-change rule hook
// - ergonomic grant helpers for common AWS resources.
type AppTheoryCodeBuildJobRunner interface {
	constructs.Construct
	LogGroup() awslogs.ILogGroup
	// The tree node.
	Node() constructs.Node
	Project() awscodebuild.Project
	Role() awsiam.Role
	StateChangeRule() awsevents.Rule
	// Attach a policy statement to the CodeBuild role.
	AddToRolePolicy(statement awsiam.PolicyStatement)
	// Grant DynamoDB read permissions to the project.
	GrantDynamoRead(table awsdynamodb.ITable)
	// Grant DynamoDB write permissions to the project.
	GrantDynamoWrite(table awsdynamodb.ITable)
	// Grant S3 read permissions to the project.
	GrantS3Read(bucket awss3.IBucket)
	// Grant S3 write permissions to the project.
	GrantS3Write(bucket awss3.IBucket)
	// Grant Secrets Manager read permissions to the project.
	GrantSecretRead(secret awssecretsmanager.ISecret)
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

// The jsii proxy struct for AppTheoryCodeBuildJobRunner
type jsiiProxy_AppTheoryCodeBuildJobRunner struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryCodeBuildJobRunner) LogGroup() awslogs.ILogGroup {
	var returns awslogs.ILogGroup
	_jsii_.Get(
		j,
		"logGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCodeBuildJobRunner) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCodeBuildJobRunner) Project() awscodebuild.Project {
	var returns awscodebuild.Project
	_jsii_.Get(
		j,
		"project",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCodeBuildJobRunner) Role() awsiam.Role {
	var returns awsiam.Role
	_jsii_.Get(
		j,
		"role",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryCodeBuildJobRunner) StateChangeRule() awsevents.Rule {
	var returns awsevents.Rule
	_jsii_.Get(
		j,
		"stateChangeRule",
		&returns,
	)
	return returns
}

func NewAppTheoryCodeBuildJobRunner(scope constructs.Construct, id *string, props *AppTheoryCodeBuildJobRunnerProps) AppTheoryCodeBuildJobRunner {
	_init_.Initialize()

	if err := validateNewAppTheoryCodeBuildJobRunnerParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryCodeBuildJobRunner{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryCodeBuildJobRunner_Override(a AppTheoryCodeBuildJobRunner, scope constructs.Construct, id *string, props *AppTheoryCodeBuildJobRunnerProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner",
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
func AppTheoryCodeBuildJobRunner_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryCodeBuildJobRunner_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryCodeBuildJobRunner",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) AddToRolePolicy(statement awsiam.PolicyStatement) {
	if err := a.validateAddToRolePolicyParameters(statement); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"addToRolePolicy",
		[]interface{}{statement},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) GrantDynamoRead(table awsdynamodb.ITable) {
	if err := a.validateGrantDynamoReadParameters(table); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantDynamoRead",
		[]interface{}{table},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) GrantDynamoWrite(table awsdynamodb.ITable) {
	if err := a.validateGrantDynamoWriteParameters(table); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantDynamoWrite",
		[]interface{}{table},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) GrantS3Read(bucket awss3.IBucket) {
	if err := a.validateGrantS3ReadParameters(bucket); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantS3Read",
		[]interface{}{bucket},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) GrantS3Write(bucket awss3.IBucket) {
	if err := a.validateGrantS3WriteParameters(bucket); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantS3Write",
		[]interface{}{bucket},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) GrantSecretRead(secret awssecretsmanager.ISecret) {
	if err := a.validateGrantSecretReadParameters(secret); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"grantSecretRead",
		[]interface{}{secret},
	)
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
