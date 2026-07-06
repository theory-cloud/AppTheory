//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryObservability_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryObservabilityParameters(scope constructs.Construct, id *string, props *AppTheoryObservabilityProps) error {
	return nil
}
