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

// Keeper's read decision.
//
// Fails closed on a denial or an unreachable account.
func AppTheoryResourceNaming_KeeperDecision(logical *string, awsResult *string, rules *AppTheoryVisibilityRules) AppTheoryKeeperAnswer {
	_init_.Initialize()

	if err := validateAppTheoryResourceNaming_KeeperDecisionParameters(logical, awsResult, rules); err != nil {
		panic(err)
	}
	var returns AppTheoryKeeperAnswer

	_jsii_.StaticInvoke(
		"@theory-cloud/apptheory-cdk.AppTheoryResourceNaming",
		"keeperDecision",
		[]interface{}{logical, awsResult, rules},
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

// Compose the physical name of one resource.
//
// A pin always wins; a legacy
// profile without a pin fails synthesis.
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
