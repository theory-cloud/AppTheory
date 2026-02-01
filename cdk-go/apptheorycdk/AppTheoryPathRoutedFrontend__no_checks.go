//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryPathRoutedFrontend_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryPathRoutedFrontendParameters(scope constructs.Construct, id *string, props *AppTheoryPathRoutedFrontendProps) error {
	return nil
}

