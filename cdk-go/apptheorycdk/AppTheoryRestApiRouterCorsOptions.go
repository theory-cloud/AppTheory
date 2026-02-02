package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
)

// CORS configuration for the REST API router.
type AppTheoryRestApiRouterCorsOptions struct {
	// Whether to allow credentials.
	// Default: false.
	//
	AllowCredentials *bool `field:"optional" json:"allowCredentials" yaml:"allowCredentials"`
	// Allowed headers.
	// Default: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'].
	//
	AllowHeaders *[]*string `field:"optional" json:"allowHeaders" yaml:"allowHeaders"`
	// Allowed HTTP methods.
	// Default: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'].
	//
	AllowMethods *[]*string `field:"optional" json:"allowMethods" yaml:"allowMethods"`
	// Allowed origins.
	// Default: ['*'].
	//
	AllowOrigins *[]*string `field:"optional" json:"allowOrigins" yaml:"allowOrigins"`
	// Max age for preflight cache in seconds.
	// Default: 600.
	//
	MaxAge awscdk.Duration `field:"optional" json:"maxAge" yaml:"maxAge"`
}
