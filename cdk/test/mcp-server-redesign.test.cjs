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

function fixtureRouteKeys() {
  return fixture.routes.flatMap((route) => [
    ...route.mcp_methods.map((method) => `${method} ${route.mcp_pattern}`),
    `GET ${route.protected_resource_pattern}`,
    `GET ${route.discovery_canonical_pattern}`,
    `GET ${route.discovery_suffix_pattern}`,
    `GET ${route.authorize_pattern}`,
    `POST ${route.token_pattern}`,
  ]).sort();
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
      authorizationRoutesAttached: route.authorization_routes_attached,
    })),
    rootAuthorizationServerPattern: fixture.root_authorization_server_pattern,
    rootAuthorizationServerAttached: fixture.root_authorization_server_attached,
  };
}

test("AppTheoryMcpServer input surfaces exclude undeclared origin and URL authority", () => {
  const assembly = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".jsii"), "utf8"));
  const expectedProps = {
    AppTheoryMcpServerProps: [
      "api",
      "apiName",
      "authorizationServerIssuer",
      "domain",
      "enableSessionTable",
      "handler",
      "jwksUri",
      "mcpPath",
      "ownedApi",
      "routeFamily",
      "sessionState",
      "sessionTableName",
      "sessionTtlMinutes",
      "stage",
      "unauthenticatedMcp",
    ],
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
    const actualNames = type.properties.map((property) => property.name).sort();
    assert.deepEqual(
      actualNames,
      expectedNames,
      `${typeName} must not acquire an unreviewed token, origin, or URL-valued prop`,
    );
  }
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
  assert.equal(keys.size, 16);
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
  }
  assert.ok(keys.has("POST /{tenant}/agents/{agent_id}/mcp"));
  assert.ok(keys.has("GET /.well-known/oauth-protected-resource/{tenant}/agents/{agent_id}/mcp"));
  assert.ok(keys.has("GET /{tenant}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server"));
  assert.ok(keys.has("GET /.well-known/oauth-authorization-server/{tenant}/agents/{agent_id}/mcp/authorize"));
  assert.ok(keys.has("POST /.well-known/oauth-authorization-server/{tenant}/agents/{agent_id}/mcp/token"));
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
  assert.ok(variables.MCP_ENDPOINT);
  assert.ok(variables.MCP_SESSION_TABLE);
  assert.equal(variables.MCP_SESSION_TTL_MINUTES, "60");
  for (const removed of [
    "APPTHEORY_MCP_PATH",
    "APPTHEORY_MCP_PROTECTED_RESOURCE_PATH",
    "APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER",
    "APPTHEORY_MCP_JWKS_URI",
  ]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(variables, removed));
  }
});

test("AppTheoryMcpServer explicit opt-outs remove facade and production resources", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "OptOutStack");
  new apptheory.AppTheoryMcpServer(stack, "McpServer", {
    handler: handler(stack),
    routeFamily: { patterns: ["/mcp"] },
    unauthenticatedMcp: true,
    sessionState: { enabled: false },
    ownedApi: { stage: { accessLogging: false, throttlingEnabled: false } },
  });
  const template = assertions.Template.fromStack(stack).toJSON();
  assert.deepEqual(routeKeys(template), ["DELETE /mcp", "GET /mcp", "POST /mcp"]);
  assert.equal(resourcesOfType(template, "AWS::DynamoDB::Table").length, 0);
  assert.equal(resourcesOfType(template, "AWS::Logs::LogGroup").length, 0);
  const stage = resourcesOfType(template, "AWS::ApiGatewayV2::Stage")[0];
  assert.equal(stage.Properties.AccessLogSettings, undefined);
  assert.equal(stage.Properties.DefaultRouteSettings, undefined);
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

test("AppTheoryMcpServer validates every explicit opt-out", () => {
  const cases = [
    {
      name: "unauthenticated auth props",
      props: {
        routeFamily: { patterns: ["/mcp"] },
        unauthenticatedMcp: true,
        authorizationServerIssuer: "https://auth.example.com",
        jwksUri: "https://auth.example.com/jwks.json",
      },
      error: /unauthenticatedMcp cannot be combined/,
    },
    {
      name: "unauthenticated root discovery",
      props: {
        routeFamily: { patterns: ["/mcp"], rootAuthorizationServerDiscovery: true },
        unauthenticatedMcp: true,
      },
      error: /unauthenticatedMcp cannot enable rootAuthorizationServerDiscovery/,
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
    propsByName.get("unauthenticatedMcp").docs.remarks,
    /RegisterMCPFacade.*always installs the authenticated\s+canonical facade/s,
  );

  const guide = fs.readFileSync(
    path.resolve(__dirname, "../../docs/features/mcp-server-construct.md"),
    "utf8",
  );
  assert.match(guide, /RegisterMCPFacade` serves exactly this canonical four-pattern family/);
  assert.match(guide, /RegisterMCPFacade` has no unauthenticated mode/);
  assert.doesNotMatch(
    guide,
    /routeFamily:\s*\{\s*patterns:\s*\[\s*["']\/mcp["']\s*\]\s*\}/s,
    "the shipped guide must not pair the canonical-only helper with a singleton family",
  );
});
