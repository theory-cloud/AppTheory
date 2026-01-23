//go:build no_runtime_type_checking

package apptheorycdk

import "github.com/aws/constructs-go/constructs/v10"

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryEventBridgeHandler_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryEventBridgeHandlerParameters(scope constructs.Construct, id *string, props *AppTheoryEventBridgeHandlerProps) error {
	return nil
}
