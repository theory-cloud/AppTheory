//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryCertificate) validateAddDependencyParameters(dependency constructs.IConstruct) error {
	return nil
}

func validateAppTheoryCertificate_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryCertificateParameters(scope constructs.Construct, id *string, props *AppTheoryCertificateProps) error {
	return nil
}
