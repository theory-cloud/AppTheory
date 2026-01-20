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
