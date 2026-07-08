import { execFileSync } from "node:child_process";
import * as path from "node:path";

import {
  AppTheoryMicrovmController,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

export type MicrovmExampleLanguage = "go" | "ts" | "py";

/**
 * Runnable example for the first-class AppTheory Lambda MicroVM deployment path.
 *
 * The stack uses AWS-managed HTTP ingress, shell ingress, and internet egress
 * connector references, an explicit no-hook MicroVM image, a real AppTheory
 * MicroVM controller, and a TableTheory-shaped session registry. Select the
 * in-MicroVM workload with `-c microvmLanguage=go|ts|py`; the default is Go.
 */
export class MicrovmControllerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const language = normalizeLanguage(this.node.tryGetContext("microvmLanguage"));
    const repoRoot = path.resolve(__dirname, "../../../..");
    const workloadAsset = new assets.Asset(this, "MicrovmWorkloadAsset", {
      path: path.join(repoRoot, "examples/cdk/microvm-controller/workloads", language),
    });
    const buildRole = new iam.Role(this, "MicrovmImageBuildRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Build role Lambda assumes to read the MicroVM code artifact and write build logs",
    });
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
      }),
    );
    workloadAsset.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [this.formatArn({ service: "logs", resource: "*" })],
      }),
    );

    const egressConnector = AppTheoryMicrovmNetworkConnector.internetEgress(this, "MicrovmInternetEgress");
    const ingressConnector = AppTheoryMicrovmNetworkConnector.httpIngress(this, "MicrovmHttpIngress");
    const shellIngressConnector = AppTheoryMicrovmNetworkConnector.shellIngress(this, "MicrovmShellIngress");

    const microvmImage = new AppTheoryMicrovmImage(this, "MicrovmImage", {
      name: `apptheory_microvm_${language}_demo`,
      description: `AppTheory ${languageName(language)} MicroVM example image`,
      baseImageArn: `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:aws:microvm-image:al2023-1`,
      baseImageVersion: "0",
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: workloadAsset.s3ObjectUrl,
      },
      egressNetworkConnectors: [egressConnector],
      hooks: {},
      logging: {
        cloudWatch: {
          logGroup: `/aws/lambda/microvms/apptheory-microvm-${language}-demo`,
        },
      },
      resources: [{ minimumMemoryInMiB: 2048 }],
      environmentVariables: [
        { key: "APPTHEORY_MICROVM_EXAMPLE_LANGUAGE", value: language },
      ],
      tags: {
        Example: "MicrovmController",
        Language: language,
      },
    });

    const demoOnlyAuthorizer = new lambda.Function(this, "DemoOnlyTokenAuthorizer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Demo-only Lambda authorizer for the MicroVM controller example",
      code: lambda.Code.fromInline(demoOnlyAuthorizerSource()),
    });

    const controller = new AppTheoryMicrovmController(this, "MicrovmController", {
      apiName: `apptheory-microvm-${language}-controller-demo`,
      controller: {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        handler: "bootstrap",
        architecture: lambda.Architecture.ARM_64,
        description: `AppTheory MicroVM controller for the ${languageName(language)} workload example`,
        code: goControllerCode(repoRoot),
        environment: {
          APPTHEORY_DEMO_PURPOSE: "live-microvm-controller-runtime",
          APPTHEORY_MICROVM_EXAMPLE_PROVIDER: "aws",
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
    new cdk.CfnOutput(this, "MicrovmExampleLanguage", {
      value: language,
    });
    new cdk.CfnOutput(this, "MicrovmImageRef", {
      value: microvmImage.microvmImageArn,
    });
    new cdk.CfnOutput(this, "MicrovmIngressConnectorRef", {
      value: ingressConnector.networkConnectorArn,
    });
    new cdk.CfnOutput(this, "MicrovmEgressConnectorRef", {
      value: egressConnector.networkConnectorArn,
    });
    new cdk.CfnOutput(this, "MicrovmAuthTokenRoute", {
      value: "POST /microvms/{session_id}/auth-token",
    });
    new cdk.CfnOutput(this, "MicrovmInvokeRoute", {
      value: "ANY /microvms/{session_id}/invoke/{proxy+}",
    });
    new cdk.CfnOutput(this, "MicrovmInvokePortHeader", {
      value: "X-AppTheory-MicroVM-Port: 8080",
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

function goControllerCode(repoRoot: string): lambda.Code {
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

function normalizeLanguage(value: unknown): MicrovmExampleLanguage {
  const normalized = String(value ?? "go").trim().toLowerCase();
  if (normalized === "go" || normalized === "ts" || normalized === "py") {
    return normalized;
  }
  throw new Error("microvmLanguage context must be go, ts, or py");
}

function languageName(language: MicrovmExampleLanguage): string {
  switch (language) {
    case "go":
      return "Go";
    case "ts":
      return "TypeScript";
    case "py":
      return "Python";
  }
}
