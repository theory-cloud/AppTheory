//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/constructs-go/constructs/v10"
)

func (a *jsiiProxy_AppTheoryNamingContext) validateLogGroupNameParameters(logical *string) error {
	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryNamingContext) validatePhysicalNameParameters(resourceType *string, logical *string) error {
	if resourceType == nil {
		return fmt.Errorf("parameter resourceType is required, but nil was provided")
	}

	if logical == nil {
		return fmt.Errorf("parameter logical is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryNamingContext_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryNamingContextParameters(scope constructs.Construct, id *string, props *AppTheoryNamingContextProps) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if props == nil {
		return fmt.Errorf("parameter props is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(props, func() string { return "parameter props" }); err != nil {
		return err
	}

	return nil
}
