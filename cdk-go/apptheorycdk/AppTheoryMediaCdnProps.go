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
	// CloudFront standard-logging output format for a CloudWatch Logs destination.
	//
	// Only used under the standard logging profile.
	// Default: AppTheoryCloudFrontLogFormat.JSON
	//
	CloudFrontLogFormat AppTheoryCloudFrontLogFormat `field:"optional" json:"cloudFrontLogFormat" yaml:"cloudFrontLogFormat"`
	// An optional name/comment for the distribution.
	Comment *string `field:"optional" json:"comment" yaml:"comment"`
	// Object CloudFront returns for a request to the distribution root.
	//
	// With a derived naming context the default is `index.html`: the default
	// behavior already sends `/` to the S3 bucket through OAC, so the root
	// object rewrite (`/` -> `/index.html`) changes which object that behavior
	// returns, not which origin serves it (Security Hub CloudFront.1).
	// Default: "index.html" under a derived naming context, otherwise undefined
	//
	DefaultRootObject *string `field:"optional" json:"defaultRootObject" yaml:"defaultRootObject"`
	// Domain configuration for custom domain, certificate, and Route53.
	Domain *MediaCdnDomainConfig `field:"optional" json:"domain" yaml:"domain"`
	// Enable CloudFront access logging.
	// Default: true.
	//
	EnableLogging *bool `field:"optional" json:"enableLogging" yaml:"enableLogging"`
	// Error responses for the distribution (e.g., custom 404 handling).
	ErrorResponses *[]*awscloudfront.ErrorResponse `field:"optional" json:"errorResponses" yaml:"errorResponses"`
	// The distribution's logical name.
	//
	// Defaults to the kebab-cased construct id
	// when a naming context is present.
	// Default: undefined.
	//
	LogicalName *string `field:"optional" json:"logicalName" yaml:"logicalName"`
	// Optional S3 bucket for CloudFront access logs.
	//
	// If not provided and enableLogging is true, a new bucket will be created.
	LogsBucket awss3.IBucket `field:"optional" json:"logsBucket" yaml:"logsBucket"`
	// Minimum TLS protocol version for viewers of a custom domain.
	//
	// With a derived naming context and a custom certificate the default is
	// `TLS_V1_2_2025`, the policy Security Hub CloudFront.15 accepts with the
	// widest client support.
	// Default: TLS_V1_2_2025 under a derived naming context with a certificate,
	// otherwise the CloudFront default for the certificate.
	//
	MinimumProtocolVersion awscloudfront.SecurityPolicyProtocol `field:"optional" json:"minimumProtocolVersion" yaml:"minimumProtocolVersion"`
	// Optional naming and logging context.
	//
	// With the standard logging profile the media bucket takes its name from the
	// contract and CloudFront access logs go to
	// `logs/access/cdn/{logicalName}` through CloudWatch Logs vended delivery.
	// Pass `enableLogging: false` to opt out of the delivery.
	//
	// With no context the construct synthesizes exactly as before.
	// Default: undefined.
	//
	NamingContext AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
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
	// Bucket that receives S3 server access logs for the media bucket this construct creates, which is what Security Hub S3.9 evaluates.
	//
	// Off by default because the log target and its storage cost money. The
	// target bucket is yours: it takes no naming entry (resource-naming
	// contract section 4).
	// Default: no server access logging.
	//
	ServerAccessLogsBucket awss3.IBucket `field:"optional" json:"serverAccessLogsBucket" yaml:"serverAccessLogsBucket"`
	// Key prefix for the server access logs.
	//
	// Only used with
	// `serverAccessLogsBucket`.
	// Default: no prefix.
	//
	ServerAccessLogsPrefix *string `field:"optional" json:"serverAccessLogsPrefix" yaml:"serverAccessLogsPrefix"`
	// Optional web ACL ID for AWS WAF integration.
	WebAclId *string `field:"optional" json:"webAclId" yaml:"webAclId"`
}
