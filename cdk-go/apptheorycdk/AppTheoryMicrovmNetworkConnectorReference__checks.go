//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/constructs-go/constructs/v10"
)

func validateAppTheoryMicrovmNetworkConnectorReference_AwsManagedParameters(scope constructs.Construct, id *string, connector AppTheoryMicrovmManagedNetworkConnector) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if connector == "" {
		return fmt.Errorf("parameter connector is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMicrovmNetworkConnectorReference_FromNetworkConnectorArnParameters(scope constructs.Construct, id *string, networkConnectorArn *string) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if networkConnectorArn == nil {
		return fmt.Errorf("parameter networkConnectorArn is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryMicrovmNetworkConnectorReference_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryMicrovmNetworkConnectorReferenceParameters(scope constructs.Construct, id *string, props *AppTheoryMicrovmNetworkConnectorReferenceProps) error {
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
