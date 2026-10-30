// Conformance kit Layers A and C for the M1 transport posture
// (docs/development/planning/apptheory/mcp-auth-facade/CONFORMANCE_KIT.md).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

const POSTURE_CONTRACT_ID = "m17.mcp-transport-posture/v1";
const POSTURE_MARKER_KEY = "apptheory:mcp-transport-posture";

const postureFixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-transport-posture.v1.json",
    ),
    "utf8",
  ),
);

const routeModelFixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-route-model.v1.json",
    ),
    "utf8",
  ),
);

const posture = apptheory.AppTheoryMcpTransportPosture;
const reachability = apptheory.AppTheoryMcpOriginReachability;

const DOMAIN_CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";

// DISABLED and LOCKED are proven postures, so the owned floor names the custom
// domain that replaces the disabled execute-api authority.
function ordinaryDomain() {
  return { domainName: "mcp.example.com", certificateArn: DOMAIN_CERTIFICATE_ARN };
}

// Fixture OAuth-surface route name -> the matching derived route-inventory field,
// the method the construct wires for it, and the v2 route-model key it must equal.
// `upstream_callback` is not derived per kind, so it is driven from the route-model
// table's stage-global row instead of this per-route map.
const OAUTH_SURFACE_FIELDS = {
  protected_resource: {
    field: "protectedResourcePattern",
    routeModelKey: "protected_resource_pattern",
    method: "GET",
  },
  discovery_canonical: {
    field: "discoveryCanonicalPattern",
    routeModelKey: "discovery_canonical_pattern",
    method: "GET",
  },
  discovery_suffix: {
    field: "discoverySuffixPattern",
    routeModelKey: "discovery_suffix_pattern",
    method: "GET",
  },
  authorize: {
    field: "authorizePattern",
    routeModelKey: "authorize_pattern",
    method: "GET",
  },
  token: {
    field: "tokenPattern",
    routeModelKey: "token_pattern",
    method: "POST",
  },
  register: {
    field: "registerPattern",
    routeModelKey: "register_pattern",
    method: "POST",
  },
};

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function resourcesOfType(template, type) {
  return Object.values(template.Resources ?? {}).filter((resource) => resource.Type === type);
}

