// AppTheoryRestV1ChallengeRestoration: framework CloudFront edge construct that
// restores the canonical WWW-Authenticate challenge for AWS API Gateway REST API
// v1 origins (design §9, FRAMEWORK_VS_POLICY.md row 12).
const assert = require("node:assert/strict");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigw = require("aws-cdk-lib/aws-apigateway");
const assertions = require("aws-cdk-lib/assertions");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");

const {
  AppTheoryMcpRouteAlgebra: Algebra,
  AppTheoryRestV1ChallengeRestoration,
  AppTheoryRestV1OriginReachability,
} = require("../lib/index.js");

const METADATA_KEY = "apptheory:rest-v1-challenge-restoration";
const CONTRACT_ID = "m17.rest-v1-challenge-restoration/v1";
const REMAP_HEADER = "x-amzn-remapped-www-authenticate";
const ALIAS_HEADERS = ["x-theory-www-authenticate", "mcp-www-authenticate"];
const ORIGIN_LOCK_HEADER = "x-apptheory-origin-lock";
const ORIGIN_LOCK_SECRET = "0123456789abcdef0123456789abcdef";
const NON_REST_V1_ORIGIN_MESSAGE =
  "AppTheoryRestV1ChallengeRestoration: origin must be an AWS API Gateway REST API (v1); " +
  "the WWW-Authenticate restoration is a documented no-op on HTTP API v2";

// EdgeFunction requires an explicit region, and a us-east-1 stack keeps the
// edge function in-stack (no cross-region support stack) so the distribution,
// the edge function, and its version all appear in one template.
function newStack() {
  const app = new cdk.App();
  return new cdk.Stack(app, "RestV1ChallengeRestorationStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
}

function newRestApi(stack) {
  const api = new apigw.RestApi(stack, "Api", {
    deployOptions: { stageName: "prod" },
  });
  api.root.addMethod("GET", new apigw.MockIntegration());
  return api;
}

// The DD-2 props every behavior test shares: a LOCKED origin with a valid lock.
// The decision itself is exercised by the dedicated decision tests below.
function locked() {
  return {
    originReachability: AppTheoryRestV1OriginReachability.LOCKED,
    originLock: { secret: ORIGIN_LOCK_SECRET, asserted: true },
  };
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter(
    (resource) => resource.Type === type,
  );
}

function resourcesOfTypeWithId(template, type) {
  return Object.entries(template.Resources ?? {}).filter(
    ([, resource]) => resource.Type === type,
  );
}

function distributionConfig(template) {
  const distributions = resourcesOfType(template, "AWS::CloudFront::Distribution");
  assert.equal(distributions.length, 1, "exactly one CloudFront distribution");
  return distributions[0].Properties.DistributionConfig;
}

function originOf(template) {
  const config = distributionConfig(template);
  assert.equal(config.Origins.length, 1, "one origin");
  return config.Origins[0];
}

function orderedBehaviors(config) {
  return config.CacheBehaviors ?? [];
}

function inlineLambdaCode(template) {
  const functions = resourcesOfType(template, "AWS::Lambda::Function");
  assert.equal(functions.length, 1, "exactly one inline edge Lambda function");
  const code = functions[0].Properties.Code?.ZipFile;
  assert.equal(typeof code, "string", "the edge Lambda carries inline code");
  return code;
}

function originRequestPolicyHeaders(template) {
  const entries = resourcesOfTypeWithId(template, "AWS::CloudFront::OriginRequestPolicy");
  assert.equal(entries.length, 1, "one shared origin request policy");
  return entries[0][1].Properties.OriginRequestPolicyConfig.HeadersConfig;
}

function distributionMetadata(template) {
  const distributions = resourcesOfTypeWithId(template, "AWS::CloudFront::Distribution");
  assert.equal(distributions.length, 1);
  return distributions[0][1].Metadata[METADATA_KEY];
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the construct to throw");
}

// The derivation rule under test: for each resource path R, the route set is
// {R, protected, authorization-server, authorize, token, register,
// authorization-server-suffix}, plus the single stage-global callback.
function expectedDerivedRoutes(resourcePaths) {
  const derivations = [
    (path) => path,
    (path) => Algebra.protectedResourcePathForResourcePath(path),
    (path) => Algebra.authorizationServerPathForResourcePath(path),
    (path) => Algebra.authorizationAuthorizePathForResourcePath(path),
    (path) => Algebra.authorizationTokenPathForResourcePath(path),
    (path) => Algebra.authorizationRegisterPathForResourcePath(path),
    (path) => Algebra.authorizationServerSuffixPathForResourcePath(path),
  ];
  const derived = new Set();
  for (const resourcePath of resourcePaths) {
    for (const derive of derivations) {
      derived.add(derive(resourcePath));
    }
  }
  derived.add(
    Algebra.callbackPathForConfiguredPath(Algebra.DEFAULT_CALLBACK_PATH),
  );
  return [...derived].sort();
}

test("derives the route set from the shared route algebra", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    resourcePaths: ["/mcp"],
  });

  const expected = expectedDerivedRoutes(["/mcp"]);
  assert.deepEqual(construct.derivedRoutePaths, expected);
  // Every "/mcp" derivation is literal, so every derived route is a behavior
  // path pattern, in the same deterministic order.
  assert.deepEqual(construct.behaviorPathPatterns, expected);
  assert.ok(
    expected.every((path) => !path.includes("{") && !path.includes("}")),
    "the /mcp derivation is fully literal",
  );
});

