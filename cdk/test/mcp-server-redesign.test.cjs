const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cdk = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const lambda = require("aws-cdk-lib/aws-lambda");
const assertions = require("aws-cdk-lib/assertions");

const apptheory = require("../lib");

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-route-algebra/facade-route-inventory.json",
    ),
    "utf8",
  ),
);

const routeModel = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-route-model.v1.json",
    ),
    "utf8",
  ),
);

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

function routeKeys(template) {
  return resourcesOfType(template, "AWS::ApiGatewayV2::Route")
    .map((route) => route.Properties.RouteKey)
    .sort();
}

function routeAuthorizations(template) {
  return resourcesOfType(template, "AWS::ApiGatewayV2::Route")
    .map((route) => ({
      key: route.Properties.RouteKey,
      authorizationType: route.Properties.AuthorizationType ?? "NONE",
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function authorizationTypeByRouteKey(template) {
  return new Map(routeAuthorizations(template).map((route) => [route.key, route.authorizationType]));
}

function transportRouteKeys() {
  return fixture.routes.flatMap((route) =>
    route.mcp_methods.map((method) => `${method} ${route.mcp_pattern}`));
}

function publicRouteKeys() {
  return fixture.routes.flatMap((route) => [
    `GET ${route.protected_resource_pattern}`,
    `GET ${route.discovery_canonical_pattern}`,
    `GET ${route.discovery_suffix_pattern}`,
    `GET ${route.authorize_pattern}`,
    `POST ${route.token_pattern}`,
    `POST ${route.register_pattern}`,
  ]).concat([`GET ${fixture.callback_pattern}`]);
}

function fixtureRouteKeys() {
  return fixture.routes.flatMap((route) => [
    ...route.mcp_methods.map((method) => `${method} ${route.mcp_pattern}`),
    `GET ${route.protected_resource_pattern}`,
    `GET ${route.discovery_canonical_pattern}`,
    `GET ${route.discovery_suffix_pattern}`,
    `GET ${route.authorize_pattern}`,
    `POST ${route.token_pattern}`,
    `POST ${route.register_pattern}`,
  ]).concat([`GET ${fixture.callback_pattern}`]).sort();
}

function inventoryFromFixture() {
  return {
    contractVersion: fixture.contract_version,
    routes: fixture.routes.map((route) => ({
      mcpPattern: route.mcp_pattern,
      mcpMethods: route.mcp_methods,
      protectedResourcePattern: route.protected_resource_pattern,
      discoveryCanonicalPattern: route.discovery_canonical_pattern,
      discoverySuffixPattern: route.discovery_suffix_pattern,
      authorizePattern: route.authorize_pattern,
      tokenPattern: route.token_pattern,
      registerPattern: route.register_pattern,
      authorizationRoutesAttached: route.authorization_routes_attached,
    })),
    rootAuthorizationServerPattern: fixture.root_authorization_server_pattern,
    rootAuthorizationServerAttached: fixture.root_authorization_server_attached,
    callbackPattern: fixture.callback_pattern,
  };
}

function literalSingletonRouteFamilies(document) {
  const singletons = [];
  for (const fence of document.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (!/\b(?:routeFamily|route_family)\s*[:=]/.test(fence[1])) continue;
    for (const patterns of fence[1].matchAll(/\bpatterns\s*[:=]\s*\[([\s\S]*?)\]/g)) {
      if (/^\s*["'][^"']+["']\s*,?\s*$/.test(patterns[1])) {
        singletons.push(patterns[0]);
      }
    }
  }
  return singletons;
}

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

function expectSnapshot(name, template) {
  const filePath = path.join(__dirname, "snapshots", `${name}.json`);
  const actual = JSON.stringify(stableJson(template), null, 2) + "\n";
  if (!fs.existsSync(filePath)) {
    assert.fail(`missing snapshot ${filePath} (run with UPDATE_SNAPSHOTS=1)`);
  }
  assert.equal(actual, fs.readFileSync(filePath, "utf-8"));
}

function writeSnapshot(name, template) {
  const filePath = path.join(__dirname, "snapshots", `${name}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(stableJson(template), null, 2) + "\n");
}

function lambdaPermissionEntries(template) {
  const entries = [];
  for (const [id, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== "AWS::Lambda::Permission") continue;
    entries.push({ id, sourceArn: resource.Properties?.SourceArn ?? null });
  }
  return entries;
}

function lambdaPermissionSourceArnResourceName(sourceArn) {
  const parts = sourceArn?.["Fn::Join"]?.[1];
  if (!Array.isArray(parts)) return undefined;
  const tail = parts[parts.length - 1];
  return typeof tail === "string" ? tail : undefined;
}

function apiScopedLambdaPermissions(template) {
  return lambdaPermissionEntries(template).filter((entry) => entry.id.includes("ApiPermissionApiScoped"));
}

test("AppTheoryMcpServer input surfaces exclude undeclared origin and URL authority", () => {
  const assembly = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".jsii"), "utf8"));
  const expectedProps = {
    AppTheoryMcpServerProps: [
      "api",
      "apiName",
      "attachedApiStageName",
      "authorizationServerIssuer",
      "cors",
      "denialSignal",
      "domain",
      "enableSessionTable",
      "facade",
      "handler",
      "jwksUri",
      "mcpPath",
      "originReachability",
      "ownedApi",
      "owningApiDefense",
      "routeFamily",
      "routeModel",
      "runtimePosture",
      "scopePermissionToRoute",
      "sessionState",
      "sessionTableName",
      "sessionTtlMinutes",
      "stage",
      "transportAuthorizer",
      "transportPosture",
      "upstreamCallbackPath",
    ],
    AppTheoryMcpTransportAuthorizerOptions: [
      "audience",
      "authorizerName",
      "identitySource",
      "issuer",
    ],
    AppTheoryMcpFacadeAttachment: ["providerId"],
    AppTheoryMcpRuntimePostureOptions: ["requireBearerToken"],
    AppTheoryMcpDenialSignalOptions: ["dimensions", "metricName"],
    AppTheoryMcpOwningApiDefenseOptions: ["accessLogging", "throttling"],
    AppTheoryMcpOwningApiThrottlingOptions: ["burstLimit", "rateLimit"],
    AppTheoryMcpRouteFamily: ["patterns", "rootAuthorizationServerDiscovery"],
    AppTheoryMcpServerOwnedApiOptions: ["apiName", "domain", "stage"],
    AppTheoryMcpSessionStateOptions: ["enabled", "removalPolicy", "tableName", "ttlMinutes"],
    AppTheoryMcpServerDomainOptions: ["certificate", "certificateArn", "domainName", "hostedZone"],
    AppTheoryMcpServerStageOptions: [
      "accessLogRetention",
      "accessLogging",
      "stageName",
      "throttlingBurstLimit",
      "throttlingEnabled",
      "throttlingRateLimit",
    ],
  };

  for (const [typeName, expectedNames] of Object.entries(expectedProps)) {
    const type = assembly.types[`@theory-cloud/apptheory-cdk.${typeName}`];
    assert.equal(
      type.interfaces,
      undefined,
      `${typeName} must not inherit an unreviewed token, origin, or URL-valued prop`,
    );
    const actualNames = type.properties.map((property) => property.name).sort();
    assert.deepEqual(
      actualNames,
      expectedNames,
      `${typeName} must not acquire an unreviewed token, origin, or URL-valued prop`,
    );
  }

  assert.equal(
    assembly.types["@theory-cloud/apptheory-cdk.AppTheoryMcpTransportAuthorizerKind"],
    undefined,
    "the replaced authorizer-kind enum must not be republished",
  );
  const posture = assembly.types[
    "@theory-cloud/apptheory-cdk.AppTheoryMcpTransportPosture"
  ];
  assert.ok(posture, "the transport posture enum must be published");
  assert.deepEqual(
    posture.members.map((member) => member.name).sort(),
    ["IAM", "JWT", "NONE_PUBLIC", "RUNTIME_BEARER"],
    "the transport posture must stay a bounded enum, not a string-literal union",
  );
  const originReachability = assembly.types[
    "@theory-cloud/apptheory-cdk.AppTheoryMcpOriginReachability"
  ];
  assert.deepEqual(
    originReachability.members.map((member) => member.name).sort(),
    ["DISABLED", "LOCKED"],
    "the origin reachability decision must stay a bounded enum",
  );
});

test("AppTheoryMcpServer attach mode wires the runtime inventory without owning an API", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachStack");
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "api-1234567890",
    apiEndpoint: "https://api.example.com",
  });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api: importedApi,
    sessionState: { enabled: false },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api").length, 0);
  assert.deepEqual(routeKeys(template), fixtureRouteKeys());
  assert.deepEqual(server.routeInventory, inventoryFromFixture());
  assert.equal(server.api, importedApi);
  assert.equal(server.ownedApi, undefined);

  // Literal spots keep this test mutation-sensitive if an enumeration shrinks.
  const keys = new Set(routeKeys(template));
  assert.ok(keys.has("DELETE /{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp"));
  assert.ok(keys.has("GET /.well-known/oauth-protected-resource/{client_namespace}/mcp"));
  assert.ok(keys.has("GET /{client_namespace}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server"));
  assert.ok(keys.has("GET /.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp/authorize"));
  assert.ok(keys.has("POST /.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/token"));
  assert.ok(keys.has("POST /.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/register"));
  assert.ok(keys.has("GET /_oauth/mcp/callback"));
});

test("AppTheoryMcpServer attach mode synthesizes an API imported by id only", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "IdOnlyAttachStack");
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "abc123",
  });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api: importedApi,
    sessionState: { enabled: false },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api").length, 0);
  assert.deepEqual(routeKeys(template), fixtureRouteKeys());
  assert.equal(server.endpoints.length, fixture.routes.length);
});

test("AppTheoryMcpServer attach mode includes a known foreign API stage in endpoint templates", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "StagedAttachStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "abc123",
    apiEndpoint: "https://frontdoor.example.com",
  });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api: importedApi,
    attachedApiStageName: "prod",
    sessionState: { enabled: false },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api").length, 0);
  assert.deepEqual(routeKeys(template), fixtureRouteKeys());
  assert.match(
    server.endpoints[0],
    /^https:\/\/abc123\.execute-api\.us-east-1\.[^/]+\/prod\/\{client_namespace\}\/mcp$/,
  );
  assert.ok(
    server.endpoints.every((endpoint) =>
      new URL(endpoint.replace(cdk.Aws.URL_SUFFIX, "amazonaws.com")).host
        === "abc123.execute-api.us-east-1.amazonaws.com"),
  );
});

test("AppTheoryMcpServer fails closed on an indeterminate attached API stage", () => {
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "OwnedAttachedStageStack");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        attachedApiStageName: "prod",
      }),
      /attachedApiStageName requires attach mode with api/,
    );
  }
  for (const [index, stageName] of ["prod/path", cdk.Fn.ref("StageName")].entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `InvalidAttachedStageStack${index}`);
    const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
      httpApiId: "abc123",
    });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api: importedApi,
        attachedApiStageName: stageName,
      }),
      /attachedApiStageName must be a synthesis-time literal API Gateway stage name/,
    );
  }
});

test("AppTheoryMcpServer derives every facade route for parameterized family members through the algebra", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "ParameterizedStack");
  const patterns = ["/{tenant}/mcp", "/{tenant}/agents/{agent_id}/mcp"];
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: { patterns },
    sessionState: { enabled: false },
    ownedApi: { stage: { accessLogging: false, throttlingEnabled: false } },
  });
  const keys = new Set(routeKeys(assertions.Template.fromStack(stack).toJSON()));

  assert.deepEqual(server.mcpPaths, patterns);
  assert.equal(keys.size, 19);
  for (const route of server.routeInventory.routes) {
    assert.equal(
      route.protectedResourcePattern,
      apptheory.AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(route.mcpPattern),
    );
    assert.equal(
      route.discoveryCanonicalPattern,
      apptheory.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(route.mcpPattern),
    );
    assert.equal(
      route.discoverySuffixPattern,
      apptheory.AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(route.mcpPattern),
    );
    assert.equal(
      route.authorizePattern,
      apptheory.AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(route.mcpPattern),
    );
    assert.equal(
      route.tokenPattern,
      apptheory.AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(route.mcpPattern),
    );
    assert.equal(
      route.registerPattern,
      apptheory.AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(route.mcpPattern),
    );
  }
  assert.ok(keys.has("POST /{tenant}/agents/{agent_id}/mcp"));
  assert.ok(keys.has("GET /.well-known/oauth-protected-resource/{tenant}/agents/{agent_id}/mcp"));
  assert.ok(keys.has("GET /{tenant}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server"));
  assert.ok(keys.has("GET /.well-known/oauth-authorization-server/{tenant}/agents/{agent_id}/mcp/authorize"));
  assert.ok(keys.has("POST /.well-known/oauth-authorization-server/{tenant}/agents/{agent_id}/mcp/token"));
  assert.ok(keys.has("POST /.well-known/oauth-authorization-server/{tenant}/agents/{agent_id}/mcp/register"));
  assert.ok(
    keys.has(`GET ${server.routeInventory.callbackPattern}`),
    "the stage-global callback must be wired once for the whole family",
  );
});

test("AppTheoryMcpServer owned mode turns production defaults on", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OwnedStack");
  const fn = handler(stack);
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", { handler: fn });
  const template = assertions.Template.fromStack(stack).toJSON();

  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api").length, 1);
  assert.equal(resourcesOfType(template, "AWS::DynamoDB::Table").length, 1);
  assert.equal(resourcesOfType(template, "AWS::Logs::LogGroup").length, 1);
  assert.deepEqual(routeKeys(template), fixtureRouteKeys());
  assert.ok(server.ownedApi);

  const stage = resourcesOfType(template, "AWS::ApiGatewayV2::Stage")[0];
  assert.equal(stage.Properties.StageName, "$default");
  assert.deepEqual(stage.Properties.DefaultRouteSettings, {
    ThrottlingBurstLimit: 200,
    ThrottlingRateLimit: 100,
  });
  assert.ok(stage.Properties.AccessLogSettings);

  const variables = resourcesOfType(template, "AWS::Lambda::Function")[0].Properties.Environment.Variables;
  assert.ok(variables.MCP_SESSION_TABLE);
  assert.equal(variables.MCP_SESSION_TTL_MINUTES, "60");
  for (const removed of [
    "MCP_ENDPOINT",
    "APPTHEORY_MCP_PATH",
    "APPTHEORY_MCP_PROTECTED_RESOURCE_PATH",
    "APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER",
    "APPTHEORY_MCP_JWKS_URI",
  ]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(variables, removed));
  }
});

test("AppTheoryMcpServer none-public keeps every route public without facade resources", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OptOutStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: { patterns: ["/mcp"] },
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(routeKeys(template), ["DELETE /mcp", "GET /mcp", "POST /mcp"]);
  assert.equal(resourcesOfType(template, "AWS::DynamoDB::Table").length, 0);
  const stage = resourcesOfType(template, "AWS::ApiGatewayV2::Stage")[0];
  assert.deepEqual(
    stage.Properties.DefaultRouteSettings,
    { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
    "none-public requires the explicit owned-mode throttling decision",
  );
  assert.ok(stage.Properties.AccessLogSettings, "none-public requires access logging");
});

test("AppTheoryMcpServer attach mode rejects every API-owning prop", () => {
  for (const [name, extra] of [
    ["ownedApi", { ownedApi: {} }],
    ["apiName", { apiName: "legacy" }],
    ["domain", { domain: { domainName: "mcp.example.com" } }],
    ["stage", { stage: {} }],
  ]) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `${name}Stack`);
    const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
      httpApiId: `api-${name}`,
    });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api: importedApi,
        sessionState: { enabled: false },
        ...extra,
      }),
      new RegExp(`attach mode.*${name}`),
    );
  }
});

test("AppTheoryMcpServer validates parameter segments, tokens, and family collisions", () => {
  const invalid = [
    "https://resource.example.com/mcp",
    "/",
    "//mcp",
    "/mcp/",
    "/mcp/../admin",
    "/mcp/./admin",
    "/{}/mcp",
    "/{bad-name}/mcp",
    "/{proxy+}/mcp",
    "/prefix-{tenant}/mcp",
    "/my mcp",
  ];
  for (const [index, pattern] of invalid.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `InvalidPattern${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        routeFamily: { patterns: [pattern] },
      }),
      /routeFamily\.patterns\[0\].*absolute synthesis-time route pattern/,
    );
  }

  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TokenPattern");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        routeFamily: { patterns: [cdk.Fn.join("", ["/", "mcp"])] },
      }),
      /synthesis-time literal route pattern/,
    );
  }
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "EmptyFamily");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        routeFamily: { patterns: [] },
      }),
      /patterns must not be empty/,
    );
  }
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "DuplicateFamily");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        routeFamily: { patterns: ["/mcp", "/mcp"] },
      }),
      /duplicate pattern/,
    );
  }
});

