//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryLambdaRole) validateAddManagedPolicyParameters(policy awsiam.IManagedPolicy) error {
	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateAddToPolicyParameters(statement awsiam.PolicyStatement) error {
	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateGrantAssumeRoleParameters(grantee awsiam.IPrincipal) error {
	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateGrantPassRoleParameters(grantee awsiam.IPrincipal) error {
	return nil
}

func validateAppTheoryLambdaRole_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryLambdaRoleParameters(scope constructs.Construct, id *string, props *AppTheoryLambdaRoleProps) error {
	return nil
}
