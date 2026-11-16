// FRONTED origin posture for attach-mode MCP servers (#1258): an app-owned
// CloudFront distribution fronts the execute-api origin, the construct declares
// the front door with a mandatory runtime-enforced header, and the synthesized
// marker records the posture, the header name, and a digest of the secret —
// never the literal.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");

const cdk = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

const POSTURE_METADATA_KEY = "apptheory:mcp-transport-posture";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";

const FRONT_DOOR_HEADER = "x-tms-front-door";
const FRONT_DOOR_SECRET = "tms-front-door-secret-0123456789-abcdefghij";

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function frontDoorVerification(extra = {}) {
  return {
    headerName: FRONT_DOOR_HEADER,
    secretValue: FRONT_DOOR_SECRET,
    asserted: true,
    ...extra,
  };
}

function runtimeBearerFloor(extra = {}) {
  return {
    transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
    runtimePosture: { requireBearerToken: true },
    denialSignal: {},
    sessionState: { enabled: false },
    owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
    ...extra,
  };
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function postureMetadata(template) {
  const marked = Object.values(template.Resources ?? {})
    .filter((resource) => resource.Metadata?.[POSTURE_METADATA_KEY] !== undefined)
    .map((resource) => resource.Metadata[POSTURE_METADATA_KEY]);
  assert.equal(marked.length, 1, "exactly one resource carries the posture marker");
  return marked[0];
}

// Every IAM statement the stack synthesizes: role-inline policies and the
// standalone AWS::IAM::Policy resources addToRolePolicy creates.
function policyStatements(template) {
  const statements = [];
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type === "AWS::IAM::Role") {
      for (const policy of resource.Properties?.Policies ?? []) {
        statements.push(...(policy.PolicyDocument?.Statement ?? []));
      }
    }
    if (resource.Type === "AWS::IAM::Policy") {
      statements.push(...(resource.Properties?.PolicyDocument?.Statement ?? []));
    }
  }
  return statements;
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The #1258 reproduction shape: one app-stack-owned HTTP API v2 with the
// MCP server in attach mode (CONSOLIDATED, RUNTIME_BEARER), fronted by a public
// CloudFront distribution whose origin is the execute-api hostname.
function tmsShapeStack(appId) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, appId, { env: { region: "us-east-1", account: "123456789012" } });
  const api = new apigwv2.HttpApi(stack, "TmsApi");
  const distribution = new cloudfront.Distribution(stack, "FrontDoor", {
    defaultBehavior: {
      origin: new origins.HttpOrigin(
        `${api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`,
        {
          customHeaders: { [FRONT_DOOR_HEADER]: FRONT_DOOR_SECRET },
        },
      ),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    },
  });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
    frontDoorVerification: frontDoorVerification(),
    ...runtimeBearerFloor(),
  });
  return { stack, api, distribution, server };
}

test("attach FRONTED synthesizes the #1258 topology with no CloudFront or API change", () => {
  const { stack, server } = tmsShapeStack("FrontedTmsShapeStack");
  const template = assertions.Template.fromStack(stack).toJSON();

  const [cfnApi] = resourcesOfType(template, "AWS::ApiGatewayV2::Api");
  assert.equal(
    cfnApi.Properties.DisableExecuteApiEndpoint,
    undefined,
    "FRONTED never disables the execute-api endpoint the front door points at",
  );
  assert.equal(
    resourcesOfType(template, "AWS::ApiGatewayV2::DomainName").length,
    0,
    "FRONTED adds no custom domain",
  );
  assert.equal(
    resourcesOfType(template, "AWS::ApiGatewayV2::ApiMapping").length,
    0,
    "FRONTED adds no API mapping",
  );
  assert.match(server.endpoint, /execute-api/, "attach endpoints stay execute-api origin templates");

  const [emittedDistribution] = resourcesOfType(template, "AWS::CloudFront::Distribution");
  assert.ok(emittedDistribution);
  const origins = emittedDistribution.Properties.DistributionConfig.Origins;
  assert.equal(origins.length, 1);
  assert.deepEqual(
    origins[0].OriginCustomHeaders,
    [{ HeaderName: FRONT_DOOR_HEADER, HeaderValue: FRONT_DOOR_SECRET }],
    "the app-owned origin header config is untouched by the construct",
  );

  // The app-owned distribution is the platform-mandated copy that carries the
  // literal header value; the construct contributes no second copy anywhere.
  const occurrences = JSON.stringify(template).split(FRONT_DOOR_SECRET).length - 1;
  assert.equal(occurrences, 1, "the construct adds no copy of the literal secret");
});