test("AppTheoryMcpServer rejects algebra-derived route collisions at synthesis", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "DerivedCollisionStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      routeFamily: {
        patterns: ["/a/mcp", "/.well-known/oauth-authorization-server/a/mcp"],
      },
    }),
    /derived route family collides at GET \/\.well-known\/oauth-authorization-server\/a\/mcp/,
  );
});

test("AppTheoryMcpServer defaults the upstream callback to the contract default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "DefaultCallbackStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    sessionState: { enabled: false },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const contractDefault = routeModel.callback_override.default;
  assert.equal(contractDefault, routeModel.contract.default_callback_path);
  assert.equal(server.routeInventory.callbackPattern, contractDefault);
  assert.ok(routeKeys(template).includes(`GET ${contractDefault}`));
  assert.equal(server.routeInventory.callbackPattern, fixture.callback_pattern);
});

test("AppTheoryMcpServer normalizes and wires an upstream callback override", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OverrideCallbackStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    upstreamCallbackPath: "  /_oauth/custom/callback  ",
    sessionState: { enabled: false },
  });
  const keys = new Set(routeKeys(assertions.Template.fromStack(stack).toJSON()));
  assert.equal(server.routeInventory.callbackPattern, "/_oauth/custom/callback");
  assert.ok(keys.has("GET /_oauth/custom/callback"));
  assert.ok(!keys.has(`GET ${routeModel.contract.default_callback_path}`));
});

