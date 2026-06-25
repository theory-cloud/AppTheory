//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func validateAppTheoryMicrovmNetworkConnectorReference_AwsManagedParameters(scope constructs.Construct, id *string, connector AppTheoryMicrovmManagedNetworkConnector) error {
	return nil
}

func validateAppTheoryMicrovmNetworkConnectorReference_FromNetworkConnectorArnParameters(scope constructs.Construct, id *string, networkConnectorArn *string) error {
	return nil
}

func validateAppTheoryMicrovmNetworkConnectorReference_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryMicrovmNetworkConnectorReferenceParameters(scope constructs.Construct, id *string, props *AppTheoryMicrovmNetworkConnectorReferenceProps) error {
	return nil
}
