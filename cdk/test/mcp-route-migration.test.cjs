const assert = require("node:assert/strict");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

// Bucket every HTTP API v2 route by the API it belongs to (via its ApiId Ref),
// recording the logical ids that hold each route key.
function routeKeysByApi(template) {
  const byApi = new Map();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== "AWS::ApiGatewayV2::Route") continue;
    const apiRef = resource.Properties?.ApiId?.Ref;
    assert.ok(apiRef, `route ${logicalId} must reference its API`);
    if (!byApi.has(apiRef)) byApi.set(apiRef, new Map());
    const keys = byApi.get(apiRef);
    const routeKey = resource.Properties.RouteKey;
    keys.set(routeKey, [...(keys.get(routeKey) ?? []), logicalId]);
  }
  return byApi;
}

function routeInventory(template) {
  const keys = new Set();
  const logicalIds = [];
  for (const [, apiKeys] of routeKeysByApi(template)) {
    for (const [routeKey, ids] of apiKeys) {
      assert.equal(
        ids.length,
        1,
        `route key ${routeKey} must be held by exactly one logical id, found ${ids.join(", ")}`,
      );
      keys.add(routeKey);
      logicalIds.push(ids[0]);
    }
  }
  return { keys, logicalIds };
}

test("new-API swap never moves a route key between logical ids in an API", () => {
  const app = new cdk.App();

  // B1-shaped: the deployed positional explicit model, one route per route key.
  const b1Stack = new cdk.Stack(app, "B1Stack");
  new apptheory.AppTheoryMcpServer(b1Stack, "McpServer", {
    handler: handler(b1Stack),
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
  });

  // Replacement: a brand-new consolidated API swapped in behind the origin.
  const nextStack = new cdk.Stack(app, "McpConsolidatedStack");
  new apptheory.AppTheoryMcpServer(nextStack, "McpServer", {
    handler: handler(nextStack),
    transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
    runtimePosture: { requireBearerToken: true },
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    denialSignal: {},
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
  });

  const b1 = routeInventory(assertions.Template.fromStack(b1Stack).toJSON());
  const next = routeInventory(assertions.Template.fromStack(nextStack).toJSON());

  // The B1-shaped stack keeps its full explicit inventory (positional ids, no moves).
  assert.ok(b1.keys.size > 2, "the B1-shaped stack keeps the explicit route inventory");
  assert.ok(
    b1.logicalIds.some((id) => /Route\d/.test(id)),
    "the explicit model stays positional so a B1 stack deploys in place",
  );

  // The consolidated API emits exactly the two greedy keys.
  assert.deepEqual([...next.keys].sort(), ["ANY /", "ANY /{proxy+}"]);

  // Every created key lives in a different API than any B1 logical id.
  for (const routeKey of next.keys) {
    assert.ok(!b1.keys.has(routeKey), `created key ${routeKey} was already held by a B1 logical id`);
  }
});