test("AppTheoryMcpServer rejects an invalid upstream callback override", () => {
  const invalid = [
    "cb",
    "/cb?x=1",
    "/cb#f",
    "/a/../b",
  ];
  for (const [index, value] of invalid.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `InvalidCallback${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        upstreamCallbackPath: value,
        sessionState: { enabled: false },
      }),
      /upstreamCallbackPath is invalid/,
      value,
    );
  }
});

test("AppTheoryMcpServer rejects an unresolved upstream callback token", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "CallbackTokenStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      upstreamCallbackPath: cdk.Fn.join("", ["/_oauth", "/callback"]),
      sessionState: { enabled: false },
    }),
    /upstreamCallbackPath must be a synthesis-time literal route path/,
  );
});

test("AppTheoryMcpServer rejects an upstream callback override that collides with a derived route", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "CallbackCollisionStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      upstreamCallbackPath:
        "/.well-known/oauth-protected-resource/{client_namespace}/mcp",
      sessionState: { enabled: false },
    }),
    /derived route family collides at GET \/\.well-known\/oauth-protected-resource\/\{client_namespace\}\/mcp/,
  );
});

test("AppTheoryMcpServer refuses an upstream callback override under none-public", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "NonePublicCallbackStack");
  assert.throws(
    () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
      originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
      upstreamCallbackPath: "/cb",
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
    }),
    /transportPosture NONE_PUBLIC cannot declare upstreamCallbackPath/,
  );
});

test("AppTheoryMcpServer rejects invalid deprecated issuer and JWKS pairs", () => {
  const cases = [
    {
      name: "partial pair",
      props: { authorizationServerIssuer: "https://auth.example.com" },
      error: /authorizationServerIssuer and jwksUri must be supplied together/,
    },
    {
      name: "insecure HTTP URLs",
      props: {
        authorizationServerIssuer: "http://auth.example.com",
        jwksUri: "http://auth.example.com/jwks.json",
      },
      error: /authorizationServerIssuer must be an absolute HTTPS URL/,
    },
  ];
  for (const [index, item] of cases.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `LegacyAuthValidation${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        ...item.props,
      }),
      item.error,
      item.name,
    );
  }
});

