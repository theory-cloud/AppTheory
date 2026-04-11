//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateAddToRolePolicyParameters(statement awsiam.PolicyStatement) error {
	return nil
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateGrantDynamoReadParameters(table awsdynamodb.ITable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateGrantDynamoWriteParameters(table awsdynamodb.ITable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateGrantS3ReadParameters(bucket awss3.IBucket) error {
	return nil
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateGrantS3WriteParameters(bucket awss3.IBucket) error {
	return nil
}

func (a *jsiiProxy_AppTheoryCodeBuildJobRunner) validateGrantSecretReadParameters(secret awssecretsmanager.ISecret) error {
	return nil
}

func validateAppTheoryCodeBuildJobRunner_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryCodeBuildJobRunnerParameters(scope constructs.Construct, id *string, props *AppTheoryCodeBuildJobRunnerProps) error {
	return nil
}

