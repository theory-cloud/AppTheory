package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigatewayv2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsroute53"
)

type AppTheoryAppProps struct {
	AppName              *string                `field:"required" json:"appName" yaml:"appName"`
	CertificateArn       *string                `field:"optional" json:"certificateArn" yaml:"certificateArn"`
	Code                 awslambda.Code         `field:"optional" json:"code" yaml:"code"`
	CodeAssetPath        *string                `field:"optional" json:"codeAssetPath" yaml:"codeAssetPath"`
	DatabasePartitionKey *string                `field:"optional" json:"databasePartitionKey" yaml:"databasePartitionKey"`
	DatabaseSortKey      *string                `field:"optional" json:"databaseSortKey" yaml:"databaseSortKey"`
	DatabaseTable        awsdynamodb.ITable     `field:"optional" json:"databaseTable" yaml:"databaseTable"`
	DatabaseTableName    *string                `field:"optional" json:"databaseTableName" yaml:"databaseTableName"`
	DomainName           *string                `field:"optional" json:"domainName" yaml:"domainName"`
	EnableDatabase       *bool                  `field:"optional" json:"enableDatabase" yaml:"enableDatabase"`
	EnableRateLimiting   *bool                  `field:"optional" json:"enableRateLimiting" yaml:"enableRateLimiting"`
	Environment          *map[string]*string    `field:"optional" json:"environment" yaml:"environment"`
	Handler              *string                `field:"optional" json:"handler" yaml:"handler"`
	HostedZone           awsroute53.IHostedZone `field:"optional" json:"hostedZone" yaml:"hostedZone"`
	MemorySize           *float64               `field:"optional" json:"memorySize" yaml:"memorySize"`
	RateLimitTableName   *string                `field:"optional" json:"rateLimitTableName" yaml:"rateLimitTableName"`
	Runtime              awslambda.Runtime      `field:"optional" json:"runtime" yaml:"runtime"`
	Stage                awsapigatewayv2.IStage `field:"optional" json:"stage" yaml:"stage"`
	TimeoutSeconds       *float64               `field:"optional" json:"timeoutSeconds" yaml:"timeoutSeconds"`
}
