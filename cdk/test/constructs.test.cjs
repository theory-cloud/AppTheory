const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");
const codebuild = require("aws-cdk-lib/aws-codebuild");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const ec2 = require("aws-cdk-lib/aws-ec2");
const events = require("aws-cdk-lib/aws-events");
const iam = require("aws-cdk-lib/aws-iam");
const kms = require("aws-cdk-lib/aws-kms");
const kinesis = require("aws-cdk-lib/aws-kinesis");
const lambda = require("aws-cdk-lib/aws-lambda");
const logs = require("aws-cdk-lib/aws-logs");
const route53 = require("aws-cdk-lib/aws-route53");
const sqs = require("aws-cdk-lib/aws-sqs");

const apptheory = require("../lib");
const { restApiStreamingRouteStageVariableName } = require("../lib/private/rest-api-streaming");

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableJson(value[key]);
    }
    return out;
  }
  return value;
}

function renderedString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderedString).join("");
  if (value && typeof value === "object" && Array.isArray(value["Fn::Join"])) {
    return renderedString(value["Fn::Join"][1]);
  }
  if (value && typeof value === "object") return JSON.stringify(stableJson(value));
  return String(value);
}

function snapshotPath(name) {
  return path.join(__dirname, "snapshots", `${name}.json`);
}

function expectSnapshot(name, template) {
  const filePath = snapshotPath(name);
  const actual = JSON.stringify(stableJson(template), null, 2) + "\n";
  if (!fs.existsSync(filePath)) {
    assert.fail(`missing snapshot ${filePath} (run with UPDATE_SNAPSHOTS=1)`);
  }
  const expected = fs.readFileSync(filePath, "utf-8");
  assert.equal(actual, expected);
}

function writeSnapshot(name, template) {
  const filePath = snapshotPath(name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(stableJson(template), null, 2) + "\n");
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function findCachePolicyEntry(resources, commentNeedle) {
  return Object.entries(resources).find(
    ([, resource]) =>
      resource.Type === "AWS::CloudFront::CachePolicy" &&
      String(resource.Properties?.CachePolicyConfig?.Comment ?? "").includes(commentNeedle),
  );
}

function restApiResourcePaths(template) {
  const resources = template.Resources ?? {};
  const cache = {};

  function resolve(resourceId) {
    if (!resourceId) return null;
    if (cache[resourceId]) return cache[resourceId];

    const resource = resources[resourceId];
    if (!resource || resource.Type !== "AWS::ApiGateway::Resource") {
      return null;
    }

    const pathPart = resource.Properties?.PathPart;
    const parentId = resource.Properties?.ParentId?.Ref;
    const parentPath = resolve(parentId);
    const fullPath = parentPath ? `${parentPath}/${pathPart}` : `/${pathPart}`;
    cache[resourceId] = fullPath.replace(/\/{2,}/g, "/");
    return cache[resourceId];
  }

  for (const resourceId of Object.keys(resources)) {
    resolve(resourceId);
  }

  return cache;
}

function restApiMethodPaths(template) {
  const resourcePaths = restApiResourcePaths(template);
  const methods = [];
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== "AWS::ApiGateway::Method") continue;
    methods.push({
      method: resource.Properties?.HttpMethod,
      path: resourcePaths[resource.Properties?.ResourceId?.Ref] ?? "/",
      integration: resource.Properties?.Integration,
    });
  }
  return methods;
}

function restApiStageVariables(template) {
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type === "AWS::ApiGateway::Stage") {
      return resource.Properties?.Variables ?? {};
    }
  }
  return {};
}

function lambdaPermissionSourceArns(template) {
  const sourceArns = [];
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== "AWS::Lambda::Permission") continue;
    sourceArns.push(JSON.stringify(stableJson(resource.Properties?.SourceArn ?? null)));
  }
  return sourceArns;
}

function lambdaPermissionCount(template) {
  return lambdaPermissionSourceArns(template).length;
}

function iamPolicyActions(template) {
  const actions = [];
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    for (const statement of resource.Properties?.PolicyDocument?.Statement ?? []) {
      const action = statement.Action;
      if (Array.isArray(action)) {
        actions.push(...action);
      } else if (typeof action === "string") {
        actions.push(action);
      }
    }
  }
  return actions;
}

function assertNoTestInvokeStagePermissions(template) {
  const sourceArns = lambdaPermissionSourceArns(template);
  assert.ok(sourceArns.length >= 1, "Should synthesize at least one Lambda permission");
  for (const sourceArn of sourceArns) {
    assert.ok(
      !sourceArn.includes("/test-invoke-stage/"),
      `Should not include test-invoke-stage Lambda permission: ${sourceArn}`,
    );
  }
}

function assertStreamingRouteStageVariable(template, method, path) {
  const variables = restApiStageVariables(template);
  const key = restApiStreamingRouteStageVariableName(method, path);
  assert.equal(variables[key], "1", `Stage should mark ${method} ${path} as streaming`);
}

function singleRestApiResource(template) {
  const restApis = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::ApiGateway::RestApi",
  );
  assert.equal(restApis.length, 1, "Should synthesize exactly one REST API resource");
  return restApis[0];
}

test("AppTheoryFunction synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryFunction(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("function", template);
  } else {
    expectSnapshot("function", template);
  }
});

test("AppTheoryHttpApi synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryHttpApi(stack, "HttpApi", { handler: fn, apiName: "apptheory-test" });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("http-api", template);
  } else {
    expectSnapshot("http-api", template);
  }
});

test("AppTheoryHttpIngestionEndpoint synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const handler = new lambda.Function(stack, "Handler", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 202, body: 'accepted' });"),
  });
  const authorizer = new lambda.Function(stack, "AuthorizerFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ isAuthorized: true });"),
  });

  new apptheory.AppTheoryHttpIngestionEndpoint(stack, "Endpoint", {
    handler,
    authorizer,
    apiName: "apptheory-ingestion",
    endpointPath: "/evidence",
    stage: {
      stageName: "prod",
      accessLogging: true,
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("http-ingestion-endpoint", template);
  } else {
    expectSnapshot("http-ingestion-endpoint", template);
  }
});

test("AppTheoryHttpIngestionEndpoint fails closed on invalid props", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const handler = new lambda.Function(stack, "Handler", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 202, body: 'accepted' });"),
  });
  const authorizer = new lambda.Function(stack, "AuthorizerFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ isAuthorized: true });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheoryHttpIngestionEndpoint(stack, "MissingPath", {
        handler,
        authorizer,
        endpointPath: " ",
      }),
    /endpointPath is required/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryHttpIngestionEndpoint(stack, "MissingHeader", {
        handler,
        authorizer,
        authorizerHeaderName: " ",
      }),
    /authorizerHeaderName is required/,
  );
});

test("AppTheoryWebSocketApi synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryWebSocketApi(stack, "WebSocketApi", {
    handler: fn,
    apiName: "apptheory-test",
    stageName: "dev",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("websocket-api", template);
  } else {
    expectSnapshot("websocket-api", template);
  }
});

test("AppTheoryWebSocketApi (parity) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryWebSocketApi(stack, "WebSocketApi", {
    handler: fn,
    apiName: "apptheory-test",
    stageName: "dev",
    enableConnectionTable: true,
    enableAccessLogging: true,
    accessLogRetention: logs.RetentionDays.ONE_WEEK,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("websocket-api-parity", template);
  } else {
    expectSnapshot("websocket-api-parity", template);
  }
});

test("AppTheoryWebSocketApi (route handlers) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const connectFn = new lambda.Function(stack, "ConnectFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const disconnectFn = new lambda.Function(stack, "DisconnectFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const defaultFn = new lambda.Function(stack, "DefaultFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryWebSocketApi(stack, "WebSocketApi", {
    handler: defaultFn,
    connectHandler: connectFn,
    disconnectHandler: disconnectFn,
    defaultHandler: defaultFn,
    apiName: "apptheory-test",
    stageName: "dev",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("websocket-api-route-handlers", template);
  } else {
    expectSnapshot("websocket-api-route-handlers", template);
  }
});

test("AppTheoryQueueProcessor synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const consumer = new lambda.Function(stack, "Consumer", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryQueueProcessor(stack, "Queue", { consumer });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("queue-processor", template);
  } else {
    expectSnapshot("queue-processor", template);
  }
});

test("AppTheoryQueue (without DLQ) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryQueue(stack, "Queue", {
    queueName: "apptheory-queue",
    enableDlq: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("queue-only-no-dlq", template);
  } else {
    expectSnapshot("queue-only-no-dlq", template);
  }
});

test("AppTheoryQueue (with DLQ) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryQueue(stack, "Queue", {
    queueName: "apptheory-queue",
    enableDlq: true,
    maxReceiveCount: 5,
    visibilityTimeout: cdk.Duration.seconds(60),
    dlqRetentionPeriod: cdk.Duration.days(14),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("queue-only-with-dlq", template);
  } else {
    expectSnapshot("queue-only-with-dlq", template);
  }
});

test("AppTheoryQueue + AppTheoryQueueConsumer (full options) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const consumer = new lambda.Function(stack, "Consumer", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const queue = new apptheory.AppTheoryQueue(stack, "Queue", {
    queueName: "apptheory-queue",
    enableDlq: true,
    maxReceiveCount: 3,
    visibilityTimeout: cdk.Duration.seconds(60),
  });

  new apptheory.AppTheoryQueueConsumer(stack, "QueueConsumer", {
    queue: queue.queue,
    consumer: consumer,
    batchSize: 100,
    maxBatchingWindow: cdk.Duration.seconds(10),
    reportBatchItemFailures: true,
    maxConcurrency: 50,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("queue-consumer-full-options", template);
  } else {
    expectSnapshot("queue-consumer-full-options", template);
  }
});

test("AppTheoryQueueProcessor (with DLQ) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const consumer = new lambda.Function(stack, "Consumer", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryQueueProcessor(stack, "Queue", {
    consumer,
    queueName: "apptheory-processor-queue",
    enableDlq: true,
    maxReceiveCount: 5,
    batchSize: 50,
    maxBatchingWindow: cdk.Duration.seconds(5),
    reportBatchItemFailures: true,
    maxConcurrency: 10,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("queue-processor-with-dlq", template);
  } else {
    expectSnapshot("queue-processor-with-dlq", template);
  }
});

test("AppTheoryQueueProcessor preserves legacy queueProps security settings", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const consumer = new lambda.Function(stack, "Consumer", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const key = new kms.Key(stack, "QueueKey");

  new apptheory.AppTheoryQueueProcessor(stack, "Queue", {
    consumer,
    queueProps: {
      queueName: "secure-legacy-queue",
      visibilityTimeout: cdk.Duration.seconds(45),
      retentionPeriod: cdk.Duration.days(7),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      enforceSSL: true,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const queue = resources.find(
    (resource) => resource.Type === "AWS::SQS::Queue" && resource.Properties?.QueueName === "secure-legacy-queue",
  );
  const queuePolicy = resources.find(
    (resource) =>
      resource.Type === "AWS::SQS::QueuePolicy" &&
      JSON.stringify(resource.Properties?.PolicyDocument ?? {}).includes("aws:SecureTransport"),
  );

  assert.ok(queue, "Should synthesize the legacy queue");
  assert.equal(queue.Properties?.MessageRetentionPeriod, 604800);
  assert.equal(queue.Properties?.VisibilityTimeout, 45);
  assert.equal(queue.Properties?.ReceiveMessageWaitTimeSeconds, 20);
  assert.ok(queue.Properties?.KmsMasterKeyId, "Should preserve legacy encryptionMasterKey");
  assert.ok(queuePolicy, "Should preserve legacy enforceSSL queue policy");
});


test("AppTheoryFunctionAlarms synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryFunctionAlarms(stack, "Alarms", { fn });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("function-alarms", template);
  } else {
    expectSnapshot("function-alarms", template);
  }
});

test("AppTheoryRestApi synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const api = new apptheory.AppTheoryRestApi(stack, "RestApi", { handler: fn, apiName: "apptheory-test" });
  api.addRoute("/sse", ["GET"], { streaming: true });

  const template = assertions.Template.fromStack(stack).toJSON();
  assertStreamingRouteStageVariable(template, "GET", "/sse");
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api", template);
  } else {
    expectSnapshot("rest-api", template);
  }
});

test("AppTheoryRestApi can suppress test-invoke-stage permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const api = new apptheory.AppTheoryRestApi(stack, "RestApi", {
    handler: fn,
    apiName: "apptheory-test",
    allowTestInvoke: false,
  });
  api.addRoute("/sse", ["GET"], { streaming: true });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 3, "Should synthesize one permission per REST method without test invoke");
  assertNoTestInvokeStagePermissions(template);
});

test("AppTheoryRestApi can use API-scoped invoke permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const api = new apptheory.AppTheoryRestApi(stack, "RestApi", {
    handler: fn,
    apiName: "apptheory-test",
    scopePermissionToMethod: false,
  });
  api.addRoute("/sse", ["GET"], { streaming: true });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 1, "Should synthesize one API-scoped permission for the shared Lambda");
  assertNoTestInvokeStagePermissions(template);
});

test("AppTheoryEventBridgeHandler synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryEventBridgeHandler(stack, "Schedule", {
    handler: fn,
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    ruleName: "apptheory-test-rule",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-handler", template);
  } else {
    expectSnapshot("eventbridge-handler", template);
  }
});

test("AppTheoryEventBridgeBus synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryEventBridgeBus(stack, "Bus", {
    eventBusName: "apptheory-compliance",
    description: "Compliance advisor relay bus",
    allowedAccountIds: ["111111111111", "222222222222"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-bus", template);
  } else {
    expectSnapshot("eventbridge-bus", template);
  }
});

test("AppTheoryEventBridgeBus fails closed on invalid allowlist entries", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  assert.throws(
    () =>
      new apptheory.AppTheoryEventBridgeBus(stack, "InvalidBus", {
        allowedAccountIds: ["not-an-account"],
      }),
    /12-digit AWS account IDs/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryEventBridgeBus(stack, "DuplicateBus", {
        allowedAccountIds: ["111111111111", "111111111111"],
      }),
    /duplicate allowed account ID/,
  );
});

test("AppTheoryEventBridgeRuleTarget (schedule) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryEventBridgeRuleTarget(stack, "RuleTarget", {
    handler: fn,
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    ruleName: "apptheory-test-rule",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-rule-target-schedule", template);
  } else {
    expectSnapshot("eventbridge-rule-target-schedule", template);
  }
});

