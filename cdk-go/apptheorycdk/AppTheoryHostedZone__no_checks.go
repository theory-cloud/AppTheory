//go:build no_runtime_type_checking

package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/constructs-go/constructs/v10"
)

// Building without runtime type checking enabled, so all the below just return nil

func (a *jsiiProxy_AppTheoryHostedZone) validateAddCnameRecordParameters(recordName *string, domainName *string, ttl awscdk.Duration) error {
	return nil
}

func (a *jsiiProxy_AppTheoryHostedZone) validateAddNsRecordParameters(recordName *string, targetNameServers *[]*string, ttl awscdk.Duration) error {
	return nil
}

func validateAppTheoryHostedZone_IsConstructParameters(x interface{}) error {
	return nil
}

func validateNewAppTheoryHostedZoneParameters(scope constructs.Construct, id *string, props *AppTheoryHostedZoneProps) error {
	return nil
}
