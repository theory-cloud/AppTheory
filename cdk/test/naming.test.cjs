const assert = require("node:assert/strict");
const fs = require("node:fs");
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

function synth(build) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: "998115851393", region: "us-east-1" } });
  build(stack);
  return assertions.Template.fromStack(stack).toJSON();
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
  assert.equal(evaluated, 83);
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
  const template = synth((stack) => {
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
  const base = synth((stack) => build(stack, undefined));
  const legacy = synth((stack) =>
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
  const legacyTemplate = synth((stack) => {
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
      synth((stack) => {
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
  const ws = synth((stack) => {
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
  const mcp = synth((stack) => {
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
  const media = synth((stack) => {
    const context = legacyContext(stack, { pins: { "s3_bucket:media-media": "autheory-live-media" } });
    new apptheory.AppTheoryMediaCdn(stack, "Media", { namingContext: context, enableLogging: false });
  });
  assert.equal(resourcesOfType(media, "AWS::S3::Bucket")[0].Properties?.BucketName, "autheory-live-media");

  // SSR assets bucket, html store and ISR metadata table.
  const site = synth((stack) => {
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