test("synthesizes the distribution, origin request policy and origin-response edge function", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const config = distributionConfig(template);

  // Origin: HTTPS-only execute-api origin carrying the REST v1 stage path.
  assert.equal(config.Origins.length, 1, "one origin");
  assert.equal(
    config.Origins[0].CustomOriginConfig.OriginProtocolPolicy,
    "https-only",
    "the execute-api origin is HTTPS only",
  );
  assert.deepEqual(config.Origins[0].CustomOriginConfig.OriginSSLProtocols, [
    "TLSv1.2",
  ]);
  assert.ok(
    JSON.stringify(config.Origins[0].DomainName).includes("execute-api.us-east-1."),
    "the origin is the REST API execute-api domain",
  );

  // The shared origin request policy forwards every viewer header except Host
  // and, under LOCKED, the origin-lock header as well (so a viewer copy cannot
  // ride along with the CloudFront-injected one), plus all cookies and all query
  // strings (the CDK-native form of the managed ALL_VIEWER_EXCEPT_HOST_HEADER
  // policy, which cannot carry Authorization in an allow list). The query string
  // must be forwarded or the derived authorize and callback routes lose their
  // parameters; cookies must be forwarded for a cookie-carried session.
  assert.deepEqual(originRequestPolicyHeaders(template), {
    HeaderBehavior: "allExcept",
    Headers: ["Host", ORIGIN_LOCK_HEADER],
  });
  const entries = resourcesOfTypeWithId(template, "AWS::CloudFront::OriginRequestPolicy");
  const [policyLogicalId, policy] = entries[0];
  assert.deepEqual(policy.Properties.OriginRequestPolicyConfig.CookiesConfig, {
    CookieBehavior: "all",
  });
  assert.deepEqual(policy.Properties.OriginRequestPolicyConfig.QueryStringsConfig, {
    QueryStringBehavior: "all",
  });

  const allBehaviors = [config.DefaultCacheBehavior, ...orderedBehaviors(config)];
  assert.equal(
    allBehaviors.length,
    construct.behaviorPathPatterns.length + 1,
    "the default behavior plus one ordered behavior per literal derived route",
  );
  for (const behavior of allBehaviors) {
    assert.equal(
      behavior.ViewerProtocolPolicy,
      "redirect-to-https",
      "viewer protocol is redirect-to-https",
    );
    assert.equal(
      behavior.CachePolicyId,
      cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
      "caching is disabled",
    );
    assert.equal(behavior.AllowedMethods.length, 7, "ALLOW_ALL method set");
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]) {
      assert.ok(behavior.AllowedMethods.includes(method), `${method} allowed`);
    }
    assert.deepEqual(behavior.OriginRequestPolicyId, { Ref: policyLogicalId });
    assert.equal(behavior.LambdaFunctionAssociations.length, 1);
    assert.equal(
      behavior.LambdaFunctionAssociations[0].EventType,
      "origin-response",
      "every behavior carries an origin-response edge lambda",
    );
  }

  const functions = resourcesOfType(template, "AWS::Lambda::Function");
  assert.equal(functions[0].Properties.Runtime, "nodejs22.x");
  assert.equal(functions[0].Properties.Handler, "index.handler");
  assert.equal(
    resourcesOfType(template, "AWS::Lambda::Version").length,
    1,
    "the edge function is pinned to a version",
  );
});

