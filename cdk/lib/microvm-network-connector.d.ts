import { CfnResource } from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
/**
 * Network protocols supported by Lambda MicroVM VPC egress connectors.
 */
export declare enum AppTheoryMicrovmNetworkProtocol {
    /**
     * IPv4-only VPC egress.
     */
    IPV4 = "IPv4",
    /**
     * Dual-stack IPv4/IPv6 VPC egress.
     */
    DUAL_STACK = "DualStack"
}
/**
 * Properties for AppTheoryMicrovmNetworkConnector.
 */
export interface AppTheoryMicrovmNetworkConnectorProps {
    /**
     * Caller-provided VPC that owns the subnets and security groups used by the connector.
     *
     * AppTheory does not synthesize a VPC for MicroVM egress. The VPC boundary is part of
     * the application's deployment contract.
     */
    readonly vpc: ec2.IVpc;
    /**
     * Caller-provided subnets where Lambda provisions connector ENIs.
     *
     * At least one subnet is required and no more than 16 may be supplied.
     */
    readonly subnets: ec2.ISubnet[];
    /**
     * Caller-provided security groups attached to connector ENIs.
     *
     * AppTheory requires explicit security group context instead of falling back to a VPC
     * default security group. At least one security group is required and no more than five
     * may be supplied.
     */
    readonly securityGroups: ec2.ISecurityGroup[];
    /**
     * Optional physical network connector name.
     *
     * When omitted, CloudFormation assigns the physical name.
     */
    readonly connectorName?: string;
    /**
     * Network protocol for VPC egress.
     *
     * @default AppTheoryMicrovmNetworkProtocol.IPV4
     */
    readonly networkProtocol?: AppTheoryMicrovmNetworkProtocol;
    /**
     * Existing operator role for Lambda to assume while managing connector ENIs.
     *
     * When omitted, AppTheory creates a role with the MicroVM network-connector ENI policy.
     * Caller-provided roles must already trust Lambda and include the required EC2 permissions.
     */
    readonly operatorRole?: iam.IRole;
    /**
     * Optional name for the operator role when AppTheory creates it.
     *
     * Cannot be used with operatorRole.
     */
    readonly operatorRoleName?: string;
    /**
     * Additional CloudFormation tags to apply to the connector.
     */
    readonly tags?: Record<string, string>;
}
/**
 * AppTheory CDK construct for AWS Lambda MicroVM VPC egress network connectors.
 *
 * This construct is intentionally deployment-only: it creates the CloudFormation
 * `AWS::Lambda::NetworkConnector` resource and, unless an operator role is supplied,
 * the IAM role Lambda uses to manage connector ENIs. Runtime MicroVM lifecycle and
 * controller behavior stays in the AppTheory runtime contract.
 */
export declare class AppTheoryMicrovmNetworkConnector extends Construct {
    /**
     * The caller-provided VPC boundary for this connector.
     */
    readonly vpc: ec2.IVpc;
    /**
     * The caller-provided subnet IDs used by the connector.
     */
    readonly subnetIds: string[];
    /**
     * The caller-provided security group IDs used by the connector.
     */
    readonly securityGroupIds: string[];
    /**
     * The IAM role passed to AWS::Lambda::NetworkConnector as OperatorRole.
     */
    readonly operatorRole: iam.IRole;
    /**
     * The underlying CloudFormation network connector resource.
     */
    readonly networkConnector: CfnResource;
    /**
     * The network connector ARN.
     */
    readonly networkConnectorArn: string;
    /**
     * The CloudFormation state attribute for the network connector.
     */
    readonly networkConnectorState: string;
    constructor(scope: Construct, id: string, props: AppTheoryMicrovmNetworkConnectorProps);
}
