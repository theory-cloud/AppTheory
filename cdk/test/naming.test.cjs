const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");

const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3 = require("aws-cdk-lib/aws-s3");
const { Node } = require("constructs");

const apptheory = require("../lib");

const FIXTURES = path.join(__dirname, "..", "..", "contract-tests", "fixtures", "resource-naming", "v0.1");

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function labContext(stack, overrides = {}) {
  return new apptheory.AppTheoryNamingContext(stack, "Naming", {
    app: "autheory",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
    loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    ...overrides,
  });
}

function legacyContext(stack, overrides = {}) {
  return new apptheory.AppTheoryNamingContext(stack, "Naming", {
    app: "autheory",
    stage: "live",
    account: "784055308075",
    region: "us-east-1",
    namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
    loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
    ...overrides,
  });
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

// The two environments the suite synthesizes into: the lab and live stage
// configurations. A naming context claims one of them and the derived-name
// artifact carries the context's account and Region; nothing compares them with
// the environment of the stack that declares through the context (operator
// ruling 2026-11-25), so a legacy-profile test still builds its stack in the
// live account because that is the stage config it deploys from.
const LAB_ENV = { account: "998115851393", region: "us-east-1" };
const LIVE_ENV = { account: "784055308075", region: "us-east-1" };

function synth(build, env = LAB_ENV) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env });
  build(stack);
  return assertions.Template.fromStack(stack).toJSON();
}

function synthLive(build) {
  return synth(build, LIVE_ENV);
}

function microvmControllerBuild(stack, context, overrides = {}) {
  return new apptheory.AppTheoryMicrovmController(stack, "Controller", {
    namingContext: context,
    controller: {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
      environment: { APP_ENV: "test" },
    },
    authorizer: handler(stack, "Authorizer"),
    microvmImage: {
      microvmImageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image/imported",
      logging: { disabled: true },
    },
    ingressNetworkConnectors: [apptheory.AppTheoryMicrovmNetworkConnector.allIngress(stack, "Ingress")],
    egressNetworkConnectors: [apptheory.AppTheoryMicrovmNetworkConnector.internetEgress(stack, "Egress")],
    shellIngressNetworkConnector: apptheory.AppTheoryMicrovmNetworkConnector.shellIngress(stack, "ShellIngress"),
    ...overrides,
  });
}

// ---- N1: the CDK exposes the same primitive ---------------------------------

test("the CDK naming API agrees with every contract fixture", () => {
  let evaluated = 0;
  for (const family of ["valid", "invalid"]) {
    const directory = path.join(FIXTURES, family);
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      const fixture = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      assert.equal(fixture.contract, "theorycloud_resource_naming.v0.1", name);
      const reasons = evaluateFixture(fixture);
      const ok = family === "invalid" ? reasons.length > 0 : reasons.length === 0;
      assert.ok(ok, `${family}/${name}: ${reasons.join("; ") || "invalid fixture passed"}`);
      evaluated += 1;
    }
  }
  assert.equal(evaluated, 116);
});

function evaluateFixture(fixture) {
  const scenario = fixture.scenario;
  const naming = apptheory.AppTheoryResourceNaming;
  const reasons = [];
  const declared = new Set(fixture.proof?.does_not_prove ?? []);
  for (const required of ["deployment_proof", "journey_proof", "aws_behaviour_proof"]) {
    if (!declared.has(required)) reasons.push(`missing proof disclaimer ${required}`);
  }
  const expected = fixture.expected ?? {};
  const expectsError = Boolean(expected && typeof expected === "object" && expected.error);
  let got;
  let error;
  try {
    got = evaluateScenario(naming, scenario);
  } catch (caught) {
    error = caught;
  }
  if (error) {
    if (!expectsError) reasons.push(`contract rejects: ${error.message}`);
  } else if (expectsError) {
    reasons.push("fixture expects rejection but contract accepts");
  } else if (!util.isDeepStrictEqual(got, expected)) {
    reasons.push(`expected ${JSON.stringify(expected)} != required ${JSON.stringify(got)}`);
  }
  return reasons;
}

function evaluateScenario(naming, scenario) {
  switch (scenario.type) {
    case "name": {
      const values = {
        ...scenario.context,
        pins: scenario.pins ?? {},
        generated: scenario.generated ?? [],
        namingProfile: scenario.context.naming_profile,
      };
      const composed = naming.physicalName(values, scenario.resource_type, scenario.logical);
      const out = {};
      if (composed.name !== undefined) out.name = composed.name;
      if (composed.bucketNamePrefix !== undefined) out.bucket_name_prefix = composed.bucketNamePrefix;
      if (composed.bucketNamespace !== undefined) out.bucket_namespace = composed.bucketNamespace;
      if (composed.pinned) out.pinned = true;
      if (composed.generated) out.generated = true;
      return out;
    }
    case "log_group":
      naming.validateContext(scenario.context);
      return { name: naming.logGroupName(scenario.context, scenario.logical) };
    case "compile":
      return JSON.parse(naming.compileVisibilityPolicyJson(scenario.context, scenario.rules ?? {}));
    case "preview":
      return snakePreview(naming.visibilityPreview(scenario.context, scenario.rules ?? {}, scenario.sources));
    case "manifest":
      return snakeManifest(naming.visibilityManifest(scenario.context, scenario.rules ?? {}, scenario.sources));
    case "keeper": {
      const rules = scenario.rules
        ? { ...scenario.rules, namingProfile: undefined }
        : undefined;
      const answer = naming.keeperDecision(rules ?? {}, scenario.logical, scenario.aws_result);
      return { answer };
    }
    case "visible":
      return { visible: naming.sourceVisible(scenario.rules ?? {}, scenario.logical) };
    case "naming_scope":
      return { scope: naming.namingScope(scenario.resource_type) };
    case "synth_check": {
      const artifact = naming.synthCheck(
        scenario.entries.map((entry) => ({
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          type: entry.type,
          logicalId: entry.logical_id,
        })),
      );
      return {
        artifact: artifact.map((row) => {
          const out = {};
          if (row.name !== undefined) out.name = row.name;
          out.type = row.type;
          out.scope = row.scope;
          out.logical_id = row.logicalId;
          return out;
        }),
      };
    }
    default:
      throw new Error(`unknown scenario type ${scenario.type}`);
  }
}

function snakePreview(preview) {
  return {
    rule_version: preview.ruleVersion,
    matched_now: preview.matchedNow,
    not_matched_now: preview.notMatchedNow,
    future: { include: preview.future.include ?? [], exclude: preview.future.exclude ?? [] },
  };
}

function snakeManifest(manifest) {
  return {
    rule_version: manifest.ruleVersion,
    matched_now: manifest.matchedNow,
    future: { include: manifest.future.include ?? [], exclude: manifest.future.exclude ?? [] },
  };
}

test("the CDK naming API shortens an over-budget Lambda name", () => {
  const naming = apptheory.AppTheoryResourceNaming;
  const values = { app: "theory-mcp-server", stage: "lab", account: "191637461429", region: "us-east-1" };
  const composed = naming.physicalName(values, "lambda_function", "namespace-vending/request-claim-handler-version-two");
  assert.equal(composed.name, "theory-mcp-server-lab-namespace-vending-request-claim-h-5mcmmerw");
});

// ---- N2: the naming context construct --------------------------------------

test("AppTheoryNamingContext validates its bound context", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryNamingContext(stack, "Naming", {
          app: "Autheory",
          stage: "lab",
          account: "998115851393",
          region: "us-east-1",
        }),
      ),
    /app/,
  );
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryNamingContext(stack, "Naming", {
          app: "autheory",
          stage: "lab",
          account: "998115851393",
          region: "us-east-1",
          retentionDays: 4,
        }),
      ),
    /retentionDays/,
  );
});

test("AppTheoryNamingContext fails synthesis on an unresolved account token", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryNamingContext(stack, "Naming", {
          app: "autheory",
          stage: "lab",
          account: cdk.Fn.importValue("AccountId"),
          region: "us-east-1",
        }),
      ),
    /concrete account id/,
  );
});

test("AppTheoryNamingContext fails synthesis on a missing legacy pin", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack");
  const context = legacyContext(stack);
  assert.throws(() => context.physicalName("dynamodb_table", "events"), /requires a pin/);
});

// ---- N3: derived names and pins --------------------------------------------

test("AppTheoryBucket sets the account-regional namespace and prefix", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheoryBucket(stack, "Data", { namingContext: context, logical: "audit-events" });
  });
  const buckets = resourcesOfType(template, "AWS::S3::Bucket");
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].Properties?.BucketNamespace, "account-regional");
  assert.equal(buckets[0].Properties?.BucketNamePrefix, "autheory-lab-audit-events");
  assert.equal(buckets[0].Properties?.BucketName, undefined);
});

test("AppTheoryBucket uses a legacy pin verbatim", () => {
  const template = synthLive((stack) => {
    const context = legacyContext(stack, { pins: { "s3_bucket:audit-events": "autheory-live-audit-events" } });
    new apptheory.AppTheoryBucket(stack, "Data", { namingContext: context, logical: "audit-events" });
  });
  const buckets = resourcesOfType(template, "AWS::S3::Bucket");
  assert.equal(buckets[0].Properties?.BucketName, "autheory-live-audit-events");
  assert.equal(buckets[0].Properties?.BucketNamespace, undefined);
});

test("AppTheoryBucket refuses to override a derived name", () => {
  assert.throws(
    () =>
      synth((stack) => {
        const context = labContext(stack);
        new apptheory.AppTheoryBucket(stack, "Data", {
          namingContext: context,
          logical: "audit-events",
          bucketName: "explicit-name",
        });
      }),
    /cannot honor props.bucketName/,
  );
});

// ---- N4: standard logging --------------------------------------------------

function standardFunctionContext(stack) {
  return labContext(stack);
}

test("AppTheoryFunction standard logging names the runtime log group and grants writes", () => {
  const template = synth((stack) => {
    new apptheory.AppTheoryFunction(stack, "Api", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({});"),
      namingContext: standardFunctionContext(stack),
      logicalName: "api",
    });
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  const runtimeGroups = groups.filter((group) => group.Properties?.LogGroupName !== undefined);
  assert.equal(runtimeGroups.length, 1);
  assert.equal(
    runtimeGroups[0].Properties.LogGroupName,
    "theorycloud_theorycloud_autheory_lab_logs_runtime_api",
  );
  assert.equal(runtimeGroups[0].Properties.RetentionInDays, 30);

  const functions = resourcesOfType(template, "AWS::Lambda::Function");
  assert.deepEqual(functions[0].Properties?.LoggingConfig, {
    LogGroup: { Ref: Object.keys(template.Resources).find((id) => template.Resources[id] === runtimeGroups[0]) },
  });

  const policies = JSON.stringify(resourcesOfType(template, "AWS::IAM::Policy"));
  assert.match(policies, /logs:CreateLogStream/);
  assert.match(policies, /logs:PutLogEvents/);
});

test("AppTheoryHttpApi standard logging defaults on with the contract JSON fields", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "main",
    });
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].Properties?.LogGroupName, "theorycloud_theorycloud_autheory_lab_logs_access_api_main");

  const stages = resourcesOfType(template, "AWS::ApiGatewayV2::Stage");
  const format = JSON.parse(stages[0].Properties.AccessLogSettings.Format);
  assert.deepEqual(Object.keys(format).sort(), [
    "httpMethod",
    "integrationLatency",
    "protocol",
    "requestId",
    "requestTime",
    "responseLength",
    "routeKey",
    "sourceIp",
    "status",
  ]);
  assert.equal(format.sourceIp, "$context.identity.sourceIp");
});

test("AppTheoryHttpApi standard logging can be opted out explicitly", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "main",
      stage: { accessLogging: false },
    });
  });
  assert.equal(resourcesOfType(template, "AWS::Logs::LogGroup").length, 0);
});

test("AppTheoryRestApiRouter standard logging uses the REST field set", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
      namingContext: context,
      logicalName: "main",
    });
    router.addLambdaIntegration("/{proxy+}", ["ANY"], handler(stack));
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  assert.equal(groups[0].Properties?.LogGroupName, "theorycloud_theorycloud_autheory_lab_logs_access_api_main");
  const stages = resourcesOfType(template, "AWS::ApiGateway::Stage");
  const format = JSON.parse(stages[0].Properties.AccessLogSetting.Format);
  assert.ok("resourcePath" in format);
  assert.ok("responseLatency" in format);
  assert.equal(format.sourceIp, "$context.identity.sourceIp");
});

test("AppTheoryWebSocketApi standard logging defaults on with the WebSocket field set", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "socket",
    });
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  assert.equal(groups[0].Properties?.LogGroupName, "theorycloud_theorycloud_autheory_lab_logs_access_api_socket");

  const stages = resourcesOfType(template, "AWS::ApiGatewayV2::Stage");
  assert.deepEqual(JSON.parse(stages[0].Properties.AccessLogSettings.Format), {
    requestId: "$context.requestId",
    requestTime: "$context.requestTime",
    eventType: "$context.eventType",
    routeKey: "$context.routeKey",
    connectionId: "$context.connectionId",
    status: "$context.status",
    integrationLatency: "$context.integrationLatency",
    sourceIp: "$context.identity.sourceIp",
  });
});

test("AppTheoryWebSocketApi takes its API name from api_websocket", () => {
  const template = synth((stack) => {
    new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      namingContext: labContext(stack),
      logicalName: "socket",
    });
  });
  const apis = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(apis[0].Properties?.Name, "autheory-lab-socket");
});

test("WebSocket access logging keeps the legacy format without a context", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      enableAccessLogging: true,
    }),
  );
  const stages = resourcesOfType(template, "AWS::ApiGatewayV2::Stage");
  const format = JSON.parse(stages[0].Properties.AccessLogSettings.Format);
  assert.deepEqual(Object.keys(format).sort(), [
    "connectionId",
    "eventType",
    "integrationLatency",
    "ip",
    "requestId",
    "requestTime",
    "responseLength",
    "routeKey",
    "status",
    "userAgent",
  ]);
});

