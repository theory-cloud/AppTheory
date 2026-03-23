package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsec2"
)

type AppTheoryEnhancedSecurityProps struct {
	Vpc               awsec2.IVpc                 `field:"required" json:"vpc" yaml:"vpc"`
	ApplicationName   *string                     `field:"optional" json:"applicationName" yaml:"applicationName"`
	EgressRules       *[]*AppTheorySecurityRule   `field:"optional" json:"egressRules" yaml:"egressRules"`
	EnableVpcFlowLogs *bool                       `field:"optional" json:"enableVpcFlowLogs" yaml:"enableVpcFlowLogs"`
	EnableWaf         *bool                       `field:"optional" json:"enableWaf" yaml:"enableWaf"`
	Environment       *string                     `field:"optional" json:"environment" yaml:"environment"`
	IngressRules      *[]*AppTheorySecurityRule   `field:"optional" json:"ingressRules" yaml:"ingressRules"`
	Secrets           *[]*AppTheorySecretConfig   `field:"optional" json:"secrets" yaml:"secrets"`
	VpcEndpointConfig *AppTheoryVpcEndpointConfig `field:"optional" json:"vpcEndpointConfig" yaml:"vpcEndpointConfig"`
	WafConfig         *AppTheoryWafRuleConfig     `field:"optional" json:"wafConfig" yaml:"wafConfig"`
}