for (const item of [
  {
    name: "issuer URL with userinfo",
    authorizationServerIssuer: "https://user:password@auth.example.com",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with empty userinfo",
    authorizationServerIssuer: "https://@auth.example.com",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with percent-encoded authority",
    authorizationServerIssuer: "https://%61uth.example.com",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with a single-slash authority",
    authorizationServerIssuer: "https:/auth.example.com",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with an out-of-range port",
    authorizationServerIssuer: "https://host:99999",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with a space in the authority",
    authorizationServerIssuer: "https://exa mple.com",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with an empty host and explicit port",
    authorizationServerIssuer: "https://:8080",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with query",
    authorizationServerIssuer: "https://auth.example.com?tenant=example",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "issuer URL with fragment",
    authorizationServerIssuer: "https://auth.example.com#issuer",
    jwksUri: "https://auth.example.com/jwks.json",
    error: /authorizationServerIssuer must be an absolute HTTPS URL with no query or fragment/,
  },
  {
    name: "JWKS URL with userinfo",
    authorizationServerIssuer: "https://auth.example.com",
    jwksUri: "https://user:password@auth.example.com/jwks.json",
    error: /jwksUri must be an absolute HTTPS URL with no userinfo or fragment/,
  },
  {
    name: "JWKS URL with fragment",
    authorizationServerIssuer: "https://auth.example.com",
    jwksUri: "https://auth.example.com/jwks.json#keys",
    error: /jwksUri must be an absolute HTTPS URL with no userinfo or fragment/,
  },
]) {
  test(`AppTheoryMcpServer rejects deprecated ${item.name}`, () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "LegacyAuthURLValidation");
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        authorizationServerIssuer: item.authorizationServerIssuer,
        jwksUri: item.jwksUri,
      }),
      item.error,
    );
  });
}

