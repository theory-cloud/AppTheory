import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";

import {
  AppTheoryDynamoDBStreamMapping,
  AppTheoryEventBridgeHandler,
  AppTheoryEventBridgeRuleTarget,
  AppTheoryFunction,
  AppTheoryFunctionAlarms,
  AppTheoryHttpApi,
  AppTheoryRestApi,
  AppTheoryWebSocketApi,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
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
    if (shouldSkipAssetEntry(entry.name)) {
      continue;
    }
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

function shouldSkipAssetEntry(name: string): boolean {
  return (
    name === "__pycache__" ||
    name.endsWith("_test.go") ||
    name.endsWith(".pyc") ||
    name.endsWith(".pyo") ||
    name.endsWith(".egg-info")
  );
}

const assetExclude = [
  "__pycache__",
  "**/__pycache__",
  "*.pyc",
  "**/*.pyc",
  "*.pyo",
  "**/*.pyo",
  "*.egg-info",
  "**/*.egg-info",
];

function resetAssetStage(exampleDir: string, name: string): string {
  const stageDir = path.join(exampleDir, ".cdk-asset-stage", name);
  rmSync(stageDir, { force: true, recursive: true });
  mkdirSync(stageDir, { recursive: true });
  return stageDir;
}

function stageHandlerFiles(handlersDir: string, stageDir: string, files: string[]): void {
  for (const file of files) {
    copyFileSync(path.join(handlersDir, file), path.join(stageDir, file));
  }
}

// The vendored AppTheory runtime imports its declared dependencies, including
// @theory-cloud/tabletheory-ts, when the barrel entry loads. A Lambda asset
// that carries only ts/dist therefore fails at init in a clean runtime. Stage
// the runtime's production dependency closure next to the vendored dist so the
// asset is self-contained.
function stageNodeDependencies(runtimeDir: string, stageDir: string): void {
  const runtimeNodeModules = path.join(runtimeDir, "node_modules");
  const marker = path.join(runtimeNodeModules, "@theory-cloud", "tabletheory-ts", "package.json");
  if (!existsSync(marker)) {
    throw new Error(
      `missing ${marker}; run 'cd ts && npm ci --ignore-scripts' before synthesizing the TypeScript asset`,
    );
  }
  const listed = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: runtimeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${runtimeNodeModules}${path.sep}`;
  const destination = path.join(stageDir, "node_modules");
  for (const line of listed.split("\n")) {
    const dependency = line.trim();
    if (!dependency.startsWith(prefix)) {
      continue;
    }
    copyDir(dependency, path.join(destination, dependency.slice(prefix.length)));
  }
}

function cleanOutputDir(outputDir: string): void {
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
}

export class MultiLangStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const app = this.node.root as cdk.App;
    const repoRoot = path.resolve(__dirname, "../../../..");

    const tier = contextValue(app, "tier") ?? "p2";
    const name = contextValue(app, "name") ?? "apptheory-multilang";
    const eventSource = "apptheory.example";
    const eventDetailType = "example.item.changed";

    const commonEnv = {
      APPTHEORY_TIER: tier,
      APPTHEORY_DEMO_NAME: name,
      APPTHEORY_DEMO_EVENT_SOURCE: eventSource,
      APPTHEORY_DEMO_EVENT_DETAIL_TYPE: eventDetailType,
    };

    const goHandler = new AppTheoryFunction(this, "GoHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), {
        bundling: {
          image: cdk.DockerImage.fromRegistry("golang:1.27"),
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

    const tsHandlersDir = path.join(__dirname, "..", "handlers", "ts");
    const tsStageDir = resetAssetStage(path.join(__dirname, ".."), "ts");
    stageHandlerFiles(tsHandlersDir, tsStageDir, ["handler.mjs", "package.json"]);
    copyDir(path.join(repoRoot, "ts", "dist"), path.join(tsStageDir, "vendor", "apptheory"));
    stageNodeDependencies(path.join(repoRoot, "ts"), tsStageDir);
    const tsHandler = new AppTheoryFunction(this, "TsHandler", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(tsStageDir, {
        exclude: assetExclude,
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: ["bash", "-c", "set -euo pipefail && cp -R /asset-input/. /asset-output/"],
          local: {
            tryBundle(outputDir: string) {
              cleanOutputDir(outputDir);
              copyDir(tsStageDir, outputDir);
              return true;
            },
          },
        },
      }),
      environment: { ...commonEnv, APPTHEORY_LANG: "ts" },
    });

    const pyHandlersDir = path.join(__dirname, "..", "handlers", "py");
    const pyStageDir = resetAssetStage(path.join(__dirname, ".."), "py");
    stageHandlerFiles(pyHandlersDir, pyStageDir, ["handler.py"]);
    copyDir(path.join(repoRoot, "py", "src", "apptheory"), path.join(pyStageDir, "apptheory"));
    const pyHandler = new AppTheoryFunction(this, "PyHandler", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(pyStageDir, {
        exclude: assetExclude,
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: ["bash", "-c", "set -euo pipefail && cp -R /asset-input/. /asset-output/"],
          local: {
            tryBundle(outputDir: string) {
              cleanOutputDir(outputDir);
              copyDir(pyStageDir, outputDir);
              return true;
            },
          },
        },
      }),
      environment: { ...commonEnv, APPTHEORY_LANG: "py" },
    });

    // One standard SNS topic and Lambda subscription per language. SNS does
    // not support Lambda subscriptions on FIFO topics, so these are standard
    // topics; the local runner delivers the documented Lambda SNS record to
    // each handler, which records it for the parity row.
    const snsTopics: Record<string, sns.CfnTopic> = {};
    for (const [lang, handler] of [["go", goHandler], ["ts", tsHandler], ["py", pyHandler]] as const) {
      const topic = new sns.CfnTopic(this, `${lang.toUpperCase()}SnsTopic`, {
        topicName: `${name}-${lang}-events`,
      });
      new sns.CfnSubscription(this, `${lang.toUpperCase()}SnsSubscription`, {
        topicArn: topic.ref,
        protocol: "lambda",
        endpoint: handler.fn.functionArn,
      });
      handler.fn.addPermission(`${lang.toUpperCase()}SnsInvoke`, {
        principal: new iam.ServicePrincipal("sns.amazonaws.com"),
        sourceArn: topic.ref,
      });
      handler.fn.addEnvironment("APPTHEORY_DEMO_TOPIC_ARN", topic.ref);
      handler.fn.addEnvironment("APPTHEORY_DEMO_SNS_NAME", topic.getAtt("TopicName").toString());
      snsTopics[lang] = topic;
    }

    const goQueue = new sqs.Queue(this, "GoQueue");
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", goQueue.queueName);
    goHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(goQueue, { reportBatchItemFailures: true }));

    const goTable = new dynamodb.Table(this, "GoTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
    });
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", goTable.tableName);
    // The Go mapping proves the failure path: a poison record exhausts two
    // retries, the batch is bisected at the reported sequence number, and the
    // discarded batch pointer reaches the on-failure SQS queue.
    const goStreamDlq = new sqs.Queue(this, "GoStreamDlq", {
      queueName: `${name}-go-stream-dlq`,
    });
    new AppTheoryDynamoDBStreamMapping(this, "GoStream", {
      consumer: goHandler.fn,
      table: goTable,
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10,
      retryAttempts: 2,
      bisectBatchOnError: true,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(goStreamDlq),
    });

    const goSchedule = new AppTheoryEventBridgeHandler(this, "GoSchedule", {
      handler: goHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", goSchedule.rule.ruleName);
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_SCHEDULE_RULE_NAME", goSchedule.rule.ruleName);
    const goEventRule = new AppTheoryEventBridgeRuleTarget(this, "GoEventRule", {
      handler: goHandler.fn,
      eventPattern: {
        source: [eventSource],
        detailType: [eventDetailType],
      },
    });
    goHandler.fn.addEnvironment("APPTHEORY_DEMO_EVENT_RULE_NAME", goEventRule.rule.ruleName);

    const tsQueue = new sqs.Queue(this, "TsQueue");
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", tsQueue.queueName);
    tsHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(tsQueue, { reportBatchItemFailures: true }));

    const tsTable = new dynamodb.Table(this, "TsTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
    });
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", tsTable.tableName);
    new AppTheoryDynamoDBStreamMapping(this, "TsStream", {
      consumer: tsHandler.fn,
      table: tsTable,
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
    });

    const tsSchedule = new AppTheoryEventBridgeHandler(this, "TsSchedule", {
      handler: tsHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", tsSchedule.rule.ruleName);
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_SCHEDULE_RULE_NAME", tsSchedule.rule.ruleName);
    const tsEventRule = new AppTheoryEventBridgeRuleTarget(this, "TsEventRule", {
      handler: tsHandler.fn,
      eventPattern: {
        source: [eventSource],
        detailType: [eventDetailType],
      },
    });
    tsHandler.fn.addEnvironment("APPTHEORY_DEMO_EVENT_RULE_NAME", tsEventRule.rule.ruleName);

    const pyQueue = new sqs.Queue(this, "PyQueue");
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_QUEUE_NAME", pyQueue.queueName);
    pyHandler.fn.addEventSource(new lambdaEventSources.SqsEventSource(pyQueue, { reportBatchItemFailures: true }));

    const pyTable = new dynamodb.Table(this, "PyTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
    });
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_TABLE_NAME", pyTable.tableName);
    new AppTheoryDynamoDBStreamMapping(this, "PyStream", {
      consumer: pyHandler.fn,
      table: pyTable,
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
    });

    const pySchedule = new AppTheoryEventBridgeHandler(this, "PySchedule", {
      handler: pyHandler.fn,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_RULE_NAME", pySchedule.rule.ruleName);
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_SCHEDULE_RULE_NAME", pySchedule.rule.ruleName);
    const pyEventRule = new AppTheoryEventBridgeRuleTarget(this, "PyEventRule", {
      handler: pyHandler.fn,
      eventPattern: {
        source: [eventSource],
        detailType: [eventDetailType],
      },
    });
    pyHandler.fn.addEnvironment("APPTHEORY_DEMO_EVENT_RULE_NAME", pyEventRule.rule.ruleName);

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

    const goWs = new AppTheoryWebSocketApi(this, "GoWebSocket", {
      apiName: `${name}-go-ws`,
      handler: goHandler.fn,
      stageName: "dev",
    });
    const tsWs = new AppTheoryWebSocketApi(this, "TsWebSocket", {
      apiName: `${name}-ts-ws`,
      handler: tsHandler.fn,
      stageName: "dev",
    });
    const pyWs = new AppTheoryWebSocketApi(this, "PyWebSocket", {
      apiName: `${name}-py-ws`,
      handler: pyHandler.fn,
      stageName: "dev",
    });

    // A custom route is selected by the API's route selection expression
    // ($request.body.action). AppTheoryWebSocketApi declares the three
    // predefined routes and does not expose its integration, so the row uses
    // the L1 escape hatch: reuse the $default route's integration target.
    // The construct and this stack can resolve different aws-cdk-lib copies, so
    // the route is found structurally (CfnResource, resource type) rather than
    // with instanceof.
    function cfnRouteOf(api: apigwv2.WebSocketApi, routeKey: string): apigwv2.CfnRoute {
      for (const child of api.node.findAll()) {
        if (!cdk.CfnResource.isCfnResource(child)) continue;
        if (child.cfnResourceType !== "AWS::ApiGatewayV2::Route") continue;
        const route = child as apigwv2.CfnRoute;
        if (route.routeKey === routeKey) {
          return route;
        }
      }
      throw new Error(`the WebSocket API has no ${routeKey} route`);
    }
    function addCustomRoute(api: apigwv2.WebSocketApi, routeKey: string): void {
      const defaultRoute = cfnRouteOf(api, "$default");
      new apigwv2.CfnRoute(api, `CustomRoute${routeKey}`, {
        apiId: api.apiId,
        routeKey,
        authorizationType: "NONE",
        target: defaultRoute.target,
      });
    }
    addCustomRoute(goWs.api, "chat");
    addCustomRoute(tsWs.api, "chat");
    addCustomRoute(pyWs.api, "chat");

    // One API declares a $connect authorizer: a REQUEST Lambda authorizer that
    // returns an IAM policy. The local runner runs it and matches the policy
    // against the $connect method ARN. The L1 resources are deliberate:
    // AppTheoryWebSocketApi has no authorizer property.
    const wsAuthorizerFn = new lambda.Function(this, "WsAuthorizerFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "ws-authorizer.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
      timeout: cdk.Duration.seconds(10),
      description: "WebSocket $connect REQUEST authorizer; returns an IAM policy",
    });
    const wsAuthorizer = new apigwv2.CfnAuthorizer(this, "GoWsConnectAuthorizer", {
      apiId: goWs.api.apiId,
      authorizerType: "REQUEST",
      name: `${name}-go-connect`,
      identitySource: ["$request.header.Authorization"],
      authorizerUri:
        `arn:aws:apigateway:${cdk.Stack.of(this).region}:lambda:path/2015-03-31/functions/` +
        `${wsAuthorizerFn.functionArn}/invocations`,
    });
    const goConnectRoute = cfnRouteOf(goWs.api, "$connect");
    goConnectRoute.authorizationType = "CUSTOM";
    goConnectRoute.authorizerId = wsAuthorizer.ref;

    new cdk.CfnOutput(this, "GoWebSocketUrl", { value: goWs.stage.url });
    new cdk.CfnOutput(this, "TsWebSocketUrl", { value: tsWs.stage.url });
    new cdk.CfnOutput(this, "PyWebSocketUrl", { value: pyWs.stage.url });

    const goRestApi = new AppTheoryRestApi(this, "GoRestApi", {
      apiName: `${name}-go-rest`,
      handler: goHandler.fn,
    });
    goRestApi.addRoute("/sse", ["GET"], { streaming: true });

    new cdk.CfnOutput(this, "GoRestApiUrl", { value: goRestApi.api.url ?? "" });
    new cdk.CfnOutput(this, "GoRestSseUrl", { value: goRestApi.api.urlForPath("/sse") ?? "" });
  }
}
