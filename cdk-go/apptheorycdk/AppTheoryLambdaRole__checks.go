//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/constructs-go/constructs/v10"
)

func (a *jsiiProxy_AppTheoryLambdaRole) validateAddManagedPolicyParameters(policy awsiam.IManagedPolicy) error {
	if policy == nil {
		return fmt.Errorf("parameter policy is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateAddToPolicyParameters(statement awsiam.PolicyStatement) error {
	if statement == nil {
		return fmt.Errorf("parameter statement is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateGrantAssumeRoleParameters(grantee awsiam.IPrincipal) error {
	if grantee == nil {
		return fmt.Errorf("parameter grantee is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryLambdaRole) validateGrantPassRoleParameters(grantee awsiam.IPrincipal) error {
	if grantee == nil {
		return fmt.Errorf("parameter grantee is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryLambdaRole_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryLambdaRoleParameters(scope constructs.Construct, id *string, props *AppTheoryLambdaRoleProps) error {
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
