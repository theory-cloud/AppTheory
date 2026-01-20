//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryApp_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryAppParameters(scope constructs.Construct, id *string, props *AppTheoryAppProps) error {
	return nil
}