test("the default alias bridge consults only the AWS REST v1 remap artifact", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });

  assert.equal(construct.aliasBridgeEnabled, false);
  assert.deepEqual(construct.restoreSourceHeaders, [REMAP_HEADER]);

  const code = inlineLambdaCode(assertions.Template.fromStack(stack).toJSON());
  assert.ok(code.includes(REMAP_HEADER), "the remap artifact is consulted");
  assert.ok(
    !code.includes("x-theory-www-authenticate"),
    "the disabled bridge must not embed x-theory-www-authenticate",
  );
  assert.ok(
    !code.includes("mcp-www-authenticate"),
    "the disabled bridge must not embed mcp-www-authenticate",
  );
  assert.ok(
    code.includes(`delete headers['${REMAP_HEADER}']`),
    "the consumed source header is deleted after restoring",
  );
  assert.ok(
    code.includes("'www-authenticate'") && code.includes("key: 'WWW-Authenticate'"),
    "the canonical WWW-Authenticate header is restored",
  );
});

test("the enabled alias bridge consults the remap artifact before the alias spellings", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    aliasBridge: { enabled: true },
  });

  assert.equal(construct.aliasBridgeEnabled, true);
  assert.deepEqual(construct.restoreSourceHeaders, [REMAP_HEADER, ...ALIAS_HEADERS]);

  const code = inlineLambdaCode(assertions.Template.fromStack(stack).toJSON());
  const remapIndex = code.indexOf(REMAP_HEADER);
  const helperIndex = code.indexOf("x-theory-www-authenticate");
  const mcpIndex = code.indexOf("mcp-www-authenticate");
  assert.ok(remapIndex >= 0, "the remap artifact appears");
  assert.ok(
    remapIndex < helperIndex && helperIndex < mcpIndex,
    "the sources are ordered remap, then x-theory, then mcp",
  );
  for (const header of ALIAS_HEADERS) {
    assert.ok(
      code.includes(`delete headers['${header}']`),
      `the consumed alias header ${header} is deleted`,
    );
  }
});

test("refuses an origin that is not a REST API v1", () => {
  const stack = newStack();
  const error = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
        ...locked(),
        origin: {},
      }),
  );
  assert.equal(error.message, NON_REST_V1_ORIGIN_MESSAGE);
});

test("refuses domainNames without a certificate", () => {
  const stack = newStack();
  const error = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
        ...locked(),
        origin: newRestApi(stack),
        domainNames: ["api.example.com"],
      }),
  );
  assert.equal(
    error.message,
    "AppTheoryRestV1ChallengeRestoration: domainNames requires certificate",
  );
});