test("attach FRONTED records the posture, the header name, and a secret digest only", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedTmsMetadataStack");
  const api = new apigwv2.HttpApi(stack, "Api");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
    frontDoorVerification: frontDoorVerification(),
    ...runtimeBearerFloor(),
  });
  const template = assertions.Template.fromStack(stack).toJSON();

  assert.deepEqual(postureMetadata(template), {
    posture: "runtime-bearer",
    contract_id: "m17.mcp-transport-posture/v1",
    route_count: 4,
    runtime_posture_declared: true,
    origin_reachability: "fronted",
    front_door_header_name: FRONT_DOOR_HEADER,
    front_door_secret_sha256: sha256Hex(FRONT_DOOR_SECRET),
  });

  assert.equal(
    JSON.stringify(template).includes(FRONT_DOOR_SECRET),
    false,
    "the construct never emits the literal front-door secret",
  );
});

test("attach FRONTED without frontDoorVerification fails synthesis", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedMissingVerificationStack");
  const api = new apigwv2.HttpApi(stack, "Api");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api,
      originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
      ...runtimeBearerFloor(),
    }),
    /originReachability FRONTED requires frontDoorVerification/,
  );
});

test("owned FRONTED is refused; ownership is wired by DISABLED or LOCKED", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedFrontedStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
      frontDoorVerification: frontDoorVerification(),
      transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
      runtimePosture: { requireBearerToken: true },
      denialSignal: {},
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
    }),
    /originReachability FRONTED is unsupported in owned mode/,
  );
});

test("frontDoorVerification without FRONTED is contradictory", () => {
  const cases = [
    {
      name: "DISABLED attach",
      props: { originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED },
    },
    {
      name: "no origin decision",
      props: {},
    },
  ];
  for (const item of cases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `FrontedContradictory${item.name.replace(/[^A-Za-z0-9]/g, "")}`);
    const api = new apigwv2.HttpApi(stack, "Api", { disableExecuteApiEndpoint: true });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api,
        frontDoorVerification: frontDoorVerification(),
        sessionState: { enabled: false },
        ...(item.props.originReachability === undefined
          ? {
            transportPosture: apptheory.AppTheoryMcpTransportPosture.IAM,
            runtimePosture: undefined,
          }
          : runtimeBearerFloor()),
        ...item.props,
      }),
      /frontDoorVerification is only valid with originReachability FRONTED/,
      item.name,
    );
  }
});

test("FRONTED validates the declared header name and secret", () => {
  const cases = [
    {
      name: "short secret",
      verification: { secretValue: "too-short" },
      error: /frontDoorVerification\.secretValue must be 32 to 128 characters of \[A-Za-z0-9\._~-\]/,
    },
    {
      name: "secret outside the header-value alphabet",
      verification: { secretValue: `${"a".repeat(31)} secret` },
      error: /frontDoorVerification\.secretValue must be 32 to 128 characters of \[A-Za-z0-9\._~-\]/,
    },
    {
      name: "header name with an illegal character",
      verification: { headerName: "x front door" },
      error: /frontDoorVerification\.headerName must be 1 to 64 characters of \[A-Za-z0-9-\]/,
    },
    {
      name: "reserved request header",
      verification: { headerName: "authorization" },
      error: /is a reserved or platform-managed request header/,
    },
    {
      name: "platform header",
      verification: { headerName: "x-amzn-trace-id" },
      error: /is a reserved or platform-managed request header/,
    },
    {
      name: "missing assertion",
      verification: { asserted: false },
      error: /frontDoorVerification requires asserted: true/,
    },
  ];
  for (const item of cases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `FrontedInvalid${item.name.replace(/[^A-Za-z0-9]/g, "")}`);
    const api = new apigwv2.HttpApi(stack, "Api");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api,
        originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
        frontDoorVerification: frontDoorVerification(item.verification),
        ...runtimeBearerFloor(),
      }),
      item.error,
      item.name,
    );
  }
});

test("attach FRONTED is accepted with none-public alongside the other decisions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedNonePublicStack");
  const api = new apigwv2.HttpApi(stack, "Api");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
    frontDoorVerification: frontDoorVerification(),
    sessionState: { enabled: false },
    owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const marker = postureMetadata(template);
  assert.equal(marker.posture, "none-public");
  assert.equal(marker.origin_reachability, "fronted");
  assert.equal(marker.front_door_header_name, FRONT_DOOR_HEADER);
  assert.equal(marker.front_door_secret_sha256, sha256Hex(FRONT_DOOR_SECRET));
  assert.equal(
    resourcesOfType(template, "AWS::ApiGatewayV2::DomainName").length,
    0,
    "FRONTED adds no custom domain under none-public either",
  );
});

