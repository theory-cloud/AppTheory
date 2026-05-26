//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryKinesisStream) validateGrantReadParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryKinesisStream) validateGrantReadWriteParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryKinesisStream) validateGrantWriteParameters(grantee awsiam.IGrantable) error {
	return nil
}

func validateAppTheoryKinesisStream_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryKinesisStreamParameters(scope constructs.Construct, id *string, props *AppTheoryKinesisStreamProps) error {
	return nil
}
