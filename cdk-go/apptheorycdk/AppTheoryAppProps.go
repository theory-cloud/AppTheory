package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsec2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
	"github.com/aws/aws-cdk-go/awscdk/v2/interfaces/interfacesawslogs"
)

type AppTheoryAppProps struct {
	AppName              *string                        `field:"required" json:"appName" yaml:"appName"`
	Alias                *AppTheoryFunctionAliasOptions `field:"optional" json:"alias" yaml:"alias"`
	AllowAllOutbound     *bool                          `field:"optional" json:"allowAllOutbound" yaml:"allowAllOutbound"`
	AllowPublicSubnet    *bool                          `field:"optional" json:"allowPublicSubnet" yaml:"allowPublicSubnet"`
	CertificateArn       *string                        `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	Code                 awslambda.Code                 `field:"optional" json:"code" yaml:"code"`
	CodeAssetPath        *string                        `field:"optional" json:"codeAssetPath" yaml:"codeAssetPath"`
	Cors                 interface{}                    `field:"optional" json:"cors" yaml:"cors"`
	DatabasePartitionKey *string                        `field:"optional" json:"databasePartitionKey" yaml:"databasePartitionKey"`
	DatabaseSortKey      *string                        `field:"optional" json:"databaseSortKey" yaml:"databaseSortKey"`
	DatabaseTable        awsdynamodb.ITable             `field:"optional" json:"databaseTable" yaml:"databaseTable"`
	DatabaseTableName    *string                        `field:"optional" json:"databaseTableName" yaml:"databaseTableName"`
	Domain               *AppTheoryHttpApiDomainOptions `field:"optional" json:"domain" yaml:"domain"`
	DomainName           *string                        `field:"optional" json:"domainName" yaml:"domainName"`
	EnableDatabase       *bool                          `field:"optional" json:"enableDatabase" yaml:"enableDatabase"`
	EnableRateLimiting   *bool                          `field:"optional" json:"enableRateLimiting" yaml:"enableRateLimiting"`
	Environment          *map[string]*string            `field:"optional" json:"environment" yaml:"environment"`
	Handler              *string                        `field:"optional" json:"handler" yaml:"handler"`
	HostedZone           awsroute53.IHostedZone         `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	// Log group the app function writes to.
	//
	// When set, AppTheory uses this group unchanged: the caller owns its
	// retention and removal policy. `logRetention` is ignored, and combining this
	// property with `logRemovalPolicy` fails synthesis.
	// Default: an AppTheory-managed log group named `/aws/lambda/<appName>`.
	//
	LogGroup interfacesawslogs.ILogGroupRef `field:"optional" json:"logGroup" yaml:"logGroup"`
	// Removal policy for the app function's AppTheory-managed named log group.
	//
	// The value is forwarded unchanged to AppTheoryFunction. Supplying both
	// `logGroup` and `logRemovalPolicy` fails synthesis because caller-provided
	// log groups own their removal policy.
	// Default: RemovalPolicy.RETAIN
	//
	// Deprecated: Configure `removalPolicy` on an explicit `logs.LogGroup` and
	// pass it as `logGroup` instead. AppTheory keeps honoring this property for
	// existing stacks and has no planned removal date.
	LogRemovalPolicy awscdk.RemovalPolicy `field:"optional" json:"logRemovalPolicy" yaml:"logRemovalPolicy"`
	// Retention for the app function's AppTheory-managed named log group.
	//
	// The value is forwarded unchanged to AppTheoryFunction, which ignores it
	// when `logGroup` supplies the log group.
	// Default: logs.RetentionDays.ONE_MONTH for AppTheory-managed log groups
	//
	// Deprecated: Configure `retention` on an explicit `logs.LogGroup` and pass
	// it as `logGroup` instead. AppTheory keeps honoring this property for
	// existing stacks and has no planned removal date.
	LogRetention awslogs.RetentionDays `field:"optional" json:"logRetention" yaml:"logRetention"`
	MemorySize   *float64              `field:"optional" json:"memorySize" yaml:"memorySize"`
	// Optional naming context.
	//
	// When present the tables this construct creates
	// (the database table and the rate-limit table) take the contract's Security
	// Hub-aligned defaults: point-in-time recovery on, and deletion protection on
	// for a RETAIN table.
	//
	// The context selects table defaults only. AppTheoryApp does not derive
	// physical names for its HTTP API in the v0.1 resource-naming contract, so it
	// consumes no naming entry.
	//
	// With no context the construct synthesizes exactly as before.
	// Default: undefined.
	//
	NamingContext      AppTheoryNamingContext `field:"optional" json:"namingContext" yaml:"namingContext"`
	RateLimitTableName *string                `field:"optional" json:"rateLimitTableName" yaml:"rateLimitTableName"`
	// Stable physical name for the app function's AppTheory-managed IAM role.
	//
	// AppTheoryFunction receives the value unchanged. Concrete names are synthesis-validated against IAM's `[\w+=,.@-]+` character set and 64-character limit; token-valued names are accepted and IAM validates the resolved value at deploy time, so an invalid resolved name fails deployment rather than synthesis.
	// This exemption keeps account-agnostic synthesis representable for the THE-2861 token-valued-input failure class. Synthesis still fails if AppTheory cannot apply the requested name exactly.
	// Default: undefined.
	//
	RoleName *string           `field:"optional" json:"roleName" yaml:"roleName"`
	Runtime  awslambda.Runtime `field:"optional" json:"runtime" yaml:"runtime"`
	// Whether Lambda invoke permissions should be scoped to individual HTTP API v2 routes.
	//
	// Forwarded unchanged to the inner `AppTheoryHttpApi`. When false, one API-scoped invoke
	// permission is granted per Lambda instead of one permission per route, which is the
	// scalable choice when the app Lambda is shared with other routes on the same HTTP API and
	// the per-route permissions can exhaust the Lambda resource policy size limit.
	//
	// The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
	// to invoke the handler, not only the routes this construct owns.
	// Default: true.
	//
	ScopePermissionToRoute *bool                    `field:"optional" json:"scopePermissionToRoute" yaml:"scopePermissionToRoute"`
	SecurityGroups         *[]awsec2.ISecurityGroup `field:"optional" json:"securityGroups" yaml:"securityGroups"`
	Stage                  awsapigatewayv2.IStage   `field:"optional" json:"stage" yaml:"stage"`
	TimeoutSeconds         *float64                 `field:"optional" json:"timeoutSeconds" yaml:"timeoutSeconds"`
	Vpc                    awsec2.IVpc              `field:"optional" json:"vpc" yaml:"vpc"`
	VpcSubnets             *awsec2.SubnetSelection  `field:"optional" json:"vpcSubnets" yaml:"vpcSubnets"`
	// Regional WAF attachment is intentionally unavailable on AppTheoryApp because this top-level construct deploys an API Gateway v2 HTTP API.
	//
	// Supplying this prop fails closed during synthesis instead of producing an
	// unsupported HTTP API WebACL association.
	//
	// Use AppTheoryRestApi or AppTheoryRestApiRouter when a WAF-protected API
	// Gateway stage is required.
	// Default: undefined.
	//
	// Deprecated: AppTheoryApp uses AppTheoryHttpApi; HTTP API WAF association is unsupported by AWS WAFv2.
	Waf interface{} `field:"optional" json:"waf" yaml:"waf"`
}
