import { ArnFormat, CfnResource, Stack, Token } from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * Network protocols supported by Lambda MicroVM VPC egress connectors.
 */
export enum AppTheoryMicrovmNetworkProtocol {
  /**
   * IPv4-only VPC egress.
   */
  IPV4 = "IPv4",

  /**
   * Dual-stack IPv4/IPv6 VPC egress.
   */
  DUAL_STACK = "DualStack",
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
export class AppTheoryMicrovmNetworkConnector extends Construct {
  /**
   * The caller-provided VPC boundary for this connector.
   */
  public readonly vpc: ec2.IVpc;

  /**
   * The caller-provided subnet IDs used by the connector.
   */
  public readonly subnetIds: string[];

  /**
   * The caller-provided security group IDs used by the connector.
   */
  public readonly securityGroupIds: string[];

  /**
   * The IAM role passed to AWS::Lambda::NetworkConnector as OperatorRole.
   */
  public readonly operatorRole: iam.IRole;

  /**
   * The underlying CloudFormation network connector resource.
   */
  public readonly networkConnector: CfnResource;

  /**
   * The network connector ARN.
   */
  public readonly networkConnectorArn: string;

  /**
   * The CloudFormation state attribute for the network connector.
   */
  public readonly networkConnectorState: string;

  constructor(scope: Construct, id: string, props: AppTheoryMicrovmNetworkConnectorProps) {
    super(scope, id);

    if (props === undefined || props === null) {
      throw new Error("AppTheoryMicrovmNetworkConnector requires props");
    }
    validateRequired(props.vpc, "vpc");
    if (props.operatorRole && props.operatorRoleName) {
      throw new Error("AppTheoryMicrovmNetworkConnector: operatorRoleName cannot be used with operatorRole");
    }

    this.vpc = props.vpc;
    this.subnetIds = normalizeResourceIds(props.subnets, "subnets", (subnet) => subnet.subnetId, 1, 16);
    this.securityGroupIds = normalizeResourceIds(
      props.securityGroups,
      "securityGroups",
      (securityGroup) => securityGroup.securityGroupId,
      1,
      5,
    );

    const connectorName = normalizeOptionalConnectorName(props.connectorName);
    const protocol = normalizeNetworkProtocol(props.networkProtocol);

    const createdOperatorRole = props.operatorRole
      ? undefined
      : new iam.Role(this, "OperatorRole", {
          roleName: props.operatorRoleName,
          description: "AppTheory Lambda MicroVM network connector operator role",
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        });
    if (createdOperatorRole) {
      addOperatorRolePolicy(createdOperatorRole, this.subnetIds, this.securityGroupIds);
    }
    this.operatorRole = props.operatorRole ?? createdOperatorRole!;

    this.networkConnector = new CfnResource(this, "NetworkConnector", {
      type: "AWS::Lambda::NetworkConnector",
      properties: {
        ...(connectorName ? { Name: connectorName } : {}),
        OperatorRole: this.operatorRole.roleArn,
        Configuration: {
          VpcEgressConfiguration: {
            AssociatedComputeResourceTypes: ["MicroVm"],
            NetworkProtocol: protocol,
            SecurityGroupIds: this.securityGroupIds,
            SubnetIds: this.subnetIds,
          },
        },
        Tags: renderTags(props.tags),
      },
    });
    if (createdOperatorRole) {
      this.networkConnector.node.addDependency(createdOperatorRole);
    }

    this.networkConnectorArn = this.networkConnector.ref;
    this.networkConnectorState = this.networkConnector.getAtt("State").toString();
  }
}

function validateRequired(value: unknown, propName: string): void {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryMicrovmNetworkConnector requires props.${propName}`);
  }
}

function normalizeResourceIds<T>(
  resources: readonly T[] | undefined,
  propName: string,
  idOf: (resource: T) => string,
  min: number,
  max: number,
): string[] {
  if (!resources || resources.length < min) {
    throw new Error(`AppTheoryMicrovmNetworkConnector requires at least ${min} ${propName} entry`);
  }
  if (resources.length > max) {
    throw new Error(`AppTheoryMicrovmNetworkConnector supports at most ${max} ${propName} entries`);
  }

  const ids = resources.map((resource, index) => {
    validateRequired(resource, `${propName}[${index}]`);
    const raw = idOf(resource);
    validateRequired(raw, `${propName}[${index}].id`);
    const normalized = String(raw).trim();
    if (!normalized) {
      throw new Error(`AppTheoryMicrovmNetworkConnector requires ${propName}[${index}] to have an id`);
    }
    return normalized;
  });

  const seen = new Set<string>();
  for (const id of ids) {
    if (Token.isUnresolved(id)) {
      continue;
    }
    if (seen.has(id)) {
      throw new Error(`AppTheoryMicrovmNetworkConnector does not allow duplicate ${propName} ids`);
    }
    seen.add(id);
  }

  return ids;
}

function normalizeOptionalConnectorName(name?: string): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("AppTheoryMicrovmNetworkConnector: connectorName cannot be empty");
  }
  if (!Token.isUnresolved(normalized) && !/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
    throw new Error(
      "AppTheoryMicrovmNetworkConnector: connectorName must be 1-64 characters using letters, numbers, hyphens, or underscores",
    );
  }
  return normalized;
}

function normalizeNetworkProtocol(
  protocol: AppTheoryMicrovmNetworkProtocol | string | undefined,
): AppTheoryMicrovmNetworkProtocol {
  const normalized = String(protocol ?? AppTheoryMicrovmNetworkProtocol.IPV4)
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, "");
  if (normalized === "ipv4") {
    return AppTheoryMicrovmNetworkProtocol.IPV4;
  }
  if (normalized === "dualstack") {
    return AppTheoryMicrovmNetworkProtocol.DUAL_STACK;
  }
  throw new Error("AppTheoryMicrovmNetworkConnector: networkProtocol must be IPv4 or DualStack");
}

function addOperatorRolePolicy(role: iam.Role, subnetIds: string[], securityGroupIds: string[]): void {
  const stack = Stack.of(role);
  const networkInterfaceArn = ec2Arn(stack, "network-interface", "*");
  const subnetArns = subnetIds.map((subnetId) => ec2Arn(stack, "subnet", subnetId));
  const securityGroupArns = securityGroupIds.map((securityGroupId) => ec2Arn(stack, "security-group", securityGroupId));

  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "CreateConnectorNetworkInterfaces",
      actions: ["ec2:CreateNetworkInterface"],
      resources: [networkInterfaceArn, ...subnetArns, ...securityGroupArns],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "TagConnectorNetworkInterfaces",
      actions: ["ec2:CreateTags"],
      resources: [networkInterfaceArn],
      conditions: {
        StringEquals: {
          "ec2:ManagedResourceOperator": "network-connectors.lambda.amazonaws.com",
        },
      },
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "DescribeConnectorNetworkContext",
      actions: [
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
      ],
      resources: ["*"],
    }),
  );
}

function ec2Arn(stack: Stack, resource: string, resourceName: string): string {
  return stack.formatArn({
    service: "ec2",
    resource,
    resourceName,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

function renderTags(tags?: Record<string, string>): Array<{ Key: string; Value: string }> {
  const rendered: Array<{ Key: string; Value: string }> = [
    { Key: "Framework", Value: "AppTheory" },
    { Key: "Component", Value: "MicrovmNetworkConnector" },
  ];

  for (const [key, value] of Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("AppTheoryMicrovmNetworkConnector: tag keys cannot be empty");
    }
    rendered.push({ Key: normalizedKey, Value: value });
  }

  return rendered;
}
