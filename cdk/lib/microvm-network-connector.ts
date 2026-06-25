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
 * Direction/type for a Lambda MicroVM network connector reference.
 */
export enum AppTheoryMicrovmNetworkConnectorKind {
  /**
   * Inbound HTTPS connector reference passed to RunMicrovm.
   */
  INGRESS = "ingress",

  /**
   * Outbound connector reference passed to RunMicrovm.
   */
  EGRESS = "egress",

  /**
   * AWS-managed shell ingress connector required for shell-auth-token support.
   */
  SHELL_INGRESS = "shell-ingress",
}

/**
 * AWS-managed Lambda MicroVM network connector references.
 */
export enum AppTheoryMicrovmManagedNetworkConnector {
  /**
   * Enable all inbound HTTPS connectivity for a MicroVM.
   */
  ALL_INGRESS = "ALL_INGRESS",

  /**
   * Explicitly disable inbound HTTPS connectivity for a MicroVM.
   */
  NO_INGRESS = "NO_INGRESS",

  /**
   * Enable AWS-managed public internet egress for a MicroVM.
   */
  INTERNET_EGRESS = "INTERNET_EGRESS",

  /**
   * Enable shell ingress required by CreateMicrovmShellAuthToken.
   */
  SHELL_INGRESS = "SHELL_INGRESS",
}

/**
 * Reference to a Lambda MicroVM network connector usable by MicroVM image constructs.
 */
export interface IAppTheoryMicrovmNetworkConnector {
  /**
   * The network connector ARN.
   */
  readonly networkConnectorArn: string;

  /**
   * Optional connector direction/type used by AppTheory constructs to fail closed when
   * ingress, egress, or shell connector references are wired into the wrong slot.
   */
  readonly networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind;
}

/**
 * Properties for an imported or AWS-managed MicroVM network connector reference.
 */
export interface AppTheoryMicrovmNetworkConnectorReferenceProps {
  /**
   * The network connector ARN.
   */
  readonly networkConnectorArn: string;

  /**
   * Connector direction/type.
   *
   * @default undefined
   */
  readonly networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind;
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
export class AppTheoryMicrovmNetworkConnector extends Construct implements IAppTheoryMicrovmNetworkConnector {
  /**
   * Import an existing Lambda MicroVM network connector ARN into the AppTheory CDK surface.
   */
  public static fromNetworkConnectorArn(
    scope: Construct,
    id: string,
    networkConnectorArn: string,
    networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind,
  ): IAppTheoryMicrovmNetworkConnector {
    return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
      networkConnectorArn,
      networkConnectorKind,
    });
  }

  /**
   * Reference an AWS-managed Lambda MicroVM connector by name.
   */
  public static awsManaged(
    scope: Construct,
    id: string,
    connector: AppTheoryMicrovmManagedNetworkConnector,
  ): IAppTheoryMicrovmNetworkConnector {
    return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, connector);
  }

  /**
   * Reference the AWS-managed ALL_INGRESS connector.
   */
  public static allIngress(scope: Construct, id: string): IAppTheoryMicrovmNetworkConnector {
    return AppTheoryMicrovmNetworkConnectorReference.awsManaged(
      scope,
      id,
      AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS,
    );
  }

  /**
   * Reference the AWS-managed NO_INGRESS connector.
   */
  public static noIngress(scope: Construct, id: string): IAppTheoryMicrovmNetworkConnector {
    return AppTheoryMicrovmNetworkConnectorReference.awsManaged(
      scope,
      id,
      AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS,
    );
  }

  /**
   * Reference the AWS-managed INTERNET_EGRESS connector.
   */
  public static internetEgress(scope: Construct, id: string): IAppTheoryMicrovmNetworkConnector {
    return AppTheoryMicrovmNetworkConnectorReference.awsManaged(
      scope,
      id,
      AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS,
    );
  }

  /**
   * Reference the AWS-managed SHELL_INGRESS connector required for shell auth-token support.
   */
  public static shellIngress(scope: Construct, id: string): IAppTheoryMicrovmNetworkConnector {
    return AppTheoryMicrovmNetworkConnectorReference.awsManaged(
      scope,
      id,
      AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS,
    );
  }

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
   * Created connectors are VPC egress connectors.
   */
  public readonly networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind = AppTheoryMicrovmNetworkConnectorKind.EGRESS;

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

/**
 * AppTheory CDK reference to an existing or AWS-managed Lambda MicroVM network connector.
 *
 * This construct intentionally synthesizes no resources. It gives controller/image constructs a
 * typed connector reference without requiring callers to pass raw strings through deployment code.
 */
