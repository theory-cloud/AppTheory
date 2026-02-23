//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryQueueConsumer_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryQueueConsumerParameters(scope constructs.Construct, id *string, props *AppTheoryQueueConsumerProps) error {
	return nil
}
