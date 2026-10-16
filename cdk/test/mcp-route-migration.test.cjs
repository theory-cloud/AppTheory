const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigwv2Authorizers = require("aws-cdk-lib/aws-apigatewayv2-authorizers");
const apigwv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");
const {
  AppTheoryRouteTransitionProblemKind,
  checkRouteKeyTransitions,
  describeRouteTransitionProblems,
  indexRouteKeys,
} = require("../lib/route-transition");

// The transition check is reusable: a consumer that swaps its own route
// inventory for a construct-owned one calls the same helper over its own
// before-template and after-template of one stack.
const PROBLEM = AppTheoryRouteTransitionProblemKind;

function handler(stack, id = "Fn") {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 204 });"),
  });
}

function templateOf(fn) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TransitionStack");
  fn(stack);
  return assertions.Template.fromStack(stack).toJSON();
}

function routesOf(template) {
  return Object.entries(template.Resources ?? {})
    .filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route")
    .map(([logicalId, resource]) => ({
      logicalId,
      routeKey: resource.Properties.RouteKey,
      apiRef: JSON.stringify(resource.Properties.ApiId),
      authorizationType: resource.Properties.AuthorizationType ?? "NONE",
    }));
}

// The default family, and a family with one extra namespace pattern inserted in
// the middle. The insertion is the 2026-10-16 chain-swap shape: the route
// inventory grows mid-list, so everything emitted after the insertion point
// shifts position.
const FAMILY = [
  "/{client_namespace}/mcp",
  "/{client_namespace}/partners/{partner_id}/mcp",
  "/{client_namespace}/agents/{agent_id}/mcp",
  "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
];
const FAMILY_WITH_MID_LIST_INSERTION = [
  "/{client_namespace}/mcp",
  "/acme2/mcp",
  "/{client_namespace}/partners/{partner_id}/mcp",
  "/{client_namespace}/agents/{agent_id}/mcp",
  "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
];

function explicitTemplate(patterns, routeIdMode) {
  return templateOf((stack) => {
    new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
      routeFamily: { patterns, rootAuthorizationServerDiscovery: patterns.length === 1 },
      routeIdMode,
    });
  });
}

function movedRouteKeys(problems) {
  return [...new Set(problems.map((problem) => problem.routeKey))].sort();
}

test("route-key transition helper passes an unchanged template", () => {
  const before = explicitTemplate(FAMILY, undefined);
  assert.deepEqual(checkRouteKeyTransitions(before, before), []);
});

test("explicit legacy model fails the mid-list route-family change", () => {
  const before = explicitTemplate(FAMILY, apptheory.AppTheoryMcpRouteIdMode.LEGACY);
  const after = explicitTemplate(FAMILY_WITH_MID_LIST_INSERTION, apptheory.AppTheoryMcpRouteIdMode.LEGACY);

  const problems = checkRouteKeyTransitions(before, after);
  const moved = movedRouteKeys(problems);

  assert.ok(
    moved.length >= 10,
    `the chain-swap shape must move at least ten route keys between logical ids, moved ${moved.length}`,
  );
  assert.ok(
    problems.some((problem) => problem.kind === PROBLEM.OWNERSHIP_CHANGED),
    "a surviving key held by a different logical id must be reported",
  );
  assert.ok(
    problems.some((problem) => problem.kind === PROBLEM.CREATED_ROUTE_TAKES_EXISTING_KEY),
    "the inserted route must be reported as taking an existing route key",
  );

  // The legacy model stays positional, which is what makes the swap unsafe.
  assert.ok(
    routesOf(before).some((route) => /^McpServerRoute\d/.test(route.logicalId)),
    "the legacy explicit model stays positional",
  );
  // The reported keys are real keys of the shared API, not invented ones.
  const afterKeys = new Set(routesOf(after).map((route) => route.routeKey));
  for (const routeKey of moved) {
    assert.ok(afterKeys.has(routeKey), `moved key ${routeKey} must exist after the transition`);
  }
});

test("explicit legacy model fails a mid-list route-family reorder", () => {
  const reordered = [FAMILY[0], FAMILY[2], FAMILY[1], FAMILY[3]];
  const problems = checkRouteKeyTransitions(
    explicitTemplate(FAMILY, undefined),
    explicitTemplate(reordered, undefined),
  );
  assert.ok(movedRouteKeys(problems).length >= 10, "reordering the family must move its route keys");
});

