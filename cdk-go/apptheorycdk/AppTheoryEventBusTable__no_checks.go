//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryEventBusTable_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryEventBusTableParameters(scope constructs.Construct, id *string, props *AppTheoryEventBusTableProps) error {
	return nil
}
