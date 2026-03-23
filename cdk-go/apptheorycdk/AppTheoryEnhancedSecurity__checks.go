//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/constructs-go/constructs/v10"
)

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateAddCustomSecurityRuleParameters(rule *AppTheorySecurityRule, direction *string) error {
	if rule == nil {
		return fmt.Errorf("parameter rule is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(rule, func() string { return "parameter rule" }); err != nil {
		return err
	}

	if direction == nil {
		return fmt.Errorf("parameter direction is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateSecretParameters(name *string) error {
	if name == nil {
		return fmt.Errorf("parameter name is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateSecurityMetricParameters(name *string) error {
	if name == nil {
		return fmt.Errorf("parameter name is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateVpcEndpointParameters(name *string) error {
	if name == nil {
		return fmt.Errorf("parameter name is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryEnhancedSecurity_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryEnhancedSecurityParameters(scope constructs.Construct, id *string, props *AppTheoryEnhancedSecurityProps) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if props == nil {
		return fmt.Errorf("parameter props is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(props, func() string { return "parameter props" }); err != nil {
		return err
	}

	return nil
}