test("AppTheoryMcpServer standard logging uses the contract log group", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheoryMcpServer(stack, "Mcp", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "mcp",
      sessionState: { enabled: false },
    });
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  const accessGroups = groups.filter((group) =>
    String(group.Properties?.LogGroupName ?? "").includes("logs_access_api"),
  );
  assert.equal(accessGroups.length, 1);
  assert.equal(accessGroups[0].Properties.LogGroupName, "theorycloud_theorycloud_autheory_lab_logs_access_api_mcp");
});

test("AppTheorySsrSite standard logging uses CloudWatch Logs delivery", () => {
  const template = synth((stack) => {
    const context = labContext(stack);
    new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack),
      namingContext: context,
      logicalName: "control-plane-site",
    });
  });
  const groups = resourcesOfType(template, "AWS::Logs::LogGroup");
  const cdn = groups.find((group) =>
    String(group.Properties?.LogGroupName ?? "").includes("logs_access_cdn_control-plane-site"),
  );
  assert.ok(cdn, "expected the CloudFront access log group");

  const sources = resourcesOfType(template, "AWS::Logs::DeliverySource");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].Properties?.LogType, "ACCESS_LOGS");
  const destinations = resourcesOfType(template, "AWS::Logs::DeliveryDestination");
  assert.equal(destinations[0].Properties?.OutputFormat, "json");
  const deliveries = resourcesOfType(template, "AWS::Logs::Delivery");
  assert.deepEqual(deliveries[0].Properties?.RecordFields, [
    "timestamp",
    "x-edge-request-id",
    "cs-method",
    "cs-uri-stem",
    "sc-status",
    "sc-bytes",
    "time-taken",
    "x-edge-result-type",
    "c-ip",
  ]);

  const buckets = resourcesOfType(template, "AWS::S3::Bucket");
  for (const bucket of buckets) {
    assert.equal(bucket.Properties?.BucketNamespace, "account-regional");
  }
  assert.ok(!buckets.some((bucket) => String(bucket.Properties?.BucketName ?? "").length > 0));
});

test("AppTheoryPathRoutedFrontend and AppTheoryMediaCdn standard logging use CloudWatch Logs delivery", () => {
  for (const build of [
    (stack, context) =>
      new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
        apiOriginUrl: "https://api.example.com",
        namingContext: context,
        logicalName: "front",
      }),
    (stack, context) =>
      new apptheory.AppTheoryMediaCdn(stack, "Media", {
        namingContext: context,
        logicalName: "media",
      }),
  ]) {
    const template = synth((stack) => build(stack, labContext(stack)));
    assert.equal(resourcesOfType(template, "AWS::Logs::DeliverySource").length, 1);
    const destinations = resourcesOfType(template, "AWS::Logs::DeliveryDestination");
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0].Properties?.OutputFormat, "json");
    assert.equal(resourcesOfType(template, "AWS::Logs::Delivery").length, 1);
  }
});

test("CloudFront standard-logging deliveries depend on their own delivery source", () => {
  // A delivery names its source by a literal string, so CloudFormation has no
  // edge between the two. The source waits on the distribution ARN, so an
  // unordered delivery can be created first and fail because its source does
  // not exist yet. Resolve the source from the template, never by a fixed id.
  const consumers = {
    AppTheorySsrSite: (stack, context) =>
      new apptheory.AppTheorySsrSite(stack, "Site", {
        ssrFunction: handler(stack),
        namingContext: context,
        logicalName: "control-plane-site",
      }),
    AppTheoryPathRoutedFrontend: (stack, context) =>
      new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
        apiOriginUrl: "https://api.example.com",
        namingContext: context,
        logicalName: "front",
      }),
    AppTheoryMediaCdn: (stack, context) =>
      new apptheory.AppTheoryMediaCdn(stack, "Media", {
        namingContext: context,
        logicalName: "media",
      }),
  };
  for (const [label, build] of Object.entries(consumers)) {
    const template = synth((stack) => build(stack, labContext(stack)));
    const sourceByPhysicalName = new Map();
    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      if (resource.Type === "AWS::Logs::DeliverySource") {
        sourceByPhysicalName.set(resource.Properties?.Name, logicalId);
      }
    }
    const deliveries = Object.entries(template.Resources ?? {}).filter(
      ([, resource]) => resource.Type === "AWS::Logs::Delivery",
    );
    assert.equal(deliveries.length, 1, `${label} must deliver standard logs`);
    for (const [logicalId, delivery] of deliveries) {
      const sourceId = sourceByPhysicalName.get(delivery.Properties?.DeliverySourceName);
      assert.ok(sourceId, `${label}: ${logicalId} must name a delivery source in the template`);
      const dependsOn = Array.isArray(delivery.DependsOn)
        ? delivery.DependsOn
        : delivery.DependsOn
          ? [delivery.DependsOn]
          : [];
      assert.ok(
        dependsOn.includes(sourceId),
        `${label}: ${logicalId} must depend on ${sourceId}, got ${JSON.stringify(delivery.DependsOn ?? null)}`,
      );
    }
  }
});

test("CloudFront standard logging refuses the W3C format for a CloudWatch Logs destination", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: labContext(stack),
          logicalName: "media",
          cloudFrontLogFormat: apptheory.AppTheoryCloudFrontLogFormat.W3C,
        }),
      ),
    /contract section 3[\s\S]*JSON/,
  );
});

test("CloudFront standard logging accepts JSON explicitly", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryMediaCdn(stack, "Media", {
      namingContext: labContext(stack),
      logicalName: "media",
      cloudFrontLogFormat: apptheory.AppTheoryCloudFrontLogFormat.JSON,
    }),
  );
  assert.equal(
    resourcesOfType(template, "AWS::Logs::DeliveryDestination")[0].Properties?.OutputFormat,
    "json",
  );
});

test("CloudFront standard logging can be opted out explicitly", () => {
  const template = synth((stack) =>
    new apptheory.AppTheoryMediaCdn(stack, "Media", {
      namingContext: labContext(stack),
      logicalName: "media",
      enableLogging: false,
    }),
  );
  assert.equal(resourcesOfType(template, "AWS::Logs::DeliverySource").length, 0);
});

test("CloudFront standard logging refuses a stack outside us-east-1", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: labContext(stack, { region: "eu-west-1" }),
          logicalName: "media",
        }),
      ),
    /us-east-1/,
  );
});

// ---- N4: legacy profiles synthesize byte-identically -----------------------

function assertIdentical(build, { pins = {}, generated = [] } = {}) {
  const base = synthLive((stack) => build(stack, undefined));
  const legacy = synthLive((stack) =>
    build(
      stack,
      new apptheory.AppTheoryNamingContext(stack, "Naming", {
        app: "autheory",
        stage: "live",
        account: "784055308075",
        region: "us-east-1",
        namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
        loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
        pins,
        generated,
      }),
    ),
  );
  assert.equal(JSON.stringify(legacy), JSON.stringify(base));
}

test("legacy profiles synthesize byte-identically: AppTheoryFunction (pin and generated role)", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryFunction(stack, "Fn", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = async () => ({});"),
        namingContext: context,
        ...(context ? {} : { functionName: "autheory-live-api" }),
      }),
    { pins: { "lambda_function:fn": "autheory-live-api" }, generated: ["iam_role:fn"] },
  );
});

test("legacy plus generated entries keep CloudFormation's Lambda name and its log group", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryFunction(stack, "Fn", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = async () => ({});"),
        namingContext: context,
      }),
    { generated: ["lambda_function:fn", "iam_role:fn"] },
  );
});

test("legacy plus generated entries keep CloudFront's generated bucket name", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheorySsrSite(stack, "Site", { ssrFunction: handler(stack), namingContext: context }),
    { generated: ["s3_bucket:site-assets"] },
  );
});

test("legacy plus generated entries keep the MediaCdn bucket name", () => {
  assertIdentical(
    (stack, context) => new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: context }),
    { generated: ["s3_bucket:media-media"] },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryHttpApi", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryHttpApi(stack, "Api", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { apiName: "autheory-live-api" }),
      }),
    { pins: { "api_http:api": "autheory-live-api" } },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryRestApiRouter", () => {
  assertIdentical(
    (stack, context) => {
      const router = new apptheory.AppTheoryRestApiRouter(stack, "Router", {
        namingContext: context,
        ...(context ? {} : { apiName: "autheory-live-rest" }),
      });
      router.addLambdaIntegration("/{proxy+}", ["ANY"], handler(stack));
    },
    { pins: { "api_rest:router": "autheory-live-rest" } },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryRemoteMcpServer", () => {
  assertIdentical(
    (stack, context) => {
      new apptheory.AppTheoryRemoteMcpServer(stack, "Mcp", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { apiName: "autheory-live-mcp" }),
      });
    },
    { pins: { "api_rest:mcp": "autheory-live-mcp" } },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryWebSocketApi", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { apiName: "autheory-live-ws" }),
      }),
    { pins: { "api_websocket:ws": "autheory-live-ws" } },
  );
});

test("legacy plus a generated entry keeps the WebSocket connection table unnamed", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { apiName: "autheory-live-ws" }),
        enableConnectionTable: true,
      }),
    { pins: { "api_websocket:ws": "autheory-live-ws" }, generated: ["dynamodb_table:ws-connections"] },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryMcpServer without a log_group entry", () => {
  // r3 (ADV-1312-1): the construct's access-log group is a logging resource. It
  // keeps today's CloudFormation-generated name and consumes no naming entry, so
  // the legacy template matches no context byte for byte with no log_group entry.
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryMcpServer(stack, "Mcp", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { ownedApi: { apiName: "autheory-live-mcp" } }),
        sessionState: { enabled: false },
      }),
    { pins: { "api_http:mcp": "autheory-live-mcp" } },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryPathRoutedFrontend", () => {
  assertIdentical((stack, context) =>
    new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
      apiOriginUrl: "https://api.example.com",
      namingContext: context,
    }),
  );
});

test("an orphan naming entry fails synthesis", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
          apiOriginUrl: "https://api.example.com",
          namingContext: legacyContext(stack, {
            pins: { "dynamodb_table:events": "autheory-live-events" },
          }),
        }),
      ),
    /match no resource/,
  );
});

// ---- N6: explicit name props under a naming context ------------------------

test("every explicit physical-name prop is refused under a naming context", () => {
  const cases = [
    [
      "AppTheoryFunction.functionName",
      (stack) =>
        new apptheory.AppTheoryFunction(stack, "Fn", {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "index.handler",
          code: lambda.Code.fromInline("exports.handler = async () => ({});"),
          namingContext: labContext(stack),
          functionName: "hand-built",
        }),
    ],
    [
      "AppTheoryFunction.roleName",
      (stack) =>
        new apptheory.AppTheoryFunction(stack, "Fn", {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "index.handler",
          code: lambda.Code.fromInline("exports.handler = async () => ({});"),
          namingContext: labContext(stack),
          roleName: "hand-built",
        }),
    ],
    [
      "AppTheoryHttpApi.apiName",
      (stack) =>
        new apptheory.AppTheoryHttpApi(stack, "Api", {
          handler: handler(stack),
          namingContext: labContext(stack),
          apiName: "hand-built",
        }),
    ],
    [
      "AppTheoryRestApiRouter.apiName",
      (stack) =>
        new apptheory.AppTheoryRestApiRouter(stack, "Router", {
          namingContext: labContext(stack),
          apiName: "hand-built",
        }),
    ],
    [
      "AppTheoryWebSocketApi.apiName",
      (stack) =>
        new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
          handler: handler(stack),
          namingContext: labContext(stack),
          apiName: "hand-built",
        }),
    ],
    [
      "AppTheoryWebSocketApi.connectionTableName",
      (stack) =>
        new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
          handler: handler(stack),
          namingContext: labContext(stack),
          connectionTableName: "hand-built",
        }),
    ],
    [
      "AppTheoryMcpServer.ownedApi.apiName",
      (stack) =>
        new apptheory.AppTheoryMcpServer(stack, "Mcp", {
          handler: handler(stack),
          namingContext: labContext(stack),
          ownedApi: { apiName: "hand-built" },
          sessionState: { enabled: false },
        }),
    ],
    [
      "AppTheoryMcpServer.sessionState.tableName",
      (stack) =>
        new apptheory.AppTheoryMcpServer(stack, "Mcp", {
          handler: handler(stack),
          namingContext: labContext(stack),
          sessionState: { enabled: true, tableName: "hand-built" },
        }),
    ],
    [
      "AppTheorySsrSite.isrMetadataTableName",
      (stack) =>
        new apptheory.AppTheorySsrSite(stack, "Site", {
          ssrFunction: handler(stack),
          namingContext: labContext(stack),
          isrMetadataTableName: "hand-built",
        }),
    ],
    [
      "AppTheorySsrSite.cacheTableName",
      (stack) =>
        new apptheory.AppTheorySsrSite(stack, "Site", {
          ssrFunction: handler(stack),
          namingContext: labContext(stack),
          cacheTableName: "hand-built",
        }),
    ],
    [
      "AppTheoryMediaCdn.bucketName",
      (stack) =>
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: labContext(stack),
          bucketName: "hand-built",
        }),
    ],
    [
      "AppTheoryBucket.bucketName",
      (stack) =>
        new apptheory.AppTheoryBucket(stack, "Data", {
          namingContext: labContext(stack),
          logical: "audit-events",
          bucketName: "hand-built",
        }),
    ],
    [
      "AppTheoryMicrovmController.apiName",
      (stack) => microvmControllerBuild(stack, labContext(stack), { apiName: "hand-built" }),
    ],
    [
      "AppTheoryMicrovmController.sessionTableName",
      (stack) => microvmControllerBuild(stack, labContext(stack), { sessionTableName: "hand-built" }),
    ],
  ];
  for (const [label, build] of cases) {
    assert.throws(() => synth(build), /naming context is present/, label);
  }
});

