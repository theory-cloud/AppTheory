import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import * as path from "node:path";

import {
  AppTheoryDynamoDBStreamMapping,
  AppTheoryEventBridgeHandler,
  AppTheoryFunction,
  AppTheoryFunctionAlarms,
  AppTheoryHttpApi,
  AppTheoryRestApi,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
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

    const goHandler = new AppTheoryFunction(this, "GoHandler", {
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
    });

    const tsHandler = new AppTheoryFunction(this, "TsHandler", {
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
    });

    const pyHandler = new AppTheoryFunction(this, "PyHandler", {
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
    });

    const goQueue = new sqs.Queue(this, "GoQueue");
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", goQueue.queueName);
    goHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(goQueue, { reportBatchItemFailures: true }));

    const goTable = new dynamodb.Table(this, "GoTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", goTable.tableName);
    new AppTheoryDynamoDBStreamMapping(this, "GoStream", { consumer: goHandler.fn, table: goTable });

    const goSchedule = new AppTheoryEventBridgeHandler(this, "GoSchedule", {
      handler: goHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", goSchedule.rule.ruleName);

    const tsQueue = new sqs.Queue(this, "TsQueue");
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", tsQueue.queueName);
    tsHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(tsQueue, { reportBatchItemFailures: true }));

    const tsTable = new dynamodb.Table(this, "TsTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", tsTable.tableName);
    new AppTheoryDynamoDBStreamMapping(this, "TsStream", { consumer: tsHandler.fn, table: tsTable });

    const tsSchedule = new AppTheoryEventBridgeHandler(this, "TsSchedule", {
      handler: tsHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", tsSchedule.rule.ruleName);

    const pyQueue = new sqs.Queue(this, "PyQueue");
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", pyQueue.queueName);
    pyHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(pyQueue, { reportBatchItemFailures: true }));

    const pyTable = new dynamodb.Table(this, "PyTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", pyTable.tableName);
    new AppTheoryDynamoDBStreamMapping(this, "PyStream", { consumer: pyHandler.fn, table: pyTable });

    const pySchedule = new AppTheoryEventBridgeHandler(this, "PySchedule", {
      handler: pyHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", pySchedule.rule.ruleName);

    const goApi = new AppTheoryHttpApi(this, "GoApi", {
      apiName: `${name}-go`,
      handler: goHandler.fn,
    });
    const tsApi = new AppTheoryHttpApi(this, "TsApi", {
      apiName: `${name}-ts`,
      handler: tsHandler.fn,
    });
    const pyApi = new AppTheoryHttpApi(this, "PyApi", {
      apiName: `${name}-py`,
      handler: pyHandler.fn,
    });

    new AppTheoryFunctionAlarms(this, "GoAlarms", { fn: goHandler.fn });
    new AppTheoryFunctionAlarms(this, "TsAlarms", { fn: tsHandler.fn });
    new AppTheoryFunctionAlarms(this, "PyAlarms", { fn: pyHandler.fn });

    new cdk.CfnOutput(this, "GoApiUrl", { value: goApi.api.url ?? "" });
    new cdk.CfnOutput(this, "TsApiUrl", { value: tsApi.api.url ?? "" });
    new cdk.CfnOutput(this, "PyApiUrl", { value: pyApi.api.url ?? "" });

    const goRestApi = new AppTheoryRestApi(this, "GoRestApi", {
      apiName: `${name}-go-rest`,
      handler: goHandler.fn,
    });
    goRestApi.addRoute("/sse", ["GET"], { streaming: true });

    new cdk.CfnOutput(this, "GoRestApiUrl", { value: goRestApi.api.url ?? "" });
    new cdk.CfnOutput(this, "GoRestSseUrl", { value: goRestApi.api.urlForPath("/sse") ?? "" });
  }
}
