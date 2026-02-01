//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryRestApiRouter) validateAddLambdaIntegrationParameters(path *string, methods *[]*string, handler awslambda.IFunction, options *AppTheoryRestApiRouterIntegrationOptions) error {
	return nil
}

func validateAppTheoryRestApiRouter_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryRestApiRouterParameters(scope constructs.Construct, id *string, props *AppTheoryRestApiRouterProps) error {
	return nil
}