function synthesizedRoutes(template) {
  return resourcesOfType(template, "AWS::ApiGatewayV2::Route")
    .map((route) => ({
      key: route.Properties.RouteKey,
      authorizationType: route.Properties.AuthorizationType ?? "NONE",
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function postureMarkers(template) {
  const markers = [];
  for (const [id, resource] of Object.entries(template.Resources ?? {})) {
    const value = resource.Metadata?.[POSTURE_MARKER_KEY];
    if (value !== undefined) markers.push({ id, type: resource.Type, value });
  }
  return markers;
}

function expectedRouteAuthorizations(postureName, server) {
  const table = postureFixture.postures[postureName];
  assert.ok(table, `the posture table must define ${postureName}`);
  const expected = new Map();
  let oauthSurfaceAttached = false;
  for (const route of server.routeInventory.routes) {
    for (const method of route.mcpMethods) {
      expected.set(`${method} ${route.mcpPattern}`, table.transport_authorization_type);
    }
    if (!route.authorizationRoutesAttached) continue;
    oauthSurfaceAttached = true;
    const routeModelRow = routeModelFixture.patterns.find(
      (row) => row.mcp_pattern === route.mcpPattern,
    );
    assert.ok(routeModelRow, `${route.mcpPattern} must exist in the v2 route-model table`);
    for (const [name, { field, routeModelKey, method }] of Object.entries(OAUTH_SURFACE_FIELDS)) {
      assert.ok(
        postureFixture.oauth_surface_routes.includes(name),
        `the posture table must export the ${name} OAuth surface route`,
      );
      assert.equal(
        route[field],
        routeModelRow[routeModelKey],
        `${route.mcpPattern} ${name} must match the v2 route-model table`,
      );
      expected.set(`${method} ${route[field]}`, table.oauth_surface_authorization_type);
    }
  }
  if (oauthSurfaceAttached) {
    for (const route of routeModelFixture.stage_global) {
      assert.ok(
        postureFixture.oauth_surface_routes.includes(route.name),
        `the posture table must export the ${route.name} stage-global route`,
      );
      assert.deepEqual(
        server.routeInventory.callbackPattern,
        route.pattern,
        "the derived stage-global callback must match the v2 route-model table",
      );
      assert.equal(route.methods.length, 1, "the stage-global callback is one method");
      expected.set(
        `${route.methods[0]} ${route.pattern}`,
        table.oauth_surface_authorization_type,
      );
    }
  }
  return expected;
}

function failClosedFloor(postureName) {
  if (postureName === "runtime-bearer") {
    return {
      transportPosture: posture.RUNTIME_BEARER,
      runtimePosture: { requireBearerToken: true },
      originReachability: reachability.DISABLED,
      denialSignal: {},
      ownedApi: { stage: { throttlingEnabled: true }, domain: ordinaryDomain() },
      sessionState: { enabled: false },
    };
  }
  if (postureName === "none-public") {
    return {
      transportPosture: posture.NONE_PUBLIC,
      originReachability: reachability.DISABLED,
      ownedApi: { stage: { throttlingEnabled: true }, domain: ordinaryDomain() },
      sessionState: { enabled: false },
    };
  }
  return { sessionState: { enabled: false } };
}

for (const postureName of Object.keys(postureFixture.postures)) {
  test(`AppTheoryMcpServer transport routes match the ${postureName} contract row`, () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `Posture${postureName}Stack`);
    const props = failClosedFloor(postureName);
    if (postureName === "jwt") {
      props.transportAuthorizer = {
        issuer: "https://accounts.example.com",
        audience: ["https://mcp.example.com"],
      };
      props.transportPosture = posture.JWT;
    } else if (postureName === "iam") {
      props.transportPosture = posture.IAM;
    }
    const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      ...props,
    });

    assert.equal(server.transportPosture, postureName);
    const table = postureFixture.postures[postureName];
    assert.equal(
      table.oauth_surface_attached,
      postureName !== "none-public",
      `${postureName} posture table must agree that only none-public detaches the OAuth surface`,
    );
    assert.equal(
      server.routeInventory.routes[0].authorizationRoutesAttached,
      table.oauth_surface_attached,
      `${postureName} OAuth surface attachment must match the posture table`,
    );

    const expected = expectedRouteAuthorizations(postureName, server);
    const actual = synthesizedRoutes(assertions.Template.fromStack(stack).toJSON());

    assert.deepEqual(
      [...actual.map((route) => route.key)],
      [...expected.keys()].sort((left, right) => left.localeCompare(right)),
      `every synthesized ${postureName} route must carry an authorization expectation`,
    );
    for (const route of actual) {
      assert.equal(
        route.authorizationType,
        expected.get(route.key),
        `${route.key} must match the ${postureName} contract row`,
      );
    }
    if (postureName === "none-public") {
      for (const name of ["protected_resource", "discovery_canonical", "authorize", "token"]) {
        assert.ok(
          postureFixture.oauth_surface_routes.includes(name),
          `the posture table must export the ${name} OAuth surface route`,
        );
      }
    }
  });
}

test("AppTheoryMcpServer route inventory matches the v2 route-model table", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "RouteModelStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    sessionState: { enabled: false },
  });
  assert.deepEqual(
    server.mcpPaths,
    routeModelFixture.patterns.map((row) => row.mcp_pattern),
    "the default family must be the table's ordered MCP patterns",
  );
  const inventoryByPattern = new Map(
    server.routeInventory.routes.map((route) => [route.mcpPattern, route]),
  );
  for (const row of routeModelFixture.patterns) {
    const route = inventoryByPattern.get(row.mcp_pattern);
    assert.ok(route, `${row.kind} must be derived`);
    assert.equal(route.protectedResourcePattern, row.protected_resource_pattern);
    assert.equal(route.discoveryCanonicalPattern, row.discovery_canonical_pattern);
    assert.equal(route.discoverySuffixPattern, row.discovery_suffix_pattern);
    assert.equal(route.authorizePattern, row.authorize_pattern);
    assert.equal(route.tokenPattern, row.token_pattern);
    assert.equal(route.registerPattern, row.register_pattern);
  }
  assert.equal(
    server.routeInventory.rootAuthorizationServerPattern,
    routeModelFixture.contract.authorization_server_prefix,
    "the root discovery route must be the unscoped canonical discovery path",
  );
  assert.equal(
    server.routeInventory.contractVersion,
    routeModelFixture.contract.id,
    "the inventory contract version must be the v2 route-algebra contract",
  );
  assert.equal(
    server.routeInventory.callbackPattern,
    routeModelFixture.contract.default_callback_path,
    "the stage-global callback must be the v2 route-model default",
  );
});

