package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
)

type AppTheorySsrSiteProps struct {
	SsrFunction       awslambda.IFunction    `field:"required" json:"ssrFunction" yaml:"ssrFunction"`
	AssetsBucket      awss3.IBucket          `field:"optional" json:"assetsBucket" yaml:"assetsBucket"`
	AssetsKeyPrefix   *string                `field:"optional" json:"assetsKeyPrefix" yaml:"assetsKeyPrefix"`
	AssetsManifestKey *string                `field:"optional" json:"assetsManifestKey" yaml:"assetsManifestKey"`
	AssetsPath        *string                `field:"optional" json:"assetsPath" yaml:"assetsPath"`
	AutoDeleteObjects *bool                  `field:"optional" json:"autoDeleteObjects" yaml:"autoDeleteObjects"`
	CacheTableName    *string                `field:"optional" json:"cacheTableName" yaml:"cacheTableName"`
	CertificateArn    *string                `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	DomainName        *string                `field:"optional" json:"domainName" yaml:"domainName"`
	EnableLogging     *bool                  `field:"optional" json:"enableLogging" yaml:"enableLogging"`
	HostedZone        awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Lambda Function URL invoke mode for the SSR origin.
	// Default: lambda.InvokeMode.RESPONSE_STREAM
	//
	InvokeMode awslambda.InvokeMode `field:"optional" json:"invokeMode" yaml:"invokeMode"`
	LogsBucket awss3.IBucket        `field:"optional" json:"logsBucket" yaml:"logsBucket"`
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
	// Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
	//
	// The default AppTheory/FaceTheory-safe edge contract forwards only:
	// - `cloudfront-forwarded-proto`
	// - `cloudfront-viewer-address`
	// - `x-apptheory-original-host`
	// - `x-apptheory-original-uri`
	// - `x-request-id`
	// - `x-tenant-id`
	//
	// Use this to opt in to additional app-specific headers such as
	// `x-facetheory-tenant`. `host` and `x-forwarded-proto` are rejected because
	// they break or bypass the supported origin model.
	SsrForwardHeaders *[]*string `field:"optional" json:"ssrForwardHeaders" yaml:"ssrForwardHeaders"`
	// Function URL auth type for the SSR origin.
	//
	// AppTheory defaults this to `AWS_IAM` so CloudFront reaches the SSR origin
	// through a signed Origin Access Control path. Set `NONE` only as an explicit
	// compatibility override for legacy public Function URL deployments.
	// Default: lambda.FunctionUrlAuthType.AWS_IAM
	//
	SsrUrlAuthType awslambda.FunctionUrlAuthType `field:"optional" json:"ssrUrlAuthType" yaml:"ssrUrlAuthType"`
	// Additional CloudFront path patterns to route directly to the S3 origin.
	//
	// In `ssg-isr` mode, `/_facetheory/data/*` is added automatically.
	// Example custom direct-S3 path: "/marketing/*".
	StaticPathPatterns *[]*string `field:"optional" json:"staticPathPatterns" yaml:"staticPathPatterns"`
	WebAclId           *string    `field:"optional" json:"webAclId" yaml:"webAclId"`
	WireRuntimeEnv     *bool      `field:"optional" json:"wireRuntimeEnv" yaml:"wireRuntimeEnv"`
}
