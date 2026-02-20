const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const ec2 = require("aws-cdk-lib/aws-ec2");
const events = require("aws-cdk-lib/aws-events");
const kms = require("aws-cdk-lib/aws-kms");
const lambda = require("aws-cdk-lib/aws-lambda");
const logs = require("aws-cdk-lib/aws-logs");
const route53 = require("aws-cdk-lib/aws-route53");

const apptheory = require("../lib");

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
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api", template);
  } else {
    expectSnapshot("rest-api", template);
  }
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

  new apptheory.AppTheoryDynamoDBStreamMapping(stack, "Stream", { consumer: fn, table });

  const template = assertions.Template.fromStack(stack).toJSON();
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

test("AppTheorySsrSite (FaceTheory) synthesizes expected template", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");

  const fn = new lambda.Function(stack, "Fn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: 'ok' });"),
  });

  new apptheory.AppTheorySsrSite(stack, "Site", {
    ssrFunction: fn,
    cacheTableName: "facetheory-cache-table",
    ssrForwardHeaders: [" X-FaceTheory-Tenant ", "x-facetheory-tenant"],
    staticPathPatterns: ["/_facetheory/data/* ", "_facetheory/data/*"],
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("ssr-site-facetheory", template);
  } else {
    expectSnapshot("ssr-site-facetheory", template);
  }
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
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("rest-api-router-multi-lambda", template);
  } else {
    expectSnapshot("rest-api-router-multi-lambda", template);
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

// ============================================================================
// AppTheoryMediaCdn tests
// ============================================================================

const cloudfront = require("aws-cdk-lib/aws-cloudfront");

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