test("refuses a resourcePaths entry the route model cannot derive", () => {
  const stack = newStack();
  const error = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
        ...locked(),
        origin: newRestApi(stack),
        resourcePaths: [42],
      }),
  );
  assert.ok(
    error.message.startsWith(
      'AppTheoryRestV1ChallengeRestoration: resourcePaths entry "42" is not a route the route model can derive: ',
    ),
    `unexpected message: ${error.message}`,
  );
});

test("refuses a missing or direct origin reachability decision at synthesis", () => {
  const cases = [
    { label: "missing", props: {}, received: "undefined" },
    { label: "direct", props: { originReachability: "direct" }, received: '"direct"' },
    { label: "unknown", props: { originReachability: "public" }, received: '"public"' },
  ];
  for (const { label, props, received } of cases) {
    const stack = newStack();
    const error = captureError(
      () =>
        new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
          origin: newRestApi(stack),
          ...props,
        }),
    );
    assert.ok(
      error.message.includes("originReachability is required and must be"),
      `${label}: expected the required-decision error, got: ${error.message}`,
    );
    assert.ok(
      error.message.includes("AppTheoryRestV1OriginReachability.DISABLED or .LOCKED"),
      label,
    );
    assert.ok(
      error.message.includes("('direct') is not allowed") &&
        error.message.includes(received),
      `${label}: the rejected decision is named (${received})`,
    );
  }
});

test("DISABLED requires the caller's disablement assertion and injects no origin lock", () => {
  // The assertion is mandatory: the construct fronts an external IRestApi it
  // cannot mutate, so it never sets disableExecuteApiEndpoint itself.
  const refusalStack = newStack();
  const error = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(refusalStack, "Restoration", {
        origin: newRestApi(refusalStack),
        originReachability: AppTheoryRestV1OriginReachability.DISABLED,
      }),
  );
  assert.ok(
    error.message.includes("disableExecuteApiEndpointAsserted: true"),
    `unexpected message: ${error.message}`,
  );
  assert.ok(error.message.includes("external IRestApi"));

  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    origin: newRestApi(stack),
    originReachability: AppTheoryRestV1OriginReachability.DISABLED,
    disableExecuteApiEndpointAsserted: true,
  });
  assert.equal(construct.originReachability, "disabled");
  assert.equal(construct.originLockHeaderName, undefined);

  const template = assertions.Template.fromStack(stack).toJSON();
  const origin = originOf(template);
  assert.equal(
    origin.OriginCustomHeaders,
    undefined,
    "DISABLED injects no origin custom header",
  );
  assert.deepEqual(originRequestPolicyHeaders(template), {
    HeaderBehavior: "allExcept",
    Headers: ["Host"],
  });
  // The construct does not own the API, so it records the caller's assertion
  // rather than mutating the external REST API.
  const apis = resourcesOfType(template, "AWS::ApiGateway::RestApi");
  assert.equal(apis.length, 1);
  assert.equal(
    apis[0].Properties.DisableExecuteApiEndpoint,
    undefined,
    "the construct never mutates an external IRestApi",
  );
  assert.deepEqual(distributionMetadata(template), {
    contractId: CONTRACT_ID,
    aliasBridge: false,
    sourceHeaders: [REMAP_HEADER],
    routeCount: construct.derivedRoutePaths.length,
    originReachability: "disabled",
    disableExecuteApiEndpointAsserted: true,
  });
});