test("AppTheoryMcpServer validates every explicit posture guard", () => {
  const cases = [
    {
      name: "none-public with legacy auth props",
      props: {
        routeFamily: { patterns: ["/mcp"] },
        transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
        authorizationServerIssuer: "https://auth.example.com",
        jwksUri: "https://auth.example.com/jwks.json",
      },
      error: /transportPosture NONE_PUBLIC cannot be combined/,
    },
    {
      name: "none-public root discovery",
      props: {
        routeFamily: { patterns: ["/mcp"], rootAuthorizationServerDiscovery: true },
        transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
      },
      error: /transportPosture NONE_PUBLIC cannot enable rootAuthorizationServerDiscovery/,
    },
    {
      name: "none-public runtime posture declaration",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
        runtimePosture: { requireBearerToken: true },
      },
      error: /transportPosture NONE_PUBLIC cannot declare runtimePosture/,
    },
    {
      name: "disabled session options",
      props: { sessionState: { enabled: false, ttlMinutes: 15 } },
      error: /disabled session state cannot configure/,
    },
    {
      name: "disabled logging retention",
      props: { ownedApi: { stage: { accessLogging: false, accessLogRetention: 7 } } },
      error: /accessLogRetention requires accessLogging/,
    },
    {
      name: "disabled throttling limits",
      props: { ownedApi: { stage: { throttlingEnabled: false, throttlingRateLimit: 1 } } },
      error: /throttling limits require throttlingEnabled/,
    },
  ];
  for (const [index, item] of cases.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `OptOutValidation${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        ...item.props,
      }),
      item.error,
      item.name,
    );
  }
});

test("AppTheoryMcpServer optional root route mirrors the runtime root inventory switch", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "RootDiscoveryStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: {
      patterns: ["/{client_namespace}/mcp"],
      rootAuthorizationServerDiscovery: true,
    },
    sessionState: { enabled: false },
    ownedApi: { stage: { accessLogging: false, throttlingEnabled: false } },
  });
  assert.equal(server.routeInventory.rootAuthorizationServerAttached, true);
  assert.equal(
    server.routeInventory.rootAuthorizationServerPattern,
    apptheory.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath("/"),
  );
  assert.ok(
    routeKeys(assertions.Template.fromStack(stack).toJSON())
      .includes("GET /.well-known/oauth-authorization-server"),
  );
});

test("AppTheoryMcpServer attach mode wires only real runtime environment dependencies", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AttachEnvironmentStack");
  const fn = handler(stack);
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "api-environment",
    apiEndpoint: "https://private.execute-api.example.com",
  });
  new apptheory.AppTheoryMcpServer(stack, "McpServer", { handler: fn, api: importedApi });
  const template = assertions.Template.fromStack(stack).toJSON();
  const variables = resourcesOfType(template, "AWS::Lambda::Function")[0].Properties.Environment.Variables;
  assert.deepEqual(Object.keys(variables).sort(), ["MCP_SESSION_TABLE", "MCP_SESSION_TTL_MINUTES"]);
});

test("AppTheoryMcpServer v3.1.x A6 props and accessors carry migration notices", () => {
  const assembly = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".jsii"), "utf8"));
  const props = assembly.types["@theory-cloud/apptheory-cdk.AppTheoryMcpServerProps"];
  const propsByName = new Map(props.properties.map((property) => [property.name, property]));
  for (const name of [
    "mcpPath",
    "authorizationServerIssuer",
    "jwksUri",
    "apiName",
    "enableSessionTable",
    "sessionTableName",
    "sessionTtlMinutes",
    "domain",
    "stage",
  ]) {
    const docs = propsByName.get(name)?.docs ?? {};
    assert.equal(docs.stability, "deprecated", `${name} stability`);
    assert.match(docs.deprecated ?? "", /Use|Configure/, `${name} migration pointer`);
  }

  const type = assembly.types["@theory-cloud/apptheory-cdk.AppTheoryMcpServer"];
  const accessors = new Map(type.properties.map((property) => [property.name, property]));
  for (const name of ["endpoint", "mcpPath", "protectedResourceMetadataPath"]) {
    assert.equal(accessors.get(name)?.docs?.stability, "deprecated", `${name} stability`);
    assert.match(accessors.get(name)?.docs?.deprecated ?? "", /Use/, `${name} migration pointer`);
  }
  for (const name of ["endpoint", "endpoints"]) {
    assert.match(
      accessors.get(name)?.docs?.remarks ?? "",
      /apiEndpoint.*never consulted/s,
      `${name} attach-mode apiEndpoint behavior`,
    );
  }
});

test("AppTheoryMcpServer docs pin the canonical runtime-helper boundary", () => {
  const assembly = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".jsii"), "utf8"));
  const props = assembly.types["@theory-cloud/apptheory-cdk.AppTheoryMcpServerProps"];
  const propsByName = new Map(props.properties.map((property) => [property.name, property]));
  assert.match(
    propsByName.get("routeFamily").docs.remarks,
    /RegisterMCPFacade.*only the canonical default\s+family/s,
  );
  assert.match(
    propsByName.get("transportPosture").docs.remarks,
    /attaches `facade` resolves to `runtime-bearer`[\s\S]*`none-public` is never a default/s,
  );
  assert.match(
    propsByName.get("runtimePosture").docs.remarks,
    /Required by `transportPosture: RUNTIME_BEARER`/s,
  );
  assert.match(
    propsByName.get("upstreamCallbackPath").docs.remarks,
    /callbackPathForConfiguredPath[\s\S]*none-public/s,
  );

  const guide = fs.readFileSync(
    path.resolve(__dirname, "../../docs/features/mcp-server-construct.md"),
    "utf8",
  );
  assert.match(guide, /RegisterMCPFacade` serves exactly this canonical four-pattern family/);
  assert.match(guide, /RegisterMCPFacade` now registers the MCP transport routes with an authenticated posture/);
  assert.match(
    guide,
    /`transportPosture`[\s\S]*`runtime-bearer`[\s\S]*`none-public`/s,
    "the guide must document the explicit transportPosture surface",
  );
  assert.doesNotMatch(
    guide,
    /unauthenticatedMcp/,
    "the guide must not advertise the removed opt-out prop",
  );
  assert.deepEqual(
    literalSingletonRouteFamilies(guide),
    [],
    "the canonical-only helper guide must not recommend any literal singleton route family",
  );
  assert.match(guide, /never\s+consults an `apiEndpoint` supplied through `HttpApi\.fromHttpApiAttributes`/s);
  assert.match(guide, /Set `attachedApiStageName`.*non-`\$default` stage.*appears in each template/s);
  assert.match(
    guide,
    /`upstreamCallbackPath`[\s\S]*callbackPathForConfiguredPath[\s\S]*none-public/s,
    "the guide must document the stage-global callback override and its none-public refusal",
  );

  const agentCoreGuides = [
    "../../docs/integrations/agentcore-mcp.md",
    "../../docs/cdk/mcp-server-agentcore.md",
    "../docs/mcp-server-agentcore.md",
  ].map((relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), "utf8"));
  for (const agentCoreGuide of agentCoreGuides) {
    assert.match(agentCoreGuide, /application-owned runtime registration/);
    assert.match(agentCoreGuide, /RegisterMCPFacade`\s+serves\s+only the canonical four-pattern\s+family/s);
    assert.doesNotMatch(
      agentCoreGuide,
      /\b(?:authorizationServerIssuer|jwksUri|authorization_server_issuer|jwks_uri)\b/i,
    );
    assert.doesNotMatch(agentCoreGuide, /oauth\.RegisterMCPServer/);

    const constructBlocks = [...agentCoreGuide.matchAll(/```(?:ts|py)\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((block) => block.includes("AppTheoryMcpServer"));
    assert.ok(constructBlocks.length > 0, "AgentCore guides must show an explicit singleton construct");
    for (const block of constructBlocks) {
      assert.match(block, /(?:routeFamily|route_family)[\s\S]*patterns[\s\S]*["']\/mcp["']/);
      assert.match(
        block,
        /transport_?posture/i,
        "AgentCore construct blocks must declare an explicit transport posture",
      );
      assert.match(
        block,
        /NONE_PUBLIC/,
        "AgentCore construct blocks must select the explicit none-public posture",
      );
      assert.match(
        block,
        /origin_?reachability/i,
        "AgentCore construct blocks must record the direct-origin reachability decision",
      );
    }
  }
  assert.match(
    agentCoreGuides[0],
    /Bedrock AgentCore[\s\S]*explicit singleton route family[\s\S]*Lambda \(Go\)[\s\S]*app\.Post\("\/mcp", \.\.\.\)/,
    "the integration diagram must show the explicit singleton and app-owned route",
  );
  assert.match(
    agentCoreGuides[0],
    /AgentCore calls \*\*`POST \/mcp`\*\* only when the deployment explicitly selects `routeFamily:/,
    "the endpoint claim must remain qualified by explicit singleton selection",
  );

  const corePatterns = fs.readFileSync(path.resolve(__dirname, "../../docs/core-patterns.md"), "utf8");
  assert.match(
    corePatterns,
    /POST-only MCP client[\s\S]*routeFamily[\s\S]*application[\s\S]*RegisterMCPFacade[\s\S]*canonical four-pattern family/,
  );

  const installParameters = fs.readFileSync(
    path.resolve(__dirname, "../../docs/features/install-parameters.md"),
    "utf8",
  );
  assert.match(installParameters, /app-owned values into `mcpfacade\.FacadeConfig\.IssuerURL` and `\.JWKSURI`/);
  assert.doesNotMatch(installParameters, /\b(?:authorizationServerIssuer|jwksUri)\s*:/);

  const conceptMap = fs.readFileSync(path.resolve(__dirname, "../docs/_concepts.yaml"), "utf8");
  const agentCoreConcept = conceptMap.match(/  mcp_server_agentcore:\n[\s\S]*?(?=\n  \S)/)?.[0];
  assert.ok(agentCoreConcept, "CDK concepts must describe AppTheoryMcpServer");
  assert.match(agentCoreConcept, /canonical four-kind route family and its full OAuth facade by default/);
  assert.match(agentCoreConcept, /session_state_enabled_by_default/);
  assert.doesNotMatch(agentCoreConcept, /Provision an HTTP API `POST \/mcp` endpoint/);
  assert.doesNotMatch(agentCoreConcept, /optional_session_table/);

  const patternMap = fs.readFileSync(path.resolve(__dirname, "../../docs/_patterns.yaml"), "utf8");
  const deploymentShape = patternMap.match(/  mcp_deployment_shape:\n[\s\S]*?(?=\n  \S)/)?.[0];
  assert.ok(deploymentShape, "docs patterns must describe the MCP deployment shape");
  assert.match(
    deploymentShape,
    /solution:.*AppTheoryMcpServer.*HTTP API v2.*complete OAuth facade/,
  );
  const incorrectExample = deploymentShape.match(
    /incorrect_example: \|\n([\s\S]*?)(?=\n        consequences:)/,
  )?.[1];
  assert.ok(incorrectExample, "MCP deployment anti-pattern must carry an incorrect example");
  assert.match(incorrectExample, /new AppTheoryRemoteMcpServer/);
  assert.match(incorrectExample, /new AppTheoryMcpProtectedResource/);
  assert.match(incorrectExample, /resource: mcp\.endpoint/);
  assert.match(incorrectExample, /authorizationServers:/);
  assert.doesNotMatch(
    incorrectExample,
    /new AppTheoryMcpServer/,
    "the anti-pattern must not depict the blessed canonical default",
  );
});

