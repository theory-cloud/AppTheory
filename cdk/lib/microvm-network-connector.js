"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMicrovmNetworkConnectorReference = exports.AppTheoryMicrovmNetworkConnector = exports.AppTheoryMicrovmManagedNetworkConnector = exports.AppTheoryMicrovmNetworkConnectorKind = exports.AppTheoryMicrovmNetworkProtocol = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = require("aws-cdk-lib/aws-iam");
const constructs_1 = require("constructs");
/**
 * Network protocols supported by Lambda MicroVM VPC egress connectors.
 */
var AppTheoryMicrovmNetworkProtocol;
(function (AppTheoryMicrovmNetworkProtocol) {
    /**
     * IPv4-only VPC egress.
     */
    AppTheoryMicrovmNetworkProtocol["IPV4"] = "IPv4";
    /**
     * Dual-stack IPv4/IPv6 VPC egress.
     */
    AppTheoryMicrovmNetworkProtocol["DUAL_STACK"] = "DualStack";
})(AppTheoryMicrovmNetworkProtocol || (exports.AppTheoryMicrovmNetworkProtocol = AppTheoryMicrovmNetworkProtocol = {}));
/**
 * Direction/type for a Lambda MicroVM network connector reference.
 */
var AppTheoryMicrovmNetworkConnectorKind;
(function (AppTheoryMicrovmNetworkConnectorKind) {
    /**
     * Inbound HTTPS connector reference passed to RunMicrovm.
     */
    AppTheoryMicrovmNetworkConnectorKind["INGRESS"] = "ingress";
    /**
     * Outbound connector reference passed to RunMicrovm.
     */
    AppTheoryMicrovmNetworkConnectorKind["EGRESS"] = "egress";
    /**
     * AWS-managed shell ingress connector required for shell-auth-token support.
     */
    AppTheoryMicrovmNetworkConnectorKind["SHELL_INGRESS"] = "shell-ingress";
})(AppTheoryMicrovmNetworkConnectorKind || (exports.AppTheoryMicrovmNetworkConnectorKind = AppTheoryMicrovmNetworkConnectorKind = {}));
/**
 * AWS-managed Lambda MicroVM network connector references.
 */
var AppTheoryMicrovmManagedNetworkConnector;
(function (AppTheoryMicrovmManagedNetworkConnector) {
    /**
     * Enable all inbound HTTPS connectivity for a MicroVM.
     */
    AppTheoryMicrovmManagedNetworkConnector["ALL_INGRESS"] = "ALL_INGRESS";
    /**
     * Explicitly disable inbound HTTPS connectivity for a MicroVM.
     */
    AppTheoryMicrovmManagedNetworkConnector["NO_INGRESS"] = "NO_INGRESS";
    /**
     * Enable AWS-managed HTTP ingress without broad ALL_INGRESS.
     */
    AppTheoryMicrovmManagedNetworkConnector["HTTP_INGRESS"] = "HTTP_INGRESS";
    /**
     * Enable AWS-managed public internet egress for a MicroVM.
     */
    AppTheoryMicrovmManagedNetworkConnector["INTERNET_EGRESS"] = "INTERNET_EGRESS";
    /**
     * Enable shell ingress required by CreateMicrovmShellAuthToken.
     */
    AppTheoryMicrovmManagedNetworkConnector["SHELL_INGRESS"] = "SHELL_INGRESS";
})(AppTheoryMicrovmManagedNetworkConnector || (exports.AppTheoryMicrovmManagedNetworkConnector = AppTheoryMicrovmManagedNetworkConnector = {}));
/**
 * AppTheory CDK construct for AWS Lambda MicroVM VPC egress network connectors.
 *
 * This construct is intentionally deployment-only: it creates the CloudFormation
 * `AWS::Lambda::NetworkConnector` resource and, unless an operator role is supplied,
 * the IAM role Lambda uses to manage connector ENIs. Runtime MicroVM lifecycle and
 * controller behavior stays in the AppTheory runtime contract.
 */