test("LOCKED requires a complete origin lock", () => {
  const cases = [
    {
      label: "no originLock",
      lock: undefined,
      expected: "LOCKED requires originLock",
    },
    {
      label: "asserted false",
      lock: { secret: ORIGIN_LOCK_SECRET, asserted: false },
      expected: "requires originLock.asserted: true",
    },
    {
      label: "short secret",
      lock: { secret: "tooshort", asserted: true },
      expected: "originLock.secret must be 32..128 characters",
    },
    {
      label: "secret with a control character",
      lock: { secret: `${"a".repeat(32)}\r\nx`, asserted: true },
      expected: "originLock.secret must be 32..128 characters",
    },
    {
      label: "secret with whitespace",
      lock: { secret: `${"a".repeat(31)} `, asserted: true },
      expected: "originLock.secret must be 32..128 characters",
    },
    {
      label: "reserved header name",
      lock: { secret: ORIGIN_LOCK_SECRET, asserted: true, headerName: "authorization" },
      expected: "is reserved by CloudFront or the origin request contract",
    },
    {
      label: "aws reserved header prefix",
      lock: { secret: ORIGIN_LOCK_SECRET, asserted: true, headerName: "x-amzn-trace-id" },
      expected: "is reserved by CloudFront or the origin request contract",
    },
    {
      label: "header name outside the alphabet",
      lock: { secret: ORIGIN_LOCK_SECRET, asserted: true, headerName: "x lock" },
      expected: "headerName must be 1..64 characters of [A-Za-z0-9-]",
    },
  ];
  for (const { label, lock, expected } of cases) {
    const stack = newStack();
    const error = captureError(
      () =>
        new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
          origin: newRestApi(stack),
          originReachability: AppTheoryRestV1OriginReachability.LOCKED,
          ...(lock === undefined ? {} : { originLock: lock }),
        }),
    );
    assert.ok(
      error.message.includes(expected),
      `${label}: expected "${expected}", got: ${error.message}`,
    );
  }
});

test("refuses contradictory reachability props", () => {
  const disabledStack = newStack();
  const disabledError = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(disabledStack, "Restoration", {
        origin: newRestApi(disabledStack),
        originReachability: AppTheoryRestV1OriginReachability.DISABLED,
        disableExecuteApiEndpointAsserted: true,
        originLock: { secret: ORIGIN_LOCK_SECRET, asserted: true },
      }),
  );
  assert.ok(disabledError.message.includes("originLock is only valid with originReachability"));

  const lockedStack = newStack();
  const lockedError = captureError(
    () =>
      new AppTheoryRestV1ChallengeRestoration(lockedStack, "Restoration", {
        ...locked(),
        origin: newRestApi(lockedStack),
        disableExecuteApiEndpointAsserted: true,
      }),
  );
  assert.ok(
    lockedError.message.includes("disableExecuteApiEndpointAsserted is only valid with originReachability"),
  );
});

test("LOCKED injects the origin-lock header on the origin and never into the edge function", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });
  assert.equal(construct.originReachability, "locked");
  assert.equal(construct.originLockHeaderName, ORIGIN_LOCK_HEADER);

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(originOf(template).OriginCustomHeaders, [
    { HeaderName: ORIGIN_LOCK_HEADER, HeaderValue: ORIGIN_LOCK_SECRET },
  ]);
  assert.deepEqual(distributionMetadata(template), {
    contractId: CONTRACT_ID,
    aliasBridge: false,
    sourceHeaders: [REMAP_HEADER],
    routeCount: construct.derivedRoutePaths.length,
    originReachability: "locked",
    originLockHeader: ORIGIN_LOCK_HEADER,
  });

  const code = inlineLambdaCode(template);
  assert.ok(
    !code.includes(ORIGIN_LOCK_SECRET),
    "the origin-lock secret reaches the origin, never the edge function",
  );
  assert.ok(
    !code.includes(ORIGIN_LOCK_HEADER),
    "the edge function does not consult the origin-lock header",
  );
});

test("honors a custom origin-lock header name", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    origin: newRestApi(stack),
    originReachability: AppTheoryRestV1OriginReachability.LOCKED,
    originLock: {
      secret: ORIGIN_LOCK_SECRET,
      asserted: true,
      headerName: "x-example-origin-verify",
    },
  });
  assert.equal(construct.originLockHeaderName, "x-example-origin-verify");

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(originOf(template).OriginCustomHeaders, [
    { HeaderName: "x-example-origin-verify", HeaderValue: ORIGIN_LOCK_SECRET },
  ]);
  assert.deepEqual(originRequestPolicyHeaders(template), {
    HeaderBehavior: "allExcept",
    Headers: ["Host", "x-example-origin-verify"],
  });
});

