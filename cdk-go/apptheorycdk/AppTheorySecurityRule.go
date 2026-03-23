package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsec2"
)

type AppTheorySecurityRule struct {
	Description *string         `field:"required" json:"description" yaml:"description"`
	Port        *float64        `field:"required" json:"port" yaml:"port"`
	Protocol    awsec2.Protocol `field:"required" json:"protocol" yaml:"protocol"`
	Source      awsec2.IPeer    `field:"required" json:"source" yaml:"source"`
}
