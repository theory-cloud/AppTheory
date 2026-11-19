//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"
)

func validateAppTheoryResourceNaming_CompileVisibilityPolicyJsonParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	if rules == nil {
		return fmt.Errorf("parameter rules is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_KeeperDecisionParameters(logical *string, awsResult *string, rules *AppTheoryVisibilityRules) error {
	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	if awsResult == nil {
		return fmt.Errorf("parameter awsResult is required, but nil was provided")
	}

	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_LogGroupNameParameters(values *AppTheoryNamingContextValues, logical *string) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_LogSourcePrefixParameters(values *AppTheoryNamingContextValues) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_ManifestJsonParameters(manifest *AppTheoryVisibilityManifest) error {
	if manifest == nil {
		return fmt.Errorf("parameter manifest is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(manifest, func() string { return "parameter manifest" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_PhysicalNameParameters(values *AppTheoryNamingContextValues, resourceType *string, logical *string) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	if resourceType == nil {
		return fmt.Errorf("parameter resourceType is required, but nil was provided")
	}

	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_RuleVersionParameters(rules *AppTheoryVisibilityRules) error {
	if rules == nil {
		return fmt.Errorf("parameter rules is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_S3AccountRegionalSuffixParameters(values *AppTheoryNamingContextValues) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_SelectorMatchesParameters(selector *string, logical *string) error {
	if selector == nil {
		return fmt.Errorf("parameter selector is required, but nil was provided")
	}

	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_SourceVisibleParameters(rules *AppTheoryVisibilityRules, logical *string) error {
	if rules == nil {
		return fmt.Errorf("parameter rules is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_ValidateContextParameters(values *AppTheoryNamingContextValues) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	return nil
}

func validateAppTheoryResourceNaming_ValidateSelectorParameters(selector *string) error {
	if selector == nil {
		return fmt.Errorf("parameter selector is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_VisibilityManifestParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	if rules == nil {
		return fmt.Errorf("parameter rules is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	if sources == nil {
		return fmt.Errorf("parameter sources is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryResourceNaming_VisibilityPreviewParameters(values *AppTheoryNamingContextValues, rules *AppTheoryVisibilityRules, sources *[]*string) error {
	if values == nil {
		return fmt.Errorf("parameter values is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(values, func() string { return "parameter values" }); err != nil {
		return err
	}

	if rules == nil {
		return fmt.Errorf("parameter rules is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rules, func() string { return "parameter rules" }); err != nil {
		return err
	}

	if sources == nil {
		return fmt.Errorf("parameter sources is required, but nil was provided")
	}

	return nil
}