test("explicit name props keep their pre-contract behaviour with no context", () => {
  const template = synth((stack) => {
    new apptheory.AppTheoryHttpApi(stack, "Api", { handler: handler(stack, "HttpHandler"), apiName: "autheory-api" });
    new apptheory.AppTheoryFunction(stack, "ApiFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({});"),
      functionName: "autheory-fn",
    });
  });
  const apis = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(apis[0].Properties?.Name, "autheory-api");
  assert.match(JSON.stringify(template), /autheory-fn/);
});

// ---- N7: CloudFront standard-profile guards --------------------------------

function synthInRegion(region, build) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: "998115851393", region } });
  build(stack);
  return assertions.Template.fromStack(stack).toJSON();
}

test("CloudFront standard logging refuses a caller-supplied logsBucket", () => {
  for (const [label, build] of [
    [
      "AppTheorySsrSite",
      (stack) => {
        const logsBucket = new s3.Bucket(stack, "CallerLogs");
        new apptheory.AppTheorySsrSite(stack, "Site", {
          ssrFunction: handler(stack),
          namingContext: labContext(stack),
          logsBucket,
        });
      },
    ],
    [
      "AppTheoryPathRoutedFrontend",
      (stack) => {
        const logsBucket = new s3.Bucket(stack, "CallerLogs");
        new apptheory.AppTheoryPathRoutedFrontend(stack, "Frontend", {
          apiOriginUrl: "https://api.example.com",
          namingContext: labContext(stack),
          logsBucket,
        });
      },
    ],
    [
      "AppTheoryMediaCdn",
      (stack) => {
        const logsBucket = new s3.Bucket(stack, "CallerLogs");
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: labContext(stack),
          logsBucket,
        });
      },
    ],
  ]) {
    assert.throws(() => synth(build), /logsBucket/, label);
  }
});

test("CloudFront standard logging refuses a stack outside us-east-1", () => {
  assert.throws(
    () =>
      synthInRegion("eu-west-1", (stack) =>
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: new apptheory.AppTheoryNamingContext(stack, "Naming", {
            app: "autheory",
            stage: "lab",
            account: "998115851393",
            region: "eu-west-1",
            loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
          }),
          logicalName: "media",
        }),
      ),
    /us-east-1/,
  );
});

test("CloudFront standard logging refuses an unresolved stack region", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack");
  assert.throws(() => {
    const context = new apptheory.AppTheoryNamingContext(stack, "Naming", {
      app: "autheory",
      stage: "lab",
      account: "998115851393",
      region: "us-east-1",
      loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    });
    new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: context, logicalName: "media" });
    app.synth();
  }, /resolved stack region/);
});

// ---- N5: keeper visibility ------------------------------------------------

test("AppTheoryKeeperVisibility compiles the policy, role and manifest", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: "998115851393", region: "us-east-1" } });
  const context = labContext(stack);
  new apptheory.AppTheoryHttpApi(stack, "Api", { handler: handler(stack), namingContext: context, logicalName: "main" });
  new apptheory.AppTheoryFunction(stack, "Runtime", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({});"),
    namingContext: context,
    logicalName: "api",
  });
  const visibility = new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
    namingContext: context,
    readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-lab-runtime",
    rules: { include: ["logs/runtime/*", "logs/access/*"], exclude: ["logs/runtime/debug/*"] },
  });

  const preview = visibility.preview();
  assert.equal(preview.ruleVersion.length, 12);
  assert.deepEqual(preview.matchedNow, ["logs/access/api/main", "logs/runtime/api"]);
  assert.deepEqual(preview.notMatchedNow, []);

  const template = assertions.Template.fromStack(stack).toJSON();
  const roles = resourcesOfType(template, "AWS::IAM::Role");
  const reader = roles.find((role) => role.Properties?.RoleName === "autheory-lab-keeper-reader");
  assert.ok(reader, "expected the keeper reader role");
  // r3 (contract section 6): the principal is the reader account, and the
  // role ARN is an `aws:PrincipalArn` condition so the trust survives Keeper
  // deleting and recreating its role.
  assert.deepEqual(JSON.parse(JSON.stringify(reader.Properties.AssumeRolePolicyDocument)), {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::191637461429:root" },
        Action: "sts:AssumeRole",
        Condition: { ArnEquals: { "aws:PrincipalArn": "arn:aws:iam::191637461429:role/cloud-keeper-lab-runtime" } },
      },
    ],
  });

  const rendered = JSON.stringify(reader);
  assert.match(rendered, /logs:FilterLogEvents/);
  assert.match(rendered, /logs:GetLogEvents/);
  assert.match(rendered, /"Deny"/);
  assert.doesNotMatch(rendered, /DescribeLogGroups/);
  assert.doesNotMatch(rendered, /StartLiveTail/);
  assert.doesNotMatch(rendered, /startQuery/i);

  const parameters = resourcesOfType(template, "AWS::SSM::Parameter");
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].Properties?.Name, "/theorycloud/visibility/autheory/lab/manifest");
  const value = parameters[0].Properties?.Value;
  assert.equal(typeof value, "string");
  const manifest = JSON.parse(value);
  assert.equal(manifest.rule_version, preview.ruleVersion);
  assert.deepEqual(manifest.matched_now, ["logs/access/api/main", "logs/runtime/api"]);
  assert.equal("not_matched_now" in manifest, false);
  assert.deepEqual(manifest.future.include, ["logs/access/*", "logs/runtime/*"]);
});

test("AppTheoryKeeperVisibility renders the preview annotation at synth", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: "998115851393", region: "us-east-1" } });
  const context = labContext(stack);
  new apptheory.AppTheoryHttpApi(stack, "Api", { handler: handler(stack), namingContext: context, logicalName: "main" });
  const visibility = new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
    namingContext: context,
    readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-lab-runtime",
    rules: { include: ["logs/access/*"] },
  });

  const template = assertions.Template.fromStack(stack).toJSON();

  // The manifest and the annotation are the same preview: the annotation adds
  // the non-matching sources and prints concrete content, never a lazy token.
  const manifest = JSON.parse(resourcesOfType(template, "AWS::SSM::Parameter")[0].Properties.Value);
  const infos = Node.of(visibility).metadata.filter((entry) => entry.type === "aws:cdk:info");
  assert.ok(infos.length >= 1, "expected the synth-time preview annotation");
  const rendered = infos.map((entry) => String(entry.data)).join("\n");
  assert.ok(
    rendered.includes(manifest.rule_version),
    `annotation must print the rule version, got: ${rendered}`,
  );
  assert.ok(rendered.includes("logs/access/api/main"), "annotation must print a matched source");
  assert.ok(rendered.includes("logs/access/*"), "annotation must print the selector");
  assert.doesNotMatch(rendered, /\$\{Token/);
});

test("AppTheoryKeeperVisibility accepts no rules and reads only the manifest", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack");
  const visibility = new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
    namingContext: labContext(stack),
    readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-lab-runtime",
    rules: {},
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const role = resourcesOfType(template, "AWS::IAM::Role")[0];
  const statements = role.Properties.Policies[0].PolicyDocument.Statement;
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Sid, "ReadManifest");
  assert.equal(visibility.preview().matchedNow.length, 0);
});

test("AppTheoryKeeperVisibility rejects an invalid selector", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
          namingContext: labContext(stack),
          readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-lab-runtime",
          rules: { include: ["logs/*/api"] },
        }),
      ),
    /selector/,
  );
});

// ---- r3 round 1: access-log groups take no naming entry (ADV-1312-1) --------

test("legacy logging keeps today's unnamed access-log group under either naming profile", () => {
  // Legacy naming plus legacy logging: the group keeps the name CloudFormation
  // generates today and consumes no naming entry.
  const legacyTemplate = synthLive((stack) => {
    const context = legacyContext(stack, { pins: { "api_http:api": "autheory-live-api" } });
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      handler: handler(stack),
      namingContext: context,
      stage: { accessLogging: true },
    });
  });
  const legacyGroups = resourcesOfType(legacyTemplate, "AWS::Logs::LogGroup");
  assert.equal(legacyGroups.length, 1);
  assert.equal(legacyGroups[0].Properties?.LogGroupName, undefined);
  assert.equal(legacyGroups[0].Properties?.RetentionInDays, 30);

  // Derived naming plus legacy logging: still today's unnamed group.
  const derivedTemplate = synth((stack) => {
    const context = new apptheory.AppTheoryNamingContext(stack, "Naming", {
      app: "autheory",
      stage: "lab",
      account: "998115851393",
      region: "us-east-1",
      namingProfile: apptheory.AppTheoryNamingProfile.DERIVED,
      loggingProfile: apptheory.AppTheoryLoggingProfile.LEGACY,
    });
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      handler: handler(stack),
      namingContext: context,
      stage: { accessLogging: true },
    });
  });
  const derivedGroups = resourcesOfType(derivedTemplate, "AWS::Logs::LogGroup");
  assert.equal(derivedGroups.length, 1);
  assert.equal(derivedGroups[0].Properties?.LogGroupName, undefined);
});

test("legacy profiles synthesize byte-identically: AppTheoryHttpApi with access logging", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryHttpApi(stack, "Api", {
        handler: handler(stack),
        namingContext: context,
        stage: { accessLogging: true },
        ...(context ? {} : { apiName: "autheory-live-api" }),
      }),
    { pins: { "api_http:api": "autheory-live-api" } },
  );
});

test("a log_group entry naming a construct access-log group is an orphan", () => {
  assert.throws(
    () =>
      synthLive((stack) => {
        const context = legacyContext(stack, {
          pins: { "api_http:api": "autheory-live-api" },
          generated: ["log_group:logs/access/api/api"],
        });
        new apptheory.AppTheoryHttpApi(stack, "Api", {
          handler: handler(stack),
          namingContext: context,
          stage: { accessLogging: true },
        });
      }),
    /match no resource/,
  );
});

// ---- r3 round 1: an API name takes a pin, never a generated entry -----------

test("a generated entry for an API name fails synthesis", () => {
  const builds = [
    ["api_http", (stack, context) => new apptheory.AppTheoryHttpApi(stack, "Api", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "main",
    })],
    ["api_rest", (stack, context) => new apptheory.AppTheoryRestApiRouter(stack, "Router", {
      namingContext: context,
      logicalName: "main",
    })],
    ["api_websocket", (stack, context) => new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      namingContext: context,
      logicalName: "main",
    })],
  ];
  for (const [type, build] of builds) {
    assert.throws(
      () => synth((stack) => build(stack, legacyContext(stack, { generated: [`${type}:main`] }))),
      /API name takes a pin/,
      type,
    );
  }
});

test("the pure primitive refuses a generated API name", () => {
  assert.throws(
    () =>
      apptheory.AppTheoryResourceNaming.physicalName(
        {
          app: "autheory",
          stage: "live",
          account: "784055308075",
          region: "us-east-1",
          namingProfile: "legacy",
          generated: ["api_http:main"],
        },
        "api_http",
        "main",
      ),
    /API name takes a pin/,
  );
});

// ---- r3 round 1: refusal hints name the suffixed entry key (ADV-1312-2) ----

test("explicit-name refusals name the suffixed entry key the construct consumes", () => {
  const cases = [
    [
      /dynamodb_table:ws-connections/,
      (stack) =>
        new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
          handler: handler(stack),
          namingContext: labContext(stack),
          connectionTableName: "hand-built",
        }),
    ],
    [
      /dynamodb_table:mcp-sessions/,
      (stack) =>
        new apptheory.AppTheoryMcpServer(stack, "Mcp", {
          handler: handler(stack),
          namingContext: labContext(stack),
          sessionState: { enabled: true, tableName: "hand-built" },
        }),
    ],
    [
      /s3_bucket:media-media/,
      (stack) =>
        new apptheory.AppTheoryMediaCdn(stack, "Media", {
          namingContext: labContext(stack),
          bucketName: "hand-built",
        }),
    ],
    [
      /dynamodb_table:site-isr-metadata/,
      (stack) =>
        new apptheory.AppTheorySsrSite(stack, "Site", {
          ssrFunction: handler(stack),
          namingContext: labContext(stack),
          isrMetadataTableName: "hand-built",
        }),
    ],
  ];
  for (const [expected, build] of cases) {
    assert.throws(() => synth(build), expected);
  }
});

