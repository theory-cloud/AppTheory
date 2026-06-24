package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awsec2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awsiam"
)

// Properties for AppTheoryMicrovmNetworkConnector.
type AppTheoryMicrovmNetworkConnectorProps struct {
	// Caller-provided security groups attached to connector ENIs.
	//
	// AppTheory requires explicit security group context instead of falling back to a VPC
	// default security group. At least one security group is required and no more than five
	// may be supplied.
	SecurityGroups *[]awsec2.ISecurityGroup `field:"required" json:"securityGroups" yaml:"securityGroups"`
	// Caller-provided subnets where Lambda provisions connector ENIs.
	//
	// At least one subnet is required and no more than 16 may be supplied.
	Subnets *[]awsec2.ISubnet `field:"required" json:"subnets" yaml:"subnets"`
	// Caller-provided VPC that owns the subnets and security groups used by the connector.
	//
	// AppTheory does not synthesize a VPC for MicroVM egress. The VPC boundary is part of
	// the application's deployment contract.
	Vpc awsec2.IVpc `field:"required" json:"vpc" yaml:"vpc"`
	// Optional physical network connector name.
	//
	// When omitted, CloudFormation assigns the physical name.
	ConnectorName *string `field:"optional" json:"connectorName" yaml:"connectorName"`
	// Network protocol for VPC egress.
	// Default: AppTheoryMicrovmNetworkProtocol.IPV4
	//
	NetworkProtocol AppTheoryMicrovmNetworkProtocol `field:"optional" json:"networkProtocol" yaml:"networkProtocol"`
	// Existing operator role for Lambda to assume while managing connector ENIs.
	//
	// When omitted, AppTheory creates a role with the MicroVM network-connector ENI policy.
	// Caller-provided roles must already trust Lambda and include the required EC2 permissions.
	OperatorRole awsiam.IRole `field:"optional" json:"operatorRole" yaml:"operatorRole"`
	// Optional name for the operator role when AppTheory creates it.
	//
	// Cannot be used with operatorRole.
	OperatorRoleName *string `field:"optional" json:"operatorRoleName" yaml:"operatorRoleName"`
	// Additional CloudFormation tags to apply to the connector.
	Tags *map[string]*string `field:"optional" json:"tags" yaml:"tags"`
}
