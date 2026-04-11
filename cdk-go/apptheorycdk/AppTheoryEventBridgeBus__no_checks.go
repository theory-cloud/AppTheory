//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryEventBridgeBus) validateAllowAccountParameters(accountId *string) error {
	return nil
}

func validateAppTheoryEventBridgeBus_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryEventBridgeBusParameters(scope constructs.Construct, id *string, props *AppTheoryEventBridgeBusProps) error {
	return nil
}

