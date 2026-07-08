//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryVectorIndex) validateBindEnvironmentParameters(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateBindTitanEmbeddingEnvironmentParameters(fn awslambda.Function, options *AppTheoryVectorIndexBindOptions) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateGrantBedrockInvokeModelParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateGrantManageParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateGrantQueryParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateGrantReadVectorsParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryVectorIndex) validateGrantWriteVectorsParameters(grantee awsiam.IGrantable) error {
	return nil
}

func validateAppTheoryVectorIndex_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryVectorIndexParameters(scope constructs.Construct, id *string, props *AppTheoryVectorIndexProps) error {
	return nil
}
