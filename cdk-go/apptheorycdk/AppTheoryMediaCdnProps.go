package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
)

type AppTheoryMediaCdnProps struct {
	// Allowed HTTP methods for the distribution.
	// Default: AllowedMethods.ALLOW_GET_HEAD_OPTIONS
	//
	AllowedMethods awscloudfront.AllowedMethods `field:"optional" json:"allowedMethods" yaml:"allowedMethods"`
	// Whether to auto-delete objects in created buckets on stack deletion.
	//
	// Only applies when removalPolicy is DESTROY.
	// Default: false.
	//
	AutoDeleteObjects *bool `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
	// Optional existing S3 bucket to use as the media origin.
	//
	// If not provided, a new bucket will be created.
	Bucket awss3.IBucket `field:"optional" json:"bucket" yaml:"bucket"`
	// Name for the media bucket (only used if bucket is not provided).
	BucketName *string `field:"optional" json:"bucketName" yaml:"bucketName"`
	// Cache policy for the default behavior.
	// Default: CachePolicy.CACHING_OPTIMIZED
	//
	CachePolicy awscloudfront.ICachePolicy `field:"optional" json:"cachePolicy" yaml:"cachePolicy"`
	// An optional name/comment for the distribution.
	Comment *string `field:"optional" json:"comment" yaml:"comment"`
	// Default root object for the distribution.
	DefaultRootObject *string `field:"optional" json:"defaultRootObject" yaml:"defaultRootObject"`
	// Domain configuration for custom domain, certificate, and Route53.
	Domain *MediaCdnDomainConfig `field:"optional" json:"domain" yaml:"domain"`
	// Enable CloudFront access logging.
	// Default: true.
	//
	EnableLogging *bool `field:"optional" json:"enableLogging" yaml:"enableLogging"`
	// Error responses for the distribution (e.g., custom 404 handling).
	ErrorResponses *[]*awscloudfront.ErrorResponse `field:"optional" json:"errorResponses" yaml:"errorResponses"`
	// Optional S3 bucket for CloudFront access logs.
	//
	// If not provided and enableLogging is true, a new bucket will be created.
	LogsBucket awss3.IBucket `field:"optional" json:"logsBucket" yaml:"logsBucket"`
	// Origin request policy for the default behavior.
	OriginRequestPolicy awscloudfront.IOriginRequestPolicy `field:"optional" json:"originRequestPolicy" yaml:"originRequestPolicy"`
	// Price class for the CloudFront distribution.
	// Default: PriceClass.PRICE_CLASS_ALL
	//
	PriceClass awscloudfront.PriceClass `field:"optional" json:"priceClass" yaml:"priceClass"`
	// Private media configuration for signed URLs/cookies.
	//
	// When configured, the distribution will require authentication.
	PrivateMedia *PrivateMediaConfig `field:"optional" json:"privateMedia" yaml:"privateMedia"`
	// Removal policy for created resources.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Response headers policy to apply to the distribution.
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
	// Optional web ACL ID for AWS WAF integration.
	WebAclId *string `field:"optional" json:"webAclId" yaml:"webAclId"`
}
