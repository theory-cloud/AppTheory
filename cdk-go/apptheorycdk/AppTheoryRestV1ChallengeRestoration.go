package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6/jsii"

	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6/internal"
)

// A framework CloudFront front door that restores the canonical `WWW-Authenticate` challenge for an AWS API Gateway REST API v1 origin.
//
// AWS REST API v1 remaps the origin's `WWW-Authenticate` response header onto
// `x-amzn-remapped-www-authenticate`, so a canonical-only app loses the
// challenge at the edge. This construct fronts the REST v1 `execute-api` origin
// with a CloudFront distribution whose origin-response Lambda@Edge function
// copies the first present source back onto `WWW-Authenticate` and removes the
// consumed source headers.
//
// The restore **source set**, in priority order, is:
//
//  1. `x-amzn-remapped-www-authenticate` — the artifact AWS itself produces when
//     REST v1 remaps the origin header. Always consulted.
//  2. the bridge aliases `x-theory-www-authenticate`, then
//     `mcp-www-authenticate` — consulted only when the optional alias bridge is
//     enabled (off by default).
//
// ## The direct-endpoint caveat (DD-2)
//
// A CloudFront front door does **not** by itself make the origin unreachable.
// The REST API keeps answering at its own
// `<restApiId>.execute-api.<region>.<urlSuffix>` endpoint, which is exactly the
// origin this distribution uses, so a client that skips the distribution still
// reaches the origin and observes a **challenge-less `401`** for a REST v1
// canonical-only app — the restoration never runs, and any edge-only control
// (throttling at the edge, edge observability, the alias bridge) is bypassed on
// that path. Authentication itself is unaffected: the runtime bearer gate still
// refuses the request at the origin, so this is challenge loss and edge bypass,
// not an authentication bypass.
//
// `originReachability` is therefore **required** (DD-2's mandatory
// direct-origin decision):
//
//   - `DISABLED` — the REST API's `execute-api` default endpoint is disabled. The
//     caller asserts it (`disableExecuteApiEndpointAsserted: true`) because this
//     construct cannot mutate an external `IRestApi`. The construct does not
//     verify the assertion, and the disabled hostname is the distribution's own
//     origin hostname, so an app that disables the default endpoint must front the
//     origin through a custom domain.
//   - `LOCKED` — the origin is reachable only through this distribution. The
//     construct injects `originLock.secret` as a custom origin header on every
//     request to the origin, and the caller asserts
//     (`originLock.asserted: true`) that the REST API verifies that header; the
//     construct cannot attach the verification to an external `IRestApi`.
//
// A directly reachable origin (`direct`) is refused at synthesis. The decision
// is recorded in the distribution's CloudFormation metadata
// (`apptheory:rest-v1-challenge-restoration`), so the posture is auditable from
// the synthesized template.
//
// The derived route set and the explicit ordered cache behaviors come from the
// shared route algebra (`AppTheoryMcpRouteAlgebra`), so the construct is never
// hand-wired. Parameterized derived routes (those carrying a `{parameter}`
// segment) cannot be expressed as CloudFront path patterns and are therefore
// covered by the distribution's default behavior.
type AppTheoryRestV1ChallengeRestoration interface {
	constructs.Construct
	// True when the optional alias bridge is enabled.
	AliasBridgeEnabled() *bool
	// The subset of `derivedRoutePaths` emitted as explicit ordered cache behaviors (the literal paths, with no `{parameter}` segment).
	//
	// CloudFront path patterns cannot express a `{param}` segment, so
	// parameterized derived routes are covered by the default behavior.
	BehaviorPathPatterns() *[]*string
	// The complete route set derived from the shared route algebra (parameterized routes included), deduped and in deterministic sorted order.
	DerivedRoutePaths() *[]*string
	// The CloudFront distribution fronting the REST v1 origin.
	Distribution() awscloudfront.Distribution
	// The tree node.
	Node() constructs.Node
	// The origin-lock header name injected on every request to the origin, or `undefined` when the decision is `DISABLED`.
	OriginLockHeaderName() *string
	// The recorded DD-2 direct-origin reachability decision.
	OriginReachability() AppTheoryRestV1OriginReachability
	// The response headers the restoration function consults, in priority order.
	//
	// `["x-amzn-remapped-www-authenticate"]` when the alias bridge is disabled;
	// `["x-amzn-remapped-www-authenticate", "x-theory-www-authenticate",
	// "mcp-www-authenticate"]` when it is enabled.
	RestoreSourceHeaders() *[]*string
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

// The jsii proxy struct for AppTheoryRestV1ChallengeRestoration
type jsiiProxy_AppTheoryRestV1ChallengeRestoration struct {
	internal.Type__constructsConstruct
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) AliasBridgeEnabled() *bool {
	var returns *bool
	_jsii_.Get(
		j,
		"aliasBridgeEnabled",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) BehaviorPathPatterns() *[]*string {
	var returns *[]*string
	_jsii_.Get(
		j,
		"behaviorPathPatterns",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) DerivedRoutePaths() *[]*string {
	var returns *[]*string
	_jsii_.Get(
		j,
		"derivedRoutePaths",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) Distribution() awscloudfront.Distribution {
	var returns awscloudfront.Distribution
	_jsii_.Get(
		j,
		"distribution",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) Node() constructs.Node {
	var returns constructs.Node
	_jsii_.Get(
		j,
		"node",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) OriginLockHeaderName() *string {
	var returns *string
	_jsii_.Get(
		j,
		"originLockHeaderName",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) OriginReachability() AppTheoryRestV1OriginReachability {
	var returns AppTheoryRestV1OriginReachability
	_jsii_.Get(
		j,
		"originReachability",
		&returns,
	)
	return returns
}

func (j *jsiiProxy_AppTheoryRestV1ChallengeRestoration) RestoreSourceHeaders() *[]*string {
	var returns *[]*string
	_jsii_.Get(
		j,
		"restoreSourceHeaders",
		&returns,
	)
	return returns
}

func NewAppTheoryRestV1ChallengeRestoration(scope constructs.Construct, id *string, props *AppTheoryRestV1ChallengeRestorationProps) AppTheoryRestV1ChallengeRestoration {
	_init_.Initialize()

	if err := validateNewAppTheoryRestV1ChallengeRestorationParameters(scope, id, props); err != nil {
		panic(err)
	}
	j := jsiiProxy_AppTheoryRestV1ChallengeRestoration{}

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration",
		[]interface{}{scope, id, props},
		&j,
	)

	return &j
}

func NewAppTheoryRestV1ChallengeRestoration_Override(a AppTheoryRestV1ChallengeRestoration, scope constructs.Construct, id *string, props *AppTheoryRestV1ChallengeRestorationProps) {
	_init_.Initialize()

	_jsii_.Create(
		"@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration",
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
func AppTheoryRestV1ChallengeRestoration_IsConstruct(x interface{}) *bool {
	_init_.Initialize()

	if err := validateAppTheoryRestV1ChallengeRestoration_IsConstructParameters(x); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration",
		"isConstruct",
		[]interface{}{x},
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRestV1ChallengeRestoration) ToString() *string {
	var returns *string

	_jsii_.Invoke(
		a,
		"toString",
		nil, // no parameters
		&returns,
	)

	return returns
}

func (a *jsiiProxy_AppTheoryRestV1ChallengeRestoration) With(mixins ...constructs.IMixin) constructs.IConstruct {
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
