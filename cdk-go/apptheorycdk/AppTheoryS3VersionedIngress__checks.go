//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/constructs-go/constructs/v10"
)

func (a *jsiiProxy_AppTheoryS3VersionedIngress) validateGrantUploadParameters(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) error {
	if grantee == nil {
		return fmt.Errorf("parameter grantee is required, but nil was provided")
	}

	if namespaceSlug == nil {
		return fmt.Errorf("parameter namespaceSlug is required, but nil was provided")
	}

	if bundleId == nil {
		return fmt.Errorf("parameter bundleId is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryS3VersionedIngress) validateGrantVersionedReadParameters(grantee awsiam.IGrantable, namespaceSlug *string, bundleId *string) error {
	if grantee == nil {
		return fmt.Errorf("parameter grantee is required, but nil was provided")
	}

	if namespaceSlug == nil {
		return fmt.Errorf("parameter namespaceSlug is required, but nil was provided")
	}

	if bundleId == nil {
		return fmt.Errorf("parameter bundleId is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryS3VersionedIngress_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryS3VersionedIngressParameters(scope constructs.Construct, id *string, props *AppTheoryS3VersionedIngressProps) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if err := _jsii_.ValidateStruct(props, func() string { return "parameter props" }); err != nil {
		return err
	}

	return nil
}
