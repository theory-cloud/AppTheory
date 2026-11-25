package apptheorycdk

import (
	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
	_init_ "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7/jsii"
)

// The `theorycloud_resource_naming.v0.1` primitives, exposed for jsii so the Go and Python CDK bindings share one implementation.
type AppTheoryResourceNaming interface {
}

// The jsii proxy struct for AppTheoryResourceNaming
type jsiiProxy_AppTheoryResourceNaming struct {
	_ byte // padding
}

// Compile the rules into the reader-role inline policy document.
//
// The return
// value is the contract JSON, so a consumer can compare it byte for byte.
func AppTheoryResourceNaming_CompileVisibilityPolicyJson(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_CompileVisibilityPolicyJsonParameters(values, rules); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"compileVisibilityPolicyJson",
		[]interface{}{values, rules},
		&returns,
	)

	return returns
}

// The derived-name artifact as the cloud-assembly metadata document, with the contract's snake_case wire keys and a deterministic entry order.
func AppTheoryResourceNaming_DerivedNamesJson(artifact *AppTheoryDerivedNames) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_DerivedNamesJsonParameters(artifact); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"derivedNamesJson",
		[]interface{}{artifact},
		&returns,
	)

	return returns
}

// Keeper's read decision, in the runtimes' parameter order.
//
// Fails closed on a
// denial or an unreachable account.
func AppTheoryResourceNaming_KeeperDecision(rules *AppTheoryVisibilityRules, logical *string, awsResult *string) AppTheoryKeeperAnswer {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_KeeperDecisionParameters(rules, logical, awsResult); err != nil {
		panic(err)
	}
	var returns AppTheoryKeeperAnswer

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"keeperDecision",
		[]interface{}{rules, logical, awsResult},
		&returns,
	)

	return returns
}

// Map a logical log source to its physical log-group name.
func AppTheoryResourceNaming_LogGroupName(values *AppTheoryNamingContextValues, logical *string) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_LogGroupNameParameters(values, logical); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"logGroupName",
		[]interface{}{values, logical},
		&returns,
	)

	return returns
}

// The bound prefix shared by every log source of the app.
func AppTheoryResourceNaming_LogSourcePrefix(values *AppTheoryNamingContextValues) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_LogSourcePrefixParameters(values); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"logSourcePrefix",
		[]interface{}{values},
		&returns,
	)

	return returns
}

// Serialize a manifest to the contract JSON shape written to SSM.
func AppTheoryResourceNaming_ManifestJson(manifest *AppTheoryVisibilityManifest) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_ManifestJsonParameters(manifest); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"manifestJson",
		[]interface{}{manifest},
		&returns,
	)

	return returns
}

// The scope in which AWS requires a type's names to be unique (contract section 11.1). A type the contract states no scope for is refused: it cannot be reserved, so it cannot be deployed through the index until a revision states its scope.
func AppTheoryResourceNaming_NamingScope(resourceType *string) AppTheoryNamingScope {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_NamingScopeParameters(resourceType); err != nil {
		panic(err)
	}
	var returns AppTheoryNamingScope

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"namingScope",
		[]interface{}{resourceType},
		&returns,
	)

	return returns
}

// Compose the physical name of one resource.
//
// A pin always wins. A generated
// entry means CloudFormation generates the name today and the construct sets
// no physical-name property. Generated entries are legacy-only; a legacy
// profile needs exactly one of a pin or a generated entry.
func AppTheoryResourceNaming_PhysicalName(values *AppTheoryNamingContextValues, resourceType *string, logical *string) *AppTheoryPhysicalName {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_PhysicalNameParameters(values, resourceType, logical); err != nil {
		panic(err)
	}
	var returns *AppTheoryPhysicalName

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"physicalName",
		[]interface{}{values, resourceType, logical},
		&returns,
	)

	return returns
}

// The first 12 hex characters of SHA-256 over the canonical rules.
func AppTheoryResourceNaming_RuleVersion(rules *AppTheoryVisibilityRules) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_RuleVersionParameters(rules); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"ruleVersion",
		[]interface{}{rules},
		&returns,
	)

	return returns
}

// The CloudFormation-appended account-regional bucket suffix.
func AppTheoryResourceNaming_S3AccountRegionalSuffix(values *AppTheoryNamingContextValues) *string {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_S3AccountRegionalSuffixParameters(values); err != nil {
		panic(err)
	}
	var returns *string

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"s3AccountRegionalSuffix",
		[]interface{}{values},
		&returns,
	)

	return returns
}