test("existing attach DISABLED keeps its posture marker byte-stable", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachDisabledMarkerStack");
  const api = new apigwv2.HttpApi(stack, "Api", { disableExecuteApiEndpoint: true });
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    ...runtimeBearerFloor(),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(postureMetadata(template), {
    posture: "runtime-bearer",
    contract_id: "m17.mcp-transport-posture/v1",
    route_count: 4,
    runtime_posture_declared: true,
  });
});

test("owned LOCKED keeps its posture marker byte-stable", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedLockedMarkerStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    ...runtimeBearerFloor({
      ownedApi: {
        stage: { throttlingEnabled: true },
        domain: {
          domainName: "mcp.example.com",
          certificate: acm.Certificate.fromCertificateArn(stack, "Certificate", CERTIFICATE_ARN),
          mutualTlsAuthentication: {
            bucket: require("aws-cdk-lib/aws-s3").Bucket.fromBucketName(stack, "Truststore", "truststore-bucket"),
            key: "truststore.pem",
          },
        },
      },
    }),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(postureMetadata(template), {
    posture: "runtime-bearer",
    contract_id: "m17.mcp-transport-posture/v1",
    route_count: 4,
    runtime_posture_declared: true,
  });
});

// Parameter form (docs/058 FRONTED-SSM): the value lives in a well-known,
// stage-qualified Parameter Store parameter, the distribution header is a
// CloudFormation dynamic reference, and the marker records the parameter name
// instead of a digest of a literal the application no longer holds.

const FRONT_DOOR_PARAMETER = "/theorycloud/tms/lab/fronted/origin-token";

function parameterFrontDoorVerification(extra = {}) {
  return {
    headerName: FRONT_DOOR_HEADER,
    secretParameterName: FRONT_DOOR_PARAMETER,
    asserted: true,
    ...extra,
  };
}

function frontedStackWith(verification, extra = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, extra.stackId ?? "FrontedParameterStack", {
    env: { region: "us-east-1", account: "123456789012" },
  });
  const api = new apigwv2.HttpApi(stack, "Api");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
    frontDoorVerification: verification,
    ...runtimeBearerFloor(),
    ...extra.props,
  });
  return { stack, server };
}

test("parameter form records the parameter name and that the value is parameter-sourced", () => {
  const { stack } = frontedStackWith(parameterFrontDoorVerification());
  const template = assertions.Template.fromStack(stack).toJSON();

  assert.deepEqual(postureMetadata(template), {
    posture: "runtime-bearer",
    contract_id: "m17.mcp-transport-posture/v1",
    route_count: 4,
    runtime_posture_declared: true,
    origin_reachability: "fronted",
    front_door_header_name: FRONT_DOOR_HEADER,
    front_door_secret_source: "ssm-parameter",
    front_door_secret_parameter_name: FRONT_DOOR_PARAMETER,
  });
  assert.equal(
    Object.hasOwn(postureMetadata(template), "front_door_secret_sha256"),
    false,
    "the parameter form records no digest of a value the application never holds",
  );
});