test("the suffixed entry keys written into stage config are accepted", () => {
  // WebSocket connection table.
  const ws = synthLive((stack) => {
    const context = legacyContext(stack, {
      pins: {
        "api_websocket:ws": "autheory-live-ws",
        "dynamodb_table:ws-connections": "autheory-live-ws-connections",
      },
    });
    new apptheory.AppTheoryWebSocketApi(stack, "Ws", {
      handler: handler(stack),
      namingContext: context,
      enableConnectionTable: true,
    });
  });
  assert.equal(
    resourcesOfType(ws, "AWS::DynamoDB::Table")[0].Properties?.TableName,
    "autheory-live-ws-connections",
  );

  // MCP session table.
  const mcp = synthLive((stack) => {
    const context = legacyContext(stack, {
      pins: {
        "api_http:mcp": "autheory-live-mcp",
        "dynamodb_table:mcp-sessions": "autheory-live-mcp-sessions",
      },
    });
    new apptheory.AppTheoryMcpServer(stack, "Mcp", {
      handler: handler(stack),
      namingContext: context,
      sessionState: { enabled: true },
    });
  });
  assert.equal(
    resourcesOfType(mcp, "AWS::DynamoDB::Table")[0].Properties?.TableName,
    "autheory-live-mcp-sessions",
  );

  // Media bucket.
  const media = synthLive((stack) => {
    const context = legacyContext(stack, { pins: { "s3_bucket:media-media": "autheory-live-media" } });
    new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: context, enableLogging: false });
  });
  assert.equal(resourcesOfType(media, "AWS::S3::Bucket")[0].Properties?.BucketName, "autheory-live-media");

  // SSR assets bucket, html store and ISR metadata table.
  const site = synthLive((stack) => {
    const context = legacyContext(stack, {
      pins: {
        "s3_bucket:site-assets": "autheory-live-site-assets",
        "s3_bucket:site-html-store": "autheory-live-site-html",
        "dynamodb_table:site-isr-metadata": "autheory-live-site-isr",
      },
    });
    new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack),
      namingContext: context,
      htmlStoreKeyPrefix: "isr",
      mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    });
  });
  const bucketNames = resourcesOfType(site, "AWS::S3::Bucket")
    .map((bucket) => bucket.Properties?.BucketName)
    .filter((name) => name !== undefined)
    .sort();
  assert.deepEqual(bucketNames, ["autheory-live-site-assets", "autheory-live-site-html"]);
  const fn = resourcesOfType(site, "AWS::Lambda::Function")[0];
  assert.equal(fn.Properties?.Environment?.Variables?.APPTHEORY_CACHE_TABLE_NAME, "autheory-live-site-isr");
});

// ---- r3 round 1: reader-role trust (contract section 6) --------------------

test("AppTheoryKeeperVisibility refuses an unresolved or malformed reader ARN", () => {
  assert.throws(
    () =>
      synth((stack) =>
        new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
          namingContext: labContext(stack),
          readerPrincipalArn: cdk.Fn.importValue("KeeperRoleArn"),
          rules: {},
        }),
      ),
    /resolved readerPrincipalArn/,
  );
  for (const arn of [
    "arn:aws:iam::12345:role/cloud-keeper",
    "arn:aws:iam::123456789012:user/cloud-keeper",
    "arn:aws:iam::123456789012:role/",
    "not-an-arn",
  ]) {
    assert.throws(
      () =>
        synth((stack) =>
          new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
            namingContext: labContext(stack),
            readerPrincipalArn: arn,
            rules: {},
          }),
        ),
      /12 digits/,
      arn,
    );
  }
});

test("AppTheoryKeeperVisibility refuses wildcards in the reader ARN", () => {
  // ArnEquals matches wildcards, so a reader ARN containing one would admit
  // every role the pattern matches (FAC-1312-R1-1).
  for (const arn of [
    "arn:aws:iam::191637461429:role/cloud-keeper-*",
    "arn:aws:iam::191637461429:role/*",
    "arn:aws:iam::191637461429:role/cloud-keeper-?",
    "arn:aws:iam::191637461429:role/?loud-keeper",
  ]) {
    assert.throws(
      () =>
        synth((stack) =>
          new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
            namingContext: labContext(stack),
            readerPrincipalArn: arn,
            rules: {},
          }),
        ),
      /wildcard/,
      arn,
    );
  }
});

// ---- M2 residual: the MicroVM controller takes a naming context -------------

test("AppTheoryMicrovmController derives its API name and standard access logging", () => {
  const template = synth((stack) => microvmControllerBuild(stack, labContext(stack), { logicalName: "controller" }));

  const apis = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(apis.length, 1);
  assert.equal(apis[0].Properties?.Name, "autheory-lab-controller");

  const accessGroups = resourcesOfType(template, "AWS::Logs::LogGroup").filter((group) =>
    String(group.Properties?.LogGroupName ?? "").includes("logs_access_api"),
  );
  assert.equal(accessGroups.length, 1);
  assert.equal(
    accessGroups[0].Properties.LogGroupName,
    "theorycloud_theorycloud_autheory_lab_logs_access_api_controller",
  );
  assert.equal(accessGroups[0].Properties.RetentionInDays, 30);

  const stage = resourcesOfType(template, "AWS::ApiGatewayV2::Stage").find(
    (resource) => resource.Properties?.AccessLogSettings !== undefined,
  );
  assert.ok(stage, "expected an access-logged controller stage");
  const format = JSON.parse(stage.Properties.AccessLogSettings.Format);
  assert.deepEqual(Object.keys(format).sort(), [
    "httpMethod",
    "integrationLatency",
    "protocol",
    "requestId",
    "requestTime",
    "responseLength",
    "routeKey",
    "sourceIp",
    "status",
  ]);
});

test("AppTheoryMicrovmController allows standard access logging to be opted out", () => {
  const template = synth((stack) =>
    microvmControllerBuild(stack, labContext(stack), {
      logicalName: "controller",
      stage: { accessLogging: false },
    }),
  );
  const accessGroups = resourcesOfType(template, "AWS::Logs::LogGroup").filter((group) =>
    String(group.Properties?.LogGroupName ?? "").includes("logs_access_api"),
  );
  assert.equal(accessGroups.length, 0);
});

test("legacy profiles synthesize byte-identically: AppTheoryMicrovmController", () => {
  assertIdentical(
    (stack, context) =>
      microvmControllerBuild(stack, context, {
        ...(context ? {} : { apiName: "apptheory-controller" }),
        stage: { accessLogging: true },
      }),
    { pins: { "api_http:controller": "apptheory-controller" } },
  );
});

// ---- M2 residual: an external ISR table takes no naming entry ---------------

test("AppTheorySsrSite takes no ISR entry when the caller supplies the metadata table", () => {
  const build = (context) => (stack) => {
    const table = new dynamodb.Table(stack, "ExternalIsr", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    return new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack),
      namingContext: context(stack),
      logicalName: "site",
      isrMetadataTable: table,
    });
  };

  // An external table is the caller's resource, so no naming entry is consumed.
  assert.ok(synth(build((stack) => labContext(stack))));

  // An entry naming the external table is therefore an orphan.
  assert.throws(
    () =>
      synth(
        build((stack) =>
          labContext(stack, { pins: { "dynamodb_table:site-isr-metadata": "external-isr" } }),
        ),
      ),
    /match no resource/,
  );
});

// ---- r4: synth refusal and the derived-name artifact (contract section 11) --

const DERIVED_NAMES_KEY = "apptheory:resource-naming/derived-names";

function synthAssembly(build, env = LAB_ENV) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env });
  build(stack);
  const assembly = app.synth();
  const artifact = assembly.getStackByName("Stack");
  const documents = [];
  for (const entries of Object.values(artifact.metadata ?? {})) {
    for (const entry of entries) {
      if (entry.type === DERIVED_NAMES_KEY) documents.push(entry.data);
    }
  }
  return { template: JSON.parse(JSON.stringify(artifact.template ?? {})), documents };
}

function synthAssemblyLive(build) {
  return synthAssembly(build, LIVE_ENV);
}

function shopContext(stack, id = "Naming", overrides = {}) {
  return new apptheory.AppTheoryNamingContext(stack, id, {
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
    ...overrides,
  });
}

function shopFunction(stack, id, logicalName, context) {
  return new apptheory.AppTheoryFunction(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
    namingContext: context,
    logicalName,
  });
}

test("R1: two logical resources deriving one name in one scope fail synthesis", () => {
  // logistics: `site/status` and `site-status` both compose shop-lab-site-status,
  // the separator ambiguity the r4 contract exists to catch (docs/155).
  assert.throws(
    () =>
      synth((stack) => {
        const context = shopContext(stack);
        shopFunction(stack, "Slash", "site/status", context);
        shopFunction(stack, "Dash", "site-status", context);
      }),
    (error) => {
      const message = String(error.message);
      assert.match(
        message,
        /AppTheoryNamingContext (\S+) and (\S+) derive shop-lab-site-status in scope account_region/,
      );
      const [, first, second] = message.match(/AppTheoryNamingContext (\S+) and (\S+) derive /);
      assert.notEqual(first, second);
      assert.match(message, /two different logical resources in one naming context cannot share a physical name/);
      return true;
    },
  );
});

test("R1: the refusal names the scope of an account-global type", () => {
  assert.throws(
    () =>
      synth((stack) => {
        const context = shopContext(stack);
        new apptheory.AppTheoryKeeperVisibility(stack, "First", {
          namingContext: context,
          readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
          rules: {},
        });
        new apptheory.AppTheoryKeeperVisibility(stack, "Second", {
          namingContext: context,
          readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
          rules: {},
        });
      }),
    /derive shop-lab-keeper-reader in scope account/,
  );
});

test("R2: a Lambda function and its IAM role may share a name", () => {
  const { documents } = synthAssembly((stack) => {
    shopFunction(stack, "Worker", "worker", shopContext(stack));
  });
  assert.equal(documents.length, 1);
  const rows = documents[0].entries.filter((entry) => entry.name === "shop-lab-worker");
  assert.deepEqual(
    rows.map((row) => [row.type, row.scope]).sort(),
    [
      ["iam_role", "account"],
      ["lambda_function", "account_region"],
    ],
  );
});

test("R2: two APIs may share a name because AWS does not keep API names unique", () => {
  const { documents, template } = synthAssembly((stack) => {
    const context = shopContext(stack);
    new apptheory.AppTheoryHttpApi(stack, "First", {
      namingContext: context,
      logicalName: "api",
      handler: handler(stack, "FirstHandler"),
    });
    new apptheory.AppTheoryHttpApi(stack, "Second", {
      namingContext: context,
      logicalName: "api",
      handler: handler(stack, "SecondHandler"),
    });
  });
  const apiNames = resourcesOfType(template, "AWS::ApiGatewayV2::Api")
    .map((api) => api.Properties?.Name)
    .filter((name) => name !== undefined);
  assert.deepEqual(apiNames, ["shop-lab-api", "shop-lab-api"]);
  const rows = documents[0].entries.filter((entry) => entry.type === "api_http");
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.scope, "not_unique");
});

test("R3: every physically named resource AppTheory declares lands in the artifact", () => {
  const { documents, template } = synthAssembly((stack) => {
    const context = shopContext(stack, "Naming", { loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD });
    shopFunction(stack, "Worker", "worker", context);
    new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
  });
  assert.equal(documents.length, 1);
  const document = documents[0];
  assert.equal(document.contract, "theorycloud_resource_naming.v0.1");
  assert.equal(document.schema, "apptheory_resource_naming.derived_names.v1");
  assert.deepEqual(document.context, {
    namespace: "theorycloud",
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });

  const logicalIds = new Set(Object.keys(template.Resources));
  assert.ok(document.entries.length >= 4);
  for (const row of document.entries) {
    assert.ok(logicalIds.has(row.logical_id), `${row.logical_id} is not a template resource`);
    assert.equal(typeof row.type, "string");
    assert.ok(["account", "account_region", "not_unique"].includes(row.scope));
  }
  assert.deepEqual(
    document.entries.map((row) => row.type).sort(),
    ["iam_role", "lambda_function", "log_group", "s3_bucket"],
  );
  const bucket = document.entries.find((row) => row.type === "s3_bucket");
  assert.equal(bucket.name, "shop-lab-site-assets-998115851393-us-east-1-an");
  const logGroup = document.entries.find((row) => row.type === "log_group");
  assert.equal(logGroup.name, "theorycloud_theorycloud_shop_lab_logs_runtime_worker");
  assert.equal(logGroup.scope, "account_region");
});

test("R3: the artifact is deterministic in order and bytes", () => {
  const build = (stack) => {
    const context = shopContext(stack);
    shopFunction(stack, "Worker", "worker", context);
    new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      namingContext: context,
      logicalName: "api",
      handler: handler(stack, "ApiHandler"),
    });
  };
  const reversed = (stack) => {
    const context = shopContext(stack);
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      namingContext: context,
      logicalName: "api",
      handler: handler(stack, "ApiHandler"),
    });
    new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
    shopFunction(stack, "Worker", "worker", context);
  };
  const first = synthAssembly(build);
  const again = synthAssembly(build);
  const other = synthAssembly(reversed);
  assert.equal(JSON.stringify(first.documents), JSON.stringify(again.documents));
  assert.equal(JSON.stringify(first.documents), JSON.stringify(other.documents));

  const keys = first.documents[0].entries.map((row) =>
    [row.scope, row.type, row.name ?? "", row.logical_id].join("\u0000"),
  );
  assert.deepEqual(keys, [...keys].sort());
});

test("R3: a generated entry is marked and carries no name", () => {
  const { documents } = synthAssemblyLive((stack) => {
    const context = new apptheory.AppTheoryNamingContext(stack, "Naming", {
      app: "shop",
      stage: "live",
      account: "784055308075",
      region: "us-east-1",
      namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
      generated: ["lambda_function:worker", "iam_role:worker"],
    });
    shopFunction(stack, "Worker", "worker", context);
  });
  const rows = documents[0].entries;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.generated, true);
    assert.equal(row.name, undefined);
  }
  assert.deepEqual(rows.map((row) => row.type).sort(), ["iam_role", "lambda_function"]);
});

test("R5: a stack without a naming context emits no artifact", () => {
  const { documents, template } = synthAssembly((stack) => {
    new lambda.Function(stack, "Plain", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
    });
  });
  assert.deepEqual(documents, []);
  assert.equal(resourcesOfType(template, "AWS::S3::Bucket").length, 0);
});

