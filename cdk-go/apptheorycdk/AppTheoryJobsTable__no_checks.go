//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryJobsTable) validateBindEnvironmentParameters(fn awslambda.Function) error {
	return nil
}

func (a *jsiiProxy_AppTheoryJobsTable) validateGrantReadToParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryJobsTable) validateGrantReadWriteToParameters(grantee awsiam.IGrantable) error {
	return nil
}

func (a *jsiiProxy_AppTheoryJobsTable) validateGrantWriteToParameters(grantee awsiam.IGrantable) error {
	return nil
}

func validateAppTheoryJobsTable_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryJobsTableParameters(scope constructs.Construct, id *string, props *AppTheoryJobsTableProps) error {
	return nil
}
