//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryHttpIngestionEndpoint_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryHttpIngestionEndpointParameters(scope constructs.Construct, id *string, props *AppTheoryHttpIngestionEndpointProps) error {
	return nil
}