export class AppTheoryMicrovmNetworkConnectorReference extends Construct implements IAppTheoryMicrovmNetworkConnector {
  /**
   * Import an existing Lambda MicroVM network connector ARN into the AppTheory CDK surface.
   */
  public static fromNetworkConnectorArn(
    scope: Construct,
    id: string,
    networkConnectorArn: string,
    networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind,
  ): IAppTheoryMicrovmNetworkConnector {
    return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
      networkConnectorArn,
      networkConnectorKind,
    });
  }

  /**
   * Reference an AWS-managed Lambda MicroVM connector by name.
   */
  public static awsManaged(
    scope: Construct,
    id: string,
    connector: AppTheoryMicrovmManagedNetworkConnector,
  ): IAppTheoryMicrovmNetworkConnector {
    const managed = normalizeManagedConnector(connector);
    return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
      networkConnectorArn: managedConnectorArn(scope, managed),
      networkConnectorKind: managedConnectorKind(managed),
    });
  }

  /**
   * The network connector ARN.
   */
  public readonly networkConnectorArn: string;

  /**
   * Optional connector direction/type.
   */
  public readonly networkConnectorKind?: AppTheoryMicrovmNetworkConnectorKind;

  constructor(scope: Construct, id: string, props: AppTheoryMicrovmNetworkConnectorReferenceProps) {
    super(scope, id);

    if (props === undefined || props === null) {
      throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props");
    }

    this.networkConnectorArn = normalizeNetworkConnectorArn(props.networkConnectorArn);
    this.networkConnectorKind = normalizeNetworkConnectorKind(props.networkConnectorKind);
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

function normalizeNetworkConnectorArn(arn: string | undefined): string {
  if (arn === undefined || arn === null) {
    throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props.networkConnectorArn");
  }
  const normalized = String(arn).trim();
  if (!normalized) {
    throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props.networkConnectorArn");
  }
  if (!Token.isUnresolved(arn) && /\s/.test(normalized)) {
    throw new Error("AppTheoryMicrovmNetworkConnectorReference: networkConnectorArn must not contain whitespace");
  }
  if (!Token.isUnresolved(arn) && normalized.length > 2048) {
    throw new Error("AppTheoryMicrovmNetworkConnectorReference: networkConnectorArn must be at most 2048 characters");
  }
  return normalized;
}

function normalizeNetworkConnectorKind(
  kind: AppTheoryMicrovmNetworkConnectorKind | string | undefined,
): AppTheoryMicrovmNetworkConnectorKind | undefined {
  if (kind === undefined) {
    return undefined;
  }
  const normalized = String(kind).trim().toLowerCase().replace(/[_-]/g, "");
  if (normalized === "ingress") {
    return AppTheoryMicrovmNetworkConnectorKind.INGRESS;
  }
  if (normalized === "egress") {
    return AppTheoryMicrovmNetworkConnectorKind.EGRESS;
  }
  if (normalized === "shellingress") {
    return AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS;
  }
  throw new Error("AppTheoryMicrovmNetworkConnectorReference: networkConnectorKind must be ingress, egress, or shell-ingress");
}

function normalizeManagedConnector(
  connector: AppTheoryMicrovmManagedNetworkConnector | string | undefined,
): AppTheoryMicrovmManagedNetworkConnector {
  if (connector === undefined || connector === null) {
    throw new Error("AppTheoryMicrovmNetworkConnectorReference requires a managed connector name");
  }
  const normalized = String(connector).trim().toUpperCase().replace(/[-\s]/g, "_");
  switch (normalized) {
    case AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS:
      return AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS;
    case AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS:
      return AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS;
    case AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS:
      return AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS;
    case AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS:
      return AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS;
    default:
      throw new Error(
        "AppTheoryMicrovmNetworkConnectorReference: managed connector must be ALL_INGRESS, NO_INGRESS, INTERNET_EGRESS, or SHELL_INGRESS",
      );
  }
}

function managedConnectorKind(
  connector: AppTheoryMicrovmManagedNetworkConnector,
): AppTheoryMicrovmNetworkConnectorKind {
  if (connector === AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS) {
    return AppTheoryMicrovmNetworkConnectorKind.EGRESS;
  }
  if (connector === AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS) {
    return AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS;
  }
  return AppTheoryMicrovmNetworkConnectorKind.INGRESS;
}

function managedConnectorArn(scope: Construct, connector: AppTheoryMicrovmManagedNetworkConnector): string {
  const stack = Stack.of(scope);
  return stack.formatArn({
    service: "lambda",
    account: "aws",
    resource: "network-connector",
    resourceName: `aws-network-connector:${connector}`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
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
