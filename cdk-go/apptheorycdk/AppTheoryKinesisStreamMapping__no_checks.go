//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryKinesisStreamMapping_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryKinesisStreamMappingParameters(scope constructs.Construct, id *string, props *AppTheoryKinesisStreamMappingProps) error {
	return nil
}