test("records the restoration marker in the distribution metadata", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(distributionMetadata(template), {
    contractId: CONTRACT_ID,
    aliasBridge: false,
    sourceHeaders: [REMAP_HEADER],
    routeCount: construct.derivedRoutePaths.length,
    originReachability: "locked",
    originLockHeader: ORIGIN_LOCK_HEADER,
  });

  const bridgedStack = newStack();
  const bridged = new AppTheoryRestV1ChallengeRestoration(bridgedStack, "Restoration", {
    ...locked(),
    origin: newRestApi(bridgedStack),
    aliasBridge: { enabled: true },
  });
  const bridgedTemplate = assertions.Template.fromStack(bridgedStack).toJSON();
  assert.deepEqual(distributionMetadata(bridgedTemplate), {
    contractId: CONTRACT_ID,
    aliasBridge: true,
    sourceHeaders: [REMAP_HEADER, ...ALIAS_HEADERS],
    routeCount: bridged.derivedRoutePaths.length,
    originReachability: "locked",
    originLockHeader: ORIGIN_LOCK_HEADER,
  });
});

test("orders one cache behavior per literal derived route", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    resourcePaths: ["/mcp"],
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const config = distributionConfig(template);

  const pathPatterns = orderedBehaviors(config).map(
    (behavior) => behavior.PathPattern,
  );
  assert.deepEqual(
    [...pathPatterns].sort(),
    [...construct.behaviorPathPatterns].sort(),
  );
  assert.equal(pathPatterns.length, construct.behaviorPathPatterns.length);
  assert.equal(
    new Set(pathPatterns).size,
    pathPatterns.length,
    "behavior path patterns are unique",
  );
});

test("accepts a parameterized resource path and covers it with the default behavior", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    resourcePaths: ["/agents/{actor}/mcp"],
  });

  const expected = expectedDerivedRoutes(["/agents/{actor}/mcp"]);
  assert.deepEqual(construct.derivedRoutePaths, expected);
  assert.ok(
    construct.derivedRoutePaths.includes("/agents/{actor}/mcp"),
    "the parameterized resource path itself is derived",
  );
  assert.ok(
    construct.derivedRoutePaths.some((path) => path.includes("{actor}")),
    "derived routes retain the {actor} placeholder",
  );
  assert.ok(
    construct.behaviorPathPatterns.every(
      (path) => !path.includes("{") && !path.includes("}"),
    ),
    "no behavior path pattern carries a {parameter} segment",
  );
  assert.deepEqual(construct.behaviorPathPatterns, [
    Algebra.callbackPathForConfiguredPath(Algebra.DEFAULT_CALLBACK_PATH),
  ]);

  const template = assertions.Template.fromStack(stack).toJSON();
  const config = distributionConfig(template);
  assert.equal(orderedBehaviors(config).length, 1);
  assert.equal(
    config.DefaultCacheBehavior.LambdaFunctionAssociations[0].EventType,
    "origin-response",
    "the default behavior covers the parameterized routes with the edge lambda",
  );
});

test("treats an empty resourcePaths array as the default resource patterns", () => {
  const stack = newStack();
  const construct = new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    resourcePaths: [],
  });
  const defaultResourcePaths = Algebra.supportedEndpointTemplates().map(
    (template) => template.mcpPattern,
  );
  assert.deepEqual(
    construct.derivedRoutePaths,
    expectedDerivedRoutes(defaultResourcePaths),
  );
});

test("fronts the REST v1 domain when a certificate is supplied", () => {
  const stack = newStack();
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "Certificate",
    "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  );
  new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
    domainNames: ["api.example.com"],
    certificate,
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const config = distributionConfig(template);
  assert.deepEqual(config.Aliases, ["api.example.com"]);
  assert.equal(config.PriceClass, "PriceClass_100");
});