test("AppTheoryMcpServer posture marker agrees with the resolved posture", () => {
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "MarkerOwnedStack");
    const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      sessionState: { enabled: false },
    });
    const markers = postureMarkers(assertions.Template.fromStack(stack).toJSON());
    assert.equal(markers.length, 1, "owned mode must write exactly one posture marker");
    assert.equal(markers[0].type, "AWS::ApiGatewayV2::Api", "owned mode marks the construct-owned API");
    assert.deepEqual(markers[0].value, {
      posture: server.transportPosture,
      contract_id: POSTURE_CONTRACT_ID,
      route_count: server.routeInventory.routes.length,
      runtime_posture_declared: false,
    });
  }
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "MarkerRuntimeBearerStack");
    const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      ...failClosedFloor("runtime-bearer"),
    });
    const markers = postureMarkers(assertions.Template.fromStack(stack).toJSON());
    assert.equal(markers.length, 1);
    assert.equal(markers[0].value.posture, posture.RUNTIME_BEARER);
    assert.equal(markers[0].value.posture, server.transportPosture);
    assert.equal(markers[0].value.contract_id, POSTURE_CONTRACT_ID);
    assert.equal(markers[0].value.route_count, server.routeInventory.routes.length);
    assert.equal(
      markers[0].value.runtime_posture_declared,
      true,
      "a declared runtime posture must be recorded",
    );
  }
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "MarkerAttachStack");
    const attachedApi = new apigwv2.HttpApi(stack, "Frontdoor", {
      disableExecuteApiEndpoint: true,
    });
    const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      api: attachedApi,
      transportPosture: posture.RUNTIME_BEARER,
      runtimePosture: { requireBearerToken: true },
      originReachability: reachability.DISABLED,
      denialSignal: { metricName: "apptheory.mcp.auth_denied" },
      owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
      sessionState: { enabled: false },
    });
    const markers = postureMarkers(assertions.Template.fromStack(stack).toJSON());
    assert.equal(markers.length, 1, "attach mode must write exactly one posture marker");
    assert.equal(
      markers[0].type,
      "AWS::ApiGatewayV2::Route",
      "attach mode marks the first construct-created transport route",
    );
    assert.deepEqual(markers[0].value, {
      posture: server.transportPosture,
      contract_id: POSTURE_CONTRACT_ID,
      route_count: server.routeInventory.routes.length,
      runtime_posture_declared: true,
    });
  }
});

const runtimeBearerFloor = failClosedFloor("runtime-bearer");
const nonePublicFloor = failClosedFloor("none-public");
const attachRuntimeBearer = {
  transportPosture: posture.RUNTIME_BEARER,
  runtimePosture: { requireBearerToken: true },
  originReachability: reachability.DISABLED,
  denialSignal: {},
  owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
  sessionState: { enabled: false },
};

