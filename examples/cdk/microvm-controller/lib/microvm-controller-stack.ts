import { execFileSync } from "node:child_process";
import * as path from "node:path";

import {
  AppTheoryMicrovmController,
  AppTheoryMicrovmHookMode,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
  AppTheoryMicrovmNetworkProtocol,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * Runnable local example for the first-class AppTheory Lambda MicroVM deployment path.
 *
 * The VPC/subnet/security group are imported placeholders so `cdk synth` does not
 * perform live AWS lookups. The controller package is a Go AppTheory handler that
 * uses the canonical route adapter, a constrained deterministic provider fake, and
 * an in-memory registry/reconstruction hook for local proof only.
 */
export class MicrovmControllerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromVpcAttributes(this, "CallerProvidedVpc", {
      vpcId: "vpc-0a11c0de123456789",
      availabilityZones: ["us-east-1a"],
      privateSubnetIds: ["subnet-0a11c0de123456789"],
    });
    const privateSubnet = ec2.Subnet.fromSubnetAttributes(this, "CallerPrivateSubnet", {
      subnetId: "subnet-0a11c0de123456789",
      availabilityZone: "us-east-1a",
    });
    const egressSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "CallerMicrovmEgressSecurityGroup",
      "sg-0a11c0de123456789",
      { mutable: false },
    );

    const egressConnector = new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgressConnector", {
      vpc,
      subnets: [privateSubnet],
      securityGroups: [egressSecurityGroup],
      connectorName: "apptheory_microvm_demo_egress",
      networkProtocol: AppTheoryMicrovmNetworkProtocol.IPV4,
      tags: {
        Example: "MicrovmController",
        NetworkBoundary: "CallerProvidedVpc",
      },
    });
    const ingressConnector = AppTheoryMicrovmNetworkConnector.allIngress(this, "MicrovmIngressConnector");
    const shellIngressConnector = AppTheoryMicrovmNetworkConnector.shellIngress(this, "MicrovmShellIngressConnector");

    const microvmImage = new AppTheoryMicrovmImage(this, "MicrovmImage", {
      name: "apptheory_microvm_demo",
      description: "Local AppTheory MicroVM controller example image",
      baseImageArn: this.formatArn({
        service: "lambda",
        resource: "microvm-image",
        resourceName: "base/apptheory-al2023",
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
      baseImageVersion: "1",
      buildRoleArn: this.formatArn({
        service: "iam",
        region: "",
        resource: "role",
        resourceName: "apptheory-microvm-image-build-demo",
      }),
      codeArtifact: {
        uri: "s3://apptheory-example-artifacts/microvm/controller-demo.tar",
      },
      egressNetworkConnectors: [egressConnector],
      hooks: {
        port: 8080,
        microvmImageHooks: {
          ready: AppTheoryMicrovmHookMode.ENABLED,
          readyTimeoutInSeconds: 120,
          validate: AppTheoryMicrovmHookMode.ENABLED,
          validateTimeoutInSeconds: 300,
        },
        microvmHooks: {
          run: AppTheoryMicrovmHookMode.ENABLED,
          runTimeoutInSeconds: 30,
          suspend: AppTheoryMicrovmHookMode.ENABLED,
          suspendTimeoutInSeconds: 30,
          resume: AppTheoryMicrovmHookMode.ENABLED,
          resumeTimeoutInSeconds: 30,
          terminate: AppTheoryMicrovmHookMode.ENABLED,
          terminateTimeoutInSeconds: 30,
        },
      },
      logging: { disabled: true },
      resources: [{ minimumMemoryInMiB: 2048 }],
      environmentVariables: [
        { key: "APPTHEORY_MICROVM_EXAMPLE", value: "controller-demo" },
      ],
      tags: {
        Example: "MicrovmController",
      },
    });

    const demoOnlyAuthorizer = new lambda.Function(this, "DemoOnlyTokenAuthorizer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Demo-only Lambda authorizer for the local MicroVM controller example",
      code: lambda.Code.fromInline(demoOnlyAuthorizerSource()),
    });

    const controller = new AppTheoryMicrovmController(this, "MicrovmController", {
      apiName: "apptheory-microvm-controller-demo",
      controller: {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        handler: "bootstrap",
        architecture: lambda.Architecture.ARM_64,
        description: "Runnable local AppTheory MicroVM controller using the canonical Go runtime path",
        code: goControllerCode(),
        environment: {
          APPTHEORY_DEMO_PURPOSE: "local-microvm-controller-runtime",
        },
      },
      authorizer: demoOnlyAuthorizer,
      authorizerName: "demo-only-microvm-token-authorizer",
      authorizerHeaderName: "Authorization",
      authorizerCacheTtl: cdk.Duration.seconds(0),
      microvmImage,
      ingressNetworkConnectors: [ingressConnector],
      egressNetworkConnectors: [egressConnector],
      shellIngressNetworkConnector: shellIngressConnector,
      sessionTableRemovalPolicy: cdk.RemovalPolicy.RETAIN,
      sessionTableDeletionProtection: true,
      enableSessionTablePointInTimeRecovery: true,
      stage: {
        stageName: "demo",
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    assertTableTheorySessionRegistry(controller.sessionTable);

    new cdk.CfnOutput(this, "MicrovmControllerEndpoint", {
      value: controller.endpoint,
    });
    new cdk.CfnOutput(this, "MicrovmSessionRegistryTable", {
      value: controller.sessionTable.tableName,
      description: "TableTheory-shaped MicroVM session registry: pk/sk keys with ttl expiration",
    });
  }
}

function demoOnlyAuthorizerSource(): string {
  return `exports.handler = async (event) => {
  const headers = event.headers || {};
  const authorization = headers.authorization || headers.Authorization || "";
  const tenant = headers["x-tenant-id"] || headers["X-Tenant-Id"] || "";
  const namespace = headers["x-namespace-id"] || headers["X-Namespace-Id"] || "";
  const isAuthorized = authorization === "Bearer local-demo-only" && tenant.trim() !== "" && namespace.trim() !== "";
  return {
    isAuthorized,
    context: isAuthorized ? { demoOnly: "true" } : {},
  };
};`;
}

function goControllerCode(): lambda.Code {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const controllerPackage = "./examples/cdk/microvm-controller/controller";

  return lambda.Code.fromAsset(path.join(repoRoot, "examples/cdk/microvm-controller/controller"), {
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: cdk.DockerImage.fromRegistry("public.ecr.aws/docker/library/golang:1.26"),
      command: [
        "bash",
        "-c",
        "echo 'local Go toolchain is required to synthesize this AppTheory example' >&2; exit 1",
      ],
      local: {
        tryBundle(outputDir: string): boolean {
          execFileSync(
            "go",
            [
              "build",
              "-trimpath",
              "-buildvcs=false",
              "-ldflags=-s -w -buildid=",
              "-o",
              path.join(outputDir, "bootstrap"),
              controllerPackage,
            ],
            {
              cwd: repoRoot,
              env: { ...process.env, GOOS: "linux", GOARCH: "arm64", CGO_ENABLED: "0" },
              stdio: "inherit",
            },
          );
          return true;
        },
      },
    },
  });
}

function assertTableTheorySessionRegistry(table: dynamodb.Table): void {
  const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
  const keySchema = cfnTable.keySchema;
  if (!Array.isArray(keySchema)) {
    throw new Error("MicroVM session registry must synthesize explicit pk/sk key schema");
  }

  const hasPartitionKey = keySchema.some((entry) => {
    const key = entry as dynamodb.CfnTable.KeySchemaProperty;
    return key.attributeName === "pk" && key.keyType === "HASH";
  });
  const hasSortKey = keySchema.some((entry) => {
    const key = entry as dynamodb.CfnTable.KeySchemaProperty;
    return key.attributeName === "sk" && key.keyType === "RANGE";
  });
  const ttl = cfnTable.timeToLiveSpecification as dynamodb.CfnTable.TimeToLiveSpecificationProperty | undefined;
  const hasTtl = ttl?.attributeName === "ttl" && ttl.enabled === true;

  if (!hasPartitionKey || !hasSortKey || !hasTtl) {
    throw new Error("MicroVM session registry must keep the TableTheory pk/sk/ttl shape");
  }
}