// Loads the embedded Lambda@Edge source and returns its exported handler, so the
// restore/delete behavior is exercised as real code rather than as substrings.
function loadInlineHandler(template) {
  const module = { exports: {} };
  const factory = new Function("module", "exports", inlineLambdaCode(template));
  factory(module, module.exports);
  return module.exports.handler;
}

function originResponseEvent(headers) {
  return { Records: [{ cf: { response: { headers } } }] };
}

test("restores the challenge from the remap artifact and removes the consumed header", async () => {
  const stack = newStack();
  new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });
  const handler = loadInlineHandler(assertions.Template.fromStack(stack).toJSON());
  const challenge = 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';

  const pending = handler(
    originResponseEvent({
      "x-amzn-remapped-www-authenticate": [
        { key: "x-amzn-remapped-www-authenticate", value: challenge },
      ],
    }),
  );
  assert.ok(
    pending instanceof Promise,
    "the generated Lambda@Edge handler must complete through its returned promise",
  );
  const response = await pending;
  assert.deepEqual(response.headers["www-authenticate"], [
    { key: "WWW-Authenticate", value: challenge },
  ]);
  assert.equal(
    response.headers["x-amzn-remapped-www-authenticate"],
    undefined,
    "the consumed remap header is removed",
  );
});

test("leaves an origin-emitted challenge intact and still removes the source header", async () => {
  const stack = newStack();
  new AppTheoryRestV1ChallengeRestoration(stack, "Restoration", {
    ...locked(),
    origin: newRestApi(stack),
  });
  const handler = loadInlineHandler(assertions.Template.fromStack(stack).toJSON());

  const response = await handler(
    originResponseEvent({
      "www-authenticate": [{ key: "WWW-Authenticate", value: "canonical" }],
      "x-amzn-remapped-www-authenticate": [
        { key: "x-amzn-remapped-www-authenticate", value: "remapped" },
      ],
    }),
  );
  assert.deepEqual(response.headers["www-authenticate"], [
    { key: "WWW-Authenticate", value: "canonical" },
  ]);
  assert.equal(response.headers["x-amzn-remapped-www-authenticate"], undefined);
});

test("restores from a bridge alias only when the alias bridge is enabled", async () => {
  const enabledStack = newStack();
  new AppTheoryRestV1ChallengeRestoration(enabledStack, "Restoration", {
    ...locked(),
    origin: newRestApi(enabledStack),
    aliasBridge: { enabled: true },
  });
  const enabledHandler = loadInlineHandler(
    assertions.Template.fromStack(enabledStack).toJSON(),
  );
  const challenge = 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
  const enabledResponse = await enabledHandler(
    originResponseEvent({
      "x-theory-www-authenticate": [
        { key: "x-theory-www-authenticate", value: challenge },
      ],
    }),
  );
  assert.deepEqual(enabledResponse.headers["www-authenticate"], [
    { key: "WWW-Authenticate", value: challenge },
  ]);
  assert.equal(enabledResponse.headers["x-theory-www-authenticate"], undefined);

  // The same origin response on the default (bridge-disabled) construct has no
  // source to restore from, so no canonical challenge is synthesized.
  const disabledStack = newStack();
  new AppTheoryRestV1ChallengeRestoration(disabledStack, "Restoration", {
    ...locked(),
    origin: newRestApi(disabledStack),
  });
  const disabledHandler = loadInlineHandler(
    assertions.Template.fromStack(disabledStack).toJSON(),
  );
  const disabledResponse = await disabledHandler(
    originResponseEvent({
      "x-theory-www-authenticate": [
        { key: "x-theory-www-authenticate", value: challenge },
      ],
    }),
  );
  assert.equal(disabledResponse.headers["www-authenticate"], undefined);
});
