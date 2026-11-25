package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/jsii"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/internal"
)

// The bound naming and logging context shared by AppTheory constructs.
type AppTheoryNamingContext interface {
	constructs.Construct
	// Twelve-digit account id.
	//
	// The derived-name artifact claims this account; it
	// is not compared with any declaring stack's account.
	Account() *string
	// App instance id.
	App() *string
	// Generated-name entries keyed `{type}:{logical}`.
	Generated() *[]*string
	// Logging profile.
	LoggingProfile() AppTheoryLoggingProfile
	// Namespace segment.
	Namespace() *string
	// Naming profile.
	NamingProfile() AppTheoryNamingProfile
	// The tree node.
	Node() constructs.Node
	// Physical pins keyed `{type}:{logical}`.
	Pins() *map[string]*string
	// Full Region code.
	//
	// The derived-name artifact claims this Region; it is not
	// compared with any declaring stack's Region.
	Region() *string
	// Retention in days for standard-profile log groups.
	RetentionDays() *float64
	// Stage id.
	Stage() *string
	// Whether the standard logging profile is active.
	StandardLogging() *bool
	// Declare the CloudFormation resource that carries one name the contract fixes rather than derives (contract section 11.4).
	//
	// Two names AppTheory creates fall outside the derivation table: the Lambda
	// service log group `/aws/lambda/{function name}`, and the visibility manifest
	// parameter `/theorycloud/visibility/{app}/{stage}/manifest` (contract section
	// 6). They are still names the context determines and resources the stack
	// creates, so the artifact carries them; the reserved scope is the type's scope
	// from contract section 11.1.
	//
	// An application that names its own resource with a fixed contract path
	// declares it here too, so the artifact covers it.
	//
	// A fixed name is still a physical name of its type, so it must satisfy the
	// character and shape rules of the contract's section 2 rule table for that
	// type (length, charset, the S3 start/end rule, the SSM and KMS path rules,
	// the secret suffix rule). A name outside them fails synthesis instead of
	// entering the artifact as a name the installer can never create
	// (SANITY-AT-N3-08).
	//
	// A fixed `log_group` name is narrowed further, because a log-group name is
	// either this context's own log source or the Lambda service path and nothing
	// else: the structural check in `validatePhysicalName` cannot know the bound
	// prefix, so the context completes it here (see
	// `assertFixedLogGroupName`).
	DeclareFixedName(resourceType *string, name *string, resource constructs.IConstruct)
	// Declare the CloudFormation resource that carries one composed name (contract section 11.4).
	//
	// Synthesis refuses two different logical resources in one naming context that
	// derive the same name in the same naming scope, and emits the derived-name
	// artifact the name reservation index reserves. A construct declares every
	// physically named resource it creates; an application that names its own
	// resource with `physicalName` declares it here once the resource exists, so
	// the artifact covers it too.
	//
	// A name AppTheory only wires for a resource another stack owns, such as
	// `AppTheorySsrSite`'s ISR metadata table, takes no declaration here: that
	// stack declares its own resource.
	//
	// A `log_group` type declares a log-source name (contract section 3): a log
	// group takes no pin or generated entry.
	DeclareName(resourceType *string, logical *string, resource constructs.IConstruct)
	// The physical log-group name of a logical source under this context.
	LogGroupName(logical *string) *string
	// The bound prefix shared by this app's log sources.
	LogSourcePrefix() *string
	// Compose the physical name of one resource under this context.
	PhysicalName(resourceType *string, logical *string) *AppTheoryPhysicalName
	// Returns a string representation of this construct.
	ToString() *string
	// The context values as a jsii struct.
	Values() *AppTheoryNamingContextValues
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

// The jsii proxy struct for AppTheoryNamingContext
type jsiiProxy_AppTheoryNamingContext struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryNamingContext) Account() *string {
	var returns *string
	_jsii_.Get(
		j,
		"account",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) App() *string {
	var returns *string
	_jsii_.Get(
		j,
		"app",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Generated() *[]*string {
	var returns *[]*string
	_jsii_.Get(
		j,
		"generated",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) LoggingProfile() AppTheoryLoggingProfile {
	var returns AppTheoryLoggingProfile
	_jsii_.Get(
		j,
		"loggingProfile",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Namespace() *string {
	var returns *string
	_jsii_.Get(
		j,
		"namespace",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) NamingProfile() AppTheoryNamingProfile {
	var returns AppTheoryNamingProfile
	_jsii_.Get(
		j,
		"namingProfile",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Pins() *map[string]*string {
	var returns *map[string]*string
	_jsii_.Get(
		j,
		"pins",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Region() *string {
	var returns *string
	_jsii_.Get(
		j,
		"region",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) RetentionDays() *float64 {
	var returns *float64
	_jsii_.Get(
		j,
		"retentionDays",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) Stage() *string {
	var returns *string
	_jsii_.Get(
		j,
		"stage",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryNamingContext) StandardLogging() *bool {
	var returns *bool
	_jsii_.Get(
		j,
		"standardLogging",
		&returns,
	)
	return returns
}

func NewAppTheoryNamingContext(scope constructs.Construct, id *string, props *AppTheoryNamingContextProps) AppTheoryNamingContext {
	_init_.Initialize()

	if err := validateNewAppTheoryNamingContextParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryNamingContext{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryNamingContext",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryNamingContext_Override(a AppTheoryNamingContext, scope constructs.Construct, id *string, props *AppTheoryNamingContextProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryNamingContext",
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
func AppTheoryNamingContext_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryNamingContext_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryNamingContext",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) DeclareFixedName(resourceType *string, name *string, resource constructs.IConstruct) {
	if err := a.validateDeclareFixedNameParameters(resourceType, name, resource); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"declareFixedName",
		[]interface{}{resourceType, name, resource},
	)
}

func (a *jsiiProxy_AppTheoryNamingContext) DeclareName(resourceType *string, logical *string, resource constructs.IConstruct) {
	if err := a.validateDeclareNameParameters(resourceType, logical, resource); err != nil {
		panic(err)
	}
	_jsii_.InvokeVoid(
		a,
		"declareName",
		[]interface{}{resourceType, logical, resource},
	)
}

func (a *jsiiProxy_AppTheoryNamingContext) LogGroupName(logical *string) *string {
	if err := a.validateLogGroupNameParameters(logical); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.Invoke(
		a,
		"logGroupName",
		[]interface{}{logical},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) LogSourcePrefix() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"logSourcePrefix",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) PhysicalName(resourceType *string, logical *string) *AppTheoryPhysicalName {
	if err := a.validatePhysicalNameParameters(resourceType, logical); err != nil {
		panic(err)
	}
	var returns *AppTheoryPhysicalName

	_jsii_.Invoke(
		a,
		"physicalName",
		[]interface{}{resourceType, logical},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) Values() *AppTheoryNamingContextValues {
	var returns *AppTheoryNamingContextValues

	_jsii_.Invoke(
		a,
		"values",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryNamingContext) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
