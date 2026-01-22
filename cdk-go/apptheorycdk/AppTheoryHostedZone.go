package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/constructs-go/constructs/v10"

	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal"
)

type AppTheoryHostedZone interface {
	constructs.Construct
	HostedZone() awsroute53.IHostedZone
	HostedZoneId() *string
	IsImported() *bool
	// The tree node.
	Node() constructs.Node
	ZoneName() *string
	AddCnameRecord(recordName *string, domainName *string, ttl awscdk.Duration) awsroute53.CnameRecord
	AddNsRecord(recordName *string, targetNameServers *[]*string, ttl awscdk.Duration) awsroute53.NsRecord
	NameServers() *[]*string
	// Returns a string representation of this construct.
	ToString() *string
}

// The jsii proxy struct for AppTheoryHostedZone
type jsiiProxy_AppTheoryHostedZone struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryHostedZone) HostedZone() awsroute53.IHostedZone {
	var returns awsroute53.IHostedZone
	_jsii_.Get(
		j,
		"hostedZone",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHostedZone) HostedZoneId() *string {
	var returns *string
	_jsii_.Get(
		j,
		"hostedZoneId",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHostedZone) IsImported() *bool {
	var returns *bool
	_jsii_.Get(
		j,
		"isImported",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHostedZone) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryHostedZone) ZoneName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"zoneName",
		&returns,
	)
	return returns
}

func NewAppTheoryHostedZone(scope constructs.Construct, id *string, props *AppTheoryHostedZoneProps) AppTheoryHostedZone {
	_init_.Initialize()

	if err := validateNewAppTheoryHostedZoneParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryHostedZone{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryHostedZone",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryHostedZone_Override(a AppTheoryHostedZone, scope constructs.Construct, id *string, props *AppTheoryHostedZoneProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryHostedZone",
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
func AppTheoryHostedZone_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryHostedZone_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryHostedZone",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHostedZone) AddCnameRecord(recordName *string, domainName *string, ttl awscdk.Duration) awsroute53.CnameRecord {
	if err := a.validateAddCnameRecordParameters(recordName, domainName, ttl); err != nil {
		panic(err)
	}
	var returns awsroute53.CnameRecord

	_jsii_.Invoke(
		a,
		"addCnameRecord",
		[]interface{}{recordName, domainName, ttl},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHostedZone) AddNsRecord(recordName *string, targetNameServers *[]*string, ttl awscdk.Duration) awsroute53.NsRecord {
	if err := a.validateAddNsRecordParameters(recordName, targetNameServers, ttl); err != nil {
		panic(err)
	}
	var returns awsroute53.NsRecord

	_jsii_.Invoke(
		a,
		"addNsRecord",
		[]interface{}{recordName, targetNameServers, ttl},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHostedZone) NameServers() *[]*string {
	var returns *[]*string

	_jsii_.Invoke(
		a,
		"nameServers",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryHostedZone) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}
