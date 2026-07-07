package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
)

type AppTheoryHttpApiCorsOptions struct {
	// Whether browsers may send credentials.
	// Default: false.
	//
	AllowCredentials *bool `field:"optional" json:"allowCredentials" yaml:"allowCredentials"`
	// Allowed headers.
	// Default: ["content-type", "authorization", "x-request-id", "x-tenant-id"].
	//
	AllowHeaders *[]*string `field:"optional" json:"allowHeaders" yaml:"allowHeaders"`
	// Allowed HTTP methods.
	// Default: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].
	//
	AllowMethods *[]*string `field:"optional" json:"allowMethods" yaml:"allowMethods"`
	// Allowed origins.
	// Default: ["*"].
	//
	AllowOrigins *[]*string `field:"optional" json:"allowOrigins" yaml:"allowOrigins"`
	// Exposed response headers.
	// Default: ["x-request-id"].
	//
	ExposeHeaders *[]*string `field:"optional" json:"exposeHeaders" yaml:"exposeHeaders"`
	// Browser preflight cache duration.
	// Default: Duration.minutes(10)
	//
	MaxAge awscdk.Duration `field:"optional" json:"maxAge" yaml:"maxAge"`
}
