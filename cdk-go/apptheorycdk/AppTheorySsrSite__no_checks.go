//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheorySsrSite_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheorySsrSiteParameters(scope constructs.Construct, id *string, props *AppTheorySsrSiteProps) error {
	return nil
}