test("AppTheoryEventBridgeRuleTarget (eventPattern) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryEventBridgeRuleTarget(stack, "RuleTarget", {
    handler: fn,
    eventPattern: {
      source: ["aws.s3"],
      detailType: ["Object Created"],
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-rule-target-event-pattern", template);
  } else {
    expectSnapshot("eventbridge-rule-target-event-pattern", template);
  }
});

test("AppTheoryEventBridgeRuleTarget (eventBus + eventPattern) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const bus = new events.EventBus(stack, "Bus");

  new apptheory.AppTheoryEventBridgeRuleTarget(stack, "RuleTarget", {
    handler: fn,
    eventBus: bus,
    eventPattern: {
      source: ["com.example"],
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-rule-target-event-bus", template);
  } else {
    expectSnapshot("eventbridge-rule-target-event-bus", template);
  }
});

test("AppTheoryEventBridgeRuleTarget (compliance beacon relay bus) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const relayBus = new apptheory.AppTheoryEventBridgeBus(stack, "RelayBus", {
    eventBusName: "compliance-advisor-relay",
    allowedAccountIds: ["111111111111"],
  });

  new apptheory.AppTheoryEventBridgeRuleTarget(stack, "RuleTarget", {
    handler: fn,
    eventBus: relayBus.eventBus,
    ruleName: "compliance-beacon-ingress",
    description: "Route compliance beacon relay events to ingestion",
    eventPattern: {
      source: ["pay-theory.compliance-beacon"],
      detailType: ["compliance.beacon.submitted"],
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbridge-rule-target-compliance-beacon", template);
  } else {
    expectSnapshot("eventbridge-rule-target-compliance-beacon", template);
  }
});

test("AppTheoryEventBridgeRuleTarget fails closed on invalid props", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheoryEventBridgeRuleTarget(stack, "MissingBoth", {
        handler: fn,
      }),
    /requires exactly one of eventPattern or schedule/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryEventBridgeRuleTarget(stack, "HasBoth", {
        handler: fn,
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        eventPattern: { source: ["aws.s3"] },
      }),
    /requires exactly one of eventPattern or schedule/,
  );
});

test("AppTheoryS3Ingest (bucket defaults) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryS3Ingest(stack, "Ingest");

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("s3-ingest-defaults", template);
  } else {
    expectSnapshot("s3-ingest-defaults", template);
  }
});

test("AppTheoryS3Ingest (EventBridge enabled) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryS3Ingest(stack, "Ingest", {
    enableEventBridge: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("s3-ingest-eventbridge", template);
  } else {
    expectSnapshot("s3-ingest-eventbridge", template);
  }
});

test("AppTheoryS3Ingest (SQS notifications + filters) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryS3Ingest(stack, "Ingest", {
    queueProps: {
      queueName: "import-ingest",
      enableDlq: true,
    },
    prefixes: ["incoming/"],
    suffixes: [".csv", ".json"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("s3-ingest-sqs-filters", template);
  } else {
    expectSnapshot("s3-ingest-sqs-filters", template);
  }
});

test("AppTheoryKinesisStream (on-demand) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-events",
    mode: kinesis.StreamMode.ON_DEMAND,
    retentionPeriod: cdk.Duration.hours(48),
    encryption: kinesis.StreamEncryption.MANAGED,
  });

  assert.ok(stream.stream);
  assert.ok(stream.streamArn);
  assert.ok(stream.streamName);

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-on-demand", template);
  } else {
    expectSnapshot("kinesis-stream-on-demand", template);
  }
});

test("AppTheoryKinesisStream (provisioned) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-provisioned-events",
    mode: kinesis.StreamMode.PROVISIONED,
    shardCount: 2,
    retentionPeriod: cdk.Duration.days(7),
    encryption: kinesis.StreamEncryption.MANAGED,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-provisioned", template);
  } else {
    expectSnapshot("kinesis-stream-provisioned", template);
  }
});

test("AppTheoryKinesisStream (KMS, removal policy, grants) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const key = new kms.Key(stack, "Key");
  const reader = new iam.Role(stack, "Reader", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  const writer = new iam.Role(stack, "Writer", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  const readWriter = new iam.Role(stack, "ReadWriter", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });

  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-secure-events",
    mode: kinesis.StreamMode.PROVISIONED,
    shardCount: 1,
    retentionPeriod: cdk.Duration.days(3),
    encryption: kinesis.StreamEncryption.KMS,
    encryptionKey: key,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    grantReadTo: [reader],
    grantWriteTo: [writer],
  });
  stream.grantReadWrite(readWriter);

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-kms-removal-policy-grants", template);
  } else {
    expectSnapshot("kinesis-stream-kms-removal-policy-grants", template);
  }
});

test("AppTheoryKinesisStream wraps imported streams without replacement resources", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });

  const role = new iam.Role(stack, "Reader", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  const imported = kinesis.Stream.fromStreamArn(
    stack,
    "Imported",
    "arn:aws:kinesis:us-east-1:111111111111:stream/existing-events",
  );

  const wrapped = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    stream: imported,
    grantReadTo: [role],
  });

  assert.equal(wrapped.streamArn, imported.streamArn);
  assert.equal(wrapped.streamName, imported.streamName);

  const template = assertions.Template.fromStack(stack).toJSON();
  const kinesisResources = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::Kinesis::Stream",
  );
  assert.equal(kinesisResources.length, 0, "Imported streams must not synthesize replacement stream resources");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-imported", template);
  } else {
    expectSnapshot("kinesis-stream-imported", template);
  }
});

test("AppTheoryKinesisStream fails closed on invalid props", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const imported = kinesis.Stream.fromStreamArn(
    stack,
    "Imported",
    "arn:aws:kinesis:us-east-1:111111111111:stream/existing-events",
  );
  const key = new kms.Key(stack, "Key");

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "ImportedWithCreateProps", {
        stream: imported,
        streamName: "replacement",
      }),
    /does not allow create-time properties/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "OnDemandWithShardCount", {
        mode: kinesis.StreamMode.ON_DEMAND,
        shardCount: 2,
      }),
    /requires mode PROVISIONED/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "InvalidShardCount", {
        mode: kinesis.StreamMode.PROVISIONED,
        shardCount: 0,
      }),
    /positive integer/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "KmsWithoutKey", {
        encryption: kinesis.StreamEncryption.KMS,
      }),
    /requires encryptionKey/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "ManagedWithKey", {
        encryption: kinesis.StreamEncryption.MANAGED,
        encryptionKey: key,
      }),
    /only supports encryptionKey/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStream(stack, "Unencrypted", {
        encryption: kinesis.StreamEncryption.UNENCRYPTED,
      }),
    /requires stream encryption/,
  );
});

test("AppTheoryKinesisStreamMapping synthesizes partial batch failures and read grant", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-events",
  });

  new apptheory.AppTheoryKinesisStreamMapping(stack, "Mapping", {
    consumer: fn,
    stream: stream.stream,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const eventSourceMappings = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::Lambda::EventSourceMapping",
  );
  assert.equal(eventSourceMappings.length, 1);
  assert.equal(eventSourceMappings[0].Properties?.StartingPosition, "LATEST");
  assert.deepEqual(eventSourceMappings[0].Properties?.FunctionResponseTypes, ["ReportBatchItemFailures"]);

  const actions = iamPolicyActions(template);
  assert.ok(actions.includes("kinesis:GetRecords"), "Mapping should grant Kinesis read access");
  assert.ok(actions.includes("kinesis:GetShardIterator"), "Mapping should grant Kinesis iterator access");
  assert.equal(actions.includes("kinesis:PutRecord"), false, "Mapping must not grant Kinesis write access");
  assert.equal(actions.includes("kinesis:PutRecords"), false, "Mapping must not grant Kinesis write access");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-mapping", template);
  } else {
    expectSnapshot("kinesis-stream-mapping", template);
  }
});

test("AppTheoryKinesisStreamMapping passes representative stream options", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const stream = kinesis.Stream.fromStreamArn(
    stack,
    "Imported",
    "arn:aws:kinesis:us-east-1:111111111111:stream/existing-events",
  );

  new apptheory.AppTheoryKinesisStreamMapping(stack, "Mapping", {
    consumer: fn,
    stream,
    startingPosition: lambda.StartingPosition.AT_TIMESTAMP,
    startingPositionTimestamp: 1710000000,
    batchSize: 250,
    maxBatchingWindow: cdk.Duration.seconds(30),
    retryAttempts: 3,
    maxRecordAge: cdk.Duration.hours(2),
    bisectBatchOnError: true,
    parallelizationFactor: 2,
    reportBatchItemFailures: true,
    tumblingWindow: cdk.Duration.minutes(1),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kinesis-stream-mapping-options", template);
  } else {
    expectSnapshot("kinesis-stream-mapping-options", template);
  }
});

test("AppTheoryKinesisStreamMapping fails closed on timestamp mismatch", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream");

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStreamMapping(stack, "MissingTimestamp", {
        consumer: fn,
        stream: stream.stream,
        startingPosition: lambda.StartingPosition.AT_TIMESTAMP,
      }),
    /requires startingPositionTimestamp/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryKinesisStreamMapping(stack, "UnexpectedTimestamp", {
        consumer: fn,
        stream: stream.stream,
        startingPositionTimestamp: 1710000000,
      }),
    /only supports startingPositionTimestamp/,
  );
});

test("AppTheoryCloudWatchLogsDestination (account allowlist) synthesizes narrow destination", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "999999999999", region: "us-east-1" },
  });
  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-events",
  });

  new apptheory.AppTheoryCloudWatchLogsDestination(stack, "LogsDestination", {
    stream: stream.stream,
    destinationName: "apptheory-central-logs",
    allowedSourceAccounts: ["111111111111", "222222222222"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const destinations = resources.filter((resource) => resource.Type === "AWS::Logs::Destination");
  const roles = resources.filter((resource) => resource.Type === "AWS::IAM::Role");

  assert.equal(destinations.length, 1, "Should synthesize one CloudWatch Logs destination");
  assert.equal(destinations[0].Properties?.DestinationName, "apptheory-central-logs");
  assert.ok(destinations[0].Properties?.TargetArn, "Destination should target the Kinesis stream");
  assert.ok(destinations[0].Properties?.RoleArn, "Destination should use the service role");

  const destinationPolicy = renderedString(destinations[0].Properties?.DestinationPolicy);
  assert.match(destinationPolicy, /logs:PutSubscriptionFilter/);
  assert.match(destinationPolicy, /111111111111/);
  assert.match(destinationPolicy, /222222222222/);
  assert.doesNotMatch(destinationPolicy, /"Principal":"\*"/);
  assert.doesNotMatch(destinationPolicy, /kinesis:\*/);

  assert.equal(roles.length, 1, "Should synthesize one CloudWatch Logs service role");
  const assumeRole = roles[0].Properties?.AssumeRolePolicyDocument?.Statement ?? [];
  assert.equal(assumeRole.length, 1);
  assert.deepEqual(assumeRole[0].Principal, { Service: "logs.amazonaws.com" });
  assert.deepEqual(assumeRole[0].Condition?.StringLike?.["aws:SourceArn"], [
    { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":logs:us-east-1:999999999999:*"]] },
    { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":logs:us-east-1:111111111111:*"]] },
    { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":logs:us-east-1:222222222222:*"]] },
  ]);

  const actions = iamPolicyActions(template);
  assert.ok(actions.includes("kinesis:PutRecord"), "Service role should be able to write records");
  assert.equal(
    actions.includes("kinesis:PutRecords"),
    false,
    "Service role should grant only the documented PutRecord operation",
  );
  assert.equal(
    actions.includes("kinesis:ListShards"),
    false,
    "Service role must not receive Kinesis read/list permissions",
  );
  assert.equal(actions.includes("kinesis:*"), false, "Service role must not receive broad Kinesis permissions");
  assert.equal(actions.includes("logs:PutSubscriptionFilter"), false, "Service role must not write destination policies");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("cloudwatch-logs-destination-account-allowlist", template);
  } else {
    expectSnapshot("cloudwatch-logs-destination-account-allowlist", template);
  }
});

test("AppTheoryCloudWatchLogsDestination (organization allowlist) constrains wildcard principal", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "999999999999", region: "us-east-1" },
  });
  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream", {
    streamName: "apptheory-org-events",
  });

  new apptheory.AppTheoryCloudWatchLogsDestination(stack, "LogsDestination", {
    stream: stream.stream,
    destinationName: "apptheory-org-logs",
    allowedOrganizationIds: ["o-abcdef1234"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const destination = resources.find((resource) => resource.Type === "AWS::Logs::Destination");
  const role = resources.find((resource) => resource.Type === "AWS::IAM::Role");

  assert.ok(destination, "Should synthesize a CloudWatch Logs destination");
  const destinationPolicy = renderedString(destination.Properties?.DestinationPolicy);
  assert.match(destinationPolicy, /"Principal":"\*"/);
  assert.match(destinationPolicy, /aws:PrincipalOrgID/);
  assert.match(destinationPolicy, /o-abcdef1234/);
  assert.match(destinationPolicy, /logs:PutSubscriptionFilter/);

  assert.ok(role, "Should synthesize the CloudWatch Logs service role");
  const assumeRole = role.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
  assert.equal(assumeRole.length, 2);
  assert.deepEqual(assumeRole[1].Principal, { Service: "logs.amazonaws.com" });
  assert.deepEqual(assumeRole[1].Condition, {
    StringEquals: {
      "aws:SourceOrgID": ["o-abcdef1234"],
    },
  });

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("cloudwatch-logs-destination-organization-allowlist", template);
  } else {
    expectSnapshot("cloudwatch-logs-destination-organization-allowlist", template);
  }
});

test("AppTheoryCloudWatchLogsDestination fails closed without an allowlist", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const stream = new apptheory.AppTheoryKinesisStream(stack, "Stream");

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsDestination(stack, "MissingAllowlist", {
        stream: stream.stream,
      }),
    /requires allowedSourceAccounts and\/or allowedOrganizationIds/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsDestination(stack, "EmptyAllowlist", {
        stream: stream.stream,
        allowedSourceAccounts: [],
        allowedOrganizationIds: [],
      }),
    /requires allowedSourceAccounts and\/or allowedOrganizationIds/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsDestination(stack, "EmptyAccount", {
        stream: stream.stream,
        allowedSourceAccounts: [" "],
      }),
    /allowedSourceAccounts cannot contain empty values/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsDestination(stack, "InvalidOrg", {
        stream: stream.stream,
        allowedOrganizationIds: ["not-an-org"],
      }),
    /allowedOrganizationIds must contain AWS Organization IDs/,
  );
});

