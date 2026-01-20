//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryKmsKey_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryKmsKeyParameters(scope constructs.Construct, id *string, props *AppTheoryKmsKeyProps) error {
	return nil
}
