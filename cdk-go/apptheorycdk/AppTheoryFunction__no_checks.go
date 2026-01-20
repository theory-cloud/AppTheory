//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryFunction_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryFunctionParameters(scope constructs.Construct, id *string, props *AppTheoryFunctionProps) error {
	return nil
}