test("AppTheoryMcpServer scopes one invoke permission per route by default", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack, "Fn"),
    sessionState: { enabled: false },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const routes = resourcesOfType(template, "AWS::ApiGatewayV2::Route");
  assert.equal(routes.length, fixtureRouteKeys().length, "Should synthesize the canonical route family");
  assert.equal(
    lambdaPermissionEntries(template).length,
    routes.length,
    "Should synthesize one route-scoped permission per route",
  );
  assert.deepEqual(apiScopedLambdaPermissions(template), [], "Default synthesis must not grant an API-scoped permission");
  for (const permission of lambdaPermissionEntries(template)) {
    assert.match(permission.id, /McpHandlerPermission/, "Should keep the per-route integration permission id");
    assert.ok(
      !lambdaPermissionSourceArnResourceName(permission.sourceArn)?.endsWith("/*/*/*"),
      "Should scope each permission to its own route",
    );
  }
});

test("AppTheoryMcpServer can use API-scoped invoke permissions", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "api-1234567890",
    apiEndpoint: "https://api.example.com",
  });
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack, "Fn"),
    api: importedApi,
    sessionState: { enabled: false },
    scopePermissionToRoute: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(routeKeys(template), fixtureRouteKeys(), "Should keep the canonical route family");
  assert.equal(
    lambdaPermissionEntries(template).length,
    1,
    "Should synthesize exactly one API-scoped permission for the shared MCP handler",
  );
  const [permission] = apiScopedLambdaPermissions(template);
  assert.ok(permission, "Should synthesize the CDK API-scoped permission");
  // An imported API renders its literal id into the execute-api ARN, so assert the scope shape.
  assert.ok(
    lambdaPermissionSourceArnResourceName(permission.sourceArn)?.endsWith("/*/*/*"),
    "Should scope the permission to every route on the API",
  );
});

test("AppTheoryMcpServer default template is unchanged for existing users", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack, "Fn"),
    ownedApi: { apiName: "apptheory-mcp-permission-scope" },
    sessionState: { enabled: true, tableName: "apptheory-mcp-sessions" },
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-permission-scope-default", template);
  } else {
    expectSnapshot("mcp-server-permission-scope-default", template);
  }
});

test("AppTheoryMcpServer defaults MCP transport routes to IAM and keeps OAuth routes public", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TransportAuthorizerDefaultStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    sessionState: { enabled: false },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const authorizations = authorizationTypeByRouteKey(template);

  for (const key of transportRouteKeys()) {
    assert.equal(authorizations.get(key), "AWS_IAM", `${key} must require credentials by default`);
  }
  for (const key of publicRouteKeys()) {
    assert.equal(authorizations.get(key), "NONE", `${key} must stay public`);
  }
  assert.equal(server.transportPosture, apptheory.AppTheoryMcpTransportPosture.IAM);
  assert.deepEqual(
    resourcesOfType(template, "AWS::ApiGatewayV2::Authorizer"),
    [],
    "IAM authorization must not synthesize an explicit authorizer resource",
  );
});