test("R4: the jsii scope and synth-check primitives refuse an unknown type", () => {
  const naming = apptheory.AppTheoryResourceNaming;
  assert.equal(naming.namingScope("dashboard"), "account");
  assert.equal(naming.namingScope("api_websocket"), "not_unique");
  assert.equal(naming.namingScope("dynamodb_table"), "account_region");
  assert.throws(() => naming.namingScope("opensearch_domain"), /no stated naming scope/);
  assert.deepEqual(
    naming.synthCheck([
      { type: "lambda_function", name: "shop-lab-worker", logicalId: "Worker" },
      { type: "iam_role", name: "shop-lab-worker", logicalId: "WorkerRole" },
    ]),
    [
      { name: "shop-lab-worker", type: "lambda_function", scope: "account_region", logicalId: "Worker" },
      { name: "shop-lab-worker", type: "iam_role", scope: "account", logicalId: "WorkerRole" },
    ],
  );
  assert.throws(
    () =>
      naming.synthCheck([
        { type: "dashboard", name: "shop-lab-lab-site-status", logicalId: "LabSiteStatus" },
        { type: "dashboard", name: "shop-lab-lab-site-status", logicalId: "SiteStatus" },
      ]),
    /LabSiteStatus and SiteStatus derive shop-lab-lab-site-status in scope account/,
  );
});

// ---- r4 rework r1: artifact completeness and stack attribution -------------

function metadataDocuments(artifact) {
  const documents = [];
  for (const entries of Object.values(artifact.metadata ?? {})) {
    for (const entry of entries) {
      if (entry.type === DERIVED_NAMES_KEY) documents.push(entry.data);
    }
  }
  return documents;
}

function namedResourcesOfType(template, type) {
  return Object.entries(template.Resources ?? {})
    .filter(([, resource]) => resource.Type === type)
    .map(([logicalId, resource]) => ({ logicalId, properties: resource.Properties ?? {} }));
}

test("F1a: the legacy-profile Lambda service log group is declared", () => {
  // AppTheoryFunction creates `/aws/lambda/{function name}` itself under the
  // default (legacy) logging profile. The name is the context's, so a synth
  // without this declaration under-reports the reserved set (SANITY-AT-N3-01).
  const { documents, template } = synthAssembly((stack) => {
    shopFunction(stack, "Worker", "worker", shopContext(stack));
  });
  assert.equal(documents.length, 1);
  const logGroups = namedResourcesOfType(template, "AWS::Logs::LogGroup");
  assert.equal(logGroups.length, 1);
  assert.equal(logGroups[0].properties.LogGroupName, "/aws/lambda/shop-lab-worker");

  const rows = documents[0].entries.filter((row) => row.type === "log_group");
  assert.deepEqual(rows, [
    { name: "/aws/lambda/shop-lab-worker", type: "log_group", scope: "account_region", logical_id: logGroups[0].logicalId },
  ]);
  // Every row still names a resource the template holds.
  assert.ok(Object.keys(template.Resources).includes(rows[0].logical_id));
});

test("F1a: two functions colliding on a derived name also collide on the derived log group", () => {
  assert.throws(
    () =>
      synth((stack) => {
        const context = shopContext(stack);
        shopFunction(stack, "Slash", "site/status", context);
        shopFunction(stack, "Dash", "site-status", context);
      }),
    /derive shop-lab-site-status in scope account_region/,
  );
});

test("F1b: the visibility manifest parameter is declared with its fixed contract path", () => {
  const { documents, template } = synthAssembly((stack) => {
    new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
      namingContext: shopContext(stack),
      readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
      rules: {},
    });
  });
  assert.equal(documents.length, 1);
  const parameters = namedResourcesOfType(template, "AWS::SSM::Parameter");
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].properties.Name, "/theorycloud/visibility/shop/lab/manifest");

  const rows = documents[0].entries.filter((row) => row.type === "ssm_parameter");
  assert.deepEqual(rows, [
    {
      name: "/theorycloud/visibility/shop/lab/manifest",
      type: "ssm_parameter",
      scope: "account_region",
      logical_id: parameters[0].logicalId,
    },
  ]);
});

test("F1b: declaring a fixed name refuses a type with no stated naming scope", () => {
  assert.throws(
    () =>
      synth((stack) => {
        const context = shopContext(stack);
        const role = new apptheory.AppTheoryLambdaRole(stack, "Role", { assumedBy: handler(stack, "Owner") });
        context.declareFixedName("opensearch_domain", "shop-lab-search", role);
      }),
    /no stated naming scope/,
  );
});

test("F1c: the artifact covers every context-derived name AppTheory creates in the stack", () => {
  // The audit: every construct that derives a name from the context and creates
  // the resource locally must declare it. This stack exercises the constructs
  // whose names come from the context, and pins the complete row set.
  const { documents, template } = synthAssembly((stack) => {
    const context = shopContext(stack, "Naming", {
      loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    });
    shopFunction(stack, "Worker", "worker", context);
    new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
    new apptheory.AppTheoryHttpApi(stack, "Api", {
      namingContext: context,
      logicalName: "api",
      handler: handler(stack, "ApiHandler"),
    });
    new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
      namingContext: context,
      readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
      rules: {},
    });
  });
  assert.equal(documents.length, 1);
  const document = documents[0];

  const expected = [
    ["api_http", "shop-lab-api", "not_unique"],
    ["iam_role", "shop-lab-worker", "account"],
    ["iam_role", "shop-lab-keeper-reader", "account"],
    ["lambda_function", "shop-lab-worker", "account_region"],
    ["log_group", "theorycloud_theorycloud_shop_lab_logs_runtime_worker", "account_region"],
    ["log_group", "theorycloud_theorycloud_shop_lab_logs_access_api_api", "account_region"],
    ["s3_bucket", "shop-lab-site-assets-998115851393-us-east-1-an", "account_region"],
    ["ssm_parameter", "/theorycloud/visibility/shop/lab/manifest", "account_region"],
  ];
  assert.deepEqual(
    document.entries.map((row) => [row.type, row.name, row.scope]).sort(),
    expected.sort(),
  );

  // Each row is a resource the stack's own template holds.
  const logicalIds = new Set(Object.keys(template.Resources));
  for (const row of document.entries) assert.ok(logicalIds.has(row.logical_id), row.logical_id);
});

test("F1c: names built from a construct's own props stay outside the artifact and are not reserved", () => {
  // AppTheoryApp names its function and tables from `appName`, not from the
  // context (Factory scope decision for r1). Those names are deliberately not
  // in the artifact, so this test pins the exclusion instead of implying it.
  const { documents, template } = synthAssembly((stack) => {
    new apptheory.AppTheoryApp(stack, "App", {
      appName: "shop-lab-worker",
      code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      namingContext: shopContext(stack),
      enableDatabase: true,
    });
  });
  const declaredNames = new Set(documents.flatMap((document) => document.entries.map((row) => row.name ?? "")));
  const createdNames = new Set(
    Object.values(template.Resources)
      .map((resource) => resource.Properties?.FunctionName ?? resource.Properties?.TableName)
      .filter((name) => name !== undefined),
  );
  assert.ok(createdNames.has("shop-lab-worker"));
  assert.ok(createdNames.has("shop-lab-worker-table"));
  for (const name of createdNames) assert.equal(declaredNames.has(name), false, name);
});

test("F1c: the ISR metadata table name AppTheory wires but does not create stays undeclared", () => {
  const { documents, template } = synthAssembly((stack) => {
    new apptheory.AppTheorySsrSite(stack, "Site", {
      ssrFunction: handler(stack, "Ssr"),
      namingContext: shopContext(stack),
      logicalName: "site",
      mode: apptheory.AppTheorySsrSiteMode.SSG_ISR,
    });
  });
  // The construct consumes the entry and wires the name into the SSR function...
  const functions = namedResourcesOfType(template, "AWS::Lambda::Function");
  const wired = functions.some(
    (fn) => fn.properties.Environment?.Variables?.APPTHEORY_CACHE_TABLE_NAME === "shop-lab-site-isr-metadata",
  );
  assert.ok(wired);
  // ...but another stack owns the table, so this stack's artifact does not
  // declare it (contract section 11.4: the owner declares its own resource).
  assert.equal(namedResourcesOfType(template, "AWS::DynamoDB::Table").length, 0);
  const rows = documents.flatMap((document) => document.entries);
  assert.equal(rows.filter((row) => row.type === "dynamodb_table").length, 0);
  assert.equal(rows.filter((row) => row.name === "shop-lab-site-isr-metadata").length, 0);
});

test("F2: a shared context attributes each entry to the stack that holds its logical id", () => {
  const app = new cdk.App();
  const owner = new cdk.Stack(app, "Owner");
  const consumer = new cdk.Stack(app, "Consumer");
  const context = new apptheory.AppTheoryNamingContext(owner, "Naming", {
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });
  new apptheory.AppTheoryBucket(owner, "Assets", { namingContext: context, logical: "site-assets" });
  new apptheory.AppTheoryFunction(consumer, "Worker", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
    namingContext: context,
    logicalName: "worker",
  });

  const assembly = app.synth();
  const ownerArtifact = assembly.getStackByName("Owner");
  const consumerArtifact = assembly.getStackByName("Consumer");
  const ownerDocuments = metadataDocuments(ownerArtifact);
  const consumerDocuments = metadataDocuments(consumerArtifact);

  const consumerLogicalIds = new Set(Object.keys(consumerArtifact.template.Resources));
  const ownerLogicalIds = new Set(Object.keys(ownerArtifact.template.Resources));

  // The consumer stack has its own document, and it describes its own resources.
  assert.equal(consumerDocuments.length, 1);
  assert.ok(consumerDocuments[0].entries.length > 0);
  for (const row of consumerDocuments[0].entries) {
    assert.ok(consumerLogicalIds.has(row.logical_id), `${row.logical_id} is not in Consumer`);
  }
  assert.deepEqual(
    consumerDocuments[0].entries.map((row) => row.type).sort(),
    ["iam_role", "lambda_function", "log_group"],
  );

  // The owner stack's document holds only the owner's resources.
  assert.equal(ownerDocuments.length, 1);
  for (const row of ownerDocuments[0].entries) {
    assert.ok(ownerLogicalIds.has(row.logical_id), `${row.logical_id} is not in Owner`);
    assert.equal(consumerLogicalIds.has(row.logical_id), false, row.logical_id);
  }
  assert.deepEqual(ownerDocuments[0].entries.map((row) => row.type), ["s3_bucket"]);

  // Neither document claims the other stack's resources.
  const ownerRows = JSON.stringify(ownerDocuments[0].entries);
  for (const logicalId of consumerLogicalIds) assert.equal(ownerRows.includes(logicalId), false, logicalId);
});

test("F2: a cross-stack collision in one context is still refused", () => {
  assert.throws(() => {
    const app = new cdk.App();
    const owner = new cdk.Stack(app, "Owner");
    const consumer = new cdk.Stack(app, "Consumer");
    const context = new apptheory.AppTheoryNamingContext(owner, "Naming", {
      app: "shop",
      stage: "lab",
      account: "998115851393",
      region: "us-east-1",
    });
    new apptheory.AppTheoryBucket(owner, "OwnerBucket", { namingContext: context, logical: "shared" });
    new apptheory.AppTheoryBucket(consumer, "ConsumerBucket", { namingContext: context, logical: "shared" });
    app.synth();
  }, /derive shop-lab-shared-998115851393-us-east-1-an in scope account_region/);
});

test("F3: the jsii scope primitive refuses inherited property names", () => {
  const naming = apptheory.AppTheoryResourceNaming;
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => naming.namingScope(inherited), /no stated naming scope/, inherited);
    assert.throws(
      () =>
        naming.synthCheck([
          { type: inherited, name: "shop-lab-worker", logicalId: "Worker" },
        ]),
      /no stated naming scope/,
      inherited,
    );
  }
});

// ---- r4 rework r2: identity, Stage, empty document, fixed names --------------
//
// Each test below pins one defect the round-2 gate found. They are written to
// fail on the round-1 tree and pass here:
// SANITY-AT-N3-05 (G1), SANITY-AT-N3-02 (G2), SANITY-AT-N3-07 (G4) and
// SANITY-AT-N3-08 / ADV-N3-R1-01 (G5). The G3 environment cases are gone: the
// operator ruled on 2026-11-25 that AppTheory does not compare a stack's
// environment with the naming context's (see the round-4 section below).

function multiStack(build) {
  const app = new cdk.App();
  build(app);
  return app;
}

test("G1: two stacks sharing a context cannot repeat a construct id and a name", () => {
  // A CloudFormation logical id is unique only inside one template, so two
  // stacks with the same construct id produced identical stack-local logical
  // ids and the round-1 check read the second resource as a re-declaration of
  // the first: the Lambda, its role and its log group collided and synth
  // succeeded (SANITY-AT-N3-05). The identity is now the owning stack plus the
  // logical id, so the refusal fires and names both resources and both stacks.
  assert.throws(
    () =>
      multiStack((app) => {
        const one = new cdk.Stack(app, "One", { env: LAB_ENV });
        const two = new cdk.Stack(app, "Two", { env: LAB_ENV });
        const context = shopContext(one);
        shopFunction(one, "Worker", "worker", context);
        shopFunction(two, "Worker", "worker", context);
        app.synth();
      }),
    (error) => {
      const message = String(error.message);
      assert.match(message, /AppTheoryNamingContext One\/WorkerFunction[0-9A-F]{8} and Two\/WorkerFunction[0-9A-F]{8} derive shop-lab-worker in scope account_region/);
      assert.match(message, /two different logical resources in one naming context cannot share a physical name/);
      return true;
    },
  );
});

test("G1: re-declaring the same resource is admitted once", () => {
  const { documents, template } = synthAssembly((stack) => {
    const context = shopContext(stack);
    const worker = shopFunction(stack, "Worker", "worker", context);
    // The same CloudFormation resource declared twice is one resource, not two:
    // the identity matches, so the check admits it and the artifact lists it once.
    context.declareName("lambda_function", "worker", worker.fn);
  });
  assert.equal(documents.length, 1);
  const workers = documents[0].entries.filter((row) => row.type === "lambda_function");
  assert.equal(workers.length, 1);
  assert.equal(workers[0].name, "shop-lab-worker");
  assert.ok(Object.keys(template.Resources).includes(workers[0].logical_id));
});

