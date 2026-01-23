//go:build !no_runtime_type_checking

package apptheorycdk

import (
	"fmt"

	_jsii_ "github.com/aws/jsii-runtime-go/runtime"

	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/constructs-go/constructs/v10"
)

func (a *jsiiProxy_AppTheoryHostedZone) validateAddCnameRecordParameters(recordName *string, domainName *string, ttl awscdk.Duration) error {
	if recordName == nil {
		return fmt.Errorf("parameter recordName is required, but nil was provided")
	}

	if domainName == nil {
		return fmt.Errorf("parameter domainName is required, but nil was provided")
	}

	if ttl == nil {
		return fmt.Errorf("parameter ttl is required, but nil was provided")
	}

	return nil
}

func (a *jsiiProxy_AppTheoryHostedZone) validateAddNsRecordParameters(recordName *string, targetNameServers *[]*string, ttl awscdk.Duration) error {
	if recordName == nil {
		return fmt.Errorf("parameter recordName is required, but nil was provided")
	}

	if targetNameServers == nil {
		return fmt.Errorf("parameter targetNameServers is required, but nil was provided")
	}

	if ttl == nil {
		return fmt.Errorf("parameter ttl is required, but nil was provided")
	}

	return nil
}

func validateAppTheoryHostedZone_IsConstructParameters(x interface{}) error {
	if x == nil {
		return fmt.Errorf("parameter x is required, but nil was provided")
	}

	return nil
}

func validateNewAppTheoryHostedZoneParameters(scope constructs.Construct, id *string, props *AppTheoryHostedZoneProps) error {
	if scope == nil {
		return fmt.Errorf("parameter scope is required, but nil was provided")
	}

	if id == nil {
		return fmt.Errorf("parameter id is required, but nil was provided")
	}

	if props == nil {
		return fmt.Errorf("parameter props is required, but nil was provided")
	}
	if err := _jsii_.ValidateStruct(props, func() string { return "parameter props" }); err != nil {
		return err
	}

	return nil
}