test("AppTheoryMcpServer flips the facade-scoped default to runtime bearer", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "FacadeDefaultStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    facade: { providerId: "autheory" },
    runtimePosture: { requireBearerToken: true },
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    denialSignal: {},
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const authorizations = authorizationTypeByRouteKey(template);

  assert.equal(server.transportPosture, apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER);
  for (const key of transportRouteKeys()) {
    assert.equal(authorizations.get(key), "NONE", `${key} must hand bearer validation to the runtime`);
  }
  for (const key of publicRouteKeys()) {
    assert.equal(authorizations.get(key), "NONE", `${key} must stay public`);
  }
  assert.deepEqual(
    resourcesOfType(template, "AWS::ApiGatewayV2::Authorizer"),
    [],
    "runtime bearer must not synthesize a gateway authorizer",
  );
});

test("AppTheoryMcpServer wires an explicit JWT transport authorizer", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TransportAuthorizerJwtStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    sessionState: { enabled: false },
    transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT,
    transportAuthorizer: {
      issuer: "https://accounts.example.com",
      audience: ["https://mcp.example.com"],
      authorizerName: "McpJwtAuthorizer",
    },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const authorizations = authorizationTypeByRouteKey(template);

  for (const key of transportRouteKeys()) {
    assert.equal(authorizations.get(key), "JWT", `${key} must use the configured JWT authorizer`);
  }
  for (const key of publicRouteKeys()) {
    assert.equal(authorizations.get(key), "NONE", `${key} must stay public`);
  }

  const authorizers = resourcesOfType(template, "AWS::ApiGatewayV2::Authorizer");
  assert.equal(authorizers.length, 1, "Should synthesize exactly one transport authorizer");
  assert.equal(authorizers[0].Properties.AuthorizerType, "JWT");
  assert.equal(authorizers[0].Properties.Name, "McpJwtAuthorizer");
  assert.equal(authorizers[0].Properties.IdentitySource[0], "$request.header.Authorization");
  assert.deepEqual(authorizers[0].Properties.JwtConfiguration, {
    Audience: ["https://mcp.example.com"],
    Issuer: "https://accounts.example.com",
  });
  assert.equal(server.routeInventory.routes.length, fixture.routes.length);
});

test("AppTheoryMcpServer none-public keeps every route public", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TransportAuthorizerOptOutStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: { patterns: ["/mcp"] },
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  const routes = routeAuthorizations(template);
  assert.deepEqual(routes.map((route) => route.key), ["DELETE /mcp", "GET /mcp", "POST /mcp"]);
  for (const route of routes) {
    assert.equal(route.authorizationType, "NONE", `${route.key} must stay public under none-public`);
  }
  assert.deepEqual(resourcesOfType(template, "AWS::ApiGatewayV2::Authorizer"), []);
  assert.equal(server.transportPosture, apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC);
  assert.equal(server.routeInventory.routes[0].authorizationRoutesAttached, false);
});