test("AppTheoryCloudWatchLogsSubscription (log group reference) synthesizes source filter", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
  const logGroup = new logs.LogGroup(stack, "SourceLogGroup", {
    logGroupName: "/apptheory/source",
  });
  const deliveryRole = new iam.Role(stack, "DeliveryRole", {
    assumedBy: new iam.ServicePrincipal("logs.amazonaws.com"),
  });

  new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "SourceSubscription", {
    logGroup,
    destinationArn: "arn:aws:kinesis:us-east-1:111111111111:stream/app-events",
    filterPatternText: "",
    role: deliveryRole,
    filterName: "all-source-events",
    distribution: logs.Distribution.RANDOM,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const subscriptionEntries = Object.entries(template.Resources ?? {}).filter(
    ([, resource]) => resource.Type === "AWS::Logs::SubscriptionFilter",
  );
  const logGroupEntries = Object.entries(template.Resources ?? {}).filter(
    ([, resource]) => resource.Type === "AWS::Logs::LogGroup",
  );
  const roleEntries = Object.entries(template.Resources ?? {}).filter(
    ([, resource]) => resource.Type === "AWS::IAM::Role",
  );

  assert.equal(subscriptionEntries.length, 1, "Should synthesize one subscription filter");
  assert.equal(logGroupEntries.length, 1, "Should synthesize one source log group");
  assert.equal(roleEntries.length, 1, "Should use only the caller-provided delivery role");

  const [subscriptionId, subscription] = subscriptionEntries[0];
  const [logGroupId] = logGroupEntries[0];
  const [roleId] = roleEntries[0];

  assert.match(subscriptionId, /SourceSubscriptionSubscriptionFilter/);
  assert.deepEqual(subscription.Properties?.LogGroupName, { Ref: logGroupId });
  assert.equal(subscription.Properties?.DestinationArn, "arn:aws:kinesis:us-east-1:111111111111:stream/app-events");
  assert.equal(subscription.Properties?.FilterPattern, "");
  assert.equal(subscription.Properties?.FilterName, "all-source-events");
  assert.equal(subscription.Properties?.Distribution, "Random");
  assert.deepEqual(subscription.Properties?.RoleArn, { "Fn::GetAtt": [roleId, "Arn"] });
});

test("AppTheoryCloudWatchLogsSubscription supports caller-owned destination configs", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "111111111111", region: "us-east-1" },
  });
  const configs = [
    {
      id: "LambdaSubscription",
      logGroupName: "/app/lambda",
      destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
      filterPatternText: '{ $.level = "info" }',
    },
    {
      id: "KinesisSubscription",
      logGroupName: "/app/kinesis",
      destinationArn: "arn:aws:kinesis:us-east-1:111111111111:stream/app-events",
      filterPattern: logs.FilterPattern.allEvents(),
      roleArn: "arn:aws:iam::111111111111:role/logs-to-kinesis",
      distribution: logs.Distribution.BY_LOG_STREAM,
    },
    {
      id: "FirehoseSubscription",
      logGroupName: "/app/firehose",
      destinationArn: "arn:aws:firehose:us-east-1:111111111111:deliverystream/app-events",
      filterPatternText: "?audit",
      roleArn: "arn:aws:iam::111111111111:role/logs-to-firehose",
    },
    {
      id: "CrossAccountSubscription",
      logGroupName: "/app/cross-account",
      destinationArn: "arn:aws:logs:us-east-1:999999999999:destination:shared-app-logs",
      filterPattern: logs.FilterPattern.literal('{ $.service = "api" }'),
      filterName: "shared-api-events",
    },
  ];

  for (const config of configs) {
    const { id, ...subscriptionProps } = config;
    new apptheory.AppTheoryCloudWatchLogsSubscription(stack, id, subscriptionProps);
  }

  const template = assertions.Template.fromStack(stack).toJSON();
  const subscriptions = resourcesOfType(template, "AWS::Logs::SubscriptionFilter");
  assert.equal(subscriptions.length, configs.length, "Should synthesize one subscription per caller config");

  const byLogGroupName = new Map(
    subscriptions.map((subscription) => [subscription.Properties?.LogGroupName, subscription]),
  );
  const lambdaSubscription = byLogGroupName.get("/app/lambda");
  const kinesisSubscription = byLogGroupName.get("/app/kinesis");
  const firehoseSubscription = byLogGroupName.get("/app/firehose");
  const crossAccountSubscription = byLogGroupName.get("/app/cross-account");

  assert.equal(lambdaSubscription?.Properties?.DestinationArn, configs[0].destinationArn);
  assert.equal(lambdaSubscription?.Properties?.FilterPattern, '{ $.level = "info" }');
  assert.equal(lambdaSubscription?.Properties?.RoleArn, undefined);

  assert.equal(kinesisSubscription?.Properties?.DestinationArn, configs[1].destinationArn);
  assert.equal(kinesisSubscription?.Properties?.FilterPattern, "");
  assert.equal(kinesisSubscription?.Properties?.RoleArn, configs[1].roleArn);
  assert.equal(kinesisSubscription?.Properties?.Distribution, "ByLogStream");

  assert.equal(firehoseSubscription?.Properties?.DestinationArn, configs[2].destinationArn);
  assert.equal(firehoseSubscription?.Properties?.FilterPattern, "?audit");
  assert.equal(firehoseSubscription?.Properties?.RoleArn, configs[2].roleArn);

  assert.equal(crossAccountSubscription?.Properties?.DestinationArn, configs[3].destinationArn);
  assert.equal(crossAccountSubscription?.Properties?.FilterPattern, '{ $.service = "api" }');
  assert.equal(crossAccountSubscription?.Properties?.FilterName, "shared-api-events");
  assert.equal(crossAccountSubscription?.Properties?.RoleArn, undefined);
});

test("AppTheoryCloudWatchLogsSubscription fails closed for ambiguous props", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const logGroup = new logs.LogGroup(stack, "SourceLogGroup");
  const deliveryRole = new iam.Role(stack, "DeliveryRole", {
    assumedBy: new iam.ServicePrincipal("logs.amazonaws.com"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "MissingLogGroup", {
        destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
        filterPatternText: "",
      }),
    /requires exactly one of logGroup or logGroupName/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "BothLogGroupInputs", {
        logGroup,
        logGroupName: "/app/logs",
        destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
        filterPatternText: "",
      }),
    /requires exactly one of logGroup or logGroupName/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "MissingDestinationArn", {
        logGroupName: "/app/logs",
        filterPatternText: "",
      }),
    /requires destinationArn/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "MissingFilterPattern", {
        logGroupName: "/app/logs",
        destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
      }),
    /requires exactly one of filterPattern or filterPatternText/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "BothFilterPatternInputs", {
        logGroupName: "/app/logs",
        destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
        filterPattern: logs.FilterPattern.allEvents(),
        filterPatternText: "",
      }),
    /requires exactly one of filterPattern or filterPatternText/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "BothRoleInputs", {
        logGroupName: "/app/logs",
        destinationArn: "arn:aws:kinesis:us-east-1:111111111111:stream/app-events",
        filterPatternText: "",
        role: deliveryRole,
        roleArn: "arn:aws:iam::111111111111:role/logs-to-kinesis",
      }),
    /accepts at most one of role or roleArn/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "EmptyDestinationArn", {
        logGroupName: "/app/logs",
        destinationArn: " ",
        filterPatternText: "",
      }),
    /destinationArn cannot be empty/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryCloudWatchLogsSubscription(stack, "EmptyFilterName", {
        logGroupName: "/app/logs",
        destinationArn: "arn:aws:lambda:us-east-1:111111111111:function:logs-processor",
        filterPatternText: "",
        filterName: " ",
      }),
    /filterName cannot be empty/,
  );
});

test("AppTheoryJobsTable synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryJobsTable(stack, "Jobs");

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("jobs-table", template);
  } else {
    expectSnapshot("jobs-table", template);
  }
});

test("AppTheoryCodeBuildJobRunner synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryCodeBuildJobRunner(stack, "Runner", {
    buildSpec: codebuild.BuildSpec.fromObject({
      version: "0.2",
      phases: {
        build: {
          commands: ["echo hello"],
        },
      },
    }),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("codebuild-job-runner", template);
  } else {
    expectSnapshot("codebuild-job-runner", template);
  }
});

test("AppTheoryCodeBuildJobRunner (env vars + KMS) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const key = new kms.Key(stack, "Key");

  new apptheory.AppTheoryCodeBuildJobRunner(stack, "Runner", {
    encryptionKey: key,
    environmentVariables: {
      HELLO: { value: "world" },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: "0.2",
      phases: {
        build: {
          commands: ["echo $HELLO"],
        },
      },
    }),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("codebuild-job-runner-env-kms", template);
  } else {
    expectSnapshot("codebuild-job-runner-env-kms", template);
  }
});

test("AppTheoryCodeBuildJobRunner (additional statements) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryCodeBuildJobRunner(stack, "Runner", {
    additionalStatements: [
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: ["*"],
      }),
    ],
    buildSpec: codebuild.BuildSpec.fromObject({
      version: "0.2",
      phases: {
        build: {
          commands: ["echo ok"],
        },
      },
    }),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("codebuild-job-runner-additional-statements", template);
  } else {
    expectSnapshot("codebuild-job-runner-additional-statements", template);
  }
});

test("AppTheoryCodeBuildJobRunner (state change rule) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryCodeBuildJobRunner(stack, "Runner", {
    enableStateChangeRule: true,
    stateChangeRuleName: "build-state-changes",
    stateChangeRuleDescription: "state changes",
    buildSpec: codebuild.BuildSpec.fromObject({
      version: "0.2",
      phases: {
        build: {
          commands: ["echo ok"],
        },
      },
    }),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("codebuild-job-runner-state-change-rule", template);
  } else {
    expectSnapshot("codebuild-job-runner-state-change-rule", template);
  }
});

test("AppTheoryDynamoDBStreamMapping synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const table = new dynamodb.Table(stack, "Table", {
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });

  const originalGrantStreamRead = table.grantStreamRead.bind(table);
  let grantStreamReadCalls = 0;
  table.grantStreamRead = (...args) => {
    grantStreamReadCalls += 1;
    return originalGrantStreamRead(...args);
  };

  new apptheory.AppTheoryDynamoDBStreamMapping(stack, "Stream", { consumer: fn, table });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(grantStreamReadCalls, 1, "DynamoEventSource must be the only stream-read grant path");

  const policyStatements = Object.values(template.Resources ?? {})
    .filter((resource) => resource.Type === "AWS::IAM::Policy")
    .flatMap((resource) => resource.Properties?.PolicyDocument?.Statement ?? []);
  const listStreamsStatements = policyStatements.filter(
    (statement) =>
      statement.Effect === "Allow" && statement.Action === "dynamodb:ListStreams" && statement.Resource === "*",
  );
  const streamReadStatements = policyStatements.filter((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return (
      statement.Effect === "Allow" &&
      actions.includes("dynamodb:DescribeStream") &&
      actions.includes("dynamodb:GetRecords") &&
      actions.includes("dynamodb:GetShardIterator") &&
      JSON.stringify(statement.Resource).includes("StreamArn")
    );
  });
  assert.equal(listStreamsStatements.length, 1, "consumer must retain the DynamoDB ListStreams grant");
  assert.equal(streamReadStatements.length, 1, "consumer must retain one DynamoDB stream-read grant statement");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("dynamodb-stream-mapping", template);
  } else {
    expectSnapshot("dynamodb-stream-mapping", template);
  }
});

test("AppTheoryDynamoDBStreamMapping (parallelization + batching window) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const table = new dynamodb.Table(stack, "Table", {
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });

  new apptheory.AppTheoryDynamoDBStreamMapping(stack, "Stream", {
    consumer: fn,
    table,
    parallelizationFactor: 2,
    maxBatchingWindow: cdk.Duration.seconds(0),
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("dynamodb-stream-mapping-options", template);
  } else {
    expectSnapshot("dynamodb-stream-mapping-options", template);
  }
});

test("AppTheoryEventBusTable synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryEventBusTable(stack, "Events", { tableName: "apptheory-events" });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbus-table", template);
  } else {
    expectSnapshot("eventbus-table", template);
  }
});

test("AppTheoryEventBusTable bind wires env vars and grants", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const ingestionFn = new lambda.Function(stack, "IngestionFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const replayFn = new lambda.Function(stack, "ReplayFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const table = new apptheory.AppTheoryEventBusTable(stack, "Events", {
    tableName: "apptheory-events",
  });

  table.bind(ingestionFn);
  table.bind(replayFn, {
    readOnly: true,
    envVarName: "COMPLIANCE_REPLAY_TABLE",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("eventbus-table-binding", template);
  } else {
    expectSnapshot("eventbus-table-binding", template);
  }
});

test("AppTheoryDynamoTable synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryDynamoTable(stack, "Table", {
    tableName: "apptheory-test-table",
    partitionKeyName: "PK",
    sortKeyName: "SK",
    timeToLiveAttribute: "ttl",
    enableStream: true,
    streamViewType: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    globalSecondaryIndexes: [
      {
        indexName: "tenant-timestamp-index",
        partitionKeyName: "tenant_id",
        sortKeyName: "published_at",
      },
      {
        indexName: "event-id-index",
        partitionKeyName: "id",
      },
    ],
    grantReadWriteTo: [fn],
    grantStreamReadTo: [fn],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("dynamo-table", template);
  } else {
    expectSnapshot("dynamo-table", template);
  }
});

test("AppTheoryDynamoTable (no TTL) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryDynamoTable(stack, "Table", {
    tableName: "apptheory-test-table",
    partitionKeyName: "PK",
    sortKeyName: "SK",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("dynamo-table-no-ttl", template);
  } else {
    expectSnapshot("dynamo-table-no-ttl", template);
  }
});

test("AppTheoryDynamoTable (deletion protection) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryDynamoTable(stack, "Table", {
    tableName: "apptheory-test-table-protected",
    partitionKeyName: "PK",
    sortKeyName: "SK",
    deletionProtection: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("dynamo-table-deletion-protection", template);
  } else {
    expectSnapshot("dynamo-table-deletion-protection", template);
  }
});

test("AppTheoryHostedZone synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryHostedZone(stack, "Zone", {
    zoneName: "example.com",
    comment: "apptheory test zone",
    enableSsmExport: true,
    enableCfnExport: true,
    tags: { Owner: "apptheory" },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("hosted-zone", template);
  } else {
    expectSnapshot("hosted-zone", template);
  }
});