const failClosedCases = [
  {
    name: "runtime bearer without a runtime posture declaration",
    props: {
      transportPosture: posture.RUNTIME_BEARER,
      originReachability: reachability.DISABLED,
      denialSignal: {},
      ownedApi: { stage: { throttlingEnabled: true } },
    },
    error: /RUNTIME_BEARER requires runtimePosture\.requireBearerToken to be true/,
  },
  {
    name: "runtime bearer with requireBearerToken false",
    props: {
      ...runtimeBearerFloor,
      runtimePosture: { requireBearerToken: false },
    },
    error: /RUNTIME_BEARER requires runtimePosture\.requireBearerToken to be true/,
  },
  {
    name: "runtime bearer without an origin reachability decision",
    props: {
      ...runtimeBearerFloor,
      originReachability: undefined,
    },
    error: /RUNTIME_BEARER requires originReachability to be AppTheoryMcpOriginReachability\.DISABLED or \.LOCKED/,
  },
  {
    name: "runtime bearer with a direct origin",
    props: {
      ...runtimeBearerFloor,
      originReachability: "direct",
    },
    error: /RUNTIME_BEARER requires originReachability to be AppTheoryMcpOriginReachability\.DISABLED or \.LOCKED/,
  },
  {
    name: "runtime bearer without a denial signal",
    props: {
      ...runtimeBearerFloor,
      denialSignal: undefined,
    },
    error: /RUNTIME_BEARER requires denialSignal/,
  },
  {
    name: "runtime bearer with an unbounded denial metric name",
    props: {
      ...runtimeBearerFloor,
      denialSignal: { metricName: "other.metric" },
    },
    error: /denialSignal\.metricName must be apptheory\.mcp\.auth_denied/,
  },
  {
    name: "runtime bearer with unbounded denial dimensions",
    props: {
      ...runtimeBearerFloor,
      denialSignal: { dimensions: ["outcome"] },
    },
    error: /denialSignal\.dimensions must be exactly \["outcome","route_family"\]/,
  },
  {
    name: "runtime bearer in attach mode without an owning API defense record",
    props: {
      ...attachRuntimeBearer,
      owningApiDefense: undefined,
    },
    api: true,
    error: /RUNTIME_BEARER requires owningApiDefense/,
  },
  {
    name: "runtime bearer in attach mode without owning API access logging",
    props: {
      ...attachRuntimeBearer,
      owningApiDefense: { accessLogging: false, throttling: { rateLimit: 50, burstLimit: 100 } },
    },
    api: true,
    error: /requires owningApiDefense\.accessLogging to be true/,
  },
  {
    name: "runtime bearer in attach mode with unbounded owning API throttling",
    props: {
      ...attachRuntimeBearer,
      owningApiDefense: { accessLogging: true, throttling: { rateLimit: 0, burstLimit: 100 } },
    },
    api: true,
    error: /requires owningApiDefense\.throttling rateLimit and burstLimit to be positive finite numbers/,
  },
  {
    name: "runtime bearer in attach mode with LOCKED",
    props: {
      ...attachRuntimeBearer,
      originReachability: reachability.LOCKED,
    },
    api: true,
    error: /originReachability LOCKED is unsupported in attach mode/,
  },
  {
    name: "runtime bearer in owned mode without an explicit throttle decision",
    props: {
      ...runtimeBearerFloor,
      ownedApi: { stage: { throttlingEnabled: false } },
    },
    error: /RUNTIME_BEARER requires an explicit ownedApi\.stage\.throttlingEnabled: true throttling decision/,
  },
  {
    name: "runtime bearer in owned mode without access logging",
    props: {
      ...runtimeBearerFloor,
      ownedApi: { stage: { throttlingEnabled: true, accessLogging: false } },
    },
    error: /RUNTIME_BEARER requires access logging/,
  },
  {
    name: "none-public without an origin reachability decision",
    props: {
      transportPosture: posture.NONE_PUBLIC,
      ownedApi: { stage: { throttlingEnabled: true } },
    },
    error: /NONE_PUBLIC requires originReachability to be AppTheoryMcpOriginReachability\.DISABLED or \.LOCKED/,
  },
  {
    name: "none-public with root authorization server discovery",
    props: {
      ...nonePublicFloor,
      routeFamily: { patterns: ["/mcp"], rootAuthorizationServerDiscovery: true },
    },
    error: /transportPosture NONE_PUBLIC cannot enable rootAuthorizationServerDiscovery/,
  },
  {
    name: "none-public with a runtime posture declaration",
    props: {
      ...nonePublicFloor,
      runtimePosture: { requireBearerToken: true },
    },
    error: /transportPosture NONE_PUBLIC cannot declare runtimePosture/,
  },
  {
    name: "facade attachment with an empty provider id",
    props: {
      facade: { providerId: "   " },
      runtimePosture: { requireBearerToken: true },
      originReachability: reachability.DISABLED,
      denialSignal: {},
      ownedApi: { stage: { throttlingEnabled: true } },
    },
    error: /facade\.providerId must be a non-empty synthesis-time literal string/,
  },
  {
    name: "facade attachment with an unresolved provider id",
    props: {
      facade: { providerId: cdk.Fn.ref("ProviderId") },
      runtimePosture: { requireBearerToken: true },
      originReachability: reachability.DISABLED,
      denialSignal: {},
      ownedApi: { stage: { throttlingEnabled: true } },
    },
    error: /facade\.providerId must be a non-empty synthesis-time literal string/,
  },
  {
    name: "unknown transport posture",
    props: {
      transportPosture: "custom",
    },
    error: /transportPosture must be AppTheoryMcpTransportPosture\.IAM, \.JWT, \.RUNTIME_BEARER, or \.NONE_PUBLIC/,
  },
  {
    name: "jwt without a transport authorizer",
    props: {
      transportPosture: posture.JWT,
    },
    error: /transportAuthorizer\.issuer is required when transportPosture is JWT/,
  },
  {
    name: "jwt without an audience",
    props: {
      transportPosture: posture.JWT,
      transportAuthorizer: { issuer: "https://accounts.example.com" },
    },
    error: /transportAuthorizer\.audience requires at least one accepted audience/,
  },
];

test("AppTheoryMcpServer covers every synth-enforceable fail-closed contract row", () => {
  const synthEnforceable = postureFixture.fail_closed.filter(
    (row) => row.expected === "synth throws",
  );
  assert.ok(synthEnforceable.length > 0, "the posture table must declare synth-enforceable rows");
  assert.ok(
    failClosedCases.length >= synthEnforceable.length,
    `must cover ${synthEnforceable.length} synth-enforceable fail-closed rows`,
  );
  for (const item of failClosedCases) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `FailClosed${item.name.replace(/[^A-Za-z0-9]/g, "")}Stack`);
    const props = { handler: handler(stack), sessionState: { enabled: false }, ...item.props };
    if (item.api) {
      props.api = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
        httpApiId: `api-${item.name.replace(/[^A-Za-z0-9]/g, "")}`,
      });
    }
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", props),
      item.error,
      item.name,
    );
  }
});