test("G1: a shared context keeps each stack's own template-local logical id", () => {
  // Different logical names: no collision, and each stack's document carries the
  // logical id its own template holds — the id the installer joins on.
  const app = multiStack((scope) => {
    const one = new cdk.Stack(scope, "One", { env: LAB_ENV });
    const two = new cdk.Stack(scope, "Two", { env: LAB_ENV });
    const context = shopContext(one);
    shopFunction(one, "Worker", "worker", context);
    shopFunction(two, "Worker", "api", context);
  });
  const assembly = app.synth();
  const one = assembly.getStackByName("One");
  const two = assembly.getStackByName("Two");
  const oneRows = metadataDocuments(one)[0].entries;
  const twoRows = metadataDocuments(two)[0].entries;

  const oneFunctions = oneRows.filter((row) => row.type === "lambda_function");
  const twoFunctions = twoRows.filter((row) => row.type === "lambda_function");
  assert.equal(oneFunctions.length, 1);
  assert.equal(twoFunctions.length, 1);
  assert.equal(oneFunctions[0].name, "shop-lab-worker");
  assert.equal(twoFunctions[0].name, "shop-lab-api");
  assert.ok(Object.keys(one.template.Resources).includes(oneFunctions[0].logical_id));
  assert.ok(Object.keys(two.template.Resources).includes(twoFunctions[0].logical_id));
});

test("G2: a declaration in a child Stage under a context above it is refused", () => {
  // CDK validates one Stage at a time and every Stage is its own cloud
  // assembly, so a context above a Stage cannot compare names and its document
  // for that assembly is silently lost (SANITY-AT-N3-02). Refuse instead.
  assert.throws(
    () =>
      multiStack((app) => {
        const root = new cdk.Stack(app, "Root", { env: LAB_ENV });
        const context = shopContext(root);
        const stage = new cdk.Stage(app, "Child");
        const stack = new cdk.Stack(stage, "Stack", { env: LAB_ENV });
        shopFunction(stack, "Worker", "worker", context);
        app.synth();
      }),
    (error) => {
      const message = String(error.message);
      assert.match(message, /cannot declare lambda_function in Root\/Child\/Stack|Child\/Stack/);
      assert.match(message, /Stage Child/);
      assert.match(message, /the App root/);
      assert.match(message, /must sit in the same Stage/);
      return true;
    },
  );
});

test("G2: a context inside the Stage emits its documents into that Stage", () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-naming-stage-"));
  const app = new cdk.App({ outdir });
  const stage = new cdk.Stage(app, "Child");
  const context = shopContext(new cdk.Stack(stage, "Home", { env: LAB_ENV }));
  const stack = new cdk.Stack(stage, "Stack", { env: LAB_ENV });
  shopFunction(stack, "Worker", "worker", context);
  const assembly = app.synth();

  const childStacks = assembly.stacksRecursively.filter((artifact) => artifact.id.includes("Stack"));
  const workerStack = childStacks.find((artifact) => Object.keys(artifact.template ?? {}).length > 0);
  assert.ok(workerStack, "the child stage's stack must exist");
  const documents = metadataDocuments(workerStack);
  assert.equal(documents.length, 1);
  assert.deepEqual(
    documents[0].entries.map((row) => row.type).sort(),
    ["iam_role", "lambda_function", "log_group"],
  );
  for (const row of documents[0].entries) {
    assert.ok(Object.keys(workerStack.template.Resources).includes(row.logical_id), row.logical_id);
  }
});

test("G2: a nested-stack row joins to the nested template, not the parent's", () => {
  // The document is recorded under the owning stack's construct path, and CDK
  // writes that path's `aws:cdk:templateFile` beside it. That pair is the join:
  // the rows describe the template named there — for a NestedStack, the nested
  // template — and never the parent's.
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "apptheory-naming-nested-"));
  const app = new cdk.App({ outdir });
  const parent = new cdk.Stack(app, "Parent", { env: LAB_ENV });
  const context = shopContext(parent);
  new apptheory.AppTheoryBucket(parent, "Assets", { namingContext: context, logical: "site-assets" });
  const nested = new cdk.NestedStack(parent, "Child");
  shopFunction(nested, "Worker", "worker", context);
  const assembly = app.synth();

  const parentArtifact = assembly.getStackByName("Parent");
  const metadata = parentArtifact.metadata ?? {};
  const parentTemplate = JSON.parse(fs.readFileSync(path.join(outdir, "Parent.template.json"), "utf8"));
  const parentLogicalIds = new Set(Object.keys(parentTemplate.Resources ?? {}));

  const documents = {};
  const templateFiles = {};
  for (const [constructPath, entries] of Object.entries(metadata)) {
    for (const entry of entries) {
      if (entry.type === DERIVED_NAMES_KEY) documents[constructPath] = entry.data;
      if (entry.type === "aws:cdk:templateFile") templateFiles[constructPath] = entry.data;
    }
  }

  const nestedPath = Object.keys(documents).find((constructPath) => constructPath === "/Parent/Child");
  assert.ok(nestedPath, `the nested stack must own a document: ${Object.keys(documents)}`);
  assert.ok(!("/Parent" in documents) || documents["/Parent"].entries.every((row) => row.type !== "lambda_function"));

  const nestedTemplateFile = templateFiles[nestedPath];
  assert.match(nestedTemplateFile, /\.nested\.template\.json$/);
  const nestedTemplate = JSON.parse(fs.readFileSync(path.join(outdir, nestedTemplateFile), "utf8"));
  const nestedLogicalIds = new Set(Object.keys(nestedTemplate.Resources ?? {}));

  const nestedRows = documents[nestedPath].entries;
  assert.deepEqual(nestedRows.map((row) => row.type).sort(), ["iam_role", "lambda_function", "log_group"]);
  for (const row of nestedRows) {
    assert.ok(nestedLogicalIds.has(row.logical_id), `${row.logical_id} is not in ${nestedTemplateFile}`);
    assert.equal(parentLogicalIds.has(row.logical_id), false, `${row.logical_id} must not be a parent resource`);
  }

  // The parent's own document describes only what the parent's template holds.
  assert.ok("/Parent" in documents, "the parent keeps its own document");
  assert.deepEqual(
    documents["/Parent"].entries.map((row) => row.type),
    ["s3_bucket"],
  );
  for (const row of documents["/Parent"].entries) assert.ok(parentLogicalIds.has(row.logical_id));
});

test("G4: a context that declares nothing still emits the artifact, and no context emits none", () => {
  // Scenario 4: every synth with a naming context emits the artifact, so a
  // context whose declarations all attribute to other stacks still leaves an
  // explicit (empty) document on its own stack. Scenario 5: a stack without a
  // context emits none. The installer must be able to tell them apart
  // (SANITY-AT-N3-07).
  const declared = multiStack((app) => {
    const stack = new cdk.Stack(app, "Stack", { env: LAB_ENV });
    shopContext(stack);
  });
  const declaredDocuments = metadataDocuments(declared.synth().getStackByName("Stack"));
  assert.equal(declaredDocuments.length, 1);
  assert.equal(declaredDocuments[0].contract, "theorycloud_resource_naming.v0.1");
  assert.equal(declaredDocuments[0].schema, "apptheory_resource_naming.derived_names.v1");
  assert.deepEqual(declaredDocuments[0].entries, []);
  assert.deepEqual(declaredDocuments[0].context, {
    namespace: "theorycloud",
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });

  const without = multiStack((app) => {
    const stack = new cdk.Stack(app, "Stack", { env: LAB_ENV });
    handler(stack, "Plain");
  });
  assert.deepEqual(metadataDocuments(without.synth().getStackByName("Stack")), []);
});

test("G4: a context above the stacks still labels the stack it declares nothing in", () => {
  // The context's own stack gets the empty document; the stacks its constructs
  // declare in keep their own. No stack claims another's rows.
  const app = multiStack((scope) => {
    const owner = new cdk.Stack(scope, "Owner", { env: LAB_ENV });
    const consumer = new cdk.Stack(scope, "Consumer", { env: LAB_ENV });
    const context = shopContext(owner);
    shopFunction(consumer, "Worker", "worker", context);
  });
  const assembly = app.synth();
  const ownerDocuments = metadataDocuments(assembly.getStackByName("Owner"));
  assert.equal(ownerDocuments.length, 1);
  assert.deepEqual(ownerDocuments[0].entries, []);

  const consumerDocuments = metadataDocuments(assembly.getStackByName("Consumer"));
  assert.equal(consumerDocuments.length, 1);
  assert.equal(consumerDocuments[0].entries.length, 3);
});

test("G5: a fixed name outside its type's section 2 rules fails synthesis", () => {
  // declareFixedName accepted any string, so a name AWS can never create
  // entered the artifact and the installer reserved it (SANITY-AT-N3-08,
  // ADV-N3-R1-01). The name is now checked against the section 2 rule row of
  // its type.
  const cases = [
    ["shop lab bucket", /must match \[a-z0-9-\]/],
    ["shop\u0000lab-bucket", /must match \[a-z0-9-\]/],
    ["Bad Bucket Name!!", /must match \[a-z0-9-\]/],
  ];
  for (const [name, pattern] of cases) {
    assert.throws(
      () =>
        synth((stack) => {
          const context = shopContext(stack);
          const bucket = new cdk.CfnResource(stack, "Fixed", {
            type: "AWS::S3::Bucket",
            properties: { BucketName: name },
          });
          context.declareFixedName("s3_bucket", name, bucket);
        }),
      (error) => {
        assert.match(String(error.message), pattern, name);
        assert.match(String(error.message), /contract section 2/, name);
        return true;
      },
      name,
    );
  }
});

test("G5: a fixed name outside its type's shape rules fails synthesis", () => {
  const cases = [
    ["s3_bucket", "-shop-lab-assets", /start and end with a letter or digit/],
    ["secret", "shop-lab-secret-ab12cd", /must not end with a hyphen and six characters/],
    ["ssm_parameter", "/aws/shop-lab-parameter", /must not begin with aws or ssm/],
    ["ssm_parameter", "/ssm/shop-lab-parameter", /must not begin with aws or ssm/],
    ["ssm_parameter", "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p", /at most 15 levels/],
    ["kms_alias", "shop-lab-key", /must start with "alias\/"/],
    ["kms_alias", "alias/aws/shop-lab", /must not be in the alias\/aws\/ namespace/],
    ["log_group", "aws/shop-lab", /must not begin with aws\//],
  ];
  for (const [type, name, pattern] of cases) {
    assert.throws(
      () => apptheory.AppTheoryResourceNaming.validatePhysicalName(type, name),
      pattern,
      `${type}: ${name}`,
    );
  }
});

test("G5: the fixed names AppTheory actually declares stay admitted", () => {
  const naming = apptheory.AppTheoryResourceNaming;
  // The two fixed names the contract states: the Lambda service log group
  // (section 3) and the visibility manifest parameter (section 6).
  naming.validatePhysicalName("log_group", "/aws/lambda/shop-lab-worker");
  naming.validatePhysicalName("ssm_parameter", "/theorycloud/visibility/shop/lab/manifest");
  // And the derived shapes of the same types stay valid, so the rule is the
  // section 2 row and not a stricter private one.
  naming.validatePhysicalName("log_group", "theorycloud_theorycloud_shop_lab_logs_runtime_worker");
  naming.validatePhysicalName("s3_bucket", "shop-lab-site-assets-998115851393-us-east-1-an");
  naming.validatePhysicalName("iam_role", "shop-lab-worker");

  // The Keeper manifest path still reaches the artifact through the construct
  // that creates it.
  const { documents, template } = synthAssembly((stack) => {
    new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
      namingContext: shopContext(stack),
      readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
      rules: {},
    });
  });
  const parameters = namedResourcesOfType(template, "AWS::SSM::Parameter");
  assert.equal(parameters[0].properties.Name, "/theorycloud/visibility/shop/lab/manifest");
  assert.equal(
    documents[0].entries.filter((row) => row.type === "ssm_parameter").length,
    1,
  );
});

test("G5: a fixed name naming a type the contract does not state is still refused first", () => {
  assert.throws(
    () => apptheory.AppTheoryResourceNaming.validatePhysicalName("opensearch_domain", "shop-lab-search"),
    /no stated naming scope/,
  );
  assert.throws(
    () => apptheory.AppTheoryResourceNaming.validatePhysicalName("toString", "shop-lab-search"),
    /no stated naming scope/,
  );
});

// ---- r4 rework r3: the section 2 rows --------------------------------------
//
// Each test below pins one defect the round-3 gate found, and they fail on the
// round-2 tree: SANITY-AT-N3-08 / ADV-N3-R2-01 (H2, the fixed-name check
// enforced only some of the section 2 rows). Round 3's H1 environment check was
// removed by the operator ruling of 2026-11-25; the round-4 section below pins
// what replaced it.

test("H2: a fixed dynamodb_table name under the section 2 minimum length fails synthesis", () => {
  // Section 2 states the plain-name limit as 3–255. Only the upper bound was
  // enforced, so `ab` and `a` entered the artifact (SANITY-AT-N3-08).
  for (const name of ["ab", "a"]) {
    assert.throws(
      () =>
        synth((stack) => {
          const context = shopContext(stack);
          const table = new cdk.CfnResource(stack, "Fixed", {
            type: "AWS::DynamoDB::Table",
            properties: { TableName: name },
          });
          context.declareFixedName("dynamodb_table", name, table);
        }),
      /must be at least 3 characters/,
      name,
    );
  }
});

