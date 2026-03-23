//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryWebSocketApi_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryWebSocketApiParameters(scope constructs.Construct, id *string, props *AppTheoryWebSocketApiProps) error {
	return nil
}

