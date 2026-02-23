package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A Lambda execution role construct with baseline permissions and optional enhancements.
//
// Creates an IAM role suitable for Lambda execution with:
// - Basic Lambda execution permissions (CloudWatch Logs)
// - Optional X-Ray tracing permissions
// - Optional KMS permissions for environment encryption
// - Optional KMS permissions for application-level encryption
// - Escape hatch for additional inline policy statements.
//
// Example:
//   const role = new AppTheoryLambdaRole(this, 'LambdaRole', {
//     roleName: 'my-lambda-role',
//     enableXRay: true,
//     environmentEncryptionKeys: [envKey],
//     applicationKmsKeys: [dataKey],
//     additionalStatements: [
//       new iam.PolicyStatement({
//         actions: ['s3:GetObject'],
//         resources: ['arn:aws:s3:::my-bucket/*'],
//       }),
//     ],
//   });
//
type AppTheoryLambdaRole interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
	// The underlying IAM Role.
	Role() awsiam.Role
	// The ARN of the IAM Role.
	RoleArn() *string
	// The name of the IAM Role.
	RoleName() *string
	// Add a managed policy to this role.
	AddManagedPolicy(policy awsiam.IManagedPolicy)
	// Add an inline policy statement to this role.
	AddToPolicy(statement awsiam.PolicyStatement) *bool
	// Grant this role to a grantable principal.
	//
	// This is useful when you need to allow another entity to assume this role.
	GrantAssumeRole(grantee awsiam.IPrincipal) awsiam.Grant
	// Grant permissions to pass this role.
	//
	// This is required when a service needs to pass this role to Lambda.
	GrantPassRole(grantee awsiam.IPrincipal) awsiam.Grant
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryLambdaRole
type jsiiProxy_AppTheoryLambdaRole struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryLambdaRole) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryLambdaRole) Role() awsiam.Role {
	var returns awsiam.Role
	_jsii_.Get(
		j,
		"role",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryLambdaRole) RoleArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"roleArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryLambdaRole) RoleName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"roleName",
		&returns,
	)
	return returns
}


func NewAppTheoryLambdaRole(scope constructs.Construct, id *string, props *AppTheoryLambdaRoleProps) AppTheoryLambdaRole {
	_init_.Initialize()

	if err := validateNewAppTheoryLambdaRoleParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryLambdaRole{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryLambdaRole",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryLambdaRole_Override(a AppTheoryLambdaRole, scope constructs.Construct, id *string, props *AppTheoryLambdaRoleProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryLambdaRole",
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
func AppTheoryLambdaRole_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryLambdaRole_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryLambdaRole",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryLambdaRole) AddManagedPolicy(policy awsiam.IManagedPolicy) {
	if err := a.validateAddManagedPolicyParameters(policy); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"addManagedPolicy",
		[]interface{}{policy},
	)
}

func (a *jsiiProxy_AppTheoryLambdaRole) AddToPolicy(statement awsiam.PolicyStatement) *bool {
	if err := a.validateAddToPolicyParameters(statement); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.Invoke(
		a,
		"addToPolicy",
		[]interface{}{statement},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryLambdaRole) GrantAssumeRole(grantee awsiam.IPrincipal) awsiam.Grant {
	if err := a.validateGrantAssumeRoleParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantAssumeRole",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryLambdaRole) GrantPassRole(grantee awsiam.IPrincipal) awsiam.Grant {
	if err := a.validateGrantPassRoleParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantPassRole",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryLambdaRole) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

