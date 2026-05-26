package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awskinesis"
)

// Properties for AppTheoryCloudWatchLogsDestination.
type AppTheoryCloudWatchLogsDestinationProps struct {
	// Kinesis Data Stream that receives CloudWatch Logs subscription records.
	Stream awskinesis.IStream `field:"required" json:"stream" yaml:"stream"`
	// Explicit AWS Organizations IDs allowed to create subscription filters against this destination.
	//
	// Organization entries use a wildcard principal only with an `aws:PrincipalOrgID` condition.
	// At least one allowed source account or organization ID is required.
	// Default: [].
	//
	AllowedOrganizationIds *[]*string `field:"optional" json:"allowedOrganizationIds" yaml:"allowedOrganizationIds"`
	// Explicit AWS account IDs allowed to create subscription filters against this destination.
	//
	// At least one allowed source account or organization ID is required. AppTheory does not
	// synthesize a broad default destination policy.
	// Default: [].
	//
	AllowedSourceAccounts *[]*string `field:"optional" json:"allowedSourceAccounts" yaml:"allowedSourceAccounts"`
	// Optional physical CloudWatch Logs destination name.
	// Default: - deterministic name derived from the construct path.
	//
	DestinationName *string `field:"optional" json:"destinationName" yaml:"destinationName"`
}
