//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryRemoteMcpServer_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryRemoteMcpServerParameters(scope constructs.Construct, id *string, props *AppTheoryRemoteMcpServerProps) error {
	return nil
}

