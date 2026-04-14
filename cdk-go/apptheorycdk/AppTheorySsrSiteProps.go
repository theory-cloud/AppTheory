package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
)

type AppTheorySsrSiteProps struct {
	SsrFunction       awslambda.IFunction `field:"required" json:"ssrFunction" yaml:"ssrFunction"`
	AssetsBucket      awss3.IBucket       `field:"optional" json:"assetsBucket" yaml:"assetsBucket"`
	AssetsKeyPrefix   *string             `field:"optional" json:"assetsKeyPrefix" yaml:"assetsKeyPrefix"`
	AssetsManifestKey *string             `field:"optional" json:"assetsManifestKey" yaml:"assetsManifestKey"`
	AssetsPath        *string             `field:"optional" json:"assetsPath" yaml:"assetsPath"`
	AutoDeleteObjects *bool               `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
	// Legacy alias for `isrMetadataTableName`.
	// Deprecated: prefer `isrMetadataTable` or `isrMetadataTableName`.
	CacheTableName *string `field:"optional" json:"cacheTableName" yaml:"cacheTableName"`
	CertificateArn *string `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	// Additional raw S3 object/data path patterns that should bypass extensionless HTML rewrites.
	//
	// In `ssg-isr` mode, `/_facetheory/data/*` is added automatically.
	// Example direct-S3 object path: "/feeds/*".
	DirectS3PathPatterns *[]*string             `field:"optional" json:"directS3PathPatterns" yaml:"directS3PathPatterns"`
	DomainName           *string                `field:"optional" json:"domainName" yaml:"domainName"`
	EnableLogging        *bool                  `field:"optional" json:"enableLogging" yaml:"enableLogging"`
	HostedZone           awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Cache policy applied to the cacheable HTML behavior in `ssg-isr` mode.
	//
	// The default AppTheory policy keys on query strings plus the stable public HTML
	// variant headers (`x-*-original-host`, `x-tenant-id`, and any extra forwarded
	// headers you opt into) while leaving cookies out of the cache key.
	HtmlCachePolicy awscloudfront.ICachePolicy `field:"optional" json:"htmlCachePolicy" yaml:"htmlCachePolicy"`
	// Optional S3 bucket used by FaceTheory ISR HTML storage (`S3HtmlStore`).
	//
	// When provided, AppTheory grants the SSR function read/write access and wires:
	// - `FACETHEORY_ISR_BUCKET`
	// - `FACETHEORY_ISR_PREFIX`.
	HtmlStoreBucket awss3.IBucket `field:"optional" json:"htmlStoreBucket" yaml:"htmlStoreBucket"`
	// S3 key prefix used by FaceTheory ISR HTML storage.
	// Default: isr.
	//
	HtmlStoreKeyPrefix *string `field:"optional" json:"htmlStoreKeyPrefix" yaml:"htmlStoreKeyPrefix"`
	// Lambda Function URL invoke mode for the SSR origin.
	// Default: lambda.InvokeMode.RESPONSE_STREAM
	//
	InvokeMode awslambda.InvokeMode `field:"optional" json:"invokeMode" yaml:"invokeMode"`
	// Optional TableTheory/DynamoDB table used for FaceTheory ISR metadata and lease coordination.
	//
	// When provided, AppTheory grants the SSR function read/write access and wires the
	// metadata table aliases expected by the documented FaceTheory deployment shape.
	IsrMetadataTable awsdynamodb.ITable `field:"optional" json:"isrMetadataTable" yaml:"isrMetadataTable"`
	// Optional ISR/cache metadata table name to wire when you are not passing `isrMetadataTable`.
	//
	// Prefer `isrMetadataTable` when AppTheory should also grant access to the SSR Lambda.
	IsrMetadataTableName *string       `field:"optional" json:"isrMetadataTableName" yaml:"isrMetadataTableName"`
	LogsBucket           awss3.IBucket `field:"optional" json:"logsBucket" yaml:"logsBucket"`
	// Explicit deployment mode for the site topology.
	//
	// - `ssr-only`: Lambda Function URL is the default origin
	// - `ssg-isr`: S3 is the primary HTML origin and Lambda is the fallback
	//
	// Existing implicit behavior maps to `ssr-only`.
	// Default: AppTheorySsrSiteMode.SSR_ONLY
	//
	Mode          AppTheorySsrSiteMode `field:"optional" json:"mode" yaml:"mode"`
	RemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	// CloudFront response headers policy applied to SSR and direct-S3 behaviors.
	//
	// If omitted, AppTheory provisions a FaceTheory-aligned baseline policy at the CDN
	// layer: HSTS, nosniff, frame-options, referrer-policy, XSS protection, and a
	// restrictive permissions-policy. Content-Security-Policy remains origin-defined.
	ResponseHeadersPolicy awscloudfront.IResponseHeadersPolicy `field:"optional" json:"responseHeadersPolicy" yaml:"responseHeadersPolicy"`
	// Cache policy applied to direct Lambda-backed SSR behaviors.
	//
	// The default is `CACHING_DISABLED` so dynamic Lambda routes stay safe unless you
	// intentionally opt into a cache policy that matches your app's variance model.
	// Default: cloudfront.CachePolicy.CACHING_DISABLED
	//
	SsrCachePolicy awscloudfront.ICachePolicy `field:"optional" json:"ssrCachePolicy" yaml:"ssrCachePolicy"`
	// Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
	//
	// The default AppTheory/FaceTheory-safe edge contract forwards only:
	// - `cloudfront-forwarded-proto`
	// - `cloudfront-viewer-address`
	// - `x-apptheory-original-host`
	// - `x-apptheory-original-uri`
	// - `x-facetheory-original-host`
	// - `x-facetheory-original-uri`
	// - `x-request-id`
	// - `x-tenant-id`
	//
	// Use this to opt in to additional app-specific headers such as
	// `x-facetheory-tenant`. `host` and `x-forwarded-proto` are rejected because
	// they break or bypass the supported origin model.
	SsrForwardHeaders *[]*string `field:"optional" json:"ssrForwardHeaders" yaml:"ssrForwardHeaders"`
	// Additional path patterns that should bypass the `ssg-isr` origin group and route directly to the Lambda Function URL with full method support.
	//
	// Use this for same-origin dynamic paths such as auth callbacks, actions, or form posts.
	// When `ssrUrlAuthType` is omitted, adding these patterns makes AppTheory select
	// `NONE` so browser-facing write methods keep working through CloudFront.
	// Example direct-SSR path: "/actions/*".
	SsrPathPatterns *[]*string `field:"optional" json:"ssrPathPatterns" yaml:"ssrPathPatterns"`
	// Function URL auth type for the SSR origin.
	//
	// If omitted, AppTheory auto-selects the auth model based on the exposed
	// Lambda-backed surface:
	//
	// - `AWS_IAM` for read-only Lambda traffic (`GET` / `HEAD` / `OPTIONS`)
	// - `NONE` when Lambda-backed behaviors expose browser-facing write methods
	//
	// Set this explicitly to force a specific Function URL auth mode.
	// Default: derived from exposed Lambda methods.
	//
	SsrUrlAuthType awslambda.FunctionUrlAuthType `field:"optional" json:"ssrUrlAuthType" yaml:"ssrUrlAuthType"`
	// Additional extensionless HTML section path patterns to route directly to the primary HTML S3 origin.
	//
	// Requests like `/marketing` and `/marketing/...` are rewritten to `/index.html`
	// within the section and stay on S3 instead of falling back to Lambda.
	//
	// Example direct-S3 HTML section path: "/marketing/*".
	StaticPathPatterns *[]*string `field:"optional" json:"staticPathPatterns" yaml:"staticPathPatterns"`
	WebAclId           *string    `field:"optional" json:"webAclId" yaml:"webAclId"`
	WireRuntimeEnv     *bool      `field:"optional" json:"wireRuntimeEnv" yaml:"wireRuntimeEnv"`
}
