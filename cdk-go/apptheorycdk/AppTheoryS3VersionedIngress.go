package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3/internal"
)

// Version-pinned artifact ingress bucket for Theory Cloud namespace releases.
//
// The construct owns one hardened, versioned bucket, its seven-day incomplete
// multipart-upload reaping rule, and the one-action IAM grant path for
// namespace bundles. Literal inputs produce exact-key grants. CloudFormation
// resolves unresolved token inputs at deployment; AppTheory cannot guarantee
// exactness for token-valued locations. It does not issue temporary
// credentials, mint bundle identifiers, or define artifact URI schemes.
type AppTheoryS3VersionedIngress interface {
	constructs.Construct
	// CloudFormation-resolved bucket ARN.
	BucketArn() *string
	// CloudFormation-resolved physical bucket name.
	BucketName() *string
	// Canonical object-key root for every namespace release bundle.
	KeyRoot() *string
	// The tree node.
	Node() constructs.Node
	// Grant one principal `s3:PutObject` on one namespace bundle resource.
	//
	// `s3:PutObject` inherently covers multipart create, part upload, and
	// completion on the same key; separate abort and part-listing actions remain
	// ungranted. Literal location values are validated at synthesis. CDK tokens
	// skip literal value validation and are resolved by CloudFormation at
	// deployment; AppTheory cannot guarantee exactness for token-valued
	// locations. Missing inputs still fail closed before any grant is added.
	GrantUpload(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) awsiam.Grant
	// Grant one principal permission to read one pinned namespace bundle version.
	//
	// The grant includes only `s3:GetObjectVersion`. Literal inputs target one
	// exact bundle key. CloudFormation resolves token inputs at deployment;
	// AppTheory cannot guarantee exactness for token-valued locations.
	// Unversioned reads and bucket listing remain ungranted.
	GrantVersionedRead(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) awsiam.Grant
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

// The jsii proxy struct for AppTheoryS3VersionedIngress
type jsiiProxy_AppTheoryS3VersionedIngress struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryS3VersionedIngress) BucketArn() *string {
	var returns *string
	_jsii_.Get(
		j,
		"bucketArn",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryS3VersionedIngress) BucketName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"bucketName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryS3VersionedIngress) KeyRoot() *string {
	var returns *string
	_jsii_.Get(
		j,
		"keyRoot",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryS3VersionedIngress) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func NewAppTheoryS3VersionedIngress(scope constructs.Construct, id *string, props *AppTheoryS3VersionedIngressProps) AppTheoryS3VersionedIngress {
	_init_.Initialize()

	if err := validateNewAppTheoryS3VersionedIngressParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryS3VersionedIngress{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryS3VersionedIngress_Override(a AppTheoryS3VersionedIngress, scope constructs.Construct, id *string, props *AppTheoryS3VersionedIngressProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress",
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
func AppTheoryS3VersionedIngress_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryS3VersionedIngress_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func AppTheoryS3VersionedIngress_KEY_ROOT() *string {
	_init_.Initialize()
	var returns *string
	_jsii_.StaticGet(
		"@theory-cloud/apptheory-cdk.AppTheoryS3VersionedIngress",
		"KEY_ROOT",
		&returns,
	)
	return returns
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) GrantUpload(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) awsiam.Grant {
	if err := a.validateGrantUploadParameters(grantee, namespaceSlug, bundleId); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantUpload",
		[]interface{}{grantee, namespaceSlug, bundleId},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) GrantVersionedRead(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) awsiam.Grant {
	if err := a.validateGrantVersionedReadParameters(grantee, namespaceSlug, bundleId); err != nil {
		panic(err)
	}
	var returns awsiam.Grant

	_jsii_.Invoke(
		a,
		"grantVersionedRead",
		[]interface{}{grantee, namespaceSlug, bundleId},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
