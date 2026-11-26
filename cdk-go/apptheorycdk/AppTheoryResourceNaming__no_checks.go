//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryResourceNaming_CompileVisibilityPolicyJsonParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules) error {
	return nil
}

func validateAppTheoryResourceNaming_DerivedNamesJsonParameters(artifact *AppTheoryDerivedNames) error {
	return nil
}

func validateAppTheoryResourceNaming_KeeperDecisionParameters(rules *AppTheoryVisibilityRules, logical *string, awsResult *string) error {
	return nil
}

func validateAppTheoryResourceNaming_LogGroupNameParameters(values *AppTheoryNamingContextValues, logical *string) error {
	return nil
}

func validateAppTheoryResourceNaming_LogSourcePrefixParameters(values *AppTheoryNamingContextValues) error {
	return nil
}

func validateAppTheoryResourceNaming_ManifestJsonParameters(manifest *AppTheoryVisibilityManifest) error {
	return nil
}

func validateAppTheoryResourceNaming_NamespacedParameters(values *AppTheoryNamingContextValues) error {
	return nil
}

func validateAppTheoryResourceNaming_NamingScopeParameters(resourceType *string) error {
	return nil
}

func validateAppTheoryResourceNaming_PhysicalNameParameters(values *AppTheoryNamingContextValues, resourceType *string, logical *string) error {
	return nil
}

func validateAppTheoryResourceNaming_RuleVersionParameters(rules *AppTheoryVisibilityRules) error {
	return nil
}

func validateAppTheoryResourceNaming_S3AccountRegionalSuffixParameters(values *AppTheoryNamingContextValues) error {
	return nil
}

func validateAppTheoryResourceNaming_SelectorMatchesParameters(selector *string, logical *string) error {
	return nil
}

func validateAppTheoryResourceNaming_SourceVisibleParameters(rules *AppTheoryVisibilityRules, logical *string) error {
	return nil
}

func validateAppTheoryResourceNaming_SynthCheckParameters(entries *[]*AppTheoryDerivedNameInput) error {
	return nil
}

func validateAppTheoryResourceNaming_ValidateContextParameters(values *AppTheoryNamingContextValues) error {
	return nil
}

func validateAppTheoryResourceNaming_ValidateHostedNamespaceParameters(namespace *string) error {
	return nil
}

func validateAppTheoryResourceNaming_ValidatePhysicalNameParameters(resourceType *string, name *string) error {
	return nil
}

func validateAppTheoryResourceNaming_ValidateSelectorParameters(selector *string) error {
	return nil
}

func validateAppTheoryResourceNaming_VisibilityManifestParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) error {
	return nil
}

func validateAppTheoryResourceNaming_VisibilityPreviewParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) error {
	return nil
}
