// AppTheory CDK constructs (TS-first jsii)
package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/constructs-go/constructs/v10"

	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryApiDomain interface {
	constructs.Construct
	ApiMapping() awsapigatewayv2.ApiMapping
	CnameRecord() awsroute53.CnameRecord
	DomainName() awsapigatewayv2.DomainName
	DomainString() *string
	// The tree node.
	Node() constructs.Node
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryApiDomain
type jsiiProxy_AppTheoryApiDomain struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryApiDomain) ApiMapping() awsapigatewayv2.ApiMapping {
	var returns awsapigatewayv2.ApiMapping
	_jsii_.Get(
		j,
		"apiMapping",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApiDomain) CnameRecord() awsroute53.CnameRecord {
	var returns awsroute53.CnameRecord
	_jsii_.Get(
		j,
		"cnameRecord",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApiDomain) DomainName() awsapigatewayv2.DomainName {
	var returns awsapigatewayv2.DomainName
	_jsii_.Get(
		j,
		"domainName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApiDomain) DomainString() *string {
	var returns *string
	_jsii_.Get(
		j,
		"domainString",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryApiDomain) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func NewAppTheoryApiDomain(scope constructs.Construct, id *string, props *AppTheoryApiDomainProps) AppTheoryApiDomain {
	_init_.Initialize()

	if err := validateNewAppTheoryApiDomainParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryApiDomain{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryApiDomain",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryApiDomain_Override(a AppTheoryApiDomain, scope constructs.Construct, id *string, props *AppTheoryApiDomainProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryApiDomain",
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
func AppTheoryApiDomain_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryApiDomain_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryApiDomain",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryApiDomain) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
