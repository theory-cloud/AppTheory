package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

type AppTheoryKmsKeyProps struct {
	AdministratorArn    *string               `field:"optional" json:"administratorArn" yaml:"administratorArn"`
	AliasName           *string               `field:"optional" json:"aliasName" yaml:"aliasName"`
	CustomKeyPolicy     awsiam.PolicyDocument `field:"optional" json:"customKeyPolicy" yaml:"customKeyPolicy"`
	Description         *string               `field:"optional" json:"description" yaml:"description"`
	EnabledRegions      *[]*string            `field:"optional" json:"enabledRegions" yaml:"enabledRegions"`
	EnableKeyRotation   *bool                 `field:"optional" json:"enableKeyRotation" yaml:"enableKeyRotation"`
	EnableSsmParameter  *bool                 `field:"optional" json:"enableSsmParameter" yaml:"enableSsmParameter"`
	GrantEncryptDecrypt *[]awsiam.IGrantable  `field:"optional" json:"grantEncryptDecrypt" yaml:"grantEncryptDecrypt"`
	GrantGenerateMac    *[]awsiam.IGrantable  `field:"optional" json:"grantGenerateMac" yaml:"grantGenerateMac"`
	IsReplicaKey        *bool                 `field:"optional" json:"isReplicaKey" yaml:"isReplicaKey"`
	KeySpec             awskms.KeySpec        `field:"optional" json:"keySpec" yaml:"keySpec"`
	KeyUsage            awskms.KeyUsage       `field:"optional" json:"keyUsage" yaml:"keyUsage"`
	MultiRegion         *bool                 `field:"optional" json:"multiRegion" yaml:"multiRegion"`
	PendingWindow       awscdk.Duration       `field:"optional" json:"pendingWindow" yaml:"pendingWindow"`
	PrimaryKeyArn       *string               `field:"optional" json:"primaryKeyArn" yaml:"primaryKeyArn"`
	RemovalPolicy       awscdk.RemovalPolicy  `field:"optional" json:"removalPolicy" yaml:"removalPolicy"`
	SsmParameterPath    *string               `field:"optional" json:"ssmParameterPath" yaml:"ssmParameterPath"`
	Tags                *map[string]*string   `field:"optional" json:"tags" yaml:"tags"`
}
