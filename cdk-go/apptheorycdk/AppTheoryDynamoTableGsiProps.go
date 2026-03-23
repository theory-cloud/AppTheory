package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
)

type AppTheoryDynamoTableGsiProps struct {
	IndexName *string `field:"required" json:"indexName" yaml:"indexName"`
	PartitionKeyName *string `field:"required" json:"partitionKeyName" yaml:"partitionKeyName"`
	NonKeyAttributes *[]*string `field:"optional" json:"nonKeyAttributes" yaml:"nonKeyAttributes"`
	PartitionKeyType awsdynamodb.AttributeType `field:"optional" json:"partitionKeyType" yaml:"partitionKeyType"`
	ProjectionType awsdynamodb.ProjectionType `field:"optional" json:"projectionType" yaml:"projectionType"`
	ReadCapacity *float64 `field:"optional" json:"readCapacity" yaml:"readCapacity"`
	SortKeyName *string `field:"optional" json:"sortKeyName" yaml:"sortKeyName"`
	SortKeyType awsdynamodb.AttributeType `field:"optional" json:"sortKeyType" yaml:"sortKeyType"`
	WriteCapacity *float64 `field:"optional" json:"writeCapacity" yaml:"writeCapacity"`
}