test("explicit semantic routeIdMode passes the same mid-list route-family change", () => {
  const before = explicitTemplate(FAMILY, apptheory.AppTheoryMcpRouteIdMode.SEMANTIC);
  const after = explicitTemplate(FAMILY_WITH_MID_LIST_INSERTION, apptheory.AppTheoryMcpRouteIdMode.SEMANTIC);

  assert.deepEqual(
    describeRouteTransitionProblems(checkRouteKeyTransitions(before, after)),
    [],
    "semantic ids must keep every surviving route key on the same logical id",
  );

  const reordered = [FAMILY[0], FAMILY[2], FAMILY[1], FAMILY[3]];
  assert.deepEqual(
    checkRouteKeyTransitions(
      explicitTemplate(FAMILY, apptheory.AppTheoryMcpRouteIdMode.SEMANTIC),
      explicitTemplate(reordered, apptheory.AppTheoryMcpRouteIdMode.SEMANTIC),
    ),
    [],
    "semantic ids must be stable under reordering too",
  );
});

test("hand-rolled routes replaced by construct-owned routes with the same keys fail", () => {
  // After: the construct owns the full explicit inventory on a shared API.
  const after = templateOf((stack) => {
    const api = new apigwv2.HttpApi(stack, "McpApi");
    new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack, "Fn2"),
      api,
      sessionState: { enabled: false },
    });
  });

  // Before: the same API, the same route keys, but owned by hand-rolled
  // stack-level routes with different logical ids.
  const afterRoutes = routesOf(after);
  const before = templateOf((stack) => {
    const api = new apigwv2.HttpApi(stack, "McpApi");
    const integration = new apigwv2Integrations.HttpLambdaIntegration("AppInt", handler(stack));
    afterRoutes.forEach((route, index) => {
      const separator = route.routeKey.indexOf(" ");
      const method = route.routeKey.slice(0, separator);
      const routePath = route.routeKey.slice(separator + 1);
      new apigwv2.HttpRoute(stack, `AppRoute${index}`, {
        httpApi: api,
        routeKey: apigwv2.HttpRouteKey.with(routePath, method),
        integration,
        authorizer: new apigwv2Authorizers.HttpIamAuthorizer(),
      });
    });
  });

  assert.ok(afterRoutes.length > 10, "the transfer shape needs a realistic inventory");
  const beforeRefs = new Set(routesOf(before).map((route) => route.apiRef));
  assert.deepEqual(
    beforeRefs,
    new Set(afterRoutes.map((route) => route.apiRef)),
    "the transfer shape must compare one API, not two",
  );

  const problems = checkRouteKeyTransitions(before, after);
  const moved = movedRouteKeys(problems);
  assert.equal(
    moved.length,
    afterRoutes.length,
    "every construct-owned route takes a key a hand-rolled logical id held before",
  );
  assert.ok(
    problems.every((problem) => problem.kind === PROBLEM.OWNERSHIP_CHANGED
      || problem.kind === PROBLEM.CREATED_ROUTE_TAKES_EXISTING_KEY),
    "the transfer shape reports only the two ownership hazards",
  );
  assert.ok(
    problems.some((problem) => problem.kind === PROBLEM.CREATED_ROUTE_TAKES_EXISTING_KEY),
    "the construct-owned route is created by the transition",
  );
});

test("the documented new-API swap passes the transition check", () => {
  // Before: the deployed explicit API with its positional route inventory.
  const before = templateOf((stack) => {
    new apptheory.AppTheoryMcpServer(stack, "McpLegacy", {
      handler: handler(stack),
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
    });
  });

  // After: that API is deleted, and a consolidated API is created in the same
  // stack. Every route key moves to a logically different API.
  const after = templateOf((stack) => {
    new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
      runtimePosture: { requireBearerToken: true },
      originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
      denialSignal: {},
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
      routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    });
  });

  const beforeRefs = new Set(routesOf(before).map((route) => route.apiRef));
  const afterRefs = new Set(routesOf(after).map((route) => route.apiRef));
  for (const apiRef of beforeRefs) {
    assert.ok(!afterRefs.has(apiRef), "the swap must not reuse the deleted API's logical id");
  }
  assert.deepEqual(
    describeRouteTransitionProblems(checkRouteKeyTransitions(before, after)),
    [],
    "deleting the old API and creating the consolidated one in the same stack is safe",
  );
});

test("the transition check refuses a template whose API holds one route key twice", () => {
  const template = {
    Resources: {
      Api: { Type: "AWS::ApiGatewayV2::Api", Properties: { Name: "x", ProtocolType: "HTTP" } },
      RouteA: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: { ApiId: { Ref: "Api" }, RouteKey: "POST /{client_namespace}/mcp" },
      },
      RouteB: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: { ApiId: { Ref: "Api" }, RouteKey: "POST /{client_namespace}/mcp" },
      },
    },
  };
  assert.throws(
    () => indexRouteKeys(template),
    /route key POST \/\{client_namespace\}\/mcp must be held by exactly one logical id on API ref:Api, found RouteA, RouteB/,
  );
});
