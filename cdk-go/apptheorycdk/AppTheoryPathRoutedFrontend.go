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

// A CloudFront distribution for path-routed multi-SPA + API deployments.
//
// This construct creates a CloudFront distribution that routes requests to:
// - SPA origins (S3 buckets) based on path prefixes (e.g., /l/*, /auth/*)
// - API origin (default behavior) for all other paths
// - API bypass paths for specific paths that should skip SPA routing
//
// A CloudFront Function handles viewer-request rewriting for SPA routing,
// ensuring that paths without file extensions are rewritten to index.html.
type AppTheoryPathRoutedFrontend interface {
	constructs.Construct
	// The certificate used for the distribution (if custom domain is configured).
	Certificate() awscertificatemanager.ICertificate
	// The CloudFront distribution.
	Distribution() awscloudfront.Distribution
	// The CloudFront access logs bucket (if logging is enabled).
	LogsBucket() awss3.IBucket
	// The tree node.
	Node() constructs.Node
	// The CloudFront Function for SPA rewrite (if SPA origins are configured).
	SpaRewriteFunction() awscloudfront.Function
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryPathRoutedFrontend
type jsiiProxy_AppTheoryPathRoutedFrontend struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryPathRoutedFrontend) Certificate() awscertificatemanager.ICertificate {
	var returns awscertificatemanager.ICertificate
	_jsii_.Get(
		j,
		"certificate",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryPathRoutedFrontend) Distribution() awscloudfront.Distribution {
	var returns awscloudfront.Distribution
	_jsii_.Get(
		j,
		"distribution",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryPathRoutedFrontend) LogsBucket() awss3.IBucket {
	var returns awss3.IBucket
	_jsii_.Get(
		j,
		"logsBucket",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryPathRoutedFrontend) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryPathRoutedFrontend) SpaRewriteFunction() awscloudfront.Function {
	var returns awscloudfront.Function
	_jsii_.Get(
		j,
		"spaRewriteFunction",
		&returns,
	)
	return returns
}


func NewAppTheoryPathRoutedFrontend(scope constructs.Construct, id *string, props *AppTheoryPathRoutedFrontendProps) AppTheoryPathRoutedFrontend {
	_init_.Initialize()

	if err := validateNewAppTheoryPathRoutedFrontendParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryPathRoutedFrontend{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryPathRoutedFrontend_Override(a AppTheoryPathRoutedFrontend, scope constructs.Construct, id *string, props *AppTheoryPathRoutedFrontendProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend",
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
func AppTheoryPathRoutedFrontend_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryPathRoutedFrontend_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryPathRoutedFrontend) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

