package apptheorycdk

import (
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
	LogGroup             interfacesawslogs.ILogGroupRef `field:"optional" json:"logGroup" yaml:"logGroup"`
	LogRetention         awslogs.RetentionDays          `field:"optional" json:"logRetention" yaml:"logRetention"`
	MemorySize           *float64                       `field:"optional" json:"memorySize" yaml:"memorySize"`
	RateLimitTableName   *string                        `field:"optional" json:"rateLimitTableName" yaml:"rateLimitTableName"`
	Runtime              awslambda.Runtime              `field:"optional" json:"runtime" yaml:"runtime"`
	SecurityGroups       *[]awsec2.ISecurityGroup       `field:"optional" json:"securityGroups" yaml:"securityGroups"`
	Stage                awsapigatewayv2.IStage         `field:"optional" json:"stage" yaml:"stage"`
	TimeoutSeconds       *float64                       `field:"optional" json:"timeoutSeconds" yaml:"timeoutSeconds"`
	Vpc                  awsec2.IVpc                    `field:"optional" json:"vpc" yaml:"vpc"`
	VpcSubnets           *awsec2.SubnetSelection        `field:"optional" json:"vpcSubnets" yaml:"vpcSubnets"`
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
