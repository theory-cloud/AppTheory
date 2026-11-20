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
	// Default response headers policy for API bypass behaviors.
	//
	// Can be overridden per bypass via `ApiBypassConfig.responseHeadersPolicy`.
	ApiBypassResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"apiBypassResponseHeadersPolicy" yaml:"apiBypassResponseHeadersPolicy"`
	// Origin request policy for the API origin (default behavior).
	ApiOriginRequestPolicy awscloudfront.IOriginRequestPolicy `field:"optional" json:"apiOriginRequestPolicy" yaml:"apiOriginRequestPolicy"`
	// Response headers policy for the API origin default behavior.
	ApiResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"apiResponseHeadersPolicy" yaml:"apiResponseHeadersPolicy"`
	// Whether to auto-delete objects in created buckets on stack deletion.
	//
	// Only applies when removalPolicy is DESTROY.
	// Default: false.
	//
	AutoDeleteObjects *bool `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
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
	// The frontend's root behavior targets the API origin, a custom origin that
	// Security Hub CloudFront.1 does not evaluate, so AppTheory sets no default.
	// Default: undefined.
	//
	DefaultRootObject *string `field:"optional" json:"defaultRootObject" yaml:"defaultRootObject"`
	// Domain configuration for custom domain, certificate, and Route53.
	Domain *PathRoutedFrontendDomainConfig `field:"optional" json:"domain" yaml:"domain"`
	// Enable CloudFront access logging.
	// Default: true.
	//
	EnableLogging *bool `field:"optional" json:"enableLogging" yaml:"enableLogging"`
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
	// With the standard logging profile CloudFront access logs go to
	// `logs/access/cdn/{logicalName}` through CloudWatch Logs vended delivery.
	// Pass `enableLogging: false` to opt out.
	//
	// With no context the construct synthesizes exactly as before.
	// Default: undefined.
	//
	NamingContext AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
	// Price class for the CloudFront distribution.
	// Default: PriceClass.PRICE_CLASS_ALL
	//
	PriceClass awscloudfront.PriceClass `field:"optional" json:"priceClass" yaml:"priceClass"`
	// Removal policy for created resources.
	// Default: RemovalPolicy.RETAIN
	//
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// Response headers policy to apply to all behaviors (legacy).
	//
	// Prefer using `apiResponseHeadersPolicy`, `spaResponseHeadersPolicy`, and
	// `apiBypassResponseHeadersPolicy` for behavior-scoped control.
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
	// SPA origins with their path patterns.
	//
	// Each SPA will be served via CloudFront with SPA rewrite support.
	SpaOrigins *[]*SpaOriginConfig `field:"optional" json:"spaOrigins" yaml:"spaOrigins"`
	// Default response headers policy for SPA behaviors.
	//
	// Can be overridden per SPA via `SpaOriginConfig.responseHeadersPolicy`.
	SpaResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"spaResponseHeadersPolicy" yaml:"spaResponseHeadersPolicy"`
	// Optional web ACL ID for AWS WAF integration.
	WebAclId *string `field:"optional" json:"webAclId" yaml:"webAclId"`
}
