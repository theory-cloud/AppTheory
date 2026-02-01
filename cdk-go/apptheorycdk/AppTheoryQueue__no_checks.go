//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryQueue) validateGrantConsumeMessagesParameters(grantee awslambda.IFunction) error {
	return nil
}

func (a *jsiiProxy_AppTheoryQueue) validateGrantPurgeParameters(grantee awslambda.IFunction) error {
	return nil
}

func (a *jsiiProxy_AppTheoryQueue) validateGrantSendMessagesParameters(grantee awslambda.IFunction) error {
	return nil
}

func validateAppTheoryQueue_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryQueueParameters(scope constructs.Construct, id *string, props *AppTheoryQueueProps) error {
	return nil
}

