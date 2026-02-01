package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
)

type AppTheoryPathRoutedFrontendProps struct {
	// The primary API origin URL (e.g., the API Gateway invoke URL or Lambda function URL). This is used for the default behavior and any API bypass paths.
	ApiOriginUrl *string `field:"required" json:"apiOriginUrl" yaml:"apiOriginUrl"`
	// API bypass configurations for paths that should go directly to the API origin even though they might match an SPA path prefix.
	//
	// These are evaluated before SPA paths due to CloudFront behavior precedence.
	ApiBypassPaths *[]*ApiBypassConfig `field:"optional" json:"apiBypassPaths" yaml:"apiBypassPaths"`
	// Origin request policy for the API origin (default behavior).
	ApiOriginRequestPolicy awscloudfront.IOriginRequestPolicy `field:"optional" json:"apiOriginRequestPolicy" yaml:"apiOriginRequestPolicy"`
	// Whether to auto-delete objects in created buckets on stack deletion.
	//
	// Only applies when removalPolicy is DESTROY.
	// Default: false.
	//
	AutoDeleteObjects *bool `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
	// An optional name/comment for the distribution.
	Comment *string `field:"optional" json:"comment" yaml:"comment"`
	// Domain configuration for custom domain, certificate, and Route53.
	Domain *PathRoutedFrontendDomainConfig `field:"optional" json:"domain" yaml:"domain"`
	// Enable CloudFront access logging.
	// Default: true.
	//
	EnableLogging *bool `field:"optional" json:"enableLogging" yaml:"enableLogging"`
	// Optional S3 bucket for CloudFront access logs.
	//
	// If not provided and enableLogging is true, a new bucket will be created.
	LogsBucket awss3.IBucket `field:"optional" json:"logsBucket" yaml:"logsBucket"`
	// Price class for the CloudFront distribution.
	// Default: PriceClass.PRICE_CLASS_ALL
	//
	PriceClass awscloudfront.PriceClass `field:"optional" json:"priceClass" yaml:"priceClass"`
	// Removal policy for created resources.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Response headers policy to apply to all behaviors.
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
	// SPA origins with their path patterns.
	//
	// Each SPA will be served via CloudFront with SPA rewrite support.
	SpaOrigins *[]*SpaOriginConfig `field:"optional" json:"spaOrigins" yaml:"spaOrigins"`
	// Optional web ACL ID for AWS WAF integration.
	WebAclId *string `field:"optional" json:"webAclId" yaml:"webAclId"`
}
