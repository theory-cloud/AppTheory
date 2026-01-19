import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import * as path from "node:path";

import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

function contextValue(app: cdk.App, key: string): string | undefined {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value ? value : undefined;
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

export class MultiLangStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const app = this.node.root as cdk.App;
    const repoRoot = path.resolve(__dirname, "../../../..");

    const tier = contextValue(app, "tier") ?? "p2";
    const name = contextValue(app, "name") ?? "apptheory-multilang";

    const commonEnv = {
      APPTHEORY_TIER: tier,
      APPTHEORY_DEMO_NAME: name,
    };

    const arch = lambda.Architecture.ARM_64;

    const goHandler = new lambda.Function(this, "GoHandler", {
      architecture: arch,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), {
        bundling: {
          image: cdk.DockerImage.fromRegistry("golang:1.25"),
          command: [
            "bash",
            "-c",
            [
              "set -euo pipefail",
              "cd /asset-input",
              "GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /asset-output/bootstrap .",
            ].join(" && "),
          ],
          local: {
            tryBundle(outputDir: string) {
              execSync(
                "go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o " +
                  path.join(outputDir, "bootstrap") +
                  " .",
                {
                  cwd: path.join(__dirname, "..", "handlers", "go"),
                  stdio: "inherit",
                  env: {
                    ...process.env,
                    GOOS: "linux",
                    GOARCH: "arm64",
                    CGO_ENABLED: "0",
                  },
                },
              );
              return true;
            },
          },
        },
      }),
      environment: { ...commonEnv, APPTHEORY_LANG: "go" },
      timeout: Duration.seconds(10),
      memorySize: 256,
    });

    const tsHandler = new lambda.Function(this, "TsHandler", {
      architecture: arch,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "ts"), {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: ["bash", "-c", "cp -R /asset-input/* /asset-output/"],
          local: {
            tryBundle(outputDir: string) {
              const handlerDir = path.join(__dirname, "..", "handlers", "ts");
              copyFileSync(path.join(handlerDir, "handler.mjs"), path.join(outputDir, "handler.mjs"));
              copyFileSync(path.join(handlerDir, "package.json"), path.join(outputDir, "package.json"));
              const sdkIn = path.join(repoRoot, "ts", "dist", "index.js");
              mkdirSync(path.join(outputDir, "vendor", "apptheory"), { recursive: true });
              copyFileSync(sdkIn, path.join(outputDir, "vendor", "apptheory", "index.js"));
              return true;
            },
          },
        },
      }),
      environment: { ...commonEnv, APPTHEORY_LANG: "ts" },
      timeout: Duration.seconds(10),
      memorySize: 256,
    });

    const pyHandler = new lambda.Function(this, "PyHandler", {
      architecture: arch,
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "py"), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: ["bash", "-c", "cp -R /asset-input/* /asset-output/"],
          local: {
            tryBundle(outputDir: string) {
              const handlerDir = path.join(__dirname, "..", "handlers", "py");
              copyFileSync(path.join(handlerDir, "handler.py"), path.join(outputDir, "handler.py"));
              const sdkIn = path.join(repoRoot, "py", "src", "apptheory");
              copyDir(sdkIn, path.join(outputDir, "apptheory"));
              return true;
            },
          },
        },
      }),
      environment: { ...commonEnv, APPTHEORY_LANG: "py" },
      timeout: Duration.seconds(10),
      memorySize: 256,
    });

    const goApi = new apigwv2.HttpApi(this, "GoApi", {
      apiName: `${name}-go`,
    });
    goApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("GoRoot", goHandler),
    });
    goApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("GoProxy", goHandler),
    });

    const tsApi = new apigwv2.HttpApi(this, "TsApi", {
      apiName: `${name}-ts`,
    });
    tsApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("TsRoot", tsHandler),
    });
    tsApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("TsProxy", tsHandler),
    });

    const pyApi = new apigwv2.HttpApi(this, "PyApi", {
      apiName: `${name}-py`,
    });
    pyApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("PyRoot", pyHandler),
    });
    pyApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("PyProxy", pyHandler),
    });

    new cdk.CfnOutput(this, "GoApiUrl", { value: goApi.url ?? "" });
    new cdk.CfnOutput(this, "TsApiUrl", { value: tsApi.url ?? "" });
    new cdk.CfnOutput(this, "PyApiUrl", { value: pyApi.url ?? "" });
  }
}
