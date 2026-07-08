package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3vectors"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// AppTheory's canonical S3 Vectors deployment primitive.
//
// The construct creates (or attaches to) one vector bucket and one vector index,
// exposes stable AppTheory environment variables, and grants the narrow S3
// Vectors and Bedrock permissions used by the runtime vectorstore helpers.
type AppTheoryVectorIndex interface {
	constructs.Construct
	Dimension() *float64
	Index() awss3vectors.CfnIndex
	IndexArn() *string
	IndexName() *string
	// The tree node.
	Node() constructs.Node
	VectorBucket() awss3vectors.CfnVectorBucket
	VectorBucketArn() *string
	VectorBucketName() *string
	// Bind canonical vectorstore environment variables to a Lambda function.
	BindEnvironment(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions)
	// Bind canonical Bedrock Titan embedding environment variables.
	BindTitanEmbeddingEnvironment(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions)
	// Grant Bedrock InvokeModel for explicit Titan embedding helpers.
	GrantBedrockInvokeModel(grantee awsiam.IGrantable, modelResourceArn *string) awsiam.Grant
	// Grant read, query, write, and management permissions.
	GrantManage(grantee awsiam.IGrantable) awsiam.Grant
	// Grant QueryVectors permissions, including metadata/filter reads.
	GrantQuery(grantee awsiam.IGrantable) awsiam.Grant
	// Grant Get/List vector permissions without query or write.
	GrantReadVectors(grantee awsiam.IGrantable) awsiam.Grant
	// Grant Put/Delete vector permissions.
	GrantWriteVectors(grantee awsiam.IGrantable) awsiam.Grant
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

// The jsii proxy struct for AppTheoryVectorIndex
type jsiiProxy_AppTheoryVectorIndex struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryVectorIndex) Dimension() *float64 {
	var returns *float64
	_jsii_.Get(
		j,
		"dimension",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) Index() awss3vectors.CfnIndex {
	var returns awss3vectors.CfnIndex
	_jsii_.Get(
		j,
		"index",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) IndexArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"indexArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) IndexName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"indexName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) VectorBucket() awss3vectors.CfnVectorBucket {
	var returns awss3vectors.CfnVectorBucket
	_jsii_.Get(
		j,
		"vectorBucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) VectorBucketArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"vectorBucketArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryVectorIndex) VectorBucketName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"vectorBucketName",
		&returns,
	)
	return returns
}

func NewAppTheoryVectorIndex(scope constructs.Construct, id *string, props *AppTheoryVectorIndexProps) AppTheoryVectorIndex {
	_init_.Initialize()

	if err := validateNewAppTheoryVectorIndexParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryVectorIndex{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryVectorIndex",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryVectorIndex_Override(a AppTheoryVectorIndex, scope constructs.Construct, id *string, props *AppTheoryVectorIndexProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryVectorIndex",
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
func AppTheoryVectorIndex_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryVectorIndex_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryVectorIndex",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) BindEnvironment(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions) {
	if err := a.validateBindEnvironmentParameters(fn, options); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"bindEnvironment",
		[]interface{}{fn, options},
	)
}

func (a *jsiiProxy_AppTheoryVectorIndex) BindTitanEmbeddingEnvironment(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions) {
	if err := a.validateBindTitanEmbeddingEnvironmentParameters(fn, options); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"bindTitanEmbeddingEnvironment",
		[]interface{}{fn, options},
	)
}

func (a *jsiiProxy_AppTheoryVectorIndex) GrantBedrockInvokeModel(grantee awsiam.IGrantable, modelResourceArn *string) awsiam.Grant {
	if err := a.validateGrantBedrockInvokeModelParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantBedrockInvokeModel",
		[]interface{}{grantee, modelResourceArn},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) GrantManage(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantManageParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantManage",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) GrantQuery(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantQueryParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantQuery",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) GrantReadVectors(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantReadVectorsParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantReadVectors",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) GrantWriteVectors(grantee awsiam.IGrantable) awsiam.Grant {
	if err := a.validateGrantWriteVectorsParameters(grantee); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantWriteVectors",
		[]interface{}{grantee},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryVectorIndex) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