class AppTheoryMicrovmNetworkConnector extends constructs_1.Construct {
    /**
     * Import an existing Lambda MicroVM network connector ARN into the AppTheory CDK surface.
     */
    static fromNetworkConnectorArn(scope, id, networkConnectorArn, networkConnectorKind) {
        return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
            networkConnectorArn,
            networkConnectorKind,
        });
    }
    /**
     * Reference an AWS-managed Lambda MicroVM connector by name.
     */
    static awsManaged(scope, id, connector) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, connector);
    }
    /**
     * Reference the AWS-managed ALL_INGRESS connector.
     */
    static allIngress(scope, id) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS);
    }
    /**
     * Reference the AWS-managed NO_INGRESS connector.
     */
    static noIngress(scope, id) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS);
    }
    /**
     * Reference the AWS-managed HTTP_INGRESS connector.
     */
    static httpIngress(scope, id) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, AppTheoryMicrovmManagedNetworkConnector.HTTP_INGRESS);
    }
    /**
     * Reference the AWS-managed INTERNET_EGRESS connector.
     */
    static internetEgress(scope, id) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS);
    }
    /**
     * Reference the AWS-managed SHELL_INGRESS connector required for shell auth-token support.
     */
    static shellIngress(scope, id) {
        return AppTheoryMicrovmNetworkConnectorReference.awsManaged(scope, id, AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS);
    }
    constructor(scope, id, props) {
        super(scope, id);
        /**
         * Created connectors are VPC egress connectors.
         */
        this.networkConnectorKind = AppTheoryMicrovmNetworkConnectorKind.EGRESS;
        if (props === undefined || props === null) {
            throw new Error("AppTheoryMicrovmNetworkConnector requires props");
        }
        validateRequired(props.vpc, "vpc");
        if (props.operatorRole && props.operatorRoleName) {
            throw new Error("AppTheoryMicrovmNetworkConnector: operatorRoleName cannot be used with operatorRole");
        }
        this.vpc = props.vpc;
        this.subnetIds = normalizeResourceIds(props.subnets, "subnets", (subnet) => subnet.subnetId, 1, 16);
        this.securityGroupIds = normalizeResourceIds(props.securityGroups, "securityGroups", (securityGroup) => securityGroup.securityGroupId, 1, 5);
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
        this.operatorRole = props.operatorRole ?? createdOperatorRole;
        this.networkConnector = new aws_cdk_lib_1.CfnResource(this, "NetworkConnector", {
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
exports.AppTheoryMicrovmNetworkConnector = AppTheoryMicrovmNetworkConnector;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmNetworkConnector[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnector", version: "1.16.0" };
/**
 * AppTheory CDK reference to an existing or AWS-managed Lambda MicroVM network connector.
 *
 * This construct intentionally synthesizes no resources. It gives controller/image constructs a
 * typed connector reference without requiring callers to pass raw strings through deployment code.
 */
class AppTheoryMicrovmNetworkConnectorReference extends constructs_1.Construct {
    /**
     * Import an existing Lambda MicroVM network connector ARN into the AppTheory CDK surface.
     */
    static fromNetworkConnectorArn(scope, id, networkConnectorArn, networkConnectorKind) {
        return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
            networkConnectorArn,
            networkConnectorKind,
        });
    }
    /**
     * Reference an AWS-managed Lambda MicroVM connector by name.
     */
    static awsManaged(scope, id, connector) {
        const managed = normalizeManagedConnector(connector);
        return new AppTheoryMicrovmNetworkConnectorReference(scope, id, {
            networkConnectorArn: managedConnectorArn(scope, managed),
            networkConnectorKind: managedConnectorKind(managed),
        });
    }
    constructor(scope, id, props) {
        super(scope, id);
        if (props === undefined || props === null) {
            throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props");
        }
        this.networkConnectorArn = normalizeNetworkConnectorArn(props.networkConnectorArn);
        this.networkConnectorKind = normalizeNetworkConnectorKind(props.networkConnectorKind);
    }
}
exports.AppTheoryMicrovmNetworkConnectorReference = AppTheoryMicrovmNetworkConnectorReference;
_b = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmNetworkConnectorReference[_b] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmNetworkConnectorReference", version: "1.16.0" };
function validateRequired(value, propName) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryMicrovmNetworkConnector requires props.${propName}`);
    }
}
function normalizeResourceIds(resources, propName, idOf, min, max) {
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
    const seen = new Set();
    for (const id of ids) {
        if (aws_cdk_lib_1.Token.isUnresolved(id)) {
            continue;
        }
        if (seen.has(id)) {
            throw new Error(`AppTheoryMicrovmNetworkConnector does not allow duplicate ${propName} ids`);
        }
        seen.add(id);
    }
    return ids;
}
function normalizeOptionalConnectorName(name) {
    if (name === undefined) {
        return undefined;
    }
    const normalized = name.trim();
    if (!normalized) {
        throw new Error("AppTheoryMicrovmNetworkConnector: connectorName cannot be empty");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(normalized) && !/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
        throw new Error("AppTheoryMicrovmNetworkConnector: connectorName must be 1-64 characters using letters, numbers, hyphens, or underscores");
    }
    return normalized;
}
function normalizeNetworkProtocol(protocol) {
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
function normalizeNetworkConnectorArn(arn) {
    if (arn === undefined || arn === null) {
        throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props.networkConnectorArn");
    }
    const normalized = String(arn).trim();
    if (!normalized) {
        throw new Error("AppTheoryMicrovmNetworkConnectorReference requires props.networkConnectorArn");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(arn) && /\s/.test(normalized)) {
        throw new Error("AppTheoryMicrovmNetworkConnectorReference: networkConnectorArn must not contain whitespace");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(arn) && normalized.length > 2048) {
        throw new Error("AppTheoryMicrovmNetworkConnectorReference: networkConnectorArn must be at most 2048 characters");
    }
    return normalized;
}
function normalizeNetworkConnectorKind(kind) {
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
function normalizeManagedConnector(connector) {
    if (connector === undefined || connector === null) {
        throw new Error("AppTheoryMicrovmNetworkConnectorReference requires a managed connector name");
    }
    const normalized = String(connector).trim().toUpperCase().replace(/[-\s]/g, "_");
    switch (normalized) {
        case AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS:
            return AppTheoryMicrovmManagedNetworkConnector.ALL_INGRESS;
        case AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS:
            return AppTheoryMicrovmManagedNetworkConnector.NO_INGRESS;
        case AppTheoryMicrovmManagedNetworkConnector.HTTP_INGRESS:
            return AppTheoryMicrovmManagedNetworkConnector.HTTP_INGRESS;
        case AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS:
            return AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS;
        case AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS:
            return AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS;
        default:
            throw new Error("AppTheoryMicrovmNetworkConnectorReference: managed connector must be ALL_INGRESS, NO_INGRESS, HTTP_INGRESS, INTERNET_EGRESS, or SHELL_INGRESS");
    }
}
function managedConnectorKind(connector) {
    if (connector === AppTheoryMicrovmManagedNetworkConnector.INTERNET_EGRESS) {
        return AppTheoryMicrovmNetworkConnectorKind.EGRESS;
    }
    if (connector === AppTheoryMicrovmManagedNetworkConnector.SHELL_INGRESS) {
        return AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS;
    }
    return AppTheoryMicrovmNetworkConnectorKind.INGRESS;
}
function managedConnectorArn(scope, connector) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    return stack.formatArn({
        service: "lambda",
        account: "aws",
        resource: "network-connector",
        resourceName: `aws-network-connector:${connector}`,
        arnFormat: aws_cdk_lib_1.ArnFormat.COLON_RESOURCE_NAME,
    });
}
function addOperatorRolePolicy(role, subnetIds, securityGroupIds) {
    const stack = aws_cdk_lib_1.Stack.of(role);
    const networkInterfaceArn = ec2Arn(stack, "network-interface", "*");
    const subnetArns = subnetIds.map((subnetId) => ec2Arn(stack, "subnet", subnetId));
    const securityGroupArns = securityGroupIds.map((securityGroupId) => ec2Arn(stack, "security-group", securityGroupId));
    role.addToPolicy(new iam.PolicyStatement({
        sid: "CreateConnectorNetworkInterfaces",
        actions: ["ec2:CreateNetworkInterface"],
        resources: [networkInterfaceArn, ...subnetArns, ...securityGroupArns],
    }));
    role.addToPolicy(new iam.PolicyStatement({
        sid: "TagConnectorNetworkInterfaces",
        actions: ["ec2:CreateTags"],
        resources: [networkInterfaceArn],
        conditions: {
            StringEquals: {
                "ec2:ManagedResourceOperator": "network-connectors.lambda.amazonaws.com",
            },
        },
    }));
    role.addToPolicy(new iam.PolicyStatement({
        sid: "DescribeConnectorNetworkContext",
        actions: [
            "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeSecurityGroups",
            "ec2:DescribeSubnets",
            "ec2:DescribeVpcs",
        ],
        resources: ["*"],
    }));
}
function ec2Arn(stack, resource, resourceName) {
    return stack.formatArn({
        service: "ec2",
        resource,
        resourceName,
        arnFormat: aws_cdk_lib_1.ArnFormat.SLASH_RESOURCE_NAME,
    });
}
function renderTags(tags) {
    const rendered = [
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1uZXR3b3JrLWNvbm5lY3Rvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1pY3Jvdm0tbmV0d29yay1jb25uZWN0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUU7QUFFbkUsMkNBQTJDO0FBQzNDLDJDQUF1QztBQUV2Qzs7R0FFRztBQUNILElBQVksK0JBVVg7QUFWRCxXQUFZLCtCQUErQjtJQUN6Qzs7T0FFRztJQUNILGdEQUFhLENBQUE7SUFFYjs7T0FFRztJQUNILDJEQUF3QixDQUFBO0FBQzFCLENBQUMsRUFWVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQVUxQztBQUVEOztHQUVHO0FBQ0gsSUFBWSxvQ0FlWDtBQWZELFdBQVksb0NBQW9DO0lBQzlDOztPQUVHO0lBQ0gsMkRBQW1CLENBQUE7SUFFbkI7O09BRUc7SUFDSCx5REFBaUIsQ0FBQTtJQUVqQjs7T0FFRztJQUNILHVFQUErQixDQUFBO0FBQ2pDLENBQUMsRUFmVyxvQ0FBb0Msb0RBQXBDLG9DQUFvQyxRQWUvQztBQUVEOztHQUVHO0FBQ0gsSUFBWSx1Q0F5Qlg7QUF6QkQsV0FBWSx1Q0FBdUM7SUFDakQ7O09BRUc7SUFDSCxzRUFBMkIsQ0FBQTtJQUUzQjs7T0FFRztJQUNILG9FQUF5QixDQUFBO0lBRXpCOztPQUVHO0lBQ0gsd0VBQTZCLENBQUE7SUFFN0I7O09BRUc7SUFDSCw4RUFBbUMsQ0FBQTtJQUVuQzs7T0FFRztJQUNILDBFQUErQixDQUFBO0FBQ2pDLENBQUMsRUF6QlcsdUNBQXVDLHVEQUF2Qyx1Q0FBdUMsUUF5QmxEO0FBa0dEOzs7Ozs7O0dBT0c7QUFDSCxNQUFhLGdDQUFpQyxTQUFRLHNCQUFTO0lBQzdEOztPQUVHO0lBQ0ksTUFBTSxDQUFDLHVCQUF1QixDQUNuQyxLQUFnQixFQUNoQixFQUFVLEVBQ1YsbUJBQTJCLEVBQzNCLG9CQUEyRDtRQUUzRCxPQUFPLElBQUkseUNBQXlDLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRTtZQUM5RCxtQkFBbUI7WUFDbkIsb0JBQW9CO1NBQ3JCLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxVQUFVLENBQ3RCLEtBQWdCLEVBQ2hCLEVBQVUsRUFDVixTQUFrRDtRQUVsRCxPQUFPLHlDQUF5QyxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ3BGLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxVQUFVLENBQUMsS0FBZ0IsRUFBRSxFQUFVO1FBQ25ELE9BQU8seUNBQXlDLENBQUMsVUFBVSxDQUN6RCxLQUFLLEVBQ0wsRUFBRSxFQUNGLHVDQUF1QyxDQUFDLFdBQVcsQ0FDcEQsQ0FBQztJQUNKLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBZ0IsRUFBRSxFQUFVO1FBQ2xELE9BQU8seUNBQXlDLENBQUMsVUFBVSxDQUN6RCxLQUFLLEVBQ0wsRUFBRSxFQUNGLHVDQUF1QyxDQUFDLFVBQVUsQ0FDbkQsQ0FBQztJQUNKLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxXQUFXLENBQUMsS0FBZ0IsRUFBRSxFQUFVO1FBQ3BELE9BQU8seUNBQXlDLENBQUMsVUFBVSxDQUN6RCxLQUFLLEVBQ0wsRUFBRSxFQUNGLHVDQUF1QyxDQUFDLFlBQVksQ0FDckQsQ0FBQztJQUNKLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxjQUFjLENBQUMsS0FBZ0IsRUFBRSxFQUFVO1FBQ3ZELE9BQU8seUNBQXlDLENBQUMsVUFBVSxDQUN6RCxLQUFLLEVBQ0wsRUFBRSxFQUNGLHVDQUF1QyxDQUFDLGVBQWUsQ0FDeEQsQ0FBQztJQUNKLENBQUM7SUFFRDs7T0FFRztJQUNJLE1BQU0sQ0FBQyxZQUFZLENBQUMsS0FBZ0IsRUFBRSxFQUFVO1FBQ3JELE9BQU8seUNBQXlDLENBQUMsVUFBVSxDQUN6RCxLQUFLLEVBQ0wsRUFBRSxFQUNGLHVDQUF1QyxDQUFDLGFBQWEsQ0FDdEQsQ0FBQztJQUNKLENBQUM7SUEwQ0QsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QztRQUNwRixLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBWG5COztXQUVHO1FBQ2EseUJBQW9CLEdBQTBDLG9DQUFvQyxDQUFDLE1BQU0sQ0FBQztRQVV4SCxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBQ0QsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNuQyxJQUFJLEtBQUssQ0FBQyxZQUFZLElBQUksS0FBSyxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDakQsTUFBTSxJQUFJLEtBQUssQ0FBQyxxRkFBcUYsQ0FBQyxDQUFDO1FBQ3pHLENBQUM7UUFFRCxJQUFJLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUM7UUFDckIsSUFBSSxDQUFDLFNBQVMsR0FBRyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFFBQVEsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDcEcsSUFBSSxDQUFDLGdCQUFnQixHQUFHLG9CQUFvQixDQUMxQyxLQUFLLENBQUMsY0FBYyxFQUNwQixnQkFBZ0IsRUFDaEIsQ0FBQyxhQUFhLEVBQUUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxlQUFlLEVBQ2hELENBQUMsRUFDRCxDQUFDLENBQ0YsQ0FBQztRQUVGLE1BQU0sYUFBYSxHQUFHLDhCQUE4QixDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUMxRSxNQUFNLFFBQVEsR0FBRyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUM7UUFFakUsTUFBTSxtQkFBbUIsR0FBRyxLQUFLLENBQUMsWUFBWTtZQUM1QyxDQUFDLENBQUMsU0FBUztZQUNYLENBQUMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtnQkFDakMsUUFBUSxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7Z0JBQ2hDLFdBQVcsRUFBRSwwREFBMEQ7Z0JBQ3ZFLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxzQkFBc0IsQ0FBQzthQUM1RCxDQUFDLENBQUM7UUFDUCxJQUFJLG1CQUFtQixFQUFFLENBQUM7WUFDeEIscUJBQXFCLENBQUMsbUJBQW1CLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUNwRixDQUFDO1FBQ0QsSUFBSSxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUMsWUFBWSxJQUFJLG1CQUFvQixDQUFDO1FBRS9ELElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLHlCQUFXLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ2hFLElBQUksRUFBRSwrQkFBK0I7WUFDckMsVUFBVSxFQUFFO2dCQUNWLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ2pELFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU87Z0JBQ3ZDLGFBQWEsRUFBRTtvQkFDYixzQkFBc0IsRUFBRTt3QkFDdEIsOEJBQThCLEVBQUUsQ0FBQyxTQUFTLENBQUM7d0JBQzNDLGVBQWUsRUFBRSxRQUFRO3dCQUN6QixnQkFBZ0IsRUFBRSxJQUFJLENBQUMsZ0JBQWdCO3dCQUN2QyxTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVM7cUJBQzFCO2lCQUNGO2dCQUNELElBQUksRUFBRSxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQzthQUM3QjtTQUNGLENBQUMsQ0FBQztRQUNILElBQUksbUJBQW1CLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQ2hFLENBQUM7UUFFRCxJQUFJLENBQUMsbUJBQW1CLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQztRQUNyRCxJQUFJLENBQUMscUJBQXFCLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQztJQUNoRixDQUFDOztBQXBMSCw0RUFxTEM7OztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBYSx5Q0FBMEMsU0FBUSxzQkFBUztJQUN0RTs7T0FFRztJQUNJLE1BQU0sQ0FBQyx1QkFBdUIsQ0FDbkMsS0FBZ0IsRUFDaEIsRUFBVSxFQUNWLG1CQUEyQixFQUMzQixvQkFBMkQ7UUFFM0QsT0FBTyxJQUFJLHlDQUF5QyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUU7WUFDOUQsbUJBQW1CO1lBQ25CLG9CQUFvQjtTQUNyQixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7O09BRUc7SUFDSSxNQUFNLENBQUMsVUFBVSxDQUN0QixLQUFnQixFQUNoQixFQUFVLEVBQ1YsU0FBa0Q7UUFFbEQsTUFBTSxPQUFPLEdBQUcseUJBQXlCLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDckQsT0FBTyxJQUFJLHlDQUF5QyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUU7WUFDOUQsbUJBQW1CLEVBQUUsbUJBQW1CLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQztZQUN4RCxvQkFBb0IsRUFBRSxvQkFBb0IsQ0FBQyxPQUFPLENBQUM7U0FDcEQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQVlELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBcUQ7UUFDN0YsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsMERBQTBELENBQUMsQ0FBQztRQUM5RSxDQUFDO1FBRUQsSUFBSSxDQUFDLG1CQUFtQixHQUFHLDRCQUE0QixDQUFDLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQ25GLElBQUksQ0FBQyxvQkFBb0IsR0FBRyw2QkFBNkIsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUN4RixDQUFDOztBQWxESCw4RkFtREM7OztBQUVELFNBQVMsZ0JBQWdCLENBQUMsS0FBYyxFQUFFLFFBQWdCO0lBQ3hELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDMUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUNqRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsb0JBQW9CLENBQzNCLFNBQW1DLEVBQ25DLFFBQWdCLEVBQ2hCLElBQTZCLEVBQzdCLEdBQVcsRUFDWCxHQUFXO0lBRVgsSUFBSSxDQUFDLFNBQVMsSUFBSSxTQUFTLENBQUMsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDO1FBQ3pDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0RBQXNELEdBQUcsSUFBSSxRQUFRLFFBQVEsQ0FBQyxDQUFDO0lBQ2pHLENBQUM7SUFDRCxJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUM7UUFDM0IsTUFBTSxJQUFJLEtBQUssQ0FBQyxxREFBcUQsR0FBRyxJQUFJLFFBQVEsVUFBVSxDQUFDLENBQUM7SUFDbEcsQ0FBQztJQUVELE1BQU0sR0FBRyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxRQUFRLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDNUMsZ0JBQWdCLENBQUMsUUFBUSxFQUFFLEdBQUcsUUFBUSxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7UUFDcEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzNCLGdCQUFnQixDQUFDLEdBQUcsRUFBRSxHQUFHLFFBQVEsSUFBSSxLQUFLLE1BQU0sQ0FBQyxDQUFDO1FBQ2xELE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN0QyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyw2Q0FBNkMsUUFBUSxJQUFJLEtBQUssaUJBQWlCLENBQUMsQ0FBQztRQUNuRyxDQUFDO1FBQ0QsT0FBTyxVQUFVLENBQUM7SUFDcEIsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQy9CLEtBQUssTUFBTSxFQUFFLElBQUksR0FBRyxFQUFFLENBQUM7UUFDckIsSUFBSSxtQkFBSyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQzNCLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7WUFDakIsTUFBTSxJQUFJLEtBQUssQ0FBQyw2REFBNkQsUUFBUSxNQUFNLENBQUMsQ0FBQztRQUMvRixDQUFDO1FBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNmLENBQUM7SUFFRCxPQUFPLEdBQUcsQ0FBQztBQUNiLENBQUM7QUFFRCxTQUFTLDhCQUE4QixDQUFDLElBQWE7SUFDbkQsSUFBSSxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDdkIsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUMvQixJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxpRUFBaUUsQ0FBQyxDQUFDO0lBQ3JGLENBQUM7SUFDRCxJQUFJLENBQUMsbUJBQUssQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUNqRixNQUFNLElBQUksS0FBSyxDQUNiLHlIQUF5SCxDQUMxSCxDQUFDO0lBQ0osQ0FBQztJQUNELE9BQU8sVUFBVSxDQUFDO0FBQ3BCLENBQUM7QUFFRCxTQUFTLHdCQUF3QixDQUMvQixRQUE4RDtJQUU5RCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsUUFBUSxJQUFJLCtCQUErQixDQUFDLElBQUksQ0FBQztTQUN4RSxJQUFJLEVBQUU7U0FDTixXQUFXLEVBQUU7U0FDYixPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3hCLElBQUksVUFBVSxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQzFCLE9BQU8sK0JBQStCLENBQUMsSUFBSSxDQUFDO0lBQzlDLENBQUM7SUFDRCxJQUFJLFVBQVUsS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUMvQixPQUFPLCtCQUErQixDQUFDLFVBQVUsQ0FBQztJQUNwRCxDQUFDO0lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQyw2RUFBNkUsQ0FBQyxDQUFDO0FBQ2pHLENBQUM7QUFFRCxTQUFTLDRCQUE0QixDQUFDLEdBQXVCO0lBQzNELElBQUksR0FBRyxLQUFLLFNBQVMsSUFBSSxHQUFHLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQyw4RUFBOEUsQ0FBQyxDQUFDO0lBQ2xHLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDdEMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsOEVBQThFLENBQUMsQ0FBQztJQUNsRyxDQUFDO0lBQ0QsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUFDLDRGQUE0RixDQUFDLENBQUM7SUFDaEgsQ0FBQztJQUNELElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsSUFBSSxVQUFVLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDO1FBQ3pELE1BQU0sSUFBSSxLQUFLLENBQUMsZ0dBQWdHLENBQUMsQ0FBQztJQUNwSCxDQUFDO0lBQ0QsT0FBTyxVQUFVLENBQUM7QUFDcEIsQ0FBQztBQUVELFNBQVMsNkJBQTZCLENBQ3BDLElBQStEO0lBRS9ELElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3ZCLE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsQ0FBQztJQUMxRSxJQUFJLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUM3QixPQUFPLG9DQUFvQyxDQUFDLE9BQU8sQ0FBQztJQUN0RCxDQUFDO0lBQ0QsSUFBSSxVQUFVLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDNUIsT0FBTyxvQ0FBb0MsQ0FBQyxNQUFNLENBQUM7SUFDckQsQ0FBQztJQUNELElBQUksVUFBVSxLQUFLLGNBQWMsRUFBRSxDQUFDO1FBQ2xDLE9BQU8sb0NBQW9DLENBQUMsYUFBYSxDQUFDO0lBQzVELENBQUM7SUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLDJHQUEyRyxDQUFDLENBQUM7QUFDL0gsQ0FBQztBQUVELFNBQVMseUJBQXlCLENBQ2hDLFNBQXVFO0lBRXZFLElBQUksU0FBUyxLQUFLLFNBQVMsSUFBSSxTQUFTLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDbEQsTUFBTSxJQUFJLEtBQUssQ0FBQyw2RUFBNkUsQ0FBQyxDQUFDO0lBQ2pHLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNqRixRQUFRLFVBQVUsRUFBRSxDQUFDO1FBQ25CLEtBQUssdUNBQXVDLENBQUMsV0FBVztZQUN0RCxPQUFPLHVDQUF1QyxDQUFDLFdBQVcsQ0FBQztRQUM3RCxLQUFLLHVDQUF1QyxDQUFDLFVBQVU7WUFDckQsT0FBTyx1Q0FBdUMsQ0FBQyxVQUFVLENBQUM7UUFDNUQsS0FBSyx1Q0FBdUMsQ0FBQyxZQUFZO1lBQ3ZELE9BQU8sdUNBQXVDLENBQUMsWUFBWSxDQUFDO1FBQzlELEtBQUssdUNBQXVDLENBQUMsZUFBZTtZQUMxRCxPQUFPLHVDQUF1QyxDQUFDLGVBQWUsQ0FBQztRQUNqRSxLQUFLLHVDQUF1QyxDQUFDLGFBQWE7WUFDeEQsT0FBTyx1Q0FBdUMsQ0FBQyxhQUFhLENBQUM7UUFDL0Q7WUFDRSxNQUFNLElBQUksS0FBSyxDQUNiLCtJQUErSSxDQUNoSixDQUFDO0lBQ04sQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUMzQixTQUFrRDtJQUVsRCxJQUFJLFNBQVMsS0FBSyx1Q0FBdUMsQ0FBQyxlQUFlLEVBQUUsQ0FBQztRQUMxRSxPQUFPLG9DQUFvQyxDQUFDLE1BQU0sQ0FBQztJQUNyRCxDQUFDO0lBQ0QsSUFBSSxTQUFTLEtBQUssdUNBQXVDLENBQUMsYUFBYSxFQUFFLENBQUM7UUFDeEUsT0FBTyxvQ0FBb0MsQ0FBQyxhQUFhLENBQUM7SUFDNUQsQ0FBQztJQUNELE9BQU8sb0NBQW9DLENBQUMsT0FBTyxDQUFDO0FBQ3RELENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLEtBQWdCLEVBQUUsU0FBa0Q7SUFDL0YsTUFBTSxLQUFLLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUIsT0FBTyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ3JCLE9BQU8sRUFBRSxRQUFRO1FBQ2pCLE9BQU8sRUFBRSxLQUFLO1FBQ2QsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixZQUFZLEVBQUUseUJBQXlCLFNBQVMsRUFBRTtRQUNsRCxTQUFTLEVBQUUsdUJBQVMsQ0FBQyxtQkFBbUI7S0FDekMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsSUFBYyxFQUFFLFNBQW1CLEVBQUUsZ0JBQTBCO0lBQzVGLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzdCLE1BQU0sbUJBQW1CLEdBQUcsTUFBTSxDQUFDLEtBQUssRUFBRSxtQkFBbUIsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNwRSxNQUFNLFVBQVUsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLE1BQU0saUJBQWlCLEdBQUcsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLENBQUMsZUFBZSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLGdCQUFnQixFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUM7SUFFdEgsSUFBSSxDQUFDLFdBQVcsQ0FDZCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7UUFDdEIsR0FBRyxFQUFFLGtDQUFrQztRQUN2QyxPQUFPLEVBQUUsQ0FBQyw0QkFBNEIsQ0FBQztRQUN2QyxTQUFTLEVBQUUsQ0FBQyxtQkFBbUIsRUFBRSxHQUFHLFVBQVUsRUFBRSxHQUFHLGlCQUFpQixDQUFDO0tBQ3RFLENBQUMsQ0FDSCxDQUFDO0lBQ0YsSUFBSSxDQUFDLFdBQVcsQ0FDZCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7UUFDdEIsR0FBRyxFQUFFLCtCQUErQjtRQUNwQyxPQUFPLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQztRQUMzQixTQUFTLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQztRQUNoQyxVQUFVLEVBQUU7WUFDVixZQUFZLEVBQUU7Z0JBQ1osNkJBQTZCLEVBQUUseUNBQXlDO2FBQ3pFO1NBQ0Y7S0FDRixDQUFDLENBQ0gsQ0FBQztJQUNGLElBQUksQ0FBQyxXQUFXLENBQ2QsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1FBQ3RCLEdBQUcsRUFBRSxpQ0FBaUM7UUFDdEMsT0FBTyxFQUFFO1lBQ1AsK0JBQStCO1lBQy9CLDRCQUE0QjtZQUM1QixxQkFBcUI7WUFDckIsa0JBQWtCO1NBQ25CO1FBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO0tBQ2pCLENBQUMsQ0FDSCxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsTUFBTSxDQUFDLEtBQVksRUFBRSxRQUFnQixFQUFFLFlBQW9CO0lBQ2xFLE9BQU8sS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUNyQixPQUFPLEVBQUUsS0FBSztRQUNkLFFBQVE7UUFDUixZQUFZO1FBQ1osU0FBUyxFQUFFLHVCQUFTLENBQUMsbUJBQW1CO0tBQ3pDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxJQUE2QjtJQUMvQyxNQUFNLFFBQVEsR0FBMEM7UUFDdEQsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUU7UUFDeEMsRUFBRSxHQUFHLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSx5QkFBeUIsRUFBRTtLQUN2RCxDQUFDO0lBRUYsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDN0YsTUFBTSxhQUFhLEdBQUcsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2pDLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUNuQixNQUFNLElBQUksS0FBSyxDQUFDLDREQUE0RCxDQUFDLENBQUM7UUFDaEYsQ0FBQztRQUNELFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXJuRm9ybWF0LCBDZm5SZXNvdXJjZSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGVjMiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIE5ldHdvcmsgcHJvdG9jb2xzIHN1cHBvcnRlZCBieSBMYW1iZGEgTWljcm9WTSBWUEMgZWdyZXNzIGNvbm5lY3RvcnMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrUHJvdG9jb2wge1xuICAvKipcbiAgICogSVB2NC1vbmx5IFZQQyBlZ3Jlc3MuXG4gICAqL1xuICBJUFY0ID0gXCJJUHY0XCIsXG5cbiAgLyoqXG4gICAqIER1YWwtc3RhY2sgSVB2NC9JUHY2IFZQQyBlZ3Jlc3MuXG4gICAqL1xuICBEVUFMX1NUQUNLID0gXCJEdWFsU3RhY2tcIixcbn1cblxuLyoqXG4gKiBEaXJlY3Rpb24vdHlwZSBmb3IgYSBMYW1iZGEgTWljcm9WTSBuZXR3b3JrIGNvbm5lY3RvciByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB7XG4gIC8qKlxuICAgKiBJbmJvdW5kIEhUVFBTIGNvbm5lY3RvciByZWZlcmVuY2UgcGFzc2VkIHRvIFJ1bk1pY3Jvdm0uXG4gICAqL1xuICBJTkdSRVNTID0gXCJpbmdyZXNzXCIsXG5cbiAgLyoqXG4gICAqIE91dGJvdW5kIGNvbm5lY3RvciByZWZlcmVuY2UgcGFzc2VkIHRvIFJ1bk1pY3Jvdm0uXG4gICAqL1xuICBFR1JFU1MgPSBcImVncmVzc1wiLFxuXG4gIC8qKlxuICAgKiBBV1MtbWFuYWdlZCBzaGVsbCBpbmdyZXNzIGNvbm5lY3RvciByZXF1aXJlZCBmb3Igc2hlbGwtYXV0aC10b2tlbiBzdXBwb3J0LlxuICAgKi9cbiAgU0hFTExfSU5HUkVTUyA9IFwic2hlbGwtaW5ncmVzc1wiLFxufVxuXG4vKipcbiAqIEFXUy1tYW5hZ2VkIExhbWJkYSBNaWNyb1ZNIG5ldHdvcmsgY29ubmVjdG9yIHJlZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3RvciB7XG4gIC8qKlxuICAgKiBFbmFibGUgYWxsIGluYm91bmQgSFRUUFMgY29ubmVjdGl2aXR5IGZvciBhIE1pY3JvVk0uXG4gICAqL1xuICBBTExfSU5HUkVTUyA9IFwiQUxMX0lOR1JFU1NcIixcblxuICAvKipcbiAgICogRXhwbGljaXRseSBkaXNhYmxlIGluYm91bmQgSFRUUFMgY29ubmVjdGl2aXR5IGZvciBhIE1pY3JvVk0uXG4gICAqL1xuICBOT19JTkdSRVNTID0gXCJOT19JTkdSRVNTXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSBBV1MtbWFuYWdlZCBIVFRQIGluZ3Jlc3Mgd2l0aG91dCBicm9hZCBBTExfSU5HUkVTUy5cbiAgICovXG4gIEhUVFBfSU5HUkVTUyA9IFwiSFRUUF9JTkdSRVNTXCIsXG5cbiAgLyoqXG4gICAqIEVuYWJsZSBBV1MtbWFuYWdlZCBwdWJsaWMgaW50ZXJuZXQgZWdyZXNzIGZvciBhIE1pY3JvVk0uXG4gICAqL1xuICBJTlRFUk5FVF9FR1JFU1MgPSBcIklOVEVSTkVUX0VHUkVTU1wiLFxuXG4gIC8qKlxuICAgKiBFbmFibGUgc2hlbGwgaW5ncmVzcyByZXF1aXJlZCBieSBDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW4uXG4gICAqL1xuICBTSEVMTF9JTkdSRVNTID0gXCJTSEVMTF9JTkdSRVNTXCIsXG59XG5cbi8qKlxuICogUmVmZXJlbmNlIHRvIGEgTGFtYmRhIE1pY3JvVk0gbmV0d29yayBjb25uZWN0b3IgdXNhYmxlIGJ5IE1pY3JvVk0gaW1hZ2UgY29uc3RydWN0cy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Ige1xuICAvKipcbiAgICogVGhlIG5ldHdvcmsgY29ubmVjdG9yIEFSTi5cbiAgICovXG4gIHJlYWRvbmx5IG5ldHdvcmtDb25uZWN0b3JBcm46IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY29ubmVjdG9yIGRpcmVjdGlvbi90eXBlIHVzZWQgYnkgQXBwVGhlb3J5IGNvbnN0cnVjdHMgdG8gZmFpbCBjbG9zZWQgd2hlblxuICAgKiBpbmdyZXNzLCBlZ3Jlc3MsIG9yIHNoZWxsIGNvbm5lY3RvciByZWZlcmVuY2VzIGFyZSB3aXJlZCBpbnRvIHRoZSB3cm9uZyBzbG90LlxuICAgKi9cbiAgcmVhZG9ubHkgbmV0d29ya0Nvbm5lY3RvcktpbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQ7XG59XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgYW4gaW1wb3J0ZWQgb3IgQVdTLW1hbmFnZWQgTWljcm9WTSBuZXR3b3JrIGNvbm5lY3RvciByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgbmV0d29yayBjb25uZWN0b3IgQVJOLlxuICAgKi9cbiAgcmVhZG9ubHkgbmV0d29ya0Nvbm5lY3RvckFybjogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBDb25uZWN0b3IgZGlyZWN0aW9uL3R5cGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmV0d29ya0Nvbm5lY3RvcktpbmQ/OiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQ7XG59XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JQcm9wcyB7XG4gIC8qKlxuICAgKiBDYWxsZXItcHJvdmlkZWQgVlBDIHRoYXQgb3ducyB0aGUgc3VibmV0cyBhbmQgc2VjdXJpdHkgZ3JvdXBzIHVzZWQgYnkgdGhlIGNvbm5lY3Rvci5cbiAgICpcbiAgICogQXBwVGhlb3J5IGRvZXMgbm90IHN5bnRoZXNpemUgYSBWUEMgZm9yIE1pY3JvVk0gZWdyZXNzLiBUaGUgVlBDIGJvdW5kYXJ5IGlzIHBhcnQgb2ZcbiAgICogdGhlIGFwcGxpY2F0aW9uJ3MgZGVwbG95bWVudCBjb250cmFjdC5cbiAgICovXG4gIHJlYWRvbmx5IHZwYzogZWMyLklWcGM7XG5cbiAgLyoqXG4gICAqIENhbGxlci1wcm92aWRlZCBzdWJuZXRzIHdoZXJlIExhbWJkYSBwcm92aXNpb25zIGNvbm5lY3RvciBFTklzLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgc3VibmV0IGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTYgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc3VibmV0czogZWMyLklTdWJuZXRbXTtcblxuICAvKipcbiAgICogQ2FsbGVyLXByb3ZpZGVkIHNlY3VyaXR5IGdyb3VwcyBhdHRhY2hlZCB0byBjb25uZWN0b3IgRU5Jcy5cbiAgICpcbiAgICogQXBwVGhlb3J5IHJlcXVpcmVzIGV4cGxpY2l0IHNlY3VyaXR5IGdyb3VwIGNvbnRleHQgaW5zdGVhZCBvZiBmYWxsaW5nIGJhY2sgdG8gYSBWUENcbiAgICogZGVmYXVsdCBzZWN1cml0eSBncm91cC4gQXQgbGVhc3Qgb25lIHNlY3VyaXR5IGdyb3VwIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gZml2ZVxuICAgKiBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eUdyb3VwczogZWMyLklTZWN1cml0eUdyb3VwW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHBoeXNpY2FsIG5ldHdvcmsgY29ubmVjdG9yIG5hbWUuXG4gICAqXG4gICAqIFdoZW4gb21pdHRlZCwgQ2xvdWRGb3JtYXRpb24gYXNzaWducyB0aGUgcGh5c2ljYWwgbmFtZS5cbiAgICovXG4gIHJlYWRvbmx5IGNvbm5lY3Rvck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE5ldHdvcmsgcHJvdG9jb2wgZm9yIFZQQyBlZ3Jlc3MuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrUHJvdG9jb2wuSVBWNFxuICAgKi9cbiAgcmVhZG9ubHkgbmV0d29ya1Byb3RvY29sPzogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtQcm90b2NvbDtcblxuICAvKipcbiAgICogRXhpc3Rpbmcgb3BlcmF0b3Igcm9sZSBmb3IgTGFtYmRhIHRvIGFzc3VtZSB3aGlsZSBtYW5hZ2luZyBjb25uZWN0b3IgRU5Jcy5cbiAgICpcbiAgICogV2hlbiBvbWl0dGVkLCBBcHBUaGVvcnkgY3JlYXRlcyBhIHJvbGUgd2l0aCB0aGUgTWljcm9WTSBuZXR3b3JrLWNvbm5lY3RvciBFTkkgcG9saWN5LlxuICAgKiBDYWxsZXItcHJvdmlkZWQgcm9sZXMgbXVzdCBhbHJlYWR5IHRydXN0IExhbWJkYSBhbmQgaW5jbHVkZSB0aGUgcmVxdWlyZWQgRUMyIHBlcm1pc3Npb25zLlxuICAgKi9cbiAgcmVhZG9ubHkgb3BlcmF0b3JSb2xlPzogaWFtLklSb2xlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1lIGZvciB0aGUgb3BlcmF0b3Igcm9sZSB3aGVuIEFwcFRoZW9yeSBjcmVhdGVzIGl0LlxuICAgKlxuICAgKiBDYW5ub3QgYmUgdXNlZCB3aXRoIG9wZXJhdG9yUm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IG9wZXJhdG9yUm9sZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgQ2xvdWRGb3JtYXRpb24gdGFncyB0byBhcHBseSB0byB0aGUgY29ubmVjdG9yLlxuICAgKi9cbiAgcmVhZG9ubHkgdGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIEFXUyBMYW1iZGEgTWljcm9WTSBWUEMgZWdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBpbnRlbnRpb25hbGx5IGRlcGxveW1lbnQtb25seTogaXQgY3JlYXRlcyB0aGUgQ2xvdWRGb3JtYXRpb25cbiAqIGBBV1M6OkxhbWJkYTo6TmV0d29ya0Nvbm5lY3RvcmAgcmVzb3VyY2UgYW5kLCB1bmxlc3MgYW4gb3BlcmF0b3Igcm9sZSBpcyBzdXBwbGllZCxcbiAqIHRoZSBJQU0gcm9sZSBMYW1iZGEgdXNlcyB0byBtYW5hZ2UgY29ubmVjdG9yIEVOSXMuIFJ1bnRpbWUgTWljcm9WTSBsaWZlY3ljbGUgYW5kXG4gKiBjb250cm9sbGVyIGJlaGF2aW9yIHN0YXlzIGluIHRoZSBBcHBUaGVvcnkgcnVudGltZSBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgLyoqXG4gICAqIEltcG9ydCBhbiBleGlzdGluZyBMYW1iZGEgTWljcm9WTSBuZXR3b3JrIGNvbm5lY3RvciBBUk4gaW50byB0aGUgQXBwVGhlb3J5IENESyBzdXJmYWNlLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBmcm9tTmV0d29ya0Nvbm5lY3RvckFybihcbiAgICBzY29wZTogQ29uc3RydWN0LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgbmV0d29ya0Nvbm5lY3RvckFybjogc3RyaW5nLFxuICAgIG5ldHdvcmtDb25uZWN0b3JLaW5kPzogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICApOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Ige1xuICAgIHJldHVybiBuZXcgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2Uoc2NvcGUsIGlkLCB7XG4gICAgICBuZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgbmV0d29ya0Nvbm5lY3RvcktpbmQsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIGFuIEFXUy1tYW5hZ2VkIExhbWJkYSBNaWNyb1ZNIGNvbm5lY3RvciBieSBuYW1lLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBhd3NNYW5hZ2VkKFxuICAgIHNjb3BlOiBDb25zdHJ1Y3QsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBjb25uZWN0b3I6IEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3RvcixcbiAgKTogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2UuYXdzTWFuYWdlZChzY29wZSwgaWQsIGNvbm5lY3Rvcik7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIHRoZSBBV1MtbWFuYWdlZCBBTExfSU5HUkVTUyBjb25uZWN0b3IuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGFsbEluZ3Jlc3Moc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZyk6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlLmF3c01hbmFnZWQoXG4gICAgICBzY29wZSxcbiAgICAgIGlkLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLkFMTF9JTkdSRVNTLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIHRoZSBBV1MtbWFuYWdlZCBOT19JTkdSRVNTIGNvbm5lY3Rvci5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgbm9JbmdyZXNzKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcpOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Ige1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZS5hd3NNYW5hZ2VkKFxuICAgICAgc2NvcGUsXG4gICAgICBpZCxcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3Rvci5OT19JTkdSRVNTLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIHRoZSBBV1MtbWFuYWdlZCBIVFRQX0lOR1JFU1MgY29ubmVjdG9yLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBodHRwSW5ncmVzcyhzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nKTogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2UuYXdzTWFuYWdlZChcbiAgICAgIHNjb3BlLFxuICAgICAgaWQsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuSFRUUF9JTkdSRVNTLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIHRoZSBBV1MtbWFuYWdlZCBJTlRFUk5FVF9FR1JFU1MgY29ubmVjdG9yLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBpbnRlcm5ldEVncmVzcyhzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nKTogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2UuYXdzTWFuYWdlZChcbiAgICAgIHNjb3BlLFxuICAgICAgaWQsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuSU5URVJORVRfRUdSRVNTLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIHRoZSBBV1MtbWFuYWdlZCBTSEVMTF9JTkdSRVNTIGNvbm5lY3RvciByZXF1aXJlZCBmb3Igc2hlbGwgYXV0aC10b2tlbiBzdXBwb3J0LlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBzaGVsbEluZ3Jlc3Moc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZyk6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlLmF3c01hbmFnZWQoXG4gICAgICBzY29wZSxcbiAgICAgIGlkLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLlNIRUxMX0lOR1JFU1MsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgY2FsbGVyLXByb3ZpZGVkIFZQQyBib3VuZGFyeSBmb3IgdGhpcyBjb25uZWN0b3IuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdnBjOiBlYzIuSVZwYztcblxuICAvKipcbiAgICogVGhlIGNhbGxlci1wcm92aWRlZCBzdWJuZXQgSURzIHVzZWQgYnkgdGhlIGNvbm5lY3Rvci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdWJuZXRJZHM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUaGUgY2FsbGVyLXByb3ZpZGVkIHNlY3VyaXR5IGdyb3VwIElEcyB1c2VkIGJ5IHRoZSBjb25uZWN0b3IuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2VjdXJpdHlHcm91cElkczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBJQU0gcm9sZSBwYXNzZWQgdG8gQVdTOjpMYW1iZGE6Ok5ldHdvcmtDb25uZWN0b3IgYXMgT3BlcmF0b3JSb2xlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG9wZXJhdG9yUm9sZTogaWFtLklSb2xlO1xuXG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBDbG91ZEZvcm1hdGlvbiBuZXR3b3JrIGNvbm5lY3RvciByZXNvdXJjZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuZXR3b3JrQ29ubmVjdG9yOiBDZm5SZXNvdXJjZTtcblxuICAvKipcbiAgICogVGhlIG5ldHdvcmsgY29ubmVjdG9yIEFSTi5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBuZXR3b3JrQ29ubmVjdG9yQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIENyZWF0ZWQgY29ubmVjdG9ycyBhcmUgVlBDIGVncmVzcyBjb25uZWN0b3JzLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5ldHdvcmtDb25uZWN0b3JLaW5kPzogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kID0gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUztcblxuICAvKipcbiAgICogVGhlIENsb3VkRm9ybWF0aW9uIHN0YXRlIGF0dHJpYnV0ZSBmb3IgdGhlIG5ldHdvcmsgY29ubmVjdG9yLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5ldHdvcmtDb25uZWN0b3JTdGF0ZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy52cGMsIFwidnBjXCIpO1xuICAgIGlmIChwcm9wcy5vcGVyYXRvclJvbGUgJiYgcHJvcHMub3BlcmF0b3JSb2xlTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I6IG9wZXJhdG9yUm9sZU5hbWUgY2Fubm90IGJlIHVzZWQgd2l0aCBvcGVyYXRvclJvbGVcIik7XG4gICAgfVxuXG4gICAgdGhpcy52cGMgPSBwcm9wcy52cGM7XG4gICAgdGhpcy5zdWJuZXRJZHMgPSBub3JtYWxpemVSZXNvdXJjZUlkcyhwcm9wcy5zdWJuZXRzLCBcInN1Ym5ldHNcIiwgKHN1Ym5ldCkgPT4gc3VibmV0LnN1Ym5ldElkLCAxLCAxNik7XG4gICAgdGhpcy5zZWN1cml0eUdyb3VwSWRzID0gbm9ybWFsaXplUmVzb3VyY2VJZHMoXG4gICAgICBwcm9wcy5zZWN1cml0eUdyb3VwcyxcbiAgICAgIFwic2VjdXJpdHlHcm91cHNcIixcbiAgICAgIChzZWN1cml0eUdyb3VwKSA9PiBzZWN1cml0eUdyb3VwLnNlY3VyaXR5R3JvdXBJZCxcbiAgICAgIDEsXG4gICAgICA1LFxuICAgICk7XG5cbiAgICBjb25zdCBjb25uZWN0b3JOYW1lID0gbm9ybWFsaXplT3B0aW9uYWxDb25uZWN0b3JOYW1lKHByb3BzLmNvbm5lY3Rvck5hbWUpO1xuICAgIGNvbnN0IHByb3RvY29sID0gbm9ybWFsaXplTmV0d29ya1Byb3RvY29sKHByb3BzLm5ldHdvcmtQcm90b2NvbCk7XG5cbiAgICBjb25zdCBjcmVhdGVkT3BlcmF0b3JSb2xlID0gcHJvcHMub3BlcmF0b3JSb2xlXG4gICAgICA/IHVuZGVmaW5lZFxuICAgICAgOiBuZXcgaWFtLlJvbGUodGhpcywgXCJPcGVyYXRvclJvbGVcIiwge1xuICAgICAgICAgIHJvbGVOYW1lOiBwcm9wcy5vcGVyYXRvclJvbGVOYW1lLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkFwcFRoZW9yeSBMYW1iZGEgTWljcm9WTSBuZXR3b3JrIGNvbm5lY3RvciBvcGVyYXRvciByb2xlXCIsXG4gICAgICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsYW1iZGEuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgfSk7XG4gICAgaWYgKGNyZWF0ZWRPcGVyYXRvclJvbGUpIHtcbiAgICAgIGFkZE9wZXJhdG9yUm9sZVBvbGljeShjcmVhdGVkT3BlcmF0b3JSb2xlLCB0aGlzLnN1Ym5ldElkcywgdGhpcy5zZWN1cml0eUdyb3VwSWRzKTtcbiAgICB9XG4gICAgdGhpcy5vcGVyYXRvclJvbGUgPSBwcm9wcy5vcGVyYXRvclJvbGUgPz8gY3JlYXRlZE9wZXJhdG9yUm9sZSE7XG5cbiAgICB0aGlzLm5ldHdvcmtDb25uZWN0b3IgPSBuZXcgQ2ZuUmVzb3VyY2UodGhpcywgXCJOZXR3b3JrQ29ubmVjdG9yXCIsIHtcbiAgICAgIHR5cGU6IFwiQVdTOjpMYW1iZGE6Ok5ldHdvcmtDb25uZWN0b3JcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgLi4uKGNvbm5lY3Rvck5hbWUgPyB7IE5hbWU6IGNvbm5lY3Rvck5hbWUgfSA6IHt9KSxcbiAgICAgICAgT3BlcmF0b3JSb2xlOiB0aGlzLm9wZXJhdG9yUm9sZS5yb2xlQXJuLFxuICAgICAgICBDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVnBjRWdyZXNzQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgQXNzb2NpYXRlZENvbXB1dGVSZXNvdXJjZVR5cGVzOiBbXCJNaWNyb1ZtXCJdLFxuICAgICAgICAgICAgTmV0d29ya1Byb3RvY29sOiBwcm90b2NvbCxcbiAgICAgICAgICAgIFNlY3VyaXR5R3JvdXBJZHM6IHRoaXMuc2VjdXJpdHlHcm91cElkcyxcbiAgICAgICAgICAgIFN1Ym5ldElkczogdGhpcy5zdWJuZXRJZHMsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgVGFnczogcmVuZGVyVGFncyhwcm9wcy50YWdzKSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaWYgKGNyZWF0ZWRPcGVyYXRvclJvbGUpIHtcbiAgICAgIHRoaXMubmV0d29ya0Nvbm5lY3Rvci5ub2RlLmFkZERlcGVuZGVuY3koY3JlYXRlZE9wZXJhdG9yUm9sZSk7XG4gICAgfVxuXG4gICAgdGhpcy5uZXR3b3JrQ29ubmVjdG9yQXJuID0gdGhpcy5uZXR3b3JrQ29ubmVjdG9yLnJlZjtcbiAgICB0aGlzLm5ldHdvcmtDb25uZWN0b3JTdGF0ZSA9IHRoaXMubmV0d29ya0Nvbm5lY3Rvci5nZXRBdHQoXCJTdGF0ZVwiKS50b1N0cmluZygpO1xuICB9XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyByZWZlcmVuY2UgdG8gYW4gZXhpc3Rpbmcgb3IgQVdTLW1hbmFnZWQgTGFtYmRhIE1pY3JvVk0gbmV0d29yayBjb25uZWN0b3IuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgaW50ZW50aW9uYWxseSBzeW50aGVzaXplcyBubyByZXNvdXJjZXMuIEl0IGdpdmVzIGNvbnRyb2xsZXIvaW1hZ2UgY29uc3RydWN0cyBhXG4gKiB0eXBlZCBjb25uZWN0b3IgcmVmZXJlbmNlIHdpdGhvdXQgcmVxdWlyaW5nIGNhbGxlcnMgdG8gcGFzcyByYXcgc3RyaW5ncyB0aHJvdWdoIGRlcGxveW1lbnQgY29kZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgLyoqXG4gICAqIEltcG9ydCBhbiBleGlzdGluZyBMYW1iZGEgTWljcm9WTSBuZXR3b3JrIGNvbm5lY3RvciBBUk4gaW50byB0aGUgQXBwVGhlb3J5IENESyBzdXJmYWNlLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBmcm9tTmV0d29ya0Nvbm5lY3RvckFybihcbiAgICBzY29wZTogQ29uc3RydWN0LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgbmV0d29ya0Nvbm5lY3RvckFybjogc3RyaW5nLFxuICAgIG5ldHdvcmtDb25uZWN0b3JLaW5kPzogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICApOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Ige1xuICAgIHJldHVybiBuZXcgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2Uoc2NvcGUsIGlkLCB7XG4gICAgICBuZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgbmV0d29ya0Nvbm5lY3RvcktpbmQsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmVmZXJlbmNlIGFuIEFXUy1tYW5hZ2VkIExhbWJkYSBNaWNyb1ZNIGNvbm5lY3RvciBieSBuYW1lLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBhd3NNYW5hZ2VkKFxuICAgIHNjb3BlOiBDb25zdHJ1Y3QsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBjb25uZWN0b3I6IEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3RvcixcbiAgKTogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHtcbiAgICBjb25zdCBtYW5hZ2VkID0gbm9ybWFsaXplTWFuYWdlZENvbm5lY3Rvcihjb25uZWN0b3IpO1xuICAgIHJldHVybiBuZXcgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2Uoc2NvcGUsIGlkLCB7XG4gICAgICBuZXR3b3JrQ29ubmVjdG9yQXJuOiBtYW5hZ2VkQ29ubmVjdG9yQXJuKHNjb3BlLCBtYW5hZ2VkKSxcbiAgICAgIG5ldHdvcmtDb25uZWN0b3JLaW5kOiBtYW5hZ2VkQ29ubmVjdG9yS2luZChtYW5hZ2VkKSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgbmV0d29yayBjb25uZWN0b3IgQVJOLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5ldHdvcmtDb25uZWN0b3JBcm46IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY29ubmVjdG9yIGRpcmVjdGlvbi90eXBlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IG5ldHdvcmtDb25uZWN0b3JLaW5kPzogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZSByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG5cbiAgICB0aGlzLm5ldHdvcmtDb25uZWN0b3JBcm4gPSBub3JtYWxpemVOZXR3b3JrQ29ubmVjdG9yQXJuKHByb3BzLm5ldHdvcmtDb25uZWN0b3JBcm4pO1xuICAgIHRoaXMubmV0d29ya0Nvbm5lY3RvcktpbmQgPSBub3JtYWxpemVOZXR3b3JrQ29ubmVjdG9yS2luZChwcm9wcy5uZXR3b3JrQ29ubmVjdG9yS2luZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSZXF1aXJlZCh2YWx1ZTogdW5rbm93biwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXNvdXJjZUlkczxUPihcbiAgcmVzb3VyY2VzOiByZWFkb25seSBUW10gfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIGlkT2Y6IChyZXNvdXJjZTogVCkgPT4gc3RyaW5nLFxuICBtaW46IG51bWJlcixcbiAgbWF4OiBudW1iZXIsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghcmVzb3VyY2VzIHx8IHJlc291cmNlcy5sZW5ndGggPCBtaW4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHJlcXVpcmVzIGF0IGxlYXN0ICR7bWlufSAke3Byb3BOYW1lfSBlbnRyeWApO1xuICB9XG4gIGlmIChyZXNvdXJjZXMubGVuZ3RoID4gbWF4KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciBzdXBwb3J0cyBhdCBtb3N0ICR7bWF4fSAke3Byb3BOYW1lfSBlbnRyaWVzYCk7XG4gIH1cblxuICBjb25zdCBpZHMgPSByZXNvdXJjZXMubWFwKChyZXNvdXJjZSwgaW5kZXgpID0+IHtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHJlc291cmNlLCBgJHtwcm9wTmFtZX1bJHtpbmRleH1dYCk7XG4gICAgY29uc3QgcmF3ID0gaWRPZihyZXNvdXJjZSk7XG4gICAgdmFsaWRhdGVSZXF1aXJlZChyYXcsIGAke3Byb3BOYW1lfVske2luZGV4fV0uaWRgKTtcbiAgICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHJhdykudHJpbSgpO1xuICAgIGlmICghbm9ybWFsaXplZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciByZXF1aXJlcyAke3Byb3BOYW1lfVske2luZGV4fV0gdG8gaGF2ZSBhbiBpZGApO1xuICAgIH1cbiAgICByZXR1cm4gbm9ybWFsaXplZDtcbiAgfSk7XG5cbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGlkIG9mIGlkcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoaWQpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKGlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtwcm9wTmFtZX0gaWRzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKGlkKTtcbiAgfVxuXG4gIHJldHVybiBpZHM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU9wdGlvbmFsQ29ubmVjdG9yTmFtZShuYW1lPzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5hbWUudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcjogY29ubmVjdG9yTmFtZSBjYW5ub3QgYmUgZW1wdHlcIik7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQobm9ybWFsaXplZCkgJiYgIS9eW0EtWmEtejAtOV8tXXsxLDY0fSQvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yOiBjb25uZWN0b3JOYW1lIG11c3QgYmUgMS02NCBjaGFyYWN0ZXJzIHVzaW5nIGxldHRlcnMsIG51bWJlcnMsIGh5cGhlbnMsIG9yIHVuZGVyc2NvcmVzXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTmV0d29ya1Byb3RvY29sKFxuICBwcm90b2NvbDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtQcm90b2NvbCB8IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrUHJvdG9jb2wge1xuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHByb3RvY29sID8/IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrUHJvdG9jb2wuSVBWNClcbiAgICAudHJpbSgpXG4gICAgLnRvTG93ZXJDYXNlKClcbiAgICAucmVwbGFjZSgvW18tXS9nLCBcIlwiKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiaXB2NFwiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrUHJvdG9jb2wuSVBWNDtcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJkdWFsc3RhY2tcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya1Byb3RvY29sLkRVQUxfU1RBQ0s7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I6IG5ldHdvcmtQcm90b2NvbCBtdXN0IGJlIElQdjQgb3IgRHVhbFN0YWNrXCIpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOZXR3b3JrQ29ubmVjdG9yQXJuKGFybjogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKGFybiA9PT0gdW5kZWZpbmVkIHx8IGFybiA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlIHJlcXVpcmVzIHByb3BzLm5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhhcm4pLnRyaW0oKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JSZWZlcmVuY2UgcmVxdWlyZXMgcHJvcHMubmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChhcm4pICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZTogbmV0d29ya0Nvbm5lY3RvckFybiBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VcIik7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoYXJuKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IDIwNDgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZTogbmV0d29ya0Nvbm5lY3RvckFybiBtdXN0IGJlIGF0IG1vc3QgMjA0OCBjaGFyYWN0ZXJzXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOZXR3b3JrQ29ubmVjdG9yS2luZChcbiAga2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHwgc3RyaW5nIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGtpbmQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhraW5kKS50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXy1dL2csIFwiXCIpO1xuICBpZiAobm9ybWFsaXplZCA9PT0gXCJpbmdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLklOR1JFU1M7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiZWdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJzaGVsbGluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUztcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvclJlZmVyZW5jZTogbmV0d29ya0Nvbm5lY3RvcktpbmQgbXVzdCBiZSBpbmdyZXNzLCBlZ3Jlc3MsIG9yIHNoZWxsLWluZ3Jlc3NcIik7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU1hbmFnZWRDb25uZWN0b3IoXG4gIGNvbm5lY3RvcjogQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yIHwgc3RyaW5nIHwgdW5kZWZpbmVkLFxuKTogQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yIHtcbiAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlIHJlcXVpcmVzIGEgbWFuYWdlZCBjb25uZWN0b3IgbmFtZVwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKGNvbm5lY3RvcikudHJpbSgpLnRvVXBwZXJDYXNlKCkucmVwbGFjZSgvWy1cXHNdL2csIFwiX1wiKTtcbiAgc3dpdGNoIChub3JtYWxpemVkKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuQUxMX0lOR1JFU1M6XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLkFMTF9JTkdSRVNTO1xuICAgIGNhc2UgQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLk5PX0lOR1JFU1M6XG4gICAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLk5PX0lOR1JFU1M7XG4gICAgY2FzZSBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuSFRUUF9JTkdSRVNTOlxuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3Rvci5IVFRQX0lOR1JFU1M7XG4gICAgY2FzZSBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuSU5URVJORVRfRUdSRVNTOlxuICAgICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1NYW5hZ2VkTmV0d29ya0Nvbm5lY3Rvci5JTlRFUk5FVF9FR1JFU1M7XG4gICAgY2FzZSBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuU0hFTExfSU5HUkVTUzpcbiAgICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuU0hFTExfSU5HUkVTUztcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yUmVmZXJlbmNlOiBtYW5hZ2VkIGNvbm5lY3RvciBtdXN0IGJlIEFMTF9JTkdSRVNTLCBOT19JTkdSRVNTLCBIVFRQX0lOR1JFU1MsIElOVEVSTkVUX0VHUkVTUywgb3IgU0hFTExfSU5HUkVTU1wiLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBtYW5hZ2VkQ29ubmVjdG9yS2luZChcbiAgY29ubmVjdG9yOiBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQge1xuICBpZiAoY29ubmVjdG9yID09PSBBcHBUaGVvcnlNaWNyb3ZtTWFuYWdlZE5ldHdvcmtDb25uZWN0b3IuSU5URVJORVRfRUdSRVNTKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1M7XG4gIH1cbiAgaWYgKGNvbm5lY3RvciA9PT0gQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yLlNIRUxMX0lOR1JFU1MpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLlNIRUxMX0lOR1JFU1M7XG4gIH1cbiAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTO1xufVxuXG5mdW5jdGlvbiBtYW5hZ2VkQ29ubmVjdG9yQXJuKHNjb3BlOiBDb25zdHJ1Y3QsIGNvbm5lY3RvcjogQXBwVGhlb3J5TWljcm92bU1hbmFnZWROZXR3b3JrQ29ubmVjdG9yKTogc3RyaW5nIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIHJldHVybiBzdGFjay5mb3JtYXRBcm4oe1xuICAgIHNlcnZpY2U6IFwibGFtYmRhXCIsXG4gICAgYWNjb3VudDogXCJhd3NcIixcbiAgICByZXNvdXJjZTogXCJuZXR3b3JrLWNvbm5lY3RvclwiLFxuICAgIHJlc291cmNlTmFtZTogYGF3cy1uZXR3b3JrLWNvbm5lY3Rvcjoke2Nvbm5lY3Rvcn1gLFxuICAgIGFybkZvcm1hdDogQXJuRm9ybWF0LkNPTE9OX1JFU09VUkNFX05BTUUsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBhZGRPcGVyYXRvclJvbGVQb2xpY3kocm9sZTogaWFtLlJvbGUsIHN1Ym5ldElkczogc3RyaW5nW10sIHNlY3VyaXR5R3JvdXBJZHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yocm9sZSk7XG4gIGNvbnN0IG5ldHdvcmtJbnRlcmZhY2VBcm4gPSBlYzJBcm4oc3RhY2ssIFwibmV0d29yay1pbnRlcmZhY2VcIiwgXCIqXCIpO1xuICBjb25zdCBzdWJuZXRBcm5zID0gc3VibmV0SWRzLm1hcCgoc3VibmV0SWQpID0+IGVjMkFybihzdGFjaywgXCJzdWJuZXRcIiwgc3VibmV0SWQpKTtcbiAgY29uc3Qgc2VjdXJpdHlHcm91cEFybnMgPSBzZWN1cml0eUdyb3VwSWRzLm1hcCgoc2VjdXJpdHlHcm91cElkKSA9PiBlYzJBcm4oc3RhY2ssIFwic2VjdXJpdHktZ3JvdXBcIiwgc2VjdXJpdHlHcm91cElkKSk7XG5cbiAgcm9sZS5hZGRUb1BvbGljeShcbiAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6IFwiQ3JlYXRlQ29ubmVjdG9yTmV0d29ya0ludGVyZmFjZXNcIixcbiAgICAgIGFjdGlvbnM6IFtcImVjMjpDcmVhdGVOZXR3b3JrSW50ZXJmYWNlXCJdLFxuICAgICAgcmVzb3VyY2VzOiBbbmV0d29ya0ludGVyZmFjZUFybiwgLi4uc3VibmV0QXJucywgLi4uc2VjdXJpdHlHcm91cEFybnNdLFxuICAgIH0pLFxuICApO1xuICByb2xlLmFkZFRvUG9saWN5KFxuICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogXCJUYWdDb25uZWN0b3JOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgYWN0aW9uczogW1wiZWMyOkNyZWF0ZVRhZ3NcIl0sXG4gICAgICByZXNvdXJjZXM6IFtuZXR3b3JrSW50ZXJmYWNlQXJuXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgXCJlYzI6TWFuYWdlZFJlc291cmNlT3BlcmF0b3JcIjogXCJuZXR3b3JrLWNvbm5lY3RvcnMubGFtYmRhLmFtYXpvbmF3cy5jb21cIixcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSksXG4gICk7XG4gIHJvbGUuYWRkVG9Qb2xpY3koXG4gICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiBcIkRlc2NyaWJlQ29ubmVjdG9yTmV0d29ya0NvbnRleHRcIixcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgXCJlYzI6RGVzY3JpYmVOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgICBcImVjMjpEZXNjcmliZVNlY3VyaXR5R3JvdXBzXCIsXG4gICAgICAgIFwiZWMyOkRlc2NyaWJlU3VibmV0c1wiLFxuICAgICAgICBcImVjMjpEZXNjcmliZVZwY3NcIixcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgfSksXG4gICk7XG59XG5cbmZ1bmN0aW9uIGVjMkFybihzdGFjazogU3RhY2ssIHJlc291cmNlOiBzdHJpbmcsIHJlc291cmNlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHN0YWNrLmZvcm1hdEFybih7XG4gICAgc2VydmljZTogXCJlYzJcIixcbiAgICByZXNvdXJjZSxcbiAgICByZXNvdXJjZU5hbWUsXG4gICAgYXJuRm9ybWF0OiBBcm5Gb3JtYXQuU0xBU0hfUkVTT1VSQ0VfTkFNRSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclRhZ3ModGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBBcnJheTx7IEtleTogc3RyaW5nOyBWYWx1ZTogc3RyaW5nIH0+IHtcbiAgY29uc3QgcmVuZGVyZWQ6IEFycmF5PHsgS2V5OiBzdHJpbmc7IFZhbHVlOiBzdHJpbmcgfT4gPSBbXG4gICAgeyBLZXk6IFwiRnJhbWV3b3JrXCIsIFZhbHVlOiBcIkFwcFRoZW9yeVwiIH0sXG4gICAgeyBLZXk6IFwiQ29tcG9uZW50XCIsIFZhbHVlOiBcIk1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yXCIgfSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh0YWdzID8/IHt9KS5zb3J0KChbYV0sIFtiXSkgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRLZXkgPSBrZXkudHJpbSgpO1xuICAgIGlmICghbm9ybWFsaXplZEtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I6IHRhZyBrZXlzIGNhbm5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG4gICAgcmVuZGVyZWQucHVzaCh7IEtleTogbm9ybWFsaXplZEtleSwgVmFsdWU6IHZhbHVlIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlbmRlcmVkO1xufVxuIl19