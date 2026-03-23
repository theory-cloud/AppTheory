package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
)

// Configuration for path patterns that should bypass SPA routing and go directly to the API origin.
type ApiBypassConfig struct {
	// Path pattern that should route to the API origin instead of SPA (e.g., "/auth/wallet/*").
	PathPattern *string `field:"required" json:"pathPattern" yaml:"pathPattern"`
	// Optional cache policy override.
	//
	// Defaults to CACHING_DISABLED.
	CachePolicy awscloudfront.ICachePolicy `field:"optional" json:"cachePolicy" yaml:"cachePolicy"`
	// Optional origin request policy override.
	OriginRequestPolicy awscloudfront.IOriginRequestPolicy `field:"optional" json:"originRequestPolicy" yaml:"originRequestPolicy"`
	// Response headers policy for this API bypass behavior.
	//
	// Overrides `apiBypassResponseHeadersPolicy` and `responseHeadersPolicy` (legacy).
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
}
