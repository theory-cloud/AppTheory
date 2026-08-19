package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3/jsii"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3/internal"
)

// Governed CloudFormation install-parameter contract for a Theory Cloud namespace.
//
// The construct keeps templates account-agnostic: every per-install identity
// value enters through one of the ten required stack parameters and is exposed
// as a string token for consuming constructs. Parameter patterns and allowed
// values are evaluated by CloudFormation, not duplicated as synthesis-time
// validation.
//
// CloudFormation Rules cannot use `Fn::Join`, so this construct cannot assert
// that `DnsHost` equals
// `cloud-keeper.<NamespaceSlug>.theorycloud.app`. The governed install-profile
// validator owns that relational check; the `DnsHost` parameter pattern still
// enforces the `theorycloud.app` suffix during stack evaluation.
type AppTheoryInstallParameters interface {
	constructs.Construct
	// Installed AWS account class token.
	AccountClass() *string
	// Autheory HTTPS JWKS URL token.
	AutheoryJwksUrl() *string
	// Autheory HTTPS authorization-server origin token.
	AuthorizationServerOrigin() *string
	// Exact Cloud Keeper DNS host token.
	DnsHost() *string
	// Theory Cloud namespace slug token.
	NamespaceSlug() *string
	// The tree node.
	Node() constructs.Node
	// Route 53 public hosted-zone identifier token.
	PublicHostedZoneId() *string
	// Namespace install stage token.
	Stage() *string
	// Exact 12-digit namespace AWS account token.
	TargetAccountId() *string
	// Target Theory Cloud application identifier token.
	TargetApplicationId() *string
	// Autheory tenant identifier token.
	TenantId() *string
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

// The jsii proxy struct for AppTheoryInstallParameters
type jsiiProxy_AppTheoryInstallParameters struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryInstallParameters) AccountClass() *string {
	var returns *string
	_jsii_.Get(
		j,
		"accountClass",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) AutheoryJwksUrl() *string {
	var returns *string
	_jsii_.Get(
		j,
		"autheoryJwksUrl",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) AuthorizationServerOrigin() *string {
	var returns *string
	_jsii_.Get(
		j,
		"authorizationServerOrigin",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) DnsHost() *string {
	var returns *string
	_jsii_.Get(
		j,
		"dnsHost",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) NamespaceSlug() *string {
	var returns *string
	_jsii_.Get(
		j,
		"namespaceSlug",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) PublicHostedZoneId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"publicHostedZoneId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) Stage() *string {
	var returns *string
	_jsii_.Get(
		j,
		"stage",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) TargetAccountId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"targetAccountId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) TargetApplicationId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"targetApplicationId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryInstallParameters) TenantId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"tenantId",
		&returns,
	)
	return returns
}

func NewAppTheoryInstallParameters(scope constructs.Construct, id *string) AppTheoryInstallParameters {
	_init_.Initialize()

	if err := validateNewAppTheoryInstallParametersParameters(scope, id); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryInstallParameters{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryInstallParameters",
		[]interface{}{scope, id},
		&j,
	)

	return &j
}

func NewAppTheoryInstallParameters_Override(a AppTheoryInstallParameters, scope constructs.Construct, id *string) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryInstallParameters",
		[]interface{}{scope, id},
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
func AppTheoryInstallParameters_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryInstallParameters_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryInstallParameters",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryInstallParameters) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryInstallParameters) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
