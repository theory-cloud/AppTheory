package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
)

type AppTheoryEventBusTableProps struct {
	BillingMode awsdynamodb.BillingMode `field:"optional" json:"billingMode" yaml:"billingMode"`
	// Whether deletion protection should be enabled for the table.
	// Default: undefined (with no naming context: the AWS default, no deletion
	// protection; with a naming context: on for a RETAIN table, off otherwise).
	//
	DeletionProtection        *bool `field:"optional" json:"deletionProtection" yaml:"deletionProtection"`
	EnableEventIdIndex        *bool `field:"optional" json:"enableEventIdIndex" yaml:"enableEventIdIndex"`
	EnablePointInTimeRecovery *bool `field:"optional" json:"enablePointInTimeRecovery" yaml:"enablePointInTimeRecovery"`
	EnableStream              *bool `field:"optional" json:"enableStream" yaml:"enableStream"`
	// Optional naming context.
	//
	// When present the table takes the contract's
	// Security Hub-aligned defaults: point-in-time recovery on, and deletion
	// protection on for a RETAIN table.
	//
	// With no context the construct synthesizes exactly as before.
	// Default: undefined.
	//
	NamingContext       AppTheoryNamingContext     `field:"optional" json:"namingContext" yaml:"namingContext"`
	ReadCapacity        *float64                   `field:"optional" json:"readCapacity" yaml:"readCapacity"`
	RemovalPolicy       awscdk.RemovalPolicy       `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	StreamViewType      awsdynamodb.StreamViewType `field:"optional" json:"streamViewType" yaml:"streamViewType"`
	TableName           *string                    `field:"optional" json:"tableName" yaml:"tableName"`
	TimeToLiveAttribute *string                    `field:"optional" json:"timeToLiveAttribute" yaml:"timeToLiveAttribute"`
	WriteCapacity       *float64                   `field:"optional" json:"writeCapacity" yaml:"writeCapacity"`
}
