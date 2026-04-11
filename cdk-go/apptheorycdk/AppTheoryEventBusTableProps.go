package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
)

type AppTheoryEventBusTableProps struct {
	BillingMode               awsdynamodb.BillingMode    `field:"optional" json:"billingMode" yaml:"billingMode"`
	EnableEventIdIndex        *bool                      `field:"optional" json:"enableEventIdIndex" yaml:"enableEventIdIndex"`
	EnablePointInTimeRecovery *bool                      `field:"optional" json:"enablePointInTimeRecovery" yaml:"enablePointInTimeRecovery"`
	EnableStream              *bool                      `field:"optional" json:"enableStream" yaml:"enableStream"`
	ReadCapacity              *float64                   `field:"optional" json:"readCapacity" yaml:"readCapacity"`
	RemovalPolicy             awscdk.RemovalPolicy       `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	StreamViewType            awsdynamodb.StreamViewType `field:"optional" json:"streamViewType" yaml:"streamViewType"`
	TableName                 *string                    `field:"optional" json:"tableName" yaml:"tableName"`
	TimeToLiveAttribute       *string                    `field:"optional" json:"timeToLiveAttribute" yaml:"timeToLiveAttribute"`
	WriteCapacity             *float64                   `field:"optional" json:"writeCapacity" yaml:"writeCapacity"`
}
