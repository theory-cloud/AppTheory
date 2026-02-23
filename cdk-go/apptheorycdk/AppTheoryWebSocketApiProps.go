package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsapigateway"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslogs"
)

type AppTheoryWebSocketApiProps struct {
	Handler                                  awslambda.IFunction           `field:"required" json:"handler" yaml:"handler"`
	AccessLogFormat                          awsapigateway.AccessLogFormat `field:"optional" json:"accessLogFormat" yaml:"accessLogFormat"`
	AccessLogGroup                           awslogs.ILogGroup             `field:"optional" json:"accessLogGroup" yaml:"accessLogGroup"`
	AccessLogRemovalPolicy                   awscdk.RemovalPolicy          `field:"optional" json:"accessLogRemovalPolicy" yaml:"accessLogRemovalPolicy"`
	AccessLogRetention                       awslogs.RetentionDays         `field:"optional" json:"accessLogRetention" yaml:"accessLogRetention"`
	ApiName                                  *string                       `field:"optional" json:"apiName" yaml:"apiName"`
	ConnectHandler                           awslambda.IFunction           `field:"optional" json:"connectHandler" yaml:"connectHandler"`
	ConnectionTable                          awsdynamodb.ITable            `field:"optional" json:"connectionTable" yaml:"connectionTable"`
	ConnectionTableEnablePointInTimeRecovery *bool                         `field:"optional" json:"connectionTableEnablePointInTimeRecovery" yaml:"connectionTableEnablePointInTimeRecovery"`
	ConnectionTableName                      *string                       `field:"optional" json:"connectionTableName" yaml:"connectionTableName"`
	ConnectionTablePartitionKeyName          *string                       `field:"optional" json:"connectionTablePartitionKeyName" yaml:"connectionTablePartitionKeyName"`
	ConnectionTableRemovalPolicy             awscdk.RemovalPolicy          `field:"optional" json:"connectionTableRemovalPolicy" yaml:"connectionTableRemovalPolicy"`
	ConnectionTableSortKeyName               *string                       `field:"optional" json:"connectionTableSortKeyName" yaml:"connectionTableSortKeyName"`
	ConnectionTableTimeToLiveAttribute       *string                       `field:"optional" json:"connectionTableTimeToLiveAttribute" yaml:"connectionTableTimeToLiveAttribute"`
	DefaultHandler                           awslambda.IFunction           `field:"optional" json:"defaultHandler" yaml:"defaultHandler"`
	DisconnectHandler                        awslambda.IFunction           `field:"optional" json:"disconnectHandler" yaml:"disconnectHandler"`
	EnableAccessLogging                      *bool                         `field:"optional" json:"enableAccessLogging" yaml:"enableAccessLogging"`
	EnableConnectionTable                    *bool                         `field:"optional" json:"enableConnectionTable" yaml:"enableConnectionTable"`
	StageName                                *string                       `field:"optional" json:"stageName" yaml:"stageName"`
}
