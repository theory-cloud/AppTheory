const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");

const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3 = require("aws-cdk-lib/aws-s3");

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
  assert.equal(evaluated, 81);
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
  assert.equal(destinations[0].Properties?.OutputFormat, "w3c");
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
    assert.equal(resourcesOfType(template, "AWS::Logs::DeliveryDestination").length, 1);
    assert.equal(resourcesOfType(template, "AWS::Logs::Delivery").length, 1);
  }
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
        enableConnectionTable: true,
      }),
    { generated: ["api_websocket:ws", "dynamodb_table:ws-connections"] },
  );
});

test("legacy profiles synthesize byte-identically: AppTheoryMcpServer (generated access log group)", () => {
  assertIdentical(
    (stack, context) =>
      new apptheory.AppTheoryMcpServer(stack, "Mcp", {
        handler: handler(stack),
        namingContext: context,
        ...(context ? {} : { ownedApi: { apiName: "autheory-live-mcp" } }),
        sessionState: { enabled: false },
      }),
    {
      pins: { "api_http:mcp": "autheory-live-mcp" },
      generated: ["log_group:logs/access/api/mcp"],
    },
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
    readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-runtime",
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
  assert.deepEqual(JSON.parse(JSON.stringify(reader.Properties.AssumeRolePolicyDocument)), {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::191637461429:role/cloud-keeper-runtime" },
        Action: "sts:AssumeRole",
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

test("AppTheoryKeeperVisibility accepts no rules and reads only the manifest", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack");
  const visibility = new apptheory.AppTheoryKeeperVisibility(stack, "Visibility", {
    namingContext: labContext(stack),
    readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-runtime",
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
          readerPrincipalArn: "arn:aws:iam::191637461429:role/cloud-keeper-runtime",
          rules: { include: ["logs/*/api"] },
        }),
      ),
    /selector/,
  );
});
