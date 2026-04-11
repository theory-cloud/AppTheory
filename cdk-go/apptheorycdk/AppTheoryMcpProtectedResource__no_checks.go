//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryMcpProtectedResource_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryMcpProtectedResourceParameters(scope constructs.Construct, id *string, props *AppTheoryMcpProtectedResourceProps) error {
	return nil
}