test("AppTheoryMcpServer rejects invalid transport authorizer configuration", () => {
  const cases = [
    {
      name: "jwt without a transport authorizer",
      props: { transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT },
      error: /transportAuthorizer\.issuer is required when transportPosture is JWT/,
    },
    {
      name: "jwt missing issuer",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT,
        transportAuthorizer: {},
      },
      error: /transportAuthorizer\.issuer is required/,
    },
    {
      name: "jwt insecure issuer",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT,
        transportAuthorizer: {
          issuer: "http://accounts.example.com",
          audience: ["https://mcp.example.com"],
        },
      },
      error: /transportAuthorizer\.issuer must be an absolute HTTPS URL/,
    },
    {
      name: "jwt missing audience",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT,
        transportAuthorizer: { issuer: "https://accounts.example.com" },
      },
      error: /transportAuthorizer\.audience requires at least one accepted audience/,
    },
    {
      name: "iam with a transport authorizer",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.IAM,
        transportAuthorizer: { issuer: "https://accounts.example.com" },
      },
      error: /transportAuthorizer is only valid with transportPosture JWT/,
    },
    {
      name: "runtime-bearer with a transport authorizer",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
        runtimePosture: { requireBearerToken: true },
        originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
        denialSignal: {},
        ownedApi: { stage: { throttlingEnabled: true } },
        transportAuthorizer: { issuer: "https://accounts.example.com" },
      },
      error: /transportAuthorizer is only valid with transportPosture JWT/,
    },
    {
      name: "none-public with a transport authorizer",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
        originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
        ownedApi: { stage: { throttlingEnabled: true } },
        transportAuthorizer: { issuer: "https://accounts.example.com" },
      },
      error: /transportAuthorizer is only valid with transportPosture JWT/,
    },
  ];
  for (const [index, item] of cases.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `TransportAuthorizerInvalid${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        ...item.props,
      }),
      item.error,
      item.name,
    );
  }
});

test("AppTheoryMcpServer consolidated mode emits two greedy NONE routes with semantic ids", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "ConsolidatedStack");
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
    runtimePosture: { requireBearerToken: true },
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    denialSignal: {},
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  const routes = resourcesOfType(template, "AWS::ApiGatewayV2::Route");
  assert.equal(routes.length, 2, "consolidated mode must emit exactly two routes");
  assert.deepEqual(routeKeys(template), ["ANY /", "ANY /{proxy+}"].sort());
  for (const route of routes) {
    assert.equal(route.Properties.AuthorizationType ?? "NONE", "NONE", "every consolidated route must be NONE");
  }
  const routeIds = Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route")
    .map(([id]) => id)
    .sort();
  assert.ok(
    routeIds.some((id) => id.startsWith("McpServerRouteAnyRoot")),
    "the root route construct id must be semantic (method + prefix), not positional",
  );
  assert.ok(
    routeIds.some((id) => id.startsWith("McpServerRouteAnyProxy")),
    "the proxy route construct id must be semantic (method + prefix), not positional",
  );
  assert.ok(
    !routeIds.some((id) => /Route\d/.test(id)),
    "consolidated route ids must never be positional counters",
  );
  assert.equal(server.routeInventory.routes.length, fixture.routes.length, "the runtime inventory is unchanged");
});

test("AppTheoryMcpServer consolidated ids are stable across route-family changes", () => {
  const idsFor = (patterns) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ConsolidatedStableStack");
    new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      routeFamily: { patterns, rootAuthorizationServerDiscovery: patterns.length === 1 },
      transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
      runtimePosture: { requireBearerToken: true },
      originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
      denialSignal: {},
      sessionState: { enabled: false },
      ownedApi: { stage: { throttlingEnabled: true } },
      routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    });
    return Object.entries(assertions.Template.fromStack(stack).toJSON().Resources)
      .filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route")
      .map(([id]) => id.replace(/[0-9A-F]{8}$/, ""))
      .sort();
  };

  const single = idsFor(["/mcp"]);
  const quartet = idsFor([
    "/{client_namespace}/mcp",
    "/{client_namespace}/partners/{partner_id}/mcp",
    "/{client_namespace}/agents/{agent_id}/mcp",
    "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
  ]);
  assert.deepEqual(single, quartet, "adding or reordering the route family must not rename consolidated routes");
});

test("AppTheoryMcpServer consolidated mode grants one API-scoped permission when unscoped", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "ConsolidatedScopedStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
    scopePermissionToRoute: false,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Route").length, 2);
  assert.equal(lambdaPermissionEntries(template).length, 1, "unscoped permission collapses to one");
  assert.equal(apiScopedLambdaPermissions(template).length, 1);
});

test("AppTheoryMcpServer consolidated attaches to an empty API and keeps the runtime inventory", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "ConsolidatedAttachStack");
  const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
    httpApiId: "api-consolidated",
    apiEndpoint: "https://api.example.com",
  });
  const server = new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    api: importedApi,
    transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
    runtimePosture: { requireBearerToken: true },
    originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
    denialSignal: {},
    owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
    sessionState: { enabled: false },
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(routeKeys(template), ["ANY /", "ANY /{proxy+}"].sort());
  assert.equal(resourcesOfType(template, "AWS::ApiGatewayV2::Api").length, 0, "attach mode owns no API");
  assert.equal(server.routeInventory.routes.length, fixture.routes.length);
  assert.equal(server.routeInventory.callbackPattern, fixture.callback_pattern);
});

test("AppTheoryMcpServer refuses consolidated with iam or jwt and on an API that already has routes", () => {
  const refused = [
    {
      name: "iam",
      props: { transportPosture: apptheory.AppTheoryMcpTransportPosture.IAM },
      error: /routeModel consolidated is only valid for transportPosture RUNTIME_BEARER or NONE_PUBLIC/,
    },
    {
      name: "jwt",
      props: {
        transportPosture: apptheory.AppTheoryMcpTransportPosture.JWT,
        transportAuthorizer: { issuer: "https://accounts.example.com", audience: ["https://mcp.example.com"] },
      },
      error: /routeModel consolidated is only valid for transportPosture RUNTIME_BEARER or NONE_PUBLIC/,
    },
  ];
  for (const [index, item] of refused.entries()) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, `ConsolidatedRefused${index}`);
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        sessionState: { enabled: false },
        routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
        ...item.props,
      }),
      item.error,
      item.name,
    );
  }

  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ConsolidatedAttachRefused");
    const httpApi = new apptheory.AppTheoryHttpApi(stack, "HttpApi", { handler: handler(stack) });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack, "Fn2"),
        api: httpApi.api,
        transportPosture: apptheory.AppTheoryMcpTransportPosture.RUNTIME_BEARER,
        runtimePosture: { requireBearerToken: true },
        originReachability: apptheory.AppTheoryMcpOriginReachability.LOCKED,
        denialSignal: {},
        owningApiDefense: { accessLogging: true, throttling: { rateLimit: 50, burstLimit: 100 } },
        sessionState: { enabled: false },
        routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
      }),
      /routeModel consolidated may attach only to an API that has no routes at attach time/,
    );
  }
});

test("AppTheoryMcpServer applies CORS preflight to a construct-owned API and refuses it in attach mode", () => {
  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ConsolidatedCorsStack");
    new apptheory.AppTheoryMcpServer(stack, "McpServer", {
      handler: handler(stack),
      cors: { allowOrigins: ["https://app.example.com"], allowMethods: ["get", "post"] },
      sessionState: { enabled: false },
    });
    const [api] = resourcesOfType(assertions.Template.fromStack(stack).toJSON(), "AWS::ApiGatewayV2::Api");
    assert.deepEqual(api.Properties.CorsConfiguration.AllowOrigins, ["https://app.example.com"]);
    assert.deepEqual(api.Properties.CorsConfiguration.AllowMethods, ["GET", "POST"]);
  }

  {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ConsolidatedCorsAttachStack");
    const importedApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, "Frontdoor", {
      httpApiId: "api-cors-attach",
      apiEndpoint: "https://api.example.com",
    });
    assert.throws(
      () => new apptheory.AppTheoryMcpServer(stack, "McpServer", {
        handler: handler(stack),
        api: importedApi,
        cors: true,
        sessionState: { enabled: false },
      }),
      /attach mode with api cannot configure owned-API props: cors/,
    );
  }
});

test("AppTheoryMcpServer consolidated template is stable", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "ConsolidatedSnapshotStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    transportPosture: apptheory.AppTheoryMcpTransportPosture.NONE_PUBLIC,
    originReachability: apptheory.AppTheoryMcpOriginReachability.DISABLED,
    sessionState: { enabled: false },
    ownedApi: { stage: { throttlingEnabled: true } },
    routeModel: apptheory.AppTheoryMcpRouteModel.CONSOLIDATED,
  });

  const template = assertions.Template.fromStack(stack).toJSON();
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeSnapshot("mcp-server-consolidated", template);
  } else {
    expectSnapshot("mcp-server-consolidated", template);
  }
});
