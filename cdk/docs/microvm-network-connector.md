# MicroVM Network Connector

`AppTheoryMicrovmNetworkConnector` is the AppTheory CDK surface for Lambda MicroVM VPC egress. It synthesizes
`AWS::Lambda::NetworkConnector` and, by default, creates the operator role Lambda uses to manage connector ENIs.

## Contract boundary

- Caller supplies the VPC, subnets, and security groups.
- AppTheory does not create a VPC or select a default security group.
- The construct is deployment-only; runtime MicroVM lifecycle and controller behavior remain in the AppTheory runtime
  contract.
- No live AWS mutation happens during construct tests or synthesis.

## TypeScript

```ts
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { AppTheoryMicrovmNetworkConnector } from "@theory-cloud/apptheory-cdk";

const connector = new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgress", {
  vpc,
  subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
  securityGroups: [microvmEgressSecurityGroup],
  connectorName: "my_microvm_egress",
});

// Pass connector.networkConnectorArn to the MicroVM controller/image constructs that require it.
```

## Operator role

If `operatorRole` is omitted, AppTheory creates an IAM role trusted by Lambda and attaches the scoped EC2 permissions
needed for connector ENI creation, tagging, and network-context description. To use a pre-existing operator role, pass
`operatorRole`; AppTheory will not mutate imported roles.

```ts
new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgress", {
  vpc,
  subnets,
  securityGroups: [microvmEgressSecurityGroup],
  operatorRole,
});
```

## Fail-closed validation

The construct fails synthesis when:

- `vpc` is missing.
- no subnet is supplied, or more than 16 subnets are supplied.
- no security group is supplied, or more than five security groups are supplied.
- both `operatorRole` and `operatorRoleName` are supplied.
- `connectorName` is empty or outside the CloudFormation name pattern.