test("AppTheoryCertificate synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "api.example.com",
    hostedZone: zone,
    subjectAlternativeNames: ["auth.example.com"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("certificate", template);
  } else {
    expectSnapshot("certificate", template);
  }
});

test("AppTheoryApiDomain synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "api.example.com",
    hostedZone: zone,
  });

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const api = new apptheory.AppTheoryHttpApi(stack, "HttpApi", { handler: fn, apiName: "apptheory-test" });

  new apptheory.AppTheoryApiDomain(stack, "Domain", {
    domainName: "api.example.com",
    certificate: cert.certificate,
    httpApi: api.api,
    hostedZone: zone,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("api-domain", template);
  } else {
    expectSnapshot("api-domain", template);
  }
});

test("AppTheoryKmsKey synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryKmsKey(stack, "Key", {
    description: "apptheory test HMAC key",
    keySpec: kms.KeySpec.HMAC_256,
    keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
    multiRegion: true,
    aliasName: "alias/apptheory/test-hmac",
    enableSsmParameter: true,
    ssmParameterPath: "/apptheory/test/hmac-key-arn",
    tags: { Purpose: "test" },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("kms-key", template);
  } else {
    expectSnapshot("kms-key", template);
  }
});

test("AppTheoryEnhancedSecurity synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const vpc = ec2.Vpc.fromVpcAttributes(stack, "Vpc", {
    vpcId: "vpc-123456",
    vpcCidrBlock: "10.0.0.0/16",
    availabilityZones: ["us-east-1a"],
    privateSubnetIds: ["subnet-private"],
    privateSubnetRouteTableIds: ["rtb-private"],
  });

  new apptheory.AppTheoryEnhancedSecurity(stack, "Security", {
    vpc,
    enableWaf: true,
    enableVpcFlowLogs: true,
    environment: "dev",
    applicationName: "apptheory-test",
    vpcEndpointConfig: {
      enableKms: true,
      enableXRay: true,
      enableCloudWatchMonitoring: true,
      enableSecretsManager: false,
      enableCloudWatchLogs: false,
      privateDnsEnabled: false,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("enhanced-security", template);
  } else {
    expectSnapshot("enhanced-security", template);
  }
});

test("AppTheoryEnhancedSecurity ipWhitelist enforces default deny semantics", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const vpc = ec2.Vpc.fromVpcAttributes(stack, "Vpc", {
    vpcId: "vpc-123456",
    vpcCidrBlock: "10.0.0.0/16",
    availabilityZones: ["us-east-1a"],
    privateSubnetIds: ["subnet-private"],
    privateSubnetRouteTableIds: ["rtb-private"],
  });

  new apptheory.AppTheoryEnhancedSecurity(stack, "Security", {
    vpc,
    enableWaf: true,
    environment: "dev",
    applicationName: "apptheory-test",
    wafConfig: {
      ipWhitelist: ["203.0.113.0/24"],
      enableRateLimit: false,
      enableSQLiProtection: false,
      enableXSSProtection: false,
      enableKnownBadInputs: false,
    },
  });

  const resources = Object.values(assertions.Template.fromStack(stack).toJSON().Resources ?? {});
  const webAcl = resources.find((resource) => resource.Type === "AWS::WAFv2::WebACL");

  assert.ok(webAcl, "Should synthesize a WAF WebACL");
  assert.deepEqual(webAcl.Properties?.DefaultAction, {
    Block: {
      CustomResponse: {
        ResponseCode: 403,
        CustomResponseBodyKey: "AccessDenied",
      },
    },
  });
});

test("AppTheoryApp synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryApp(stack, "App", {
    appName: "apptheory-test",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    enableDatabase: true,
    databasePartitionKey: "ID",
    databaseSortKey: "SK",
    enableRateLimiting: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("app", template);
  } else {
    expectSnapshot("app", template);
  }
});

test("AppTheorySsrSite synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", { ssrFunction: fn });
  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("ssr-site", template);
  } else {
    expectSnapshot("ssr-site", template);
  }
});

test("AppTheorySsrSite auto-creates hosted-zone certificate only in explicit us-east-1 stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    domainName: "app.example.com",
    hostedZone: zone,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const certificates = resourcesOfType(template, "AWS::CertificateManager::Certificate");
  assert.equal(certificates.length, 1, "Should synthesize one non-deprecated ACM certificate resource");
  assert.equal(certificates[0].Properties?.DomainName, "app.example.com");
});

test("AppTheorySsrSite rejects hosted-zone certificate creation for environment-agnostic stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });
  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        domainName: "app.example.com",
        hostedZone: zone,
      }),
    /AppTheorySsrSite cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is unresolved\. Provide props\.certificateArn/,
  );
});

test("AppTheorySsrSite (FaceTheory) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const htmlStoreBucket = new s3.Bucket(stack, "HtmlStoreBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  });

  const isrMetadataTable = new dynamodb.Table(stack, "IsrMetadataTable", {
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    timeToLiveAttribute: "ttl",
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    htmlStoreBucket,
    htmlStoreKeyPrefix: "isr-pages",
    isrMetadataTable,
    allowViewerTenantHeaders: true,
    ssrForwardHeaders: [" X-FaceTheory-Tenant ", "x-facetheory-tenant"],
    staticPathPatterns: ["/marketing/* ", "marketing/*"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("ssr-site-facetheory", template);
  } else {
    expectSnapshot("ssr-site-facetheory", template);
  }
});

test("AppTheorySsrSite signs read-only Lambda Function URL origins by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const functionUrls = resources.filter((resource) => resource.Type === "AWS::Lambda::Url");
  const lambdaOriginAccessControls = resources.filter(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );
  const cloudfrontInvokePermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );
  const cloudfrontInvokeViaUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunction" &&
      resource.Properties?.InvokedViaFunctionUrl === true,
  );
  const publicUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "*" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );

  assert.equal(functionUrls.length, 1);
  assert.equal(functionUrls[0].Properties?.AuthType, "AWS_IAM");
  assert.equal(lambdaOriginAccessControls.length, 1);
  assert.equal(cloudfrontInvokePermissions.length, 1);
  assert.equal(cloudfrontInvokeViaUrlPermissions.length, 1);
  assert.equal(publicUrlPermissions.length, 0);
});

test("AppTheorySsrSite keeps read-only SSR origins on Function URL plus lambda OAC", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = template.Resources ?? {};
  const lambdaUrlEntry = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::Lambda::Url");
  const distribution = Object.values(resources).find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const lambdaOriginAccessControl = Object.values(resources).find(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );

  assert.ok(lambdaUrlEntry, "Should synthesize a Lambda Function URL");
  assert.ok(distribution, "Should synthesize a CloudFront distribution");
  assert.ok(lambdaOriginAccessControl, "Should synthesize lambda origin access control");

  const [lambdaUrlLogicalId] = lambdaUrlEntry;
  const origins = distribution.Properties?.DistributionConfig?.Origins ?? [];
  const lambdaOrigin = origins.find((origin) => origin.CustomOriginConfig?.OriginProtocolPolicy === "https-only");

  assert.ok(lambdaOrigin, "Should keep a dedicated HTTPS Lambda URL origin");
  assert.deepEqual(lambdaOrigin.DomainName, {
    "Fn::Select": [
      2,
      {
        "Fn::Split": [
          "/",
          {
            "Fn::GetAtt": [lambdaUrlLogicalId, "FunctionUrl"],
          },
        ],
      },
    ],
  });
  assert.ok(lambdaOrigin.OriginAccessControlId, "Lambda origin should be signed via CloudFront OAC");
});

test("AppTheorySsrSite signs writable ssr-only mode by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", { ssrFunction: fn });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const functions = resources.filter((resource) => resource.Type === "AWS::CloudFront::Function");
  const functionUrls = resources.filter((resource) => resource.Type === "AWS::Lambda::Url");
  const lambdaOriginAccessControls = resources.filter(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );
  const cloudfrontInvokePermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );
  const cloudfrontInvokeViaUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunction" &&
      resource.Properties?.InvokedViaFunctionUrl === true,
  );
  const publicUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "*" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );

  assert.ok(distribution, "Should have CloudFront distribution");
  assert.equal(functions.length, 2);
  assert.equal(functionUrls.length, 1);
  assert.equal(functionUrls[0].Properties?.AuthType, "AWS_IAM");
  assert.equal(lambdaOriginAccessControls.length, 1);
  assert.equal(cloudfrontInvokePermissions.length, 1);
  assert.equal(cloudfrontInvokeViaUrlPermissions.length, 1);
  assert.equal(publicUrlPermissions.length, 0);
  assert.equal(distribution.Properties?.DistributionConfig?.OriginGroups?.Quantity ?? 0, 0);
  assert.equal(distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.length, 2);
  assert.equal(
    distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.CachePolicyId,
    "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  );
  assert.deepEqual(distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.AllowedMethods, [
    "GET",
    "HEAD",
    "OPTIONS",
    "PUT",
    "PATCH",
    "POST",
    "DELETE",
  ]);
});

test("AppTheorySsrSite allows explicit public Function URL compatibility mode", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const functionUrls = resources.filter((resource) => resource.Type === "AWS::Lambda::Url");
  const lambdaOriginAccessControls = resources.filter(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );
  const publicUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "*" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );

  assert.equal(functionUrls.length, 1);
  assert.equal(functionUrls[0].Properties?.AuthType, "NONE");
  assert.equal(lambdaOriginAccessControls.length, 0);
  assert.equal(publicUrlPermissions.length, 1);
});

