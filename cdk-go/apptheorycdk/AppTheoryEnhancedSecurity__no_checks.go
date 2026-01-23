//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateAddCustomSecurityRuleParameters(rule *AppTheorySecurityRule, direction *string) error {
	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateSecretParameters(name *string) error {
	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateSecurityMetricParameters(name *string) error {
	return nil
}

func (a *jsiiProxy_AppTheoryEnhancedSecurity) validateVpcEndpointParameters(name *string) error {
	return nil
}

func validateAppTheoryEnhancedSecurity_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryEnhancedSecurityParameters(scope constructs.Construct, id *string, props *AppTheoryEnhancedSecurityProps) error {
	return nil
}
