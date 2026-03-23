package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/aws-cdk-go/awscdk/v2/awssecretsmanager"
)

type AppTheorySecretConfig struct {
	Description      *string                                    `field:"required" json:"description" yaml:"description"`
	Name             *string                                    `field:"required" json:"name" yaml:"name"`
	EnableRotation   *bool                                      `field:"optional" json:"enableRotation" yaml:"enableRotation"`
	ExcludeChars     *string                                    `field:"optional" json:"excludeChars" yaml:"excludeChars"`
	GenerateKey      *string                                    `field:"optional" json:"generateKey" yaml:"generateKey"`
	Length           *float64                                   `field:"optional" json:"length" yaml:"length"`
	RotationLambda   awslambda.IFunction                        `field:"optional" json:"rotationLambda" yaml:"rotationLambda"`
	RotationSchedule *awssecretsmanager.RotationScheduleOptions `field:"optional" json:"rotationSchedule" yaml:"rotationSchedule"`
	Template         *string                                    `field:"optional" json:"template" yaml:"template"`
}
