package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
)

// Configuration for an SPA origin routed by path prefix.
type SpaOriginConfig struct {
	// S3 bucket containing the SPA assets.
	Bucket awss3.IBucket `field:"required" json:"bucket" yaml:"bucket"`
	// Path pattern to route to this SPA (e.g., "/l/*", "/auth/*"). Must include the trailing wildcard.
	PathPattern *string `field:"required" json:"pathPattern" yaml:"pathPattern"`
	// Optional cache policy override.
	//
	// Defaults to CACHING_OPTIMIZED.
	CachePolicy awscloudfront.ICachePolicy `field:"optional" json:"cachePolicy" yaml:"cachePolicy"`
}