test("H2: a fixed log_group name that is neither a log source nor the Lambda service path fails synthesis", () => {
  // The `/` charset extension was applied to every log_group name, so any
  // path-shaped string was admitted. Section 3 states two shapes only.
  const cases = [
    ["arbitrary/path", /must be either a section 3 log-source name/],
    ["/aws/shop-lab", /must be either a section 3 log-source name/],
    ["/aws/lambda/", /must be either a section 3 log-source name/],
    ["/aws/lambda/worker/suffix", /must be either a section 3 log-source name/],
    [`/aws/lambda/${"a".repeat(65)}`, /must be either a section 3 log-source name/],
  ];
  for (const [name, pattern] of cases) {
    assert.throws(
      () => apptheory.AppTheoryResourceNaming.validatePhysicalName("log_group", name),
      pattern,
      name,
    );
  }
});

test("H2: a fixed ssm_parameter name without a non-empty segment after its lead fails synthesis", () => {
  const cases = ["/", "//", "/a//b", "/a/"];
  for (const name of cases) {
    assert.throws(
      () => apptheory.AppTheoryResourceNaming.validatePhysicalName("ssm_parameter", name),
      /at least one non-empty segment after its lead/,
      name,
    );
  }
});

test("H2: a fixed kms_alias name without a name after alias/ fails synthesis", () => {
  assert.throws(
    () => apptheory.AppTheoryResourceNaming.validatePhysicalName("kms_alias", "alias/"),
    /must carry a non-empty name after its "alias\/" lead/,
  );
});

test("H2: every section 2 length limit is enforced at both ends", () => {
  // The audit of the section 2 table: each row's upper limit is enforced, and
  // the one row that also states a lower limit enforces it. A row that states
  // no lower limit has none, so the check is the contract's and not a stricter
  // private one.
  const fill = (length) => "a".repeat(length);
  const rows = [
    ["s3_bucket", 63, null, fill],
    ["s3_vector_bucket", 63, null, fill],
    ["s3_vector_index", 63, null, fill],
    ["dynamodb_table", 255, 3, fill],
    ["lambda_function", 64, null, fill],
    ["sqs_queue", 80, null, fill],
    ["sns_topic", 256, null, fill],
    ["secret", 512, null, fill],
    ["ssm_parameter", 900, null, (length) => `/${"a".repeat(length - 1)}`],
    ["kms_alias", 256, null, (length) => `alias/${"a".repeat(length - 6)}`],
    ["event_bus", 256, null, fill],
    ["event_rule", 64, null, fill],
    ["schedule", 64, null, fill],
    ["alarm", 255, null, fill],
    ["dashboard", 255, null, fill],
    ["iam_role", 64, null, fill],
    ["iam_managed_policy", 128, null, fill],
    ["state_machine", 80, null, fill],
    ["codebuild_project", 150, null, fill],
    ["api_rest", 128, null, fill],
    ["api_http", 128, null, fill],
    ["api_websocket", 128, null, fill],
    ["log_delivery_source", 60, null, fill],
    ["log_delivery_destination", 60, null, fill],
    ["log_group", 512, null, fill],
  ];
  const naming = apptheory.AppTheoryResourceNaming;
  for (const [type, max, min, make] of rows) {
    assert.doesNotThrow(() => naming.validatePhysicalName(type, make(max)), `${type} at ${max}`);
    assert.throws(
      () => naming.validatePhysicalName(type, make(max + 1)),
      /must be at most/,
      `${type} at ${max + 1}`,
    );
    if (min !== null) {
      assert.doesNotThrow(() => naming.validatePhysicalName(type, make(min)), `${type} at ${min}`);
      assert.throws(
        () => naming.validatePhysicalName(type, make(min - 1)),
        /must be at least/,
        `${type} at ${min - 1}`,
      );
    }
  }
});

test("H2: the fixed names section 3 and section 6 state stay admitted", () => {
  // The two fixed names AppTheory itself declares, the section 3 log-source
  // shape, and the path shapes the section 2 rows lead with, all stay admitted:
  // the restriction narrows the rows, it does not replace them.
  const naming = apptheory.AppTheoryResourceNaming;
  naming.validatePhysicalName("log_group", "/aws/lambda/shop-lab-worker");
  naming.validatePhysicalName("log_group", `/aws/lambda/${"a".repeat(64)}`);
  naming.validatePhysicalName("log_group", "theorycloud_theorycloud_shop_lab_logs_runtime_worker");
  naming.validatePhysicalName("ssm_parameter", "/theorycloud/visibility/shop/lab/manifest");
  naming.validatePhysicalName("ssm_parameter", "/shop/lab/parameter");
  naming.validatePhysicalName("kms_alias", "alias/shop/lab/key");
  naming.validatePhysicalName("dynamodb_table", "shop-lab-events");

  // And they still reach the artifact through the constructs that create them.
  const { documents, template } = synthAssembly((stack) => {
    const context = shopContext(stack);
    shopFunction(stack, "Worker", "worker", context);
    new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
      namingContext: context,
      readerPrincipalArn: "arn:aws:iam::123456789012:role/cloud-keeper",
      rules: {},
    });
  });
  const groups = namedResourcesOfType(template, "AWS::Logs::LogGroup");
  assert.ok(
    groups.some((group) => group.properties.LogGroupName === "/aws/lambda/shop-lab-worker"),
    JSON.stringify(groups.map((group) => group.properties.LogGroupName)),
  );
  const parameters = namedResourcesOfType(template, "AWS::SSM::Parameter");
  assert.equal(parameters[0].properties.Name, "/theorycloud/visibility/shop/lab/manifest");
  assert.equal(documents[0].entries.filter((row) => row.type === "ssm_parameter").length, 1);
  // The legacy logging profile of this context declares the Lambda service
  // group only; the standard profile's `logs/runtime/{logical}` group is the
  // other section 3 shape and is declared by the standard-profile tests.
  assert.equal(documents[0].entries.filter((row) => row.type === "log_group").length, 1);
});

// ---- r4 rework r4: no environment comparison; the fixed log-group shape ----
//
// Each test below pins one defect the round-4 gate found, or the operator ruling
// of 2026-11-25 that replaced round 3's environment refusal: the derived-name
// artifact's account and Region are the naming context's, AppTheory does not
// compare them with the owning stack's environment, and TheoryCloud.ai's
// installer validates them against the stack it deploys.

test("J1: a Lazy Region produced after the construct is created is never resolved early", () => {
  // SANITY-AT-N3-09: the round-3 environment check resolved the owning stack's
  // account and Region while the declaration was made, which runs a Lazy
  // producer at declare time. A producer that depends on a value only known once
  // the constructs exist therefore failed synthesis for no naming reason at all.
  // The naming code must not evaluate a Lazy producer any more.
  const holder = { region: undefined };
  let producedByDeclaration = 0;
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", {
    env: {
      account: LAB_ENV.account,
      region: cdk.Lazy.string({
        produce: () => {
          producedByDeclaration += 1;
          if (holder.region === undefined) {
            throw new Error("the region is not known until after the constructs exist");
          }
          return holder.region;
        },
      }),
    },
  });
  const context = shopContext(stack);
  shopFunction(stack, "Worker", "worker", context);
  assert.equal(producedByDeclaration, 0, "the naming code resolved the stack's Lazy Region at declare time");

  // Only now is the Region known; still before synthesis.
  holder.region = LAB_ENV.region;
  const documents = metadataDocuments(app.synth().getStackByName("Stack"));
  assert.equal(documents.length, 1);
  assert.equal(documents[0].context.region, LAB_ENV.region);
  assert.deepEqual(documents[0].entries.map((row) => row.type).sort(), [
    "iam_role",
    "lambda_function",
    "log_group",
  ]);
});

test("J1: a stack in another account and Region synthesizes and the artifact claims the context's environment", () => {
  // Operator ruling 2026-11-25: no comparison. A stack built from another
  // stage's configuration still declares through the context; it synthesizes,
  // its rows are the context's names, and the document carries the context's
  // account and Region. TheoryCloud.ai's installer is what refuses a deploy
  // whose stack does not match them.
  const app = multiStack((scope) => {
    const home = new cdk.Stack(scope, "Home", { env: LAB_ENV });
    const away = new cdk.Stack(scope, "Away", { env: { account: "111122223333", region: "eu-west-1" } });
    const context = shopContext(home);
    shopFunction(away, "Worker", "worker", context);
  });
  const documents = metadataDocuments(app.synth().getStackByName("Away"));
  assert.equal(documents.length, 1);
  assert.deepEqual(documents[0].context, {
    namespace: "theorycloud",
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });
  assert.deepEqual(
    documents[0].entries.map((row) => [row.type, row.name]).sort(),
    [
      ["iam_role", "shop-lab-worker"],
      ["lambda_function", "shop-lab-worker"],
      ["log_group", "/aws/lambda/shop-lab-worker"],
    ],
  );
});

test("J2: a fixed log_group name that is neither this context's log source nor the Lambda service path fails synthesis", () => {
  // SANITY-AT-N3-08: validatePhysicalName is structural, so it admitted every
  // slash-free name as a log source. A fixed name must be a log source of THIS
  // context -- its own prefix, then the section 3 remainder grammar -- or the
  // Lambda service path. A bare word is no log source, a foreign context's
  // prefix is another app's, and a remainder outside the section 3 grammar is
  // not the source either.
  const cases = [
    "orders",
    "theorycloud_other_app_lab_x",
    "theorycloud_theorycloud_shop_live_logs_runtime_worker",
    "theorycloud_theorycloud_shop_lab_orders",
    "theorycloud_theorycloud_shop_lab_logs_runtime_",
    "theorycloud_theorycloud_shop_lab_logs__runtime",
    "theorycloud_theorycloud_shop_lab_logs_Runtime",
  ];
  for (const name of cases) {
    assert.throws(
      () =>
        synth((stack) => {
          const context = shopContext(stack);
          const group = new cdk.CfnResource(stack, "Fixed", {
            type: "AWS::Logs::LogGroup",
            properties: { LogGroupName: name },
          });
          context.declareFixedName("log_group", name, group);
        }),
      (error) => {
        const message = String(error.message);
        assert.match(message, /cannot declare log_group/);
        assert.match(message, /is either this context's section 3 log source/);
        assert.match(message, /"theorycloud_theorycloud_shop_lab_"/);
        assert.match(message, /app shop, stage lab, namespace theorycloud/);
        return true;
      },
      name,
    );
  }
});

test("J2: this context's log source and the Lambda service path are admitted and reach the artifact", () => {
  // The two shapes a fixed log_group may take, through the context that owns the
  // prefix: the section 3 name of this context's own source, and the Lambda
  // service path with a function name that satisfies the lambda_function row.
  const sourceName = "theorycloud_theorycloud_shop_lab_logs_runtime_api";
  const serviceName = "/aws/lambda/shop-lab-api";
  const { documents } = synthAssembly((stack) => {
    const context = shopContext(stack);
    assert.equal(context.logGroupName("logs/runtime/api"), sourceName);
    for (const [id, name] of [
      ["Source", sourceName],
      ["Service", serviceName],
    ]) {
      const group = new cdk.CfnResource(stack, id, {
        type: "AWS::Logs::LogGroup",
        properties: { LogGroupName: name },
      });
      context.declareFixedName("log_group", name, group);
    }
  });
  assert.equal(documents.length, 1);
  assert.deepEqual(
    documents[0].entries
      .filter((row) => row.type === "log_group")
      .map((row) => [row.name, row.scope])
      .sort(),
    [
      ["/aws/lambda/shop-lab-api", "account_region"],
      [sourceName, "account_region"],
    ],
  );
});

test("J2: the fixed log-group names AppTheory's own constructs declare still reach the artifact", () => {
  // The lambda_function row of the service path, and the standard profile's
  // logs/runtime/{logical} source: the narrowing refuses foreign names, it does
  // not push AppTheory's own declarations out of the artifact.
  const { documents } = synthAssembly((stack) => {
    const context = shopContext(stack, "Naming", {
      loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    });
    shopFunction(stack, "Worker", "worker", context);
  });
  const groups = documents[0].entries.filter((row) => row.type === "log_group");
  assert.deepEqual(
    groups.map((row) => row.name).sort(),
    ["theorycloud_theorycloud_shop_lab_logs_runtime_worker"],
  );
  assert.deepEqual(
    groups.map((row) => row.scope),
    ["account_region"],
  );
});

// ---- r5: hosted namespaces (contract sections 1, 2, 2.1, 2.4 and 4) --------
//
// The five actor/state scenarios of the AT-N5 milestone, one test per scenario,
// so every surface can be compared line for line. TheoryCloud.ai sets `hosted`
// and the tenant namespace and injects the account and Region; AppTheory derives
// the names and never resolves or chooses the environment.

function hostedContext(stack, id = "Naming", overrides = {}) {
  return new apptheory.AppTheoryNamingContext(stack, id, {
    namespace: "acme",
    hosted: true,
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
    ...overrides,
  });
}

function hostedBuild(stack) {
  const context = hostedContext(stack, "Naming", {
    loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
  });
  shopFunction(stack, "Worker", "worker", context);
  new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
}

function platformBuild(stack) {
  const context = shopContext(stack, "Naming", {
    loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
  });
  shopFunction(stack, "Worker", "worker", context);
  new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
}

function namesOfType(template, type, property) {
  return Object.values(template.Resources ?? {})
    .filter((resource) => resource.Type === type)
    .map((resource) => resource.Properties?.[property])
    .filter((value) => value !== undefined);
}

test("N5-1: a platform app's derived-name artifact is byte-identical to r4", () => {
  const { documents } = synthAssembly(platformBuild);
  assert.equal(documents.length, 1);
  // Pinned byte for byte: the r5 change adds a hosted form and leaves the
  // platform form, and therefore the live hard gate of contract section 4,
  // untouched.
  assert.equal(
    JSON.stringify(documents[0]),
    '{"contract":"theorycloud_resource_naming.v0.1","schema":"apptheory_resource_naming.derived_names.v1",' +
      '"context":{"namespace":"theorycloud","app":"shop","stage":"lab","account":"998115851393",' +
      '"region":"us-east-1"},"entries":[' +
      '{"name":"shop-lab-worker","type":"iam_role","scope":"account","logical_id":"WorkerFunctionServiceRole650C7B87"},' +
      '{"name":"shop-lab-worker","type":"lambda_function","scope":"account_region","logical_id":"WorkerFunctionAF8A26AF"},' +
      '{"name":"theorycloud_theorycloud_shop_lab_logs_runtime_worker","type":"log_group",' +
      '"scope":"account_region","logical_id":"WorkerRuntimeLogGroupCF742C5E"},' +
      '{"name":"shop-lab-site-assets-998115851393-us-east-1-an","type":"s3_bucket",' +
      '"scope":"account_region","logical_id":"AssetsBucket252B3DF7"}]}',
  );

  // An explicit platform namespace is the same context as an omitted one.
  const explicit = synthAssembly((stack) => {
    const context = shopContext(stack, "Naming", {
      namespace: "theorycloud",
      loggingProfile: apptheory.AppTheoryLoggingProfile.STANDARD,
    });
    shopFunction(stack, "Worker", "worker", context);
    new apptheory.AppTheoryBucket(stack, "Assets", { namingContext: context, logical: "site-assets" });
  });
  assert.equal(JSON.stringify(explicit.documents), JSON.stringify(documents));
  assert.equal(apptheory.AppTheoryResourceNaming.namespaced({ ...platformValues() }), false);
  assert.equal(apptheory.AppTheoryResourceNaming.namespaced({ ...platformValues(), namespace: "theorycloud" }), false);
});

function platformValues() {
  return { app: "shop", stage: "lab", account: "998115851393", region: "us-east-1" };
}

test("N5-2: a hosted context carries its namespace in every derived name", () => {
  const { documents, template } = synthAssembly(hostedBuild);

  // The template resources carry the hosted names.
  assert.deepEqual(namesOfType(template, "AWS::Lambda::Function", "FunctionName"), ["acme-shop-lab-worker"]);
  assert.deepEqual(namesOfType(template, "AWS::IAM::Role", "RoleName"), ["acme-shop-lab-worker"]);
  assert.deepEqual(namesOfType(template, "AWS::Logs::LogGroup", "LogGroupName"), [
    "theorycloud_acme_shop_lab_logs_runtime_worker",
  ]);

  // The S3 bucket takes the account-regional namespace and the namespaced prefix.
  const buckets = Object.values(template.Resources)
    .filter((resource) => resource.Type === "AWS::S3::Bucket")
    .map((resource) => resource.Properties);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].BucketNamePrefix, "acme-shop-lab-site-assets");
  assert.equal(buckets[0].BucketNamespace, "account-regional");

  // The section 11.4 artifact carries the hosted names, so the reservation
  // index reserves the namespaced forms TheoryCloud.ai enforces.
  assert.equal(documents.length, 1);
  const document = documents[0];
  assert.equal(document.contract, "theorycloud_resource_naming.v0.1");
  assert.deepEqual(document.context, {
    namespace: "acme",
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });
  assert.deepEqual(
    document.entries.map((row) => [row.type, row.name]).sort(),
    [
      ["iam_role", "acme-shop-lab-worker"],
      ["lambda_function", "acme-shop-lab-worker"],
      ["log_group", "theorycloud_acme_shop_lab_logs_runtime_worker"],
      ["s3_bucket", "acme-shop-lab-site-assets-998115851393-us-east-1-an"],
    ],
  );

  // The over-budget rule reaches the hosted prefix sooner (contract section 2.4).
  const naming = apptheory.AppTheoryResourceNaming;
  const shortened = naming.physicalName(
    { ...hostedValues(), app: "storefront-checkout" },
    "s3_bucket",
    "customer-uploads-archive",
  );
  assert.equal(shortened.bucketNamePrefix, "acme-storefront-checkout-lab-5cs2pek2");
  assert.equal(shortened.name, "acme-storefront-checkout-lab-5cs2pek2-998115851393-us-east-1-an");
});

