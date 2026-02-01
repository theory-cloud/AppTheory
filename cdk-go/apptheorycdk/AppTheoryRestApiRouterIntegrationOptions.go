package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
)

// Options for adding a Lambda integration to a route.
type AppTheoryRestApiRouterIntegrationOptions struct {
	// Passthrough behavior for the integration.
	// Default: WHEN_NO_MATCH.
	//
	PassthroughBehavior awsapigateway.PassthroughBehavior `field:"optional" json:"passthroughBehavior" yaml:"passthroughBehavior"`
	// Request templates for the integration.
	// Default: undefined (use Lambda proxy integration).
	//
	RequestTemplates *map[string]*string `field:"optional" json:"requestTemplates" yaml:"requestTemplates"`
	// Enable response streaming for this route.
	//
	// When enabled:
	// - ResponseTransferMode is set to STREAM
	// - The Lambda invocation URI uses /response-streaming-invocations
	// - Timeout is set to 15 minutes (900000ms).
	// Default: false.
	//
	Streaming *bool `field:"optional" json:"streaming" yaml:"streaming"`
	// Custom integration timeout.
	//
	// For streaming routes, defaults to 15 minutes.
	// For non-streaming routes, defaults to 29 seconds.
	Timeout awscdk.Duration `field:"optional" json:"timeout" yaml:"timeout"`
}

