package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudwatch"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsec2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssecretsmanager"
	"github.com/aws/aws-cdk-go/awscdk/v2/awswafv2"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryEnhancedSecurity interface {
	constructs.Construct
	// The tree node.
	Node() constructs.Node
	Secrets() *map[string]awssecretsmanager.Secret
	SecurityGroup() awsec2.SecurityGroup
	SecurityMetrics() *map[string]awscloudwatch.IMetric
	VpcEndpoints() *map[string]awsec2.InterfaceVpcEndpoint
	VpcFlowLogsGroup() awslogs.LogGroup
	Waf() awswafv2.CfnWebACL
	AddCustomSecurityRule(rule *AppTheorySecurityRule, direction *string)
	Secret(name *string) awssecretsmanager.Secret
	SecurityGroupResource() awsec2.ISecurityGroup
	SecurityMetric(name *string) awscloudwatch.IMetric
	// Returns a string representation of this construct.
	ToString() *string
	VpcEndpoint(name *string) awsec2.InterfaceVpcEndpoint
	WafWebAcl() awswafv2.CfnWebACL
}

// The jsii proxy struct for AppTheoryEnhancedSecurity
type jsiiProxy_AppTheoryEnhancedSecurity struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) Secrets() *map[string]awssecretsmanager.Secret {
	var returns *map[string]awssecretsmanager.Secret
	_jsii_.Get(
		j,
		"secrets",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) SecurityGroup() awsec2.SecurityGroup {
	var returns awsec2.SecurityGroup
	_jsii_.Get(
		j,
		"securityGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) SecurityMetrics() *map[string]awscloudwatch.IMetric {
	var returns *map[string]awscloudwatch.IMetric
	_jsii_.Get(
		j,
		"securityMetrics",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) VpcEndpoints() *map[string]awsec2.InterfaceVpcEndpoint {
	var returns *map[string]awsec2.InterfaceVpcEndpoint
	_jsii_.Get(
		j,
		"vpcEndpoints",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) VpcFlowLogsGroup() awslogs.LogGroup {
	var returns awslogs.LogGroup
	_jsii_.Get(
		j,
		"vpcFlowLogsGroup",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryEnhancedSecurity) Waf() awswafv2.CfnWebACL {
	var returns awswafv2.CfnWebACL
	_jsii_.Get(
		j,
		"waf",
		&returns,
	)
	return returns
}

func NewAppTheoryEnhancedSecurity(scope constructs.Construct, id *string, props *AppTheoryEnhancedSecurityProps) AppTheoryEnhancedSecurity {
	_init_.Initialize()

	if err := validateNewAppTheoryEnhancedSecurityParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryEnhancedSecurity{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryEnhancedSecurity_Override(a AppTheoryEnhancedSecurity, scope constructs.Construct, id *string, props *AppTheoryEnhancedSecurityProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity",
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
func AppTheoryEnhancedSecurity_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryEnhancedSecurity_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) AddCustomSecurityRule(rule *AppTheorySecurityRule, direction *string) {
	if err := a.validateAddCustomSecurityRuleParameters(rule, direction); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"addCustomSecurityRule",
		[]interface{}{rule, direction},
	)
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) Secret(name *string) awssecretsmanager.Secret {
	if err := a.validateSecretParameters(name); err != nil {
		panic(err)
	}
	var returns awssecretsmanager.Secret

	_jsii_.Invoke(
		a,
		"secret",
		[]interface{}{name},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) SecurityGroupResource() awsec2.ISecurityGroup {
	var returns awsec2.ISecurityGroup

	_jsii_.Invoke(
		a,
		"securityGroupResource",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) SecurityMetric(name *string) awscloudwatch.IMetric {
	if err := a.validateSecurityMetricParameters(name); err != nil {
		panic(err)
	}
	var returns awscloudwatch.IMetric

	_jsii_.Invoke(
		a,
		"securityMetric",
		[]interface{}{name},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) VpcEndpoint(name *string) awsec2.InterfaceVpcEndpoint {
	if err := a.validateVpcEndpointParameters(name); err != nil {
		panic(err)
	}
	var returns awsec2.InterfaceVpcEndpoint

	_jsii_.Invoke(
		a,
		"vpcEndpoint",
		[]interface{}{name},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) WafWebAcl() awswafv2.CfnWebACL {
	var returns awswafv2.CfnWebACL

	_jsii_.Invoke(
		a,
		"wafWebAcl",
		nil, // no parameters
		&returns,
	)

	return returns
}
