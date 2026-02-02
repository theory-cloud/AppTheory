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
	// Response headers policy for this SPA behavior.
	//
	// Overrides `spaResponseHeadersPolicy` and `responseHeadersPolicy` (legacy).
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
	// SPA rewrite mode.
	//
	// - `SPA`: rewrite extensionless routes to the SPA's `index.html`
	// - `NONE`: do not rewrite routes (useful for multi-page sites).
	// Default: AppTheorySpaRewriteMode.SPA
	//
	RewriteMode AppTheorySpaRewriteMode `field:"optional" json:"rewriteMode" yaml:"rewriteMode"`
	// Whether to strip the SPA prefix before forwarding to the S3 origin.
	//
	// Example:
	// - Request: `/auth/assets/app.js`
	// - With `stripPrefixBeforeOrigin=true`, S3 receives: `/assets/app.js`
	//
	// This allows laying out the SPA bucket at root while still serving it under a prefix.
	// Default: false.
	//
	StripPrefixBeforeOrigin *bool `field:"optional" json:"stripPrefixBeforeOrigin" yaml:"stripPrefixBeforeOrigin"`
}
