//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryS3Ingest_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryS3IngestParameters(scope constructs.Construct, id *string, props *AppTheoryS3IngestProps) error {
	return nil
}
