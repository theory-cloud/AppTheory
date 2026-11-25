//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryNamingContext) validateDeclareFixedNameParameters(resourceType *string, name *string, resource constructs.IConstruct) error {
	return nil
}

func (a *jsiiProxy_AppTheoryNamingContext) validateDeclareNameParameters(resourceType *string, logical *string, resource constructs.IConstruct) error {
	return nil
}

func (a *jsiiProxy_AppTheoryNamingContext) validateLogGroupNameParameters(logical *string) error {
	return nil
}

func (a *jsiiProxy_AppTheoryNamingContext) validatePhysicalNameParameters(resourceType *string, logical *string) error {
	return nil
}

func validateAppTheoryNamingContext_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryNamingContextParameters(scope constructs.Construct, id *string, props *AppTheoryNamingContextProps) error {
	return nil
}
