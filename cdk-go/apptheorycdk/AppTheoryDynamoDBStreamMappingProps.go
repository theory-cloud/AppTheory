package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsdynamodb"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
)

type AppTheoryDynamoDBStreamMappingProps struct {
	Consumer                awslambda.Function         `field:"required" json:"consumer" yaml:"consumer"`
	Table                   awsdynamodb.ITable         `field:"required" json:"table" yaml:"table"`
	BatchSize               *float64                   `field:"optional" json:"batchSize" yaml:"batchSize"`
	BisectBatchOnError      *bool                      `field:"optional" json:"bisectBatchOnError" yaml:"bisectBatchOnError"`
	MaxRecordAge            awscdk.Duration            `field:"optional" json:"maxRecordAge" yaml:"maxRecordAge"`
	ReportBatchItemFailures *bool                      `field:"optional" json:"reportBatchItemFailures" yaml:"reportBatchItemFailures"`
	RetryAttempts           *float64                   `field:"optional" json:"retryAttempts" yaml:"retryAttempts"`
	StartingPosition        awslambda.StartingPosition `field:"optional" json:"startingPosition" yaml:"startingPosition"`
}