function hostedValues() {
  return { namespace: "acme", hosted: true, ...platformValues() };
}

test("N5-3: every broken hosted context fails synthesis, naming its reason", () => {
  const cases = [
    ["missing namespace", { namespace: undefined, hosted: true }, /requires a namespace for a hosted deployment/],
    ["empty namespace", { namespace: "", hosted: true }, /requires a namespace for a hosted deployment/],
    ["namespace over 12 characters", { namespace: "northwind-trade" }, /longer than 12 characters/],
    ["namespace starts with aws", { namespace: "awsome" }, /must not start with aws or ssm/],
    ["namespace starts with ssm", { namespace: "ssmtools" }, /must not start with aws or ssm/],
    ["reserved platform namespace", { namespace: "theorycloud" }, /reserved for first-party platform apps/],
  ];
  for (const [name, overrides, want] of cases) {
    assert.throws(() => synth((stack) => hostedContext(stack, "Naming", overrides)), want, name);
  }

  // A hosted deployment takes no legacy profile and no generated entry.
  assert.throws(
    () =>
      synth((stack) => {
        const context = hostedContext(stack, "Naming", {
          namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
          pins: { "lambda_function:worker": "acme-shop-lab-worker" },
        });
        shopFunction(stack, "Worker", "worker", context);
      }),
    /a hosted deployment takes no legacy profile or generated entries/,
  );
  assert.throws(
    () =>
      synth((stack) => {
        const context = hostedContext(stack, "Naming", {
          namingProfile: apptheory.AppTheoryNamingProfile.LEGACY,
          generated: ["lambda_function:worker"],
        });
        shopFunction(stack, "Worker", "worker", context);
      }),
    /a hosted deployment takes no legacy profile or generated entries/,
  );

  // A hosted pin that does not start with its namespace component is refused,
  // and containing the namespace elsewhere is not enough.
  assert.throws(
    () =>
      synth((stack) => {
        const context = hostedContext(stack, "Naming", {
          pins: { "lambda_function:worker": "shop-lab-worker" },
        });
        shopFunction(stack, "Worker", "worker", context);
      }),
    /a hosted pin must start with the namespace component/,
  );
  assert.throws(
    () =>
      synth((stack) => {
        const context = hostedContext(stack, "Naming", {
          namespace: "hop",
          pins: { "lambda_function:worker": "shop-lab-worker" },
        });
        shopFunction(stack, "Worker", "worker", context);
      }),
    /a hosted pin must start with the namespace component/,
  );

  // A hosted pin that does start with it is accepted verbatim.
  const pinned = synthAssembly((stack) => {
    const context = hostedContext(stack, "Naming", {
      pins: { "lambda_function:worker": "acme-shop-lab-worker-v1" },
    });
    shopFunction(stack, "Worker", "worker", context);
  });
  assert.deepEqual(namesOfType(pinned.template, "AWS::Lambda::Function", "FunctionName"), [
    "acme-shop-lab-worker-v1",
  ]);
});

// SAN-AT-N5-01: the naming-profile rule is a property of the context, so a
// hosted context that carries a forbidden profile is refused when the context is
// created — with no naming declarations at all, and with only a log-source name —
// and not only when a construct composes a physical name. The gate's
// reproduction is the regression: a stack whose template holds an ordinary
// resource, `hosted: true`, namespace `acme` and the legacy profile synthesized
// before this test existed.
function synthOrRefuse(build, env = LAB_ENV) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env });
  try {
    build(stack);
  } catch (error) {
    // A refused context never reaches synthesis, so it emits no artifact at all.
    return { error, documents: [] };
  }
  const artifact = app.synth().getStackByName("Stack");
  const documents = [];
  for (const entries of Object.values(artifact.metadata ?? {})) {
    for (const entry of entries) {
      if (entry.type === DERIVED_NAMES_KEY) documents.push(entry.data);
    }
  }
  return { error: undefined, documents };
}

test("N5-3b: a forbidden profile is refused at the context, not at the first composed name", () => {
  const want = /a hosted deployment takes no legacy profile or generated entries/;
  const legacy = { namingProfile: apptheory.AppTheoryNamingProfile.LEGACY };

  const cases = [
    // No naming declarations: an ordinary resource is the whole stack.
    [
      "no declarations",
      (stack) => {
        hostedContext(stack, "Naming", legacy);
        new cdk.aws_sqs.Queue(stack, "Work");
      },
    ],
    // A log-only declaration through the context's own log-source API.
    [
      "log-only declaration",
      (stack) => {
        const context = hostedContext(stack, "Naming", legacy);
        const logs = new cdk.aws_logs.LogGroup(stack, "Logs", {
          logGroupName: context.logGroupName("logs/runtime/api"),
        });
        context.declareName("log_group", "logs/runtime/api", logs);
      },
    ],
    // A composed name keeps refusing on the same reason.
    [
      "composed name",
      (stack) => {
        const context = hostedContext(stack, "Naming", {
          ...legacy,
          pins: { "lambda_function:worker": "acme-shop-lab-worker" },
        });
        shopFunction(stack, "Worker", "worker", context);
      },
    ],
  ];
  for (const [name, build] of cases) {
    const refused = synthOrRefuse(build);
    assert.match(refused.error?.message ?? "", want, name);
    assert.deepEqual(refused.documents, [], `${name} must emit no artifact`);
  }

  // Control: the valid derived hosted context still synthesizes, and its
  // artifact still carries the hosted name.
  const derived = synthOrRefuse((stack) => {
    const context = hostedContext(stack, "Naming");
    shopFunction(stack, "Worker", "worker", context);
  });
  assert.equal(derived.error, undefined);
  assert.deepEqual(
    derived.documents[0].entries.map((entry) => [entry.type, entry.name]),
    [
      ["iam_role", "acme-shop-lab-worker"],
      ["lambda_function", "acme-shop-lab-worker"],
      ["log_group", "/aws/lambda/acme-shop-lab-worker"],
    ],
  );

  // Control: a platform app keeps the legacy profile, exactly as r4 allowed, so
  // the platform path is not narrowed.
  const platform = synthOrRefuse((stack) => {
    const context = shopContext(stack, "Naming", {
      ...legacy,
      pins: {
        "lambda_function:worker": "shop-lab-worker",
        "iam_role:worker": "shop-lab-worker-role",
      },
    });
    shopFunction(stack, "Worker", "worker", context);
  });
  assert.equal(platform.error, undefined);
  assert.deepEqual(
    platform.documents[0].entries.map((entry) => [entry.type, entry.name]),
    [
      ["iam_role", "shop-lab-worker-role"],
      ["lambda_function", "shop-lab-worker"],
      // The Lambda service log group keeps its fixed contract name.
      ["log_group", "/aws/lambda/shop-lab-worker"],
    ],
  );
});

test("N5-4: two hosted namespaces in one account synthesize distinct names", () => {
  const buildFor = (namespace) => (stack) => {
    const context = hostedContext(stack, "Naming", { namespace });
    shopFunction(stack, "Worker", "worker", context);
  };
  const acme = synthAssembly(buildFor("acme"));
  const globex = synthAssembly(buildFor("globex"));

  assert.deepEqual(namesOfType(acme.template, "AWS::Lambda::Function", "FunctionName"), ["acme-shop-lab-worker"]);
  assert.deepEqual(namesOfType(globex.template, "AWS::Lambda::Function", "FunctionName"), ["globex-shop-lab-worker"]);
  assert.notEqual(
    namesOfType(acme.template, "AWS::Lambda::Function", "FunctionName")[0],
    namesOfType(globex.template, "AWS::Lambda::Function", "FunctionName")[0],
  );

  // Both namespaces' artifacts are their own documents, with their own rows.
  assert.equal(acme.documents[0].context.namespace, "acme");
  assert.equal(globex.documents[0].context.namespace, "globex");
  assert.deepEqual(
    acme.documents[0].entries.filter((row) => row.type === "lambda_function").map((row) => row.name),
    ["acme-shop-lab-worker"],
  );
  assert.deepEqual(
    globex.documents[0].entries.filter((row) => row.type === "lambda_function").map((row) => row.name),
    ["globex-shop-lab-worker"],
  );
});

test("N5-5: the account and Region stay caller inputs for a hosted context", () => {
  // AppTheory does not choose or resolve them: the context's own values are the
  // artifact's, whatever the stack's environment is.
  const elsewhere = synthAssembly(
    (stack) => {
      const context = hostedContext(stack, "Naming");
      shopFunction(stack, "Worker", "worker", context);
    },
    { account: "111111111111", region: "ap-southeast-2" },
  );
  assert.deepEqual(elsewhere.documents[0].context, {
    namespace: "acme",
    app: "shop",
    stage: "lab",
    account: "998115851393",
    region: "us-east-1",
  });

  // An unresolved token still fails synthesis; nothing is deferred to deploy.
  assert.throws(
    () =>
      synth((stack) => {
        hostedContext(stack, "Naming", { account: cdk.Lazy.string({ produce: () => "998115851393" }) });
      }),
    /requires a concrete account id/,
  );
  assert.throws(
    () =>
      synth((stack) => {
        hostedContext(stack, "Naming", { region: cdk.Lazy.string({ produce: () => "us-east-1" }) });
      }),
    /requires a concrete region/,
  );

  // The namespace label rule is a property of the namespace, hosted or not: a
  // non-platform namespace keeps the cap on a platform-profile context too.
  assert.throws(
    () => synth((stack) => shopContext(stack, "Naming", { namespace: "northwind-trade" })),
    /longer than 12 characters/,
  );
  assert.throws(() => apptheory.AppTheoryResourceNaming.validateHostedNamespace("thirteen-char"), /12 characters/);
  assert.doesNotThrow(() => apptheory.AppTheoryResourceNaming.validateHostedNamespace("twelve-chars"));
  assert.doesNotThrow(() => apptheory.AppTheoryResourceNaming.validateHostedNamespace("theorycloud"));
});
