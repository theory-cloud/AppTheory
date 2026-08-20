//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryInstallParameters_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryInstallParametersParameters(scope constructs.Construct, id *string) error {
	return nil
}
