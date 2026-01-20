//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryQueueProcessor_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryQueueProcessorParameters(scope constructs.Construct, id *string, props *AppTheoryQueueProcessorProps) error {
	return nil
}
