//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryMicrovmController_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryMicrovmControllerParameters(scope constructs.Construct, id *string, props *AppTheoryMicrovmControllerProps) error {
	return nil
}