test("parameter form renders the origin header as an ssm dynamic reference", () => {
  const { stack, server } = frontedStackWith(parameterFrontDoorVerification());
  assert.deepEqual(server.frontDoorOriginHeader, {
    headerName: FRONT_DOOR_HEADER,
    headerValue: `{{resolve:ssm:${FRONT_DOOR_PARAMETER}}}`,
  });

  const distribution = new cloudfront.Distribution(stack, "FrontDoor", {
    defaultBehavior: {
      origin: new origins.HttpOrigin("origin.example.com", {
        customHeaders: {
          [server.frontDoorOriginHeader.headerName]: server.frontDoorOriginHeader.headerValue,
        },
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    },
  });
  assert.ok(distribution);
  const template = assertions.Template.fromStack(stack).toJSON();
  const [emitted] = resourcesOfType(template, "AWS::CloudFront::Distribution");
  assert.deepEqual(
    emitted.Properties.DistributionConfig.Origins[0].OriginCustomHeaders,
    [{ HeaderName: FRONT_DOOR_HEADER, HeaderValue: `{{resolve:ssm:${FRONT_DOOR_PARAMETER}}}` }],
    "the app-owned distribution carries the reference, not a value",
  );
});

test("literal form still renders the literal and keeps its marker byte-identical", () => {
  const { server } = frontedStackWith(frontDoorVerification(), { stackId: "FrontedLiteralStack" });
  assert.deepEqual(server.frontDoorOriginHeader, {
    headerName: FRONT_DOOR_HEADER,
    headerValue: FRONT_DOOR_SECRET,
  });
});

test("parameter form grants ssm:GetParameter on exactly that parameter", () => {
  const { stack } = frontedStackWith(parameterFrontDoorVerification(), {
    stackId: "FrontedParameterGrantStack",
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const statements = policyStatements(template);
  const grant = statements.find((statement) => [].concat(statement.Action).includes("ssm:GetParameter"));
  assert.ok(grant, "the construct grants the runtime read access to the parameter");
  assert.equal(
    JSON.stringify(grant.Resource),
    JSON.stringify({
      "Fn::Join": ["", [
        "arn:",
        { Ref: "AWS::Partition" },
        `:ssm:us-east-1:123456789012:parameter${FRONT_DOOR_PARAMETER}`,
      ]],
    }),
    "the grant names exactly the well-known parameter ARN",
  );
  assert.equal(
    JSON.stringify(statements).includes("parameter/*"),
    false,
    "the grant names the parameter, never a wildcard",
  );
});

test("parameter form grants kms:Decrypt only when a key is declared", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedParameterKmsStack", {
    env: { region: "us-east-1", account: "123456789012" },
  });
  const key = new (require("aws-cdk-lib/aws-kms").Key)(stack, "ParameterKey", {});
  const api = new apigwv2.HttpApi(stack, "Api");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api,
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
    frontDoorVerification: parameterFrontDoorVerification({ secretParameterKmsKey: key }),
    ...runtimeBearerFloor(),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.ok(
    policyStatements(template).some((statement) => [].concat(statement.Action).includes("kms:Decrypt")),
    "a declared customer managed key adds kms:Decrypt",
  );
});

test("secretValue and secretParameterName are mutually exclusive", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedBothFormsStack");
  const api = new apigwv2.HttpApi(stack, "Api");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api,
      originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
      frontDoorVerification: frontDoorVerification({ secretParameterName: FRONT_DOOR_PARAMETER }),
      ...runtimeBearerFloor(),
    }),
    /requires exactly one of secretValue and secretParameterName/,
  );
});

test("FRONTED requires one of the two secret forms", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedNeitherFormStack");
  const api = new apigwv2.HttpApi(stack, "Api");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api,
      originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
      frontDoorVerification: { headerName: FRONT_DOOR_HEADER, asserted: true },
      ...runtimeBearerFloor(),
    }),
    /requires exactly one of secretValue and secretParameterName/,
  );
});

test("the parameter name must be a dynamic-reference-safe, well-known name", () => {
  const cases = [
    {
      name: "no leading slash",
      secretParameterName: "theorycloud/tms/lab/fronted-token",
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "colon cannot appear in a dynamic reference",
      secretParameterName: "/theorycloud/tms/lab/fronted:token",
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "empty segment",
      secretParameterName: "/theorycloud//fronted-token",
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "trailing slash",
      secretParameterName: "/theorycloud/tms/",
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "reserved aws hierarchy",
      secretParameterName: "/aws/fronted-token",
      error: /must not use the reserved aws or ssm hierarchy/,
    },
    {
      name: "reserved ssm hierarchy",
      secretParameterName: "/SSM/fronted-token",
      error: /must not use the reserved aws or ssm hierarchy/,
    },
    {
      name: "too many levels",
      secretParameterName: `/${Array.from({ length: 16 }, (_, index) => `l${index}`).join("/")}`,
      error: /must have between one and fifteen hierarchy levels/,
    },
    {
      name: "longer than 1011 characters",
      secretParameterName: `/${"a".repeat(1011)}`,
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
  ];
  for (const item of cases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `FrontedBadParameter${item.name.replace(/[^A-Za-z0-9]/g, "")}`);
    const api = new apigwv2.HttpApi(stack, "Api");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api,
        originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
        frontDoorVerification: parameterFrontDoorVerification(
          { secretParameterName: item.secretParameterName },
        ),
        ...runtimeBearerFloor(),
      }),
      item.error,
      item.name,
    );
  }
});

test("secretParameterKmsKey is refused with the literal form", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FrontedLiteralKmsStack");
  const key = new (require("aws-cdk-lib/aws-kms").Key)(stack, "ParameterKey", {});
  const api = new apigwv2.HttpApi(stack, "Api");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api,
      originReachability: apptheory.AppTheoryMcpOriginReachability.FRONTED,
      frontDoorVerification: frontDoorVerification({ secretParameterKmsKey: key }),
      ...runtimeBearerFloor(),
    }),
    /secretParameterKmsKey is only valid with secretParameterName/,
  );
});
