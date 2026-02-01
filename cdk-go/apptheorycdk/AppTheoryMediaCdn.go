package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

// A CloudFront distribution optimized for serving media assets from S3.
//
// This construct creates or wraps an S3 bucket with a CloudFront distribution
// configured for media delivery. It supports:
// - Custom domain with certificate and Route53 integration
// - Private media access via signed URLs/cookies (trusted key groups)
// - Customizable caching and response headers
// - Access logging
//
// Use cases:
// - Public media CDN (images, videos, documents)
// - Private/authenticated media access
// - Stage-specific media subdomains (e.g., media.stage.example.com)
type AppTheoryMediaCdn interface {
	constructs.Construct
	// The S3 bucket for media assets.
	Bucket() awss3.IBucket
	// The certificate used for the distribution (if custom domain is configured).
	Certificate() awscertificatemanager.ICertificate
	// The CloudFront distribution.
	Distribution() awscloudfront.Distribution
	// The key group for private media access (if configured).
	KeyGroup() awscloudfront.IKeyGroup
	// The CloudFront access logs bucket (if logging is enabled).
	LogsBucket() awss3.IBucket
	// The tree node.
	Node() constructs.Node
	// The public key created for private media (if created from PEM).
	PublicKey() awscloudfront.PublicKey
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryMediaCdn
type jsiiProxy_AppTheoryMediaCdn struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryMediaCdn) Bucket() awss3.IBucket {
	var returns awss3.IBucket
	_jsii_.Get(
		j,
		"bucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) Certificate() awscertificatemanager.ICertificate {
	var returns awscertificatemanager.ICertificate
	_jsii_.Get(
		j,
		"certificate",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) Distribution() awscloudfront.Distribution {
	var returns awscloudfront.Distribution
	_jsii_.Get(
		j,
		"distribution",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) KeyGroup() awscloudfront.IKeyGroup {
	var returns awscloudfront.IKeyGroup
	_jsii_.Get(
		j,
		"keyGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) LogsBucket() awss3.IBucket {
	var returns awss3.IBucket
	_jsii_.Get(
		j,
		"logsBucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryMediaCdn) PublicKey() awscloudfront.PublicKey {
	var returns awscloudfront.PublicKey
	_jsii_.Get(
		j,
		"publicKey",
		&returns,
	)
	return returns
}


func NewAppTheoryMediaCdn(scope constructs.Construct, id *string, props *AppTheoryMediaCdnProps) AppTheoryMediaCdn {
	_init_.Initialize()

	if err := validateNewAppTheoryMediaCdnParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryMediaCdn{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMediaCdn",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryMediaCdn_Override(a AppTheoryMediaCdn, scope constructs.Construct, id *string, props *AppTheoryMediaCdnProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryMediaCdn",
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
func AppTheoryMediaCdn_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryMediaCdn_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryMediaCdn",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryMediaCdn) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

