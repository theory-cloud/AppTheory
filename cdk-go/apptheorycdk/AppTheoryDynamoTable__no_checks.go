//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryDynamoTable_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryDynamoTableParameters(scope constructs.Construct, id *string, props *AppTheoryDynamoTableProps) error {
	return nil
}
