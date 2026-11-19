//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryBucket_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryBucketParameters(scope constructs.Construct, id *string, props *AppTheoryBucketProps) error {
	return nil
}
