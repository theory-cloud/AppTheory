//go:build no_runtime_type_checking

package apptheorycdk

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryS3VersionedIngress) validateGrantUploadParameters(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) error {
	return nil
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) validateGrantVersionedReadParameters(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) error {
	return nil
}

func validateAppTheoryS3VersionedIngress_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryS3VersionedIngressParameters(scope constructs.Construct, id *string, props *AppTheoryS3VersionedIngressProps) error {
	return nil
}
