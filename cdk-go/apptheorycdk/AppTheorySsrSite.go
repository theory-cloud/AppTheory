package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscertificatemanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheorySsrSite interface {
	constructs.Construct
	AssetsBucket() awss3.IBucket
	AssetsKeyPrefix() *string
	AssetsManifestKey() *string
	Certificate() awscertificatemanager.ICertificate
	Distribution() awscloudfront.Distribution
	LogsBucket() awss3.IBucket
	// The tree node.
	Node() constructs.Node
	SsrUrl() awslambda.FunctionUrl
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheorySsrSite
type jsiiProxy_AppTheorySsrSite struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheorySsrSite) AssetsBucket() awss3.IBucket {
	var returns awss3.IBucket
	_jsii_.Get(
		j,
		"assetsBucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) AssetsKeyPrefix() *string {
	var returns *string
	_jsii_.Get(
		j,
		"assetsKeyPrefix",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) AssetsManifestKey() *string {
	var returns *string
	_jsii_.Get(
		j,
		"assetsManifestKey",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) Certificate() awscertificatemanager.ICertificate {
	var returns awscertificatemanager.ICertificate
	_jsii_.Get(
		j,
		"certificate",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) Distribution() awscloudfront.Distribution {
	var returns awscloudfront.Distribution
	_jsii_.Get(
		j,
		"distribution",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) LogsBucket() awss3.IBucket {
	var returns awss3.IBucket
	_jsii_.Get(
		j,
		"logsBucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheorySsrSite) SsrUrl() awslambda.FunctionUrl {
	var returns awslambda.FunctionUrl
	_jsii_.Get(
		j,
		"ssrUrl",
		&returns,
	)
	return returns
}

func NewAppTheorySsrSite(scope constructs.Construct, id *string, props *AppTheorySsrSiteProps) AppTheorySsrSite {
	_init_.Initialize()

	if err := validateNewAppTheorySsrSiteParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheorySsrSite{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSite",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheorySsrSite_Override(a AppTheorySsrSite, scope constructs.Construct, id *string, props *AppTheorySsrSiteProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSite",
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
func AppTheorySsrSite_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheorySsrSite_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheorySsrSite",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheorySsrSite) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