test("AppTheorySsrSite signs direct SSR write paths by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    ssrPathPatterns: ["/actions/*"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const functionUrls = resources.filter((resource) => resource.Type === "AWS::Lambda::Url");
  const lambdaOriginAccessControls = resources.filter(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );
  const cloudfrontInvokePermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );
  const cloudfrontInvokeViaUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "cloudfront.amazonaws.com" &&
      resource.Properties?.Action === "lambda:InvokeFunction" &&
      resource.Properties?.InvokedViaFunctionUrl === true,
  );
  const publicUrlPermissions = resources.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "*" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );

  assert.equal(functionUrls.length, 1);
  assert.equal(functionUrls[0].Properties?.AuthType, "AWS_IAM");
  assert.equal(lambdaOriginAccessControls.length, 1);
  assert.equal(cloudfrontInvokePermissions.length, 1);
  assert.equal(cloudfrontInvokeViaUrlPermissions.length, 1);
  assert.equal(publicUrlPermissions.length, 0);
});

test("AppTheorySsrSite composes bearer Function URL co-origins without weakening SSR OAC", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const handlerCode = lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });");
  const ssrFn = new lambda.Function(stack, "SsrFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });
  const controlPlaneFn = new lambda.Function(stack, "ControlPlaneFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });
  const trustFn = new lambda.Function(stack, "TrustFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: ssrFn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    bearerFunctionUrlOrigins: [
      {
        function: controlPlaneFn,
        pathPatterns: ["/api/*", "/auth/*", "/setup/*"],
      },
      {
        function: trustFn,
        pathPatterns: ["/.well-known/*", "/attestations/*"],
      },
    ],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = template.Resources ?? {};
  const resourceValues = Object.values(resources);
  const distribution = resourceValues.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const requestFunction = resourceValues.find(
    (resource) =>
      resource.Type === "AWS::CloudFront::Function" &&
      String(resource.Properties?.FunctionConfig?.Comment ?? "").includes("viewer-request"),
  );
  const functionUrls = resourceValues.filter((resource) => resource.Type === "AWS::Lambda::Url");
  const lambdaOriginAccessControls = resourceValues.filter(
    (resource) =>
      resource.Type === "AWS::CloudFront::OriginAccessControl" &&
      resource.Properties?.OriginAccessControlConfig?.OriginAccessControlOriginType === "lambda",
  );
  const publicUrlPermissions = resourceValues.filter(
    (resource) =>
      resource.Type === "AWS::Lambda::Permission" &&
      resource.Properties?.Principal === "*" &&
      resource.Properties?.Action === "lambda:InvokeFunctionUrl",
  );

  assert.ok(distribution, "Should synthesize a CloudFront distribution");
  assert.ok(requestFunction, "Should synthesize the shared SSR viewer-request function");
  assert.equal(lambdaOriginAccessControls.length, 1);
  assert.deepEqual(
    functionUrls.map((resource) => resource.Properties?.AuthType).sort(),
    ["AWS_IAM", "NONE", "NONE"],
  );
  assert.equal(publicUrlPermissions.length, 2);

  const distributionConfig = distribution.Properties?.DistributionConfig ?? {};
  const origins = distributionConfig.Origins ?? [];
  const originsById = new Map(origins.map((origin) => [origin.Id, origin]));
  const cacheBehaviors = distributionConfig.CacheBehaviors ?? [];
  const bearerBehaviorPatterns = [
    "api/*",
    "api",
    "auth/*",
    "auth",
    "setup/*",
    "setup",
    ".well-known/*",
    ".well-known",
    "attestations/*",
    "attestations",
  ];
  const bearerBehaviors = bearerBehaviorPatterns.map((pattern) => {
    const behavior = cacheBehaviors.find((candidate) => candidate.PathPattern === pattern);
    assert.ok(behavior, `Should synthesize bearer Function URL behavior for ${pattern}`);
    return behavior;
  });

  for (const behavior of bearerBehaviors) {
    const targetOrigin = originsById.get(behavior.TargetOriginId);
    assert.ok(targetOrigin, `Should synthesize origin for ${behavior.PathPattern}`);
    assert.equal(targetOrigin.CustomOriginConfig?.OriginProtocolPolicy, "https-only");
    assert.equal(targetOrigin.OriginAccessControlId, undefined);
    assert.deepEqual(behavior.AllowedMethods, ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]);
    assert.equal(behavior.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    assert.equal(behavior.OriginRequestPolicyId, "b689b0a8-53d0-40ab-baf2-68738e2966ac");
    assert.equal(behavior.FunctionAssociations?.length, 2);
  }

  const functionCode = String(requestFunction.Properties?.FunctionCode ?? "");
  assert.ok(functionCode.includes("'/api'"));
  assert.ok(functionCode.includes("'/.well-known'"));
  assert.match(functionCode, /x-apptheory-original-host/);
  assert.match(functionCode, /x-request-id/);
});

test("AppTheorySsrSite rejects overlapping bearer Function URL co-origin paths", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const handlerCode = lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });");
  const ssrFn = new lambda.Function(stack, "SsrFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });
  const apiFn = new lambda.Function(stack, "ApiFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: ssrFn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        bearerFunctionUrlOrigins: [
          {
            function: apiFn,
            pathPatterns: ["/assets/*"],
          },
        ],
      }),
    /AppTheorySsrSite received overlapping path pattern "assets\/\*" for direct S3 paths and bearer Function URL co-origin 1/,
  );
});

test("AppTheorySsrSite rejects duplicate bearer Function URL co-origin paths across origins", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const handlerCode = lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });");
  const ssrFn = new lambda.Function(stack, "SsrFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });
  const apiFn = new lambda.Function(stack, "ApiFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });
  const trustFn = new lambda.Function(stack, "TrustFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: handlerCode,
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: ssrFn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        bearerFunctionUrlOrigins: [
          {
            function: apiFn,
            pathPatterns: ["/api/*"],
          },
          {
            function: trustFn,
            pathPatterns: ["/api"],
          },
        ],
      }),
    /AppTheorySsrSite received overlapping path pattern "api" for bearer Function URL co-origin 1 and bearer Function URL co-origin 2/,
  );
});

test("AppTheorySsrSite defaults to FaceTheory-safe SSR origin request headers", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", { ssrFunction: fn });

  const template = assertions.Template.fromStack(stack).toJSON();
  const originRequestPolicies = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::CloudFront::OriginRequestPolicy",
  );
  const ssrPolicy = originRequestPolicies.find(
    (resource) => resource.Properties?.OriginRequestPolicyConfig?.CookiesConfig?.CookieBehavior === "all",
  );
  const htmlPolicy = originRequestPolicies.find(
    (resource) => resource.Properties?.OriginRequestPolicyConfig?.CookiesConfig?.CookieBehavior === "none",
  );

  assert.equal(originRequestPolicies.length, 2);
  assert.ok(ssrPolicy, "Should keep an SSR origin request policy that forwards cookies");
  assert.ok(htmlPolicy, "Should synthesize a public HTML origin request policy without cookies");

  const headers = [...(ssrPolicy.Properties?.OriginRequestPolicyConfig?.HeadersConfig?.Headers ?? [])].sort();
  const htmlHeaders = [...(htmlPolicy.Properties?.OriginRequestPolicyConfig?.HeadersConfig?.Headers ?? [])].sort();

  assert.deepEqual(headers, [
    "cloudfront-forwarded-proto",
    "cloudfront-viewer-address",
    "x-apptheory-original-host",
    "x-apptheory-original-uri",
    "x-facetheory-original-host",
    "x-facetheory-original-uri",
    "x-request-id",
  ]);
  assert.deepEqual(htmlHeaders, headers, "HTML and SSR policies should share the safe edge header contract");
  assert.ok(!headers.includes("host"), "Should not forward raw host to Function URL origin");
  assert.ok(!headers.includes("x-forwarded-proto"), "Should not forward x-forwarded-proto to Function URL origin");
});

test("AppTheorySsrSite strips viewer-supplied tenant headers by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", { ssrFunction: fn });

  const resources = Object.values(assertions.Template.fromStack(stack).toJSON().Resources ?? {});
  const viewerRequestFunction = resources.find(
    (resource) =>
      resource.Type === "AWS::CloudFront::Function" &&
      String(resource.Properties?.FunctionConfig?.Comment ?? "").includes("viewer-request"),
  );

  assert.ok(viewerRequestFunction, "Should synthesize a viewer-request CloudFront Function");
  assert.match(viewerRequestFunction.Properties?.FunctionCode ?? "", /'x-tenant-id'/);
});

test("AppTheorySsrSite rejects tenant-like ssrForwardHeaders without compatibility mode", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        ssrForwardHeaders: ["x-facetheory-tenant"],
      }),
    /allowViewerTenantHeaders=true/,
  );
});

test("AppTheorySsrSite allows explicit tenant-header passthrough compatibility mode", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    allowViewerTenantHeaders: true,
    ssrForwardHeaders: [" X-FaceTheory-Tenant ", "x-facetheory-tenant"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const originRequestPolicies = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::CloudFront::OriginRequestPolicy",
  );
  const ssrPolicy = originRequestPolicies.find(
    (resource) => resource.Properties?.OriginRequestPolicyConfig?.CookiesConfig?.CookieBehavior === "all",
  );
  const viewerRequestFunction = Object.values(template.Resources ?? {}).find(
    (resource) =>
      resource.Type === "AWS::CloudFront::Function" &&
      String(resource.Properties?.FunctionConfig?.Comment ?? "").includes("viewer-request"),
  );

  const headers = [...(ssrPolicy.Properties?.OriginRequestPolicyConfig?.HeadersConfig?.Headers ?? [])].sort();

  assert.deepEqual(headers, [
    "cloudfront-forwarded-proto",
    "cloudfront-viewer-address",
    "x-apptheory-original-host",
    "x-apptheory-original-uri",
    "x-facetheory-original-host",
    "x-facetheory-original-uri",
    "x-facetheory-tenant",
    "x-request-id",
    "x-tenant-id",
  ]);
  assert.doesNotMatch(viewerRequestFunction.Properties?.FunctionCode ?? "", /'x-tenant-id'/);
});

test("AppTheorySsrSite wires first-class ISR HTML store and metadata resources", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const htmlStoreBucket = new s3.Bucket(stack, "HtmlStoreBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  });

  const isrMetadataTable = new dynamodb.Table(stack, "IsrMetadataTable", {
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    timeToLiveAttribute: "ttl",
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    htmlStoreBucket,
    htmlStoreKeyPrefix: "isr-pages",
    isrMetadataTable,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const lambdaFunctions = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::Lambda::Function",
  );
  assert.equal(lambdaFunctions.length, 1);

  const envVars = lambdaFunctions[0].Properties?.Environment?.Variables ?? {};
  assert.equal(envVars.FACETHEORY_ISR_PREFIX, "isr-pages");
  assert.ok(envVars.FACETHEORY_ISR_BUCKET, "Should wire FACETHEORY_ISR_BUCKET");
  assert.ok(envVars.APPTHEORY_CACHE_TABLE_NAME, "Should wire APPTHEORY_CACHE_TABLE_NAME");
  assert.ok(envVars.FACETHEORY_CACHE_TABLE_NAME, "Should wire FACETHEORY_CACHE_TABLE_NAME");
  assert.ok(envVars.CACHE_TABLE_NAME, "Should wire CACHE_TABLE_NAME");
  assert.ok(envVars.CACHE_TABLE, "Should wire CACHE_TABLE");

  const iamPolicies = Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === "AWS::IAM::Policy",
  );
  const policyJson = JSON.stringify(iamPolicies);
  assert.match(policyJson, /s3:GetObject/);
  assert.match(policyJson, /s3:PutObject/);
  assert.match(policyJson, /dynamodb:GetItem/);
  assert.match(policyJson, /dynamodb:PutItem/);
});

test("AppTheorySsrSite ssg-isr mode uses the html store as the primary HTML origin", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const htmlStoreBucket = new s3.Bucket(stack, "HtmlStoreBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    htmlStoreBucket,
    htmlStoreKeyPrefix: "isr-pages",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = template.Resources ?? {};
  const distribution = Object.values(resources).find((resource) => resource.Type === "AWS::CloudFront::Distribution");

  assert.ok(distribution, "Should have CloudFront distribution");

  const origins = distribution.Properties?.DistributionConfig?.Origins ?? [];
  const htmlOrigin = origins.find((origin) => origin.OriginPath === "/isr-pages");
  const originGroupMembers =
    distribution.Properties?.DistributionConfig?.OriginGroups?.Items?.[0]?.Members?.Items ?? [];

  assert.ok(htmlOrigin, "Should synthesize an HTML S3 origin with the html store origin path");
  assert.equal(originGroupMembers[0]?.OriginId, htmlOrigin?.Id);
});

test("AppTheorySsrSite ssg-isr mode creates a stable public HTML cache key", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = template.Resources ?? {};
  const distribution = Object.values(resources).find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const cachePolicyEntry = findCachePolicyEntry(resources, "FaceTheory HTML cache policy");

  assert.ok(distribution, "Should have CloudFront distribution");
  assert.ok(cachePolicyEntry, "Should synthesize a custom HTML cache policy");

  const [cachePolicyLogicalId, cachePolicy] = cachePolicyEntry;
  const headers = [
    ...(cachePolicy.Properties?.CachePolicyConfig?.ParametersInCacheKeyAndForwardedToOrigin?.HeadersConfig?.Headers ?? []),
  ].sort();

  assert.equal(cachePolicy.Properties?.CachePolicyConfig?.ParametersInCacheKeyAndForwardedToOrigin?.CookiesConfig?.CookieBehavior, "none");
  assert.equal(cachePolicy.Properties?.CachePolicyConfig?.ParametersInCacheKeyAndForwardedToOrigin?.QueryStringsConfig?.QueryStringBehavior, "all");
  assert.deepEqual(headers, [
    "x-apptheory-original-host",
    "x-facetheory-original-host",
  ]);
  assert.deepEqual(distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.CachePolicyId, {
    Ref: cachePolicyLogicalId,
  });
});

test("AppTheorySsrSite ssg-isr mode allows explicit tenant headers into the public HTML cache key only in compatibility mode", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    allowViewerTenantHeaders: true,
    ssrForwardHeaders: ["x-facetheory-tenant"],
  });

  const resources = assertions.Template.fromStack(stack).toJSON().Resources ?? {};
  const cachePolicyEntry = findCachePolicyEntry(resources, "FaceTheory HTML cache policy");

  assert.ok(cachePolicyEntry, "Should synthesize a custom HTML cache policy");

  const [, cachePolicy] = cachePolicyEntry;
  const headers = [
    ...(cachePolicy.Properties?.CachePolicyConfig?.ParametersInCacheKeyAndForwardedToOrigin?.HeadersConfig?.Headers ?? []),
  ].sort();

  assert.deepEqual(headers, [
    "x-apptheory-original-host",
    "x-facetheory-original-host",
    "x-facetheory-tenant",
    "x-tenant-id",
  ]);
});

test("AppTheorySsrSite ssg-isr mode synthesizes origin-group fallback and edge rewrite", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const resourceEntries = Object.entries(template.Resources ?? {});
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const functions = resources.filter((resource) => resource.Type === "AWS::CloudFront::Function");
  const requestFunction = functions.find((resource) =>
    String(resource.Properties?.FunctionConfig?.Comment ?? "").includes("viewer-request"),
  );
  const cachePolicyEntry = findCachePolicyEntry(template.Resources ?? {}, "FaceTheory HTML cache policy");
  const htmlOriginRequestPolicyEntry = resourceEntries.find(
    ([, resource]) =>
      resource.Type === "AWS::CloudFront::OriginRequestPolicy" &&
      resource.Properties?.OriginRequestPolicyConfig?.CookiesConfig?.CookieBehavior === "none",
  );

  assert.ok(distribution, "Should have CloudFront distribution");
  assert.ok(requestFunction, "Should have SSR viewer-request function");
  assert.ok(cachePolicyEntry, "Should synthesize the shared HTML cache policy");
  assert.ok(htmlOriginRequestPolicyEntry, "Should synthesize the shared HTML origin request policy");
  assert.equal(distribution.Properties?.DistributionConfig?.OriginGroups?.Quantity, 1);
  assert.equal(distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.length, 2);
  assert.deepEqual(distribution.Properties?.DistributionConfig?.DefaultCacheBehavior?.AllowedMethods, [
    "GET",
    "HEAD",
    "OPTIONS",
  ]);

  const originGroupMembers =
    distribution.Properties?.DistributionConfig?.OriginGroups?.Items?.[0]?.Members?.Items ?? [];
  const fallbackStatusCodes =
    distribution.Properties?.DistributionConfig?.OriginGroups?.Items?.[0]?.FailoverCriteria?.StatusCodes?.Items ?? [];
  const cacheBehaviors = distribution.Properties?.DistributionConfig?.CacheBehaviors ?? [];
  const origins = distribution.Properties?.DistributionConfig?.Origins ?? [];
  const originsById = new Map(origins.map((origin) => [origin.Id, origin]));
  const hydrationBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "_facetheory/data/*");
  const hydrationRootBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "_facetheory/data");
  const ssrDataBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "_facetheory/ssr-data/*");
  const ssrDataRootBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "_facetheory/ssr-data");

  assert.equal(originGroupMembers.length, 2);
  assert.deepEqual(fallbackStatusCodes, [403, 404]);
  assert.ok(hydrationBehavior, "Should keep FaceTheory hydration path on direct S3 behavior");
  assert.ok(hydrationRootBehavior, "Should keep FaceTheory hydration root on direct S3 behavior");
  assert.ok(ssrDataBehavior, "Should route FaceTheory SSR data sidecar path to direct SSR behavior");
  assert.ok(ssrDataRootBehavior, "Should route FaceTheory SSR data sidecar root to direct SSR behavior");

  const hydrationOrigin = originsById.get(hydrationBehavior.TargetOriginId);
  const ssrDataOrigin = originsById.get(ssrDataBehavior.TargetOriginId);

  assert.ok(hydrationOrigin?.S3OriginConfig, "FaceTheory SSG hydration sidecars should stay on S3");
  assert.equal(ssrDataOrigin?.CustomOriginConfig?.OriginProtocolPolicy, "https-only");
  assert.ok(ssrDataOrigin?.OriginAccessControlId, "FaceTheory SSR data sidecars should keep Lambda OAC");
  assert.deepEqual(ssrDataBehavior.AllowedMethods, ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]);
  assert.equal(ssrDataBehavior.CachePolicyId, cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId);
  assert.ok(ssrDataBehavior.OriginRequestPolicyId, "SSR data sidecars should use the Lambda origin request policy");

  const functionCode = String(requestFunction.Properties?.FunctionCode ?? "");
  assert.match(functionCode, /x-apptheory-original-host/);
  assert.match(functionCode, /x-apptheory-original-uri/);
  assert.match(functionCode, /x-facetheory-original-host/);
  assert.match(functionCode, /x-facetheory-original-uri/);
  assert.match(functionCode, /event\.context\.requestId/);
  assert.match(functionCode, /index\.html/);
  assert.match(functionCode, /'\/_facetheory\/data'/);
  assert.match(functionCode, /'\/_facetheory\/ssr-data'/);
});

test("AppTheorySsrSite rejects direct S3 ownership of reserved SSR data sidecars", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        directS3PathPatterns: ["/_facetheory/ssr-data/*"],
      }),
    /AppTheorySsrSite received overlapping path pattern "_facetheory\/ssr-data\/\*" for direct S3 paths and direct SSR paths/,
  );
});

test("AppTheorySsrSite rejects broader direct S3 ownership of reserved SSR data sidecars", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        directS3PathPatterns: ["/_facetheory/*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/\*" and "_facetheory\/ssr-data\/\*" for direct S3 paths and direct SSR paths/,
  );
});

test("AppTheorySsrSite rejects broader static HTML ownership of reserved SSR data sidecars", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        staticPathPatterns: ["/_facetheory/*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/data\/\*" and "_facetheory\/\*" for direct S3 paths and static HTML paths/,
  );
});

test("AppTheorySsrSite rejects nested static HTML ownership of reserved SSR data sidecars", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        staticPathPatterns: ["/_facetheory/ssr-data/private/*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/ssr-data\/private\/\*" and "_facetheory\/ssr-data\/\*" for static HTML paths and direct SSR paths/,
  );
});

test("AppTheorySsrSite rejects question-mark wildcard shadows of reserved SSR data sidecars", () => {
  const createStack = (id) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, id);
    const fn = new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
    });

    return { fn, stack };
  };

  const directS3AnySuffix = createStack("DirectS3AnySuffixStack");
  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(directS3AnySuffix.stack, "Site", {
        ssrFunction: directS3AnySuffix.fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        directS3PathPatterns: ["/_facetheory/ssr-data?*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/ssr-data\?\*" and "_facetheory\/ssr-data\/\*" for direct S3 paths and direct SSR paths/,
  );

  const staticAnySuffix = createStack("StaticAnySuffixStack");
  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(staticAnySuffix.stack, "Site", {
        ssrFunction: staticAnySuffix.fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        staticPathPatterns: ["/_facetheory/ssr-data?*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/ssr-data\?\*" and "_facetheory\/ssr-data\/\*" for static HTML paths and direct SSR paths/,
  );

  const directS3SegmentCharacter = createStack("DirectS3SegmentCharacterStack");
  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(directS3SegmentCharacter.stack, "Site", {
        ssrFunction: directS3SegmentCharacter.fn,
        mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
        directS3PathPatterns: ["/_facetheory/ssr-dat?/*"],
      }),
    /AppTheorySsrSite received overlapping path patterns "_facetheory\/ssr-dat\?\/\*" and "_facetheory\/ssr-data\/\*" for direct S3 paths and direct SSR paths/,
  );
});

test("AppTheorySsrSite expands static HTML and direct SSR path patterns for root plus nested routes", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    staticPathPatterns: ["/marketing/*"],
    ssrPathPatterns: ["/actions/*"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});
  const resourceEntries = Object.entries(template.Resources ?? {});
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const functions = resources.filter((resource) => resource.Type === "AWS::CloudFront::Function");
  const requestFunction = functions.find((resource) =>
    String(resource.Properties?.FunctionConfig?.Comment ?? "").includes("viewer-request"),
  );
  const cachePolicyEntry = findCachePolicyEntry(template.Resources ?? {}, "FaceTheory HTML cache policy");
  const htmlOriginRequestPolicyEntry = resourceEntries.find(
    ([, resource]) =>
      resource.Type === "AWS::CloudFront::OriginRequestPolicy" &&
      resource.Properties?.OriginRequestPolicyConfig?.CookiesConfig?.CookieBehavior === "none",
  );

  assert.ok(distribution, "Should have CloudFront distribution");
  assert.ok(requestFunction, "Should have SSR viewer-request function");
  assert.ok(cachePolicyEntry, "Should synthesize the shared HTML cache policy");
  assert.ok(htmlOriginRequestPolicyEntry, "Should synthesize the shared HTML origin request policy");

  const cacheBehaviors = distribution.Properties?.DistributionConfig?.CacheBehaviors ?? [];
  const marketingRootBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "marketing");
  const marketingWildcardBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "marketing/*");
  const actionsRootBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "actions");
  const actionsWildcardBehavior = cacheBehaviors.find((behavior) => behavior.PathPattern === "actions/*");

  assert.ok(marketingRootBehavior, "Should synthesize exact-root S3 behavior for static HTML sections");
  assert.ok(marketingWildcardBehavior, "Should synthesize wildcard S3 behavior for static HTML sections");
  assert.ok(actionsRootBehavior, "Should synthesize exact-root Lambda behavior for direct SSR paths");
  assert.ok(actionsWildcardBehavior, "Should synthesize wildcard Lambda behavior for direct SSR paths");
  assert.deepEqual(marketingRootBehavior.AllowedMethods, ["GET", "HEAD", "OPTIONS"]);
  assert.deepEqual(marketingRootBehavior.CachePolicyId, { Ref: cachePolicyEntry[0] });
  assert.deepEqual(marketingWildcardBehavior.CachePolicyId, { Ref: cachePolicyEntry[0] });
  assert.deepEqual(marketingRootBehavior.OriginRequestPolicyId, { Ref: htmlOriginRequestPolicyEntry[0] });
  assert.deepEqual(marketingWildcardBehavior.OriginRequestPolicyId, { Ref: htmlOriginRequestPolicyEntry[0] });
  assert.deepEqual(actionsWildcardBehavior.AllowedMethods, ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]);
  assert.ok(actionsWildcardBehavior.OriginRequestPolicyId, "Direct SSR paths should keep the Lambda origin contract");

  const functionCode = String(requestFunction.Properties?.FunctionCode ?? "");
  assert.match(functionCode, /lambdaPassthroughPrefixes/);
  assert.match(functionCode, /\/actions/);
  assert.doesNotMatch(functionCode, /\/marketing'/);
});

test("AppTheorySsrSite defaults to FaceTheory CDN response headers and origin cache-control policies", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const templateResources = template.Resources ?? {};
  const resources = Object.values(templateResources);
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const responseHeadersPolicies = resources.filter((resource) => resource.Type === "AWS::CloudFront::ResponseHeadersPolicy");

  assert.ok(distribution, "Should have CloudFront distribution");
  assert.equal(responseHeadersPolicies.length, 1);

  const [policy] = responseHeadersPolicies;
  const responseHeadersConfig = policy.Properties?.ResponseHeadersPolicyConfig ?? {};
  const securityHeaders = responseHeadersConfig.SecurityHeadersConfig ?? {};
  const customHeaders = responseHeadersConfig.CustomHeadersConfig?.Items ?? [];

  assert.equal(securityHeaders.StrictTransportSecurity?.Preload, true);
  assert.equal(securityHeaders.ContentTypeOptions?.Override, true);
  assert.equal(securityHeaders.FrameOptions?.FrameOption, "DENY");
  assert.equal(securityHeaders.ReferrerPolicy?.ReferrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(securityHeaders.XSSProtection?.Override, true);
  assert.ok(
    customHeaders.some(
      (header) =>
        header.Header === "permissions-policy" &&
        header.Value === "camera=(), microphone=(), geolocation=()",
    ),
    "Should include restrictive permissions-policy header",
  );

  const defaultBehavior = distribution.Properties?.DistributionConfig?.DefaultCacheBehavior ?? {};
  const staticBehaviors = distribution.Properties?.DistributionConfig?.CacheBehaviors ?? [];
  const htmlCachePolicyEntry = findCachePolicyEntry(templateResources, "FaceTheory HTML cache policy");
  const staticAssetsCachePolicyEntry = findCachePolicyEntry(templateResources, "AppTheory direct S3 asset/data");

  assert.ok(htmlCachePolicyEntry, "Should synthesize a dedicated HTML cache policy for the default HTML behavior");
  assert.ok(staticAssetsCachePolicyEntry, "Should synthesize a dedicated direct-S3 static asset cache policy");
  assert.deepEqual(defaultBehavior.CachePolicyId, { Ref: htmlCachePolicyEntry[0] });
  assert.ok(defaultBehavior.ResponseHeadersPolicyId, "Default behavior should use response headers policy");

  const staticCacheConfig = staticAssetsCachePolicyEntry[1].Properties?.CachePolicyConfig ?? {};
  const staticCacheKey = staticCacheConfig.ParametersInCacheKeyAndForwardedToOrigin ?? {};
  assert.equal(staticCacheConfig.MinTTL, 0);
  assert.equal(staticCacheConfig.DefaultTTL, 86400);
  assert.equal(staticCacheConfig.MaxTTL, 31536000);
  assert.equal(staticCacheKey.HeadersConfig?.HeaderBehavior, "none");
  assert.equal(staticCacheKey.CookiesConfig?.CookieBehavior, "none");
  assert.equal(staticCacheKey.QueryStringsConfig?.QueryStringBehavior, "none");
  assert.equal(staticCacheKey.EnableAcceptEncodingBrotli, true);
  assert.equal(staticCacheKey.EnableAcceptEncodingGzip, true);

  for (const behavior of staticBehaviors) {
    if (String(behavior.PathPattern ?? "").startsWith("_facetheory/ssr-data")) {
      assert.equal(behavior.CachePolicyId, cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId);
      assert.ok(behavior.OriginRequestPolicyId, "SSR data sidecars should use the Lambda origin request policy");
      continue;
    }
    assert.deepEqual(behavior.CachePolicyId, { Ref: staticAssetsCachePolicyEntry[0] });
    assert.equal(behavior.OriginRequestPolicyId, undefined, "Direct S3 behaviors should not forward viewer headers");
    assert.deepEqual(
      behavior.ResponseHeadersPolicyId,
      defaultBehavior.ResponseHeadersPolicyId,
      "Static behaviors should share the default response headers policy",
    );
  }
});

test("AppTheorySsrSite rejects disallowed SSR origin request headers", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: fn,
        ssrForwardHeaders: ["host", " x-forwarded-proto "],
      }),
    /AppTheorySsrSite disallows ssrForwardHeaders: host, x-forwarded-proto/,
  );
});

// ============================================================================
// AppTheoryRestApiRouter tests
// ============================================================================

test("AppTheoryRestApiRouter (multi-Lambda) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const sseFn = new lambda.Function(stack, "SseFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'sse' });"),
  });

  const graphqlFn = new lambda.Function(stack, "GraphqlFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'graphql' });"),
  });

  const apiFn = new lambda.Function(stack, "ApiFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'api' });"),
  });

  const inventoryFn = new lambda.Function(stack, "InventoryFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'inventory' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-router-test",
  });

  // SSE streaming
  router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });

  // GraphQL
  router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);

  // Proxy catch-all
  router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);

  // Inventory-driven path (proof of multi-Lambda scaling)
  router.addLambdaIntegration("/inventory/{id}", ["GET", "PUT", "DELETE"], inventoryFn);

  const template = assertions.Template.fromStack(stack).toJSON();
  assertStreamingRouteStageVariable(template, "GET", "/sse");
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-multi-lambda", template);
  } else {
    expectSnapshot("rest-api-router-multi-lambda", template);
  }
});

test("AppTheoryRestApiRouter omits REST compression configuration by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-router-compression-default",
  });
  router.addLambdaIntegration("/{proxy+}", ["ANY"], fn);

  const template = assertions.Template.fromStack(stack).toJSON();
  const restApi = singleRestApiResource(template);
  assert.equal(
    Object.prototype.hasOwnProperty.call(restApi.Properties ?? {}, "MinimumCompressionSize"),
    false,
    "Should not synthesize a compression threshold unless configured",
  );
});

test("AppTheoryRestApiRouter maps REST compression threshold when configured", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-router-compression-enabled",
    minimumCompressionSize: 1024,
  });
  router.addLambdaIntegration("/{proxy+}", ["ANY"], fn);

  const template = assertions.Template.fromStack(stack).toJSON();
  const restApi = singleRestApiResource(template);
  assert.equal(restApi.Properties?.MinimumCompressionSize, 1024);
});

test("AppTheoryRestApiRouter can suppress test-invoke-stage permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const sseFn = new lambda.Function(stack, "SseFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'sse' });"),
  });

  const graphqlFn = new lambda.Function(stack, "GraphqlFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'graphql' });"),
  });

  const apiFn = new lambda.Function(stack, "ApiFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'api' });"),
  });

  const inventoryFn = new lambda.Function(stack, "InventoryFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'inventory' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-router-no-test-invoke",
    allowTestInvoke: false,
  });

  router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });
  router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);
  router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);
  router.addLambdaIntegration("/inventory/{id}", ["GET", "PUT", "DELETE"], inventoryFn);

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 6, "Should synthesize one permission per method/path pair without test invoke");
  assertNoTestInvokeStagePermissions(template);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-multi-lambda-no-test-invoke", template);
  } else {
    expectSnapshot("rest-api-router-multi-lambda-no-test-invoke", template);
  }
});

test("AppTheoryRestApiRouter can use API-scoped invoke permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const sseFn = new lambda.Function(stack, "SseFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'sse' });"),
  });

  const graphqlFn = new lambda.Function(stack, "GraphqlFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'graphql' });"),
  });

  const apiFn = new lambda.Function(stack, "ApiFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'api' });"),
  });

  const inventoryFn = new lambda.Function(stack, "InventoryFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'inventory' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-router-api-scoped",
    scopePermissionToMethod: false,
  });

  router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });
  router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);
  router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);
  router.addLambdaIntegration("/inventory/{id}", ["GET", "PUT", "DELETE"], inventoryFn);

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 4, "Should synthesize one API-scoped permission per Lambda");
  assertNoTestInvokeStagePermissions(template);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-multi-lambda-api-scoped-permissions", template);
  } else {
    expectSnapshot("rest-api-router-multi-lambda-api-scoped-permissions", template);
  }
});

test("AppTheoryRestApiRouter (streaming parity) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-streaming-test",
  });

  // Add a streaming route
  router.addLambdaIntegration("/sse", ["GET"], fn, { streaming: true });
  router.addLambdaIntegration("/events", ["GET"], fn, { streaming: true });

  // Add a non-streaming route for comparison
  router.addLambdaIntegration("/api", ["GET", "POST"], fn);

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify the streaming routes have the correct configuration
  const methods = template.Resources;
  let streamingMethodCount = 0;

  for (const [key, resource] of Object.entries(methods)) {
    if (resource.Type === "AWS::ApiGateway::Method") {
      const integration = resource.Properties?.Integration;
      if (integration?.ResponseTransferMode === "STREAM") {
        streamingMethodCount++;
        // Verify URI contains /response-streaming-invocations
        const uri = integration.Uri;
        if (uri && uri["Fn::Join"]) {
          const uriParts = uri["Fn::Join"][1];
          const hasStreamingUri = uriParts.some(
            (p) => typeof p === "string" && p.includes("/response-streaming-invocations"),
          );
          assert.ok(hasStreamingUri, `Method ${key} should have streaming invocation URI`);
        }
        // Verify timeout is 900000ms (15 minutes)
        assert.equal(integration.TimeoutInMillis, 900000, `Method ${key} should have 15min timeout`);
      }
    }
  }

  assert.ok(streamingMethodCount >= 2, "Should have at least 2 streaming methods");
  assertStreamingRouteStageVariable(template, "GET", "/sse");
  assertStreamingRouteStageVariable(template, "GET", "/events");
  assert.equal(restApiStageVariables(template)[restApiStreamingRouteStageVariableName("GET", "/api")], undefined);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-streaming", template);
  } else {
    expectSnapshot("rest-api-router-streaming", template);
  }
});

test("AppTheoryRestApiRouter (stage options) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-stage-test",
    stage: {
      stageName: "dev",
      accessLogging: true,
      accessLogRetention: logs.RetentionDays.ONE_WEEK,
      detailedMetrics: true,
      throttlingRateLimit: 100,
      throttlingBurstLimit: 200,
    },
  });

  router.addLambdaIntegration("/api/{proxy+}", ["ANY"], fn);

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-stage", template);
  } else {
    expectSnapshot("rest-api-router-stage", template);
  }
});

test("AppTheoryRestApiRouter (domain + Route53) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "api.example.com",
    hostedZone: zone,
  });

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-domain-test",
    domain: {
      domainName: "api.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
  });

  router.addLambdaIntegration("/{proxy+}", ["ANY"], fn);

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-domain", template);
  } else {
    expectSnapshot("rest-api-router-domain", template);
  }
});

// ============================================================================
// AppTheoryPathRoutedFrontend tests
// ============================================================================

const s3 = require("aws-cdk-lib/aws-s3");

test("AppTheoryPathRoutedFrontend (basic) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("path-routed-frontend-basic", template);
  } else {
    expectSnapshot("path-routed-frontend-basic", template);
  }
});

test("AppTheoryPathRoutedFrontend (api origin with path) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com/prod",
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify originPath is applied to the API origin
  const distributions = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::Distribution",
  );
  assert.ok(distributions.length >= 1, "Should have CloudFront Distribution");

  const distribution = distributions[0][1];
  const origins = distribution.Properties?.DistributionConfig?.Origins ?? [];
  const apiOrigin = origins.find((o) => o.DomainName === "api.example.com");
  assert.ok(apiOrigin, "Should have API origin configured");
  assert.equal(apiOrigin.OriginPath, "/prod", "API origin should have originPath '/prod'");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("path-routed-frontend-api-origin-path", template);
  } else {
    expectSnapshot("path-routed-frontend-api-origin-path", template);
  }
});

test("AppTheoryPathRoutedFrontend (multi-SPA) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const clientBucket = new s3.Bucket(stack, "ClientBucket");
  const authBucket = new s3.Bucket(stack, "AuthBucket");

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    spaOrigins: [
      { bucket: clientBucket, pathPattern: "/l/*" },
      { bucket: authBucket, pathPattern: "/auth/*" },
    ],
    apiBypassPaths: [{ pathPattern: "/auth/wallet/*" }],
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify CloudFront Function is created
  const functions = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::Function",
  );
  assert.ok(functions.length >= 1, "Should have at least 1 CloudFront Function for SPA rewrite");

  // Verify additional behaviors are configured
  const distributions = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::Distribution",
  );
  assert.ok(distributions.length >= 1, "Should have CloudFront Distribution");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("path-routed-frontend-multi-spa", template);
  } else {
    expectSnapshot("path-routed-frontend-multi-spa", template);
  }
});

test("AppTheoryPathRoutedFrontend normalizes Go jsii SPA rewrite enum values", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const clientBucket = new s3.Bucket(stack, "ClientBucket");

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    spaOrigins: [{ bucket: clientBucket, pathPattern: "/l/*", rewriteMode: "SPA" }],
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const functions = Object.values(template.Resources).filter(
    (resource) => resource.Type === "AWS::CloudFront::Function",
  );
  assert.equal(functions.length, 1, "Should attach the SPA rewrite function for uppercase SPA");
  const code = String(functions[0].Properties?.FunctionCode ?? "");
  assert.match(code, /rewriteMode: 'spa'/);
  assert.doesNotMatch(code, /rewriteMode: 'SPA'/);
});

test("AppTheoryPathRoutedFrontend normalizes Go jsii NONE rewrite enum values", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const clientBucket = new s3.Bucket(stack, "ClientBucket");

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    spaOrigins: [{ bucket: clientBucket, pathPattern: "/l/*", rewriteMode: "NONE" }],
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const functions = Object.values(template.Resources).filter(
    (resource) => resource.Type === "AWS::CloudFront::Function",
  );
  assert.equal(functions.length, 0, "Should not attach a rewrite function for uppercase NONE");
});

test("AppTheoryPathRoutedFrontend (domain + Route53) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const clientBucket = new s3.Bucket(stack, "ClientBucket");
  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "app.example.com",
    hostedZone: zone,
  });

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    spaOrigins: [{ bucket: clientBucket, pathPattern: "/l/*" }],
    domain: {
      domainName: "app.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify Route53 A record is created
  const aRecords = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::Route53::RecordSet",
  );
  assert.ok(aRecords.length >= 1, "Should have Route53 A record");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("path-routed-frontend-domain", template);
  } else {
    expectSnapshot("path-routed-frontend-domain", template);
  }
});

test("AppTheoryPathRoutedFrontend auto-creates hosted-zone certificate only in explicit us-east-1 stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const clientBucket = new s3.Bucket(stack, "ClientBucket");
  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
    apiOriginUrl: "https://api.example.com",
    spaOrigins: [{ bucket: clientBucket, pathPattern: "/l/*" }],
    domain: {
      domainName: "app.example.com",
      hostedZone: zone,
    },
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const certificates = resourcesOfType(template, "AWS::CertificateManager::Certificate");
  assert.equal(certificates.length, 1, "Should synthesize one non-deprecated ACM certificate resource");
  assert.equal(certificates[0].Properties?.DomainName, "app.example.com");
});

test("AppTheoryPathRoutedFrontend rejects hosted-zone certificate creation for environment-agnostic stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const clientBucket = new s3.Bucket(stack, "ClientBucket");
  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  assert.throws(
    () =>
      new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
        apiOriginUrl: "https://api.example.com",
        spaOrigins: [{ bucket: clientBucket, pathPattern: "/l/*" }],
        domain: {
          domainName: "app.example.com",
          hostedZone: zone,
        },
        enableLogging: false,
      }),
    /AppTheoryPathRoutedFrontend cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is unresolved\. Provide domain\.certificate or domain\.certificateArn/,
  );
});

// ============================================================================
// AppTheoryMediaCdn tests
// ============================================================================

test("AppTheoryMediaCdn (basic) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    comment: "Basic media CDN",
    enableLogging: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-basic", template);
  } else {
    expectSnapshot("media-cdn-basic", template);
  }
});

test("AppTheoryMediaCdn (existing bucket) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const existingBucket = new s3.Bucket(stack, "ExistingBucket");

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    bucket: existingBucket,
    enableLogging: false,
    comment: "Media CDN with existing bucket",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-existing-bucket", template);
  } else {
    expectSnapshot("media-cdn-existing-bucket", template);
  }
});

test("AppTheoryMediaCdn (domain + Route53) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "media.example.com",
    hostedZone: zone,
  });

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    domain: {
      domainName: "media.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
    enableLogging: false,
    comment: "Media CDN with custom domain",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify Route53 A record is created
  const aRecords = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::Route53::RecordSet",
  );
  assert.ok(aRecords.length >= 1, "Should have Route53 A record");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-domain", template);
  } else {
    expectSnapshot("media-cdn-domain", template);
  }
});

test("AppTheoryMediaCdn auto-creates hosted-zone certificate only in explicit us-east-1 stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    domain: {
      domainName: "media.example.com",
      hostedZone: zone,
    },
    enableLogging: false,
    comment: "Media CDN with auto-created hosted-zone certificate",
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const certificates = resourcesOfType(template, "AWS::CertificateManager::Certificate");
  assert.equal(certificates.length, 1, "Should synthesize one non-deprecated ACM certificate resource");
  assert.equal(certificates[0].Properties?.DomainName, "media.example.com");
});

test("AppTheoryMediaCdn rejects hosted-zone certificate creation for environment-agnostic stacks", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });

  assert.throws(
    () =>
      new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
        domain: {
          domainName: "media.example.com",
          hostedZone: zone,
        },
        enableLogging: false,
      }),
    /AppTheoryMediaCdn cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is unresolved\. Provide domain\.certificate or domain\.certificateArn/,
  );
});

test("AppTheoryMediaCdn (private media with key group) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  // Create a public key and key group for testing
  const publicKey = new cloudfront.PublicKey(stack, "TestPublicKey", {
    encodedKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAudf8/iNkQgdvjEdm6xYS
JAyxd/kGTbJfQNg9YhInb7TSm0dGu0yx8yZ3fnpmH2FBYXZ+NFVW/yfM8xU3FO+e
bykZ3JCsmEbHMEqDnDqPWy1x7a/0XN1+0R/v6bPQ7EHLa6k7VlZjP+zLBbt2T2V0
O0cv9LVGFG/rpwB3g7OXI8DKMc4m50eDFyZN/1lCvF5oIGlgm4pjdD48sUBk3X9S
kSvhVXPl0JNHoGg+Gn4FPK0xQTSzv0r4EfxXPw0fU6zfFHclm0k+K6B9Lb/k0z5d
8Yn8c3JqtXu3F/EzLxVjfWQ2pRHlI9E0q9EuS7UOFD4FD0D3sLfXd8ZNpQ/hdnT1
7wIDAQAB
-----END PUBLIC KEY-----`,
    publicKeyName: "test-public-key",
  });

  const keyGroup = new cloudfront.KeyGroup(stack, "TestKeyGroup", {
    items: [publicKey],
    keyGroupName: "test-key-group",
  });

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    privateMedia: {
      keyGroup: keyGroup,
    },
    enableLogging: false,
    comment: "Private media CDN with key group",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify the distribution has trusted key groups configured
  const distributions = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::Distribution",
  );
  assert.ok(distributions.length >= 1, "Should have CloudFront Distribution");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-private-keygroup", template);
  } else {
    expectSnapshot("media-cdn-private-keygroup", template);
  }
});

test("AppTheoryMediaCdn (private media with PEM) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    privateMedia: {
      publicKeyPem: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAudf8/iNkQgdvjEdm6xYS
JAyxd/kGTbJfQNg9YhInb7TSm0dGu0yx8yZ3fnpmH2FBYXZ+NFVW/yfM8xU3FO+e
bykZ3JCsmEbHMEqDnDqPWy1x7a/0XN1+0R/v6bPQ7EHLa6k7VlZjP+zLBbt2T2V0
O0cv9LVGFG/rpwB3g7OXI8DKMc4m50eDFyZN/1lCvF5oIGlgm4pjdD48sUBk3X9S
kSvhVXPl0JNHoGg+Gn4FPK0xQTSzv0r4EfxXPw0fU6zfFHclm0k+K6B9Lb/k0z5d
8Yn8c3JqtXu3F/EzLxVjfWQ2pRHlI9E0q9EuS7UOFD4FD0D3sLfXd8ZNpQ/hdnT1
7wIDAQAB
-----END PUBLIC KEY-----`,
      publicKeyName: "media-cdn-public-key",
      keyGroupName: "media-cdn-key-group",
      keyGroupComment: "Key group for private media access",
    },
    enableLogging: false,
    comment: "Private media CDN with PEM key",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify that a public key and key group were created
  const publicKeys = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::PublicKey",
  );
  assert.ok(publicKeys.length >= 1, "Should have CloudFront PublicKey");

  const keyGroups = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::CloudFront::KeyGroup",
  );
  assert.ok(keyGroups.length >= 1, "Should have CloudFront KeyGroup");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-private-pem", template);
  } else {
    expectSnapshot("media-cdn-private-pem", template);
  }
});

test("AppTheoryMediaCdn (full options) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "media.example.com",
    hostedZone: zone,
  });

  new apptheory.AppTheoryMediaCdn(stack, "MediaCdn", {
    bucketName: "my-media-bucket",
    domain: {
      domainName: "media.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
    enableLogging: true,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    defaultRootObject: "index.html",
    comment: "Full options media CDN",
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("media-cdn-full-options", template);
  } else {
    expectSnapshot("media-cdn-full-options", template);
  }
});

// ============================================================================
// AppTheoryLambdaRole tests
// ============================================================================

test("AppTheoryLambdaRole (baseline) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryLambdaRole(stack, "LambdaRole", {
    roleName: "apptheory-test-role",
    description: "Test Lambda execution role",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: role exists with Lambda as trusted entity
  const roles = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::IAM::Role",
  );
  assert.ok(roles.length >= 1, "Should have IAM Role");

  // Verify: baseline managed policy (AWSLambdaBasicExecutionRole) is attached
  const [roleKey, roleResource] = roles[0];
  const managedPolicies = roleResource.Properties?.ManagedPolicyArns || [];
  const hasBasicExecution = managedPolicies.some(
    (p) =>
      (typeof p === "string" && p.includes("AWSLambdaBasicExecutionRole")) ||
      (p["Fn::Join"] && JSON.stringify(p).includes("AWSLambdaBasicExecutionRole")),
  );
  assert.ok(hasBasicExecution, "Should have AWSLambdaBasicExecutionRole managed policy");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("lambda-role-baseline", template);
  } else {
    expectSnapshot("lambda-role-baseline", template);
  }
});

test("AppTheoryLambdaRole (with X-Ray) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  new apptheory.AppTheoryLambdaRole(stack, "LambdaRole", {
    enableXRay: true,
    tags: { Environment: "test" },
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: X-Ray managed policy is attached
  const roles = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::IAM::Role",
  );
  const [roleKey, roleResource] = roles[0];
  const managedPolicies = roleResource.Properties?.ManagedPolicyArns || [];
  const hasXRay = managedPolicies.some(
    (p) =>
      (typeof p === "string" && p.includes("AWSXRayDaemonWriteAccess")) ||
      (p["Fn::Join"] && JSON.stringify(p).includes("AWSXRayDaemonWriteAccess")),
  );
  assert.ok(hasXRay, "Should have AWSXRayDaemonWriteAccess managed policy");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("lambda-role-xray", template);
  } else {
    expectSnapshot("lambda-role-xray", template);
  }
});

test("AppTheoryLambdaRole (with KMS permissions) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  // Create KMS keys for testing
  const envKey = new kms.Key(stack, "EnvKey", {
    description: "Environment encryption key",
  });

  const appKey = new kms.Key(stack, "AppKey", {
    description: "Application encryption key",
  });

  new apptheory.AppTheoryLambdaRole(stack, "LambdaRole", {
    roleName: "apptheory-kms-role",
    enableXRay: true,
    environmentEncryptionKeys: [envKey],
    applicationKmsKeys: [appKey],
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: KMS policies are created for both environment and application keys
  const policies = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::IAM::Policy",
  );
  assert.ok(policies.length >= 1, "Should have inline policies for KMS permissions");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("lambda-role-kms", template);
  } else {
    expectSnapshot("lambda-role-kms", template);
  }
});

test("AppTheoryLambdaRole (with additional statements) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const iam = require("aws-cdk-lib/aws-iam");

  new apptheory.AppTheoryLambdaRole(stack, "LambdaRole", {
    roleName: "apptheory-custom-role",
    additionalStatements: [
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: ["arn:aws:s3:::my-bucket/*"],
      }),
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: ["arn:aws:dynamodb:*:*:table/my-table"],
      }),
    ],
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: Additional inline policies are attached
  const policies = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::IAM::Policy",
  );
  assert.ok(policies.length >= 1, "Should have inline policy for additional statements");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("lambda-role-additional-statements", template);
  } else {
    expectSnapshot("lambda-role-additional-statements", template);
  }
});

// ============================================================================
// AppTheoryMcpServer tests
// ============================================================================

test("AppTheoryMcpServer (basic) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: fn,
    apiName: "apptheory-mcp-test",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: HTTP API exists
  template.hasResourceProperties
    ? assertions.Template.fromStack(stack).hasResourceProperties("AWS::ApiGatewayV2::Api", {
        Name: "apptheory-mcp-test",
        ProtocolType: "HTTP",
      })
    : null;

  // Verify: POST /mcp route exists
  const routes = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::ApiGatewayV2::Route",
  );
  const mcpRoute = routes.find(([key, resource]) => resource.Properties?.RouteKey === "POST /mcp");
  assert.ok(mcpRoute, "Should have POST /mcp route");

  // Verify: No DynamoDB table (session table not enabled)
  const tables = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::DynamoDB::Table",
  );
  assert.equal(tables.length, 0, "Should not have DynamoDB table when session table is not enabled");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-basic", template);
  } else {
    expectSnapshot("mcp-server-basic", template);
  }
});

test("AppTheoryMcpServer (with session table) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: fn,
    apiName: "apptheory-mcp-session-test",
    enableSessionTable: true,
    sessionTableName: "mcp-sessions",
    sessionTtlMinutes: 120,
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: DynamoDB table exists with correct key schema and TTL
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "mcp-sessions",
    KeySchema: [{ AttributeName: "sessionId", KeyType: "HASH" }],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  // Verify: Lambda has read/write permissions to the session table
  const policies = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::IAM::Policy",
  );
  assert.ok(policies.length >= 1, "Should have IAM policy for DynamoDB access");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-session-table", template);
  } else {
    expectSnapshot("mcp-server-session-table", template);
  }
});

test("AppTheoryMcpServer (with custom domain) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "mcp.example.com",
    hostedZone: zone,
  });

  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: fn,
    apiName: "apptheory-mcp-domain-test",
    domain: {
      domainName: "mcp.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: Custom domain name exists
  const domainNames = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::ApiGatewayV2::DomainName",
  );
  assert.ok(domainNames.length >= 1, "Should have API Gateway v2 DomainName");

  // Verify: API mapping exists
  const apiMappings = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::ApiGatewayV2::ApiMapping",
  );
  assert.ok(apiMappings.length >= 1, "Should have API Gateway v2 ApiMapping");

  // Verify: Route53 CNAME record exists
  const records = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::Route53::RecordSet",
  );
  assert.ok(records.length >= 1, "Should have Route53 record");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-domain", template);
  } else {
    expectSnapshot("mcp-server-domain", template);
  }
});

test("AppTheoryMcpServer (with stage options) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: fn,
    apiName: "apptheory-mcp-stage-test",
    stage: {
      stageName: "dev",
      accessLogging: true,
      accessLogRetention: logs.RetentionDays.ONE_WEEK,
      throttlingRateLimit: 100,
      throttlingBurstLimit: 200,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: Stage exists with throttling
  const stages = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::ApiGatewayV2::Stage",
  );
  assert.ok(stages.length >= 1, "Should have API Gateway v2 Stage");

  // Verify: Access log group exists
  const logGroups = Object.entries(template.Resources).filter(
    ([key, resource]) => resource.Type === "AWS::Logs::LogGroup",
  );
  assert.ok(logGroups.length >= 1, "Should have CloudWatch Log Group for access logging");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-stage", template);
  } else {
    expectSnapshot("mcp-server-stage", template);
  }
});

// ============================================================================
// AppTheoryRemoteMcpServer tests
// ============================================================================

test("AppTheoryRemoteMcpServer (basic) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-test",
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: REST API exists
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::ApiGateway::RestApi", {
    Name: "apptheory-remote-mcp-test",
  });

  const methodPaths = restApiMethodPaths(template);

  // Verify: Streaming enabled on POST/GET methods (ResponseTransferMode + URI suffix + timeout)
  let streamingMethods = 0;

  for (const [key, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::ApiGateway::Method") continue;

    const method = resource.Properties?.HttpMethod;

    if (method !== "POST" && method !== "GET") continue;

    const integration = resource.Properties?.Integration;
    assert.equal(integration?.ResponseTransferMode, "STREAM", `Method ${key} should be streaming`);
    assert.equal(integration?.TimeoutInMillis, 900000, `Method ${key} should have 15min timeout`);

    const uri = integration?.Uri;
    if (uri && uri["Fn::Join"]) {
      const uriParts = uri["Fn::Join"][1];
      const hasStreamingUri = uriParts.some(
        (p) => typeof p === "string" && p.includes("/response-streaming-invocations"),
      );
      assert.ok(hasStreamingUri, `Method ${key} should have streaming invocation URI`);
    } else {
      assert.fail(`Method ${key} should have a Fn::Join integration URI`);
    }

    streamingMethods++;
  }

  assert.ok(methodPaths.some((m) => m.method === "POST" && m.path === "/mcp"), "Should have POST /mcp method");
  assert.ok(methodPaths.some((m) => m.method === "GET" && m.path === "/mcp"), "Should have GET /mcp method");
  assert.ok(methodPaths.some((m) => m.method === "DELETE" && m.path === "/mcp"), "Should have DELETE /mcp method");
  assert.ok(streamingMethods >= 2, "Should have streaming enabled on POST and GET");
  assertStreamingRouteStageVariable(template, "GET", "/mcp");
  assertStreamingRouteStageVariable(template, "POST", "/mcp");
  assert.equal(restApiStageVariables(template)[restApiStreamingRouteStageVariableName("DELETE", "/mcp")], undefined);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-basic", template);
  } else {
    expectSnapshot("remote-mcp-server-basic", template);
  }
});

test("AppTheoryRemoteMcpServer can suppress test-invoke-stage permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-test",
    allowTestInvoke: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 3, "Should synthesize one permission per Remote MCP method without test invoke");
  assertNoTestInvokeStagePermissions(template);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-basic-no-test-invoke", template);
  } else {
    expectSnapshot("remote-mcp-server-basic-no-test-invoke", template);
  }
});

test("AppTheoryRemoteMcpServer can use API-scoped invoke permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-test",
    scopePermissionToMethod: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(lambdaPermissionCount(template), 1, "Should synthesize one API-scoped permission for the Remote MCP handler");
  assertNoTestInvokeStagePermissions(template);

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-basic-api-scoped-permissions", template);
  } else {
    expectSnapshot("remote-mcp-server-basic-api-scoped-permissions", template);
  }
});

test("AppTheoryRemoteMcpServer (actor path) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-actor-test",
    actorPath: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const methodPaths = restApiMethodPaths(template);

  assert.ok(
    methodPaths.some((m) => m.method === "POST" && m.path === "/mcp/{actor}"),
    "Should have POST /mcp/{actor} method",
  );
  assert.ok(
    methodPaths.some((m) => m.method === "GET" && m.path === "/mcp/{actor}"),
    "Should have GET /mcp/{actor} method",
  );
  assert.ok(
    methodPaths.some((m) => m.method === "DELETE" && m.path === "/mcp/{actor}"),
    "Should have DELETE /mcp/{actor} method",
  );
  assert.ok(
    methodPaths.some((m) => m.method === "GET" && m.path === "/.well-known/oauth-protected-resource/mcp/{actor}"),
    "Should have GET protected resource metadata route for /mcp/{actor}",
  );

  const functions = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::Lambda::Function");
  assert.ok(functions.length >= 1, "Should synthesize a Lambda function");
  const mcpEndpoint = functions[0].Properties?.Environment?.Variables?.MCP_ENDPOINT;
  assert.ok(JSON.stringify(mcpEndpoint).includes("/prod/mcp/{actor}"), "MCP_ENDPOINT should use the actor template");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-actor-path", template);
  } else {
    expectSnapshot("remote-mcp-server-actor-path", template);
  }
});

test("AppTheoryRemoteMcpServer can register /.well-known/mcp.json", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-discovery-test",
    actorPath: true,
    enableWellKnownMcpDiscovery: true,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const methodPaths = restApiMethodPaths(template);

  assert.ok(
    methodPaths.some((m) => m.method === "GET" && m.path === "/.well-known/mcp.json"),
    "Should have GET /.well-known/mcp.json method",
  );

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-discovery", template);
  } else {
    expectSnapshot("remote-mcp-server-discovery", template);
  }
});

test("AppTheoryRemoteMcpServer (with tables) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-tables-test",
    enableSessionTable: true,
    sessionTableName: "mcp-sessions",
    sessionTtlMinutes: 120,
    enableStreamTable: true,
    streamTableName: "mcp-streams",
    streamTtlMinutes: 240,
    enableTaskTable: true,
    taskTableName: "mcp-tasks",
    taskTtlMinutes: 180,
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: Session table exists (pk + TTL)
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "mcp-sessions",
    KeySchema: [{ AttributeName: "sessionId", KeyType: "HASH" }],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  // Verify: Stream table exists (pk/sk + TTL)
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "mcp-streams",
    KeySchema: [
      { AttributeName: "sessionId", KeyType: "HASH" },
      { AttributeName: "eventId", KeyType: "RANGE" },
    ],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  // Verify: Task table exists (pk/sk + TTL)
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "mcp-tasks",
    KeySchema: [
      { AttributeName: "sessionId", KeyType: "HASH" },
      { AttributeName: "taskId", KeyType: "RANGE" },
    ],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  // Verify: Stream spill bucket is private, encrypted, and expires objects.
  assertions.Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "AES256",
          },
        },
      ],
    },
    LifecycleConfiguration: {
      Rules: [
        {
          ExpirationInDays: 1,
          Status: "Enabled",
        },
      ],
    },
  });

  // Verify: Lambda has IAM policies for DynamoDB access
  const policies = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::IAM::Policy",
  );
  assert.ok(policies.length >= 1, "Should have IAM policy for DynamoDB access");

  const functions = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::Lambda::Function");
  const env = functions[0].Properties?.Environment?.Variables ?? {};
  assert.equal(env.MCP_STREAM_SPILL_PREFIX, "mcp-stream-events");
  assert.equal(env.MCP_STREAM_SPILL_INLINE_MAX_BYTES, "32768");
  assert.equal(env.MCP_STREAM_MAX_EVENT_BYTES, "10485760");
  assert.ok(env.MCP_STREAM_SPILL_BUCKET, "Should set MCP_STREAM_SPILL_BUCKET");
  assert.equal(env.MCP_TASK_TTL_MINUTES, "180");
  assert.ok(env.MCP_TASK_TABLE, "Should set MCP_TASK_TABLE");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-tables", template);
  } else {
    expectSnapshot("remote-mcp-server-tables", template);
  }
});

test("AppTheoryRemoteMcpServer validates stream spill thresholds", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  assert.throws(
    () =>
      new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcpInlineTooLarge", {
        handler: fn,
        enableStreamTable: true,
        streamSpillInlineMaxBytes: 350 * 1024 + 1,
      }),
    /streamSpillInlineMaxBytes must be less than or equal to 358400/,
  );

  assert.throws(
    () =>
      new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcpMaxBelowInline", {
        handler: fn,
        enableStreamTable: true,
        streamSpillInlineMaxBytes: 4096,
        streamMaxEventBytes: 1024,
      }),
    /streamMaxEventBytes must be greater than or equal to streamSpillInlineMaxBytes/,
  );
});

test("AppTheoryRemoteMcpServer (with custom domain) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
  const cert = new apptheory.AppTheoryCertificate(stack, "Cert", {
    domainName: "mcp.example.com",
    hostedZone: zone,
  });

  new apptheory.AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
    handler: fn,
    apiName: "apptheory-remote-mcp-domain-test",
    domain: {
      domainName: "mcp.example.com",
      certificate: cert.certificate,
      hostedZone: zone,
    },
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // Verify: REST domain + mapping + Route53 alias record exist
  const domainNames = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::ApiGateway::DomainName",
  );
  assert.ok(domainNames.length >= 1, "Should have API Gateway REST DomainName");

  const mappings = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::ApiGateway::BasePathMapping",
  );
  assert.ok(mappings.length >= 1, "Should have API Gateway REST BasePathMapping");

  const records = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::Route53::RecordSet",
  );
  assert.ok(records.length >= 1, "Should have Route53 record");

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("remote-mcp-server-domain", template);
  } else {
    expectSnapshot("remote-mcp-server-domain", template);
  }
});

// ============================================================================
// AppTheoryMcpProtectedResource tests
// ============================================================================

test("AppTheoryMcpProtectedResource synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
    apiName: "apptheory-protected-resource-test",
  });

  new apptheory.AppTheoryMcpProtectedResource(stack, "Protected", {
    router,
    resource: "https://mcp.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const methodPaths = restApiMethodPaths(template);

  let mockGetMethods = 0;
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== "AWS::ApiGateway::Method") continue;
    if (resource.Properties?.HttpMethod !== "GET") continue;
    if (resource.Properties?.Integration?.Type !== "MOCK") continue;
    mockGetMethods++;
  }
  assert.equal(mockGetMethods, 1, "Should have one GET mock method for the protected resource metadata route");
  assert.ok(
    methodPaths.some((m) => m.method === "GET" && m.path === "/.well-known/oauth-protected-resource/mcp"),
    "Should mount the RFC 9728 path-scoped metadata route",
  );

  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-protected-resource", template);
  } else {
    expectSnapshot("mcp-protected-resource", template);
  }
});
