//go:build no_runtime_type_checking

package apptheorycdk

import "github.com/aws/constructs-go/constructs/v10"

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryRestApi) validateAddRouteParameters(path *string, options *AppTheoryRestApiRouteOptions) error {
	return nil
}

func validateAppTheoryRestApi_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryRestApiParameters(scope constructs.Construct, id *string, props *AppTheoryRestApiProps) error {
	return nil
}
