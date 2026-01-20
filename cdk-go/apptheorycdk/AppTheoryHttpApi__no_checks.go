//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryHttpApi_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryHttpApiParameters(scope constructs.Construct, id *string, props *AppTheoryHttpApiProps) error {
	return nil
}