// Whether a selector matches a logical source.
//
// A trailing `/*` matches
// descendants only.
func AppTheoryResourceNaming_SelectorMatches(selector *string, logical *string) *bool {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_SelectorMatchesParameters(selector, logical); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"selectorMatches",
		[]interface{}{selector, logical},
		&returns,
	)

	return returns
}

// Whether a source is visible: an include matches and no exclude does.
func AppTheoryResourceNaming_SourceVisible(rules *AppTheoryVisibilityRules, logical *string) *bool {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_SourceVisibleParameters(rules, logical); err != nil {
		panic(err)
	}
	var returns *bool

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"sourceVisible",
		[]interface{}{rules, logical},
		&returns,
	)

	return returns
}

// Refuse two different logical resources in one naming context that derive the same name in the same naming scope, and return the derived-name artifact (contract section 11.4). A Lambda function and its IAM role may share a name because their scopes differ, and two APIs may share one because AWS does not keep API names unique. Rows keep the order of the entries.
//
// `logicalId` is the resource's identity inside the naming context: its
// CloudFormation logical id, or the owning stack's construct path plus that
// logical id when the context spans several stacks. A CloudFormation logical id
// is unique only inside one template, so a caller that owns more than one
// template must pass the qualified form; otherwise two resources in different
// stacks with the same local logical id look like one re-declared resource
// (SANITY-AT-N3-05). The returned row echoes the identity it was given.
func AppTheoryResourceNaming_SynthCheck(entries *[]*AppTheoryDerivedNameInput) *[]*AppTheoryDerivedName {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_SynthCheckParameters(entries); err != nil {
		panic(err)
	}
	var returns *[]*AppTheoryDerivedName

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"synthCheck",
		[]interface{}{entries},
		&returns,
	)

	return returns
}

// Validate the bound context grammar.
//
// Throws on an invalid context.
func AppTheoryResourceNaming_ValidateContext(values *AppTheoryNamingContextValues) {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_ValidateContextParameters(values); err != nil {
		panic(err)
	}
	_jsii_.StaticInvokeVoid(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"validateContext",
		[]interface{}{values},
	)
}

// Validate a physical name the contract fixes rather than derives against the character and shape rules of the type's section 2 row: charset, the length range (**both** bounds when the row states a lower one, not only the upper), the S3 start/end rule, the path rules (lead, non-empty segments, depth, reserved prefixes, the `alias/aws/` namespace) and the secret ARN-suffix rule.
//
// Throws on a name outside them.
//
// This is the section 2 table, not a second one: it reads the same rule rows
// the derivation uses. A `log_group` accepts `/` in addition to the section 2
// charset, but only for the two fixed shapes contract section 3 states: a
// log-source name (which carries no `/` at all, because section 3 joins its
// segments with `_`) or the Lambda service path `/aws/lambda/{function name}`,
// whose function name satisfies the `lambda_function` row. Any other
// `/`-bearing log group is refused (SANITY-AT-N3-08).
//
// The check is **structural**: it holds no context values, so it cannot tell
// whether a log-source-shaped name is this naming context's own source. The
// context completes that rule in `AppTheoryNamingContext.declareFixedName`,
// which owns the bound `theorycloud_{namespace}_{app}_{stage}_` prefix
// (SANITY-AT-N3-08, round 4).
func AppTheoryResourceNaming_ValidatePhysicalName(resourceType *string, name *string) {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_ValidatePhysicalNameParameters(resourceType, name); err != nil {
		panic(err)
	}
	_jsii_.StaticInvokeVoid(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"validatePhysicalName",
		[]interface{}{resourceType, name},
	)
}

// Validate one selector.
//
// Throws on a selector outside the grammar.
func AppTheoryResourceNaming_ValidateSelector(selector *string) {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_ValidateSelectorParameters(selector); err != nil {
		panic(err)
	}
	_jsii_.StaticInvokeVoid(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"validateSelector",
		[]interface{}{selector},
	)
}

// Assemble the published manifest (the preview minus `notMatchedNow`).
func AppTheoryResourceNaming_VisibilityManifest(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) *AppTheoryVisibilityManifest {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_VisibilityManifestParameters(values, rules, sources); err != nil {
		panic(err)
	}
	var returns *AppTheoryVisibilityManifest

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"visibilityManifest",
		[]interface{}{values, rules, sources},
		&returns,
	)

	return returns
}

// Assemble the synth-time visibility preview.
func AppTheoryResourceNaming_VisibilityPreview(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) *AppTheoryVisibilityPreview {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_VisibilityPreviewParameters(values, rules, sources); err != nil {
		panic(err)
	}
	var returns *AppTheoryVisibilityPreview

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"visibilityPreview",
		[]interface{}{values, rules, sources},
		&returns,
	)

	return returns
}
